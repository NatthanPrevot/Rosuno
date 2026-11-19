// Provider-neutral notification delivery (MVP-001 S10; MBS section 15
// deliverable 12C; ROS section 15; TA sections 23, 27 and 47; MB sections 97
// to 99).
//
// Business Event -> Notification -> Operational Job -> Provider Adapter ->
// Provider Observation. Canonical business events create Notifications in
// their own database transactions (the outbox); each email Notification
// enqueues one notification.deliver job, and the S2 job protocol runs the
// handler defined here after commit, with bounded attempts, backoff and
// visible escalation. Nothing here knows a provider: an email adapter offers
// one send operation in Rosuno's own terms (an accepted message with the
// provider's reference, a transient or permanent failure with a fixed
// failure code, or its own refusal before any provider call), names its own
// provider code, and maps the provider's
// webhook events into Rosuno's observation vocabulary. Another email adapter,
// or another channel, is a separate adapter behind the same port.
//
// The handler of one notification.deliver job:
// - reads what the job is to do from canonical state through the server-only
//   recording port (notification_job_context): act (with the Notification's
//   type, the recipient's notification center path and the recipient's
//   address, read at send time and used only for this one call: never logged,
//   stored or returned), nothing_to_do, no_recipient or not_running;
// - builds the fixed message of the type (no legal matter details, names,
//   message bodies or document names: a link to the notification center at
//   the configured site origin only) and sends it once through the email
//   adapter with an idempotency key derived from the Notification id, so a
//   retry after a lost answer never sends a second email;
// - records the outcome as one Rosuno delivery attempt
//   (notification_record_attempt) and lets the database move the
//   Notification: accepted -> sent; a transient failure -> retrying, and the
//   handler fails so the job protocol retries it with backoff (on the job's
//   last attempt the database ends it permanently_failed instead); a
//   permanent failure -> permanently_failed;
// - an attempt that stops before any provider call is recorded with the
//   provider-neutral result not_sent and one fixed code: without a configured
//   adapter or site origin (no fallback, mock or default exists)
//   provider_unconfigured, retried like a transient failure, so the
//   Notification ends permanently_failed after its bounded attempts unless
//   configuration arrives; without a recipient recipient_unavailable, and for
//   an address outside the one fixed address rule (shared with the database
//   and the adapter) recipient_address_unsupported, both final; the adapter's
//   own refusal before a call keeps its fixed code. The business event that
//   caused a Notification is never touched.
// Every answer is read strictly; anything unknown makes the attempt fail and
// the job retry. Provider events reach the database through
// recordNotificationEvent after the webhook adapter has verified them.

import { JOB_DONE, type JobHandler, type JobRun } from "./job-worker.ts";
import { isUuid, readExact } from "./professional-records.ts";

// ---------------------------------------------------------------------------
// Vocabulary (the database checks every value again)
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = Object.freeze([
  "request_awaiting_decision",
  "request_accepted",
  "request_declined",
  "request_expired",
  "consultation_ready",
  "message_received",
  "document_shared",
] as const);
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_JOB_TYPES = Object.freeze([
  "notification.deliver",
] as const);

// The delivery states of an email Notification and of an in-app one.
export const EMAIL_STATES = Object.freeze([
  "pending",
  "sent",
  "delivered",
  "failed",
  "retrying",
  "permanently_failed",
] as const);
export type EmailState = (typeof EMAIL_STATES)[number];
export const IN_APP_STATES = Object.freeze([
  "delivered",
  "acknowledged",
] as const);
export type InAppState = (typeof IN_APP_STATES)[number];

// The provider-neutral attempt results and observation kinds.
export const ATTEMPT_RESULTS = Object.freeze([
  "accepted",
  "failed_transient",
  "failed_permanent",
  "not_sent",
] as const);
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

// The fixed codes of an attempt that stopped before any provider call (the
// database admits exactly these with not_sent). Only provider_unconfigured is
// retried.
export const NOT_SENT_CODES = Object.freeze([
  "provider_unconfigured",
  "recipient_unavailable",
  "recipient_address_unsupported",
  "invalid_request",
] as const);
export type NotSentCode = (typeof NOT_SENT_CODES)[number];

export const OBSERVATION_KINDS = Object.freeze([
  "accepted",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "suppressed",
  "failed",
  "ignored",
] as const);
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const PROVIDER_REFERENCE = /^[A-Za-z0-9._:-]{1,255}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const EVENT_REFERENCE = /^[A-Za-z0-9_]{3,255}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{2,99}$/;
const PAYLOAD_DIGEST = /^sha256:[0-9a-f]{64}$/;
const EVENT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CENTER_PATH = /^\/(?:client|attorney)\/notifications$/;
// The one fixed address rule, the same as the database's
// (notification_job_context) and the adapter's: an RFC 5322 dot-atom-style
// local part of atext characters and dots (the apostrophe included) and a
// host name of letters, digits and inner hyphens, 3 to 320 characters in all.
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const oneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export function isProviderCode(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_CODE.test(value);
}

export function isProviderReference(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_REFERENCE.test(value);
}

export function isFailureCode(value: unknown): value is string {
  return typeof value === "string" && FAILURE_CODE.test(value);
}

export function isEmailAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 320 &&
    ADDRESS.test(value)
  );
}

export function isNotSentCode(value: unknown): value is NotSentCode {
  return oneOf(NOT_SENT_CODES, value);
}

// The idempotency key of one Notification's email: the same on every attempt
// and every job of that Notification, different for every other one.
export function emailIdempotencyKeyOf(notificationId: string): string {
  if (!isUuid(notificationId)) {
    throw new Error("not a notification identifier");
  }
  return `rosuno-notification-${notificationId}`;
}

// ---------------------------------------------------------------------------
// The email port (an adapter implements it; it decides nothing about state)
// ---------------------------------------------------------------------------

export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

export type EmailSendResult =
  | { readonly kind: "accepted"; readonly reference: string }
  | {
      readonly kind: "failed";
      readonly permanence: "transient" | "permanent";
      readonly failureCode: string;
    }
  // The adapter refused the message itself, before any provider call.
  | {
      readonly kind: "not_sent";
      readonly failureCode: "recipient_address_unsupported" | "invalid_request";
    };

export type EmailProvider = {
  // The provider code Rosuno records with each attempt.
  readonly providerCode: string;
  readonly send: (
    message: EmailMessage,
    idempotencyKey: string,
  ) => Promise<EmailSendResult>;
};

// Whether a send result has exactly one of the allowed shapes.
export function isEmailSendResult(value: unknown): value is EmailSendResult {
  const accepted = readExact(value, ["kind", "reference"]);
  if (accepted !== null) {
    return (
      accepted.get("kind") === "accepted" &&
      isProviderReference(accepted.get("reference"))
    );
  }
  const refused = readExact(value, ["kind", "failureCode"]);
  if (refused !== null) {
    return (
      refused.get("kind") === "not_sent" &&
      (refused.get("failureCode") === "recipient_address_unsupported" ||
        refused.get("failureCode") === "invalid_request")
    );
  }
  const failed = readExact(value, ["kind", "permanence", "failureCode"]);
  return (
    failed !== null &&
    failed.get("kind") === "failed" &&
    (failed.get("permanence") === "transient" ||
      failed.get("permanence") === "permanent") &&
    isFailureCode(failed.get("failureCode"))
  );
}

// ---------------------------------------------------------------------------
// Templates (fixed, minimal; no legal matter details, names, bodies or
// document names)
// ---------------------------------------------------------------------------

export const EMAIL_TEMPLATES: Readonly<
  Record<NotificationType, { readonly subject: string; readonly line: string }>
> = Object.freeze({
  request_awaiting_decision: {
    subject: "A consultation request is waiting for your decision",
    line: "A consultation request is waiting for your decision.",
  },
  request_accepted: {
    subject: "Your consultation request was accepted",
    line: "Your consultation request was accepted.",
  },
  request_declined: {
    subject: "Your consultation request was declined",
    line: "Your consultation request was declined.",
  },
  request_expired: {
    subject: "Your consultation request expired",
    line: "Your consultation request expired without a decision.",
  },
  consultation_ready: {
    subject: "Your consultation is ready",
    line: "Your consultation is ready to join.",
  },
  message_received: {
    subject: "You have a new message",
    line: "You have a new message in your consultation.",
  },
  document_shared: {
    subject: "A document was shared with you",
    line: "A document was shared with you in your consultation.",
  },
});

const SITE_ORIGIN = /^https?:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;

// The one link an email carries: the recipient's notification center at the
// configured site origin, or null when either is not well-formed.
export function centerUrlOf(origin: string, centerPath: string): string | null {
  return SITE_ORIGIN.test(origin) && CENTER_PATH.test(centerPath)
    ? `${origin}${centerPath}`
    : null;
}

// The fixed email of one notification type for one recipient.
export function emailMessageOf(
  type: NotificationType,
  to: string,
  centerUrl: string,
): EmailMessage {
  const template = EMAIL_TEMPLATES[type];
  const text = [
    template.line,
    "",
    "Sign in to Rosuno to see it in your notifications:",
    centerUrl,
    "",
    "This message contains no details of your matter. You receive it because you have a Rosuno account.",
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html lang="en"><body>',
    `<p>${template.line}</p>`,
    `<p><a href="${centerUrl}">Open your notifications</a></p>`,
    "<p>This message contains no details of your matter. You receive it because you have a Rosuno account.</p>",
    "</body></html>",
  ].join("");
  return Object.freeze({ to, subject: template.subject, text, html });
}

// ---------------------------------------------------------------------------
// The recording port (server-only; the privileged worker and webhook calls)
// ---------------------------------------------------------------------------

export const RECORD_OUTCOMES = Object.freeze([
  "sent",
  "retrying",
  "permanently_failed",
  "no_effect",
  "invalid",
  "not_running",
] as const);
export type RecordOutcome = (typeof RECORD_OUTCOMES)[number];

export const EVENT_OUTCOMES = Object.freeze([
  "recorded",
  "duplicate",
  "invalid",
] as const);
export const PROCESSING_STATES = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "unmatched",
  "ignored",
] as const);

export type DeliveryAttempt =
  | { readonly result: "accepted"; readonly reference: string }
  | {
      readonly result: "failed_transient" | "failed_permanent";
      readonly failureCode: string;
    }
  // Stopped before any provider call.
  | { readonly result: "not_sent"; readonly failureCode: NotSentCode };

export type NotificationObservation = {
  readonly kind: ObservationKind;
  // null only for ignored events.
  readonly provider_reference: string | null;
};

// One authenticated provider event as Rosuno records it.
export type NotificationEvent = {
  readonly providerCode: string;
  readonly eventReference: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadDigest: string;
  readonly observation: NotificationObservation;
};

export type NotificationEventAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: (typeof EVENT_OUTCOMES)[number];
      readonly processing: (typeof PROCESSING_STATES)[number] | null;
    }
  | { readonly kind: "unknown" };

export type NotificationRecorder = {
  // notification_job_context(p_job_id): its rows, or null when unreadable.
  readonly jobContext: (jobId: string) => Promise<readonly unknown[] | null>;
  // notification_record_attempt(p_job_id, p_provider_code, p_result,
  // p_provider_reference, p_failure_code).
  readonly recordAttempt: (
    jobId: string,
    providerCode: string,
    attempt: DeliveryAttempt,
  ) => Promise<RecordOutcome | "unknown">;
  // notification_record_provider_event(...).
  readonly recordEvent: (
    event: NotificationEvent,
  ) => Promise<NotificationEventAnswer>;
};

export function isDeliveryAttempt(value: unknown): value is DeliveryAttempt {
  const accepted = readExact(value, ["result", "reference"]);
  if (accepted !== null) {
    return (
      accepted.get("result") === "accepted" &&
      isProviderReference(accepted.get("reference"))
    );
  }
  const failed = readExact(value, ["result", "failureCode"]);
  if (failed === null) {
    return false;
  }
  if (failed.get("result") === "not_sent") {
    return isNotSentCode(failed.get("failureCode"));
  }
  return (
    (failed.get("result") === "failed_transient" ||
      failed.get("result") === "failed_permanent") &&
    isFailureCode(failed.get("failureCode"))
  );
}

export function isNotificationObservation(
  value: unknown,
): value is NotificationObservation {
  const fields = readExact(value, ["kind", "provider_reference"]);
  if (fields === null) {
    return false;
  }
  const kind = fields.get("kind");
  const reference = fields.get("provider_reference");
  return kind === "ignored"
    ? reference === null
    : oneOf(OBSERVATION_KINDS, kind) && isProviderReference(reference);
}

export function isNotificationEvent(
  value: unknown,
): value is NotificationEvent {
  const fields = readExact(value, [
    "providerCode",
    "eventReference",
    "eventType",
    "occurredAt",
    "payloadDigest",
    "observation",
  ]);
  if (fields === null) {
    return false;
  }
  const reference = fields.get("eventReference");
  const type = fields.get("eventType");
  const time = fields.get("occurredAt");
  const digest = fields.get("payloadDigest");
  return (
    isProviderCode(fields.get("providerCode")) &&
    typeof reference === "string" &&
    EVENT_REFERENCE.test(reference) &&
    typeof type === "string" &&
    EVENT_TYPE.test(type) &&
    typeof time === "string" &&
    EVENT_TIME.test(time) &&
    typeof digest === "string" &&
    PAYLOAD_DIGEST.test(digest) &&
    isNotificationObservation(fields.get("observation"))
  );
}

export function recordOutcomeOf(data: unknown): RecordOutcome | "unknown" {
  return oneOf(RECORD_OUTCOMES, data) ? data : "unknown";
}

// notification_record_provider_event's one row read strictly.
export function notificationEventAnswerOf(
  rows: unknown,
): NotificationEventAnswer {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return Object.freeze({ kind: "unknown" });
  }
  const fields = readExact(rows[0], ["outcome", "processing_state"]);
  const outcome = fields?.get("outcome");
  const processing = fields?.get("processing_state");
  if (
    fields === null ||
    !oneOf(EVENT_OUTCOMES, outcome) ||
    !(processing === null || oneOf(PROCESSING_STATES, processing)) ||
    (outcome === "invalid") !== (processing === null)
  ) {
    return Object.freeze({ kind: "unknown" });
  }
  return Object.freeze({
    kind: "answer",
    outcome,
    processing: processing as (typeof PROCESSING_STATES)[number] | null,
  });
}

export type NotificationJobContext =
  | {
      readonly outcome: "act";
      readonly notificationId: string;
      readonly type: NotificationType;
      readonly centerPath: string;
      readonly address: string;
    }
  | {
      readonly outcome: "nothing_to_do" | "no_recipient" | "not_running";
    }
  // An act answer whose address this side does not accept (the rules are the
  // same, so only a divergence reaches this): recorded, never retried.
  | { readonly outcome: "address_unsupported" };

const CONTEXT_COLUMNS = Object.freeze([
  "outcome",
  "notification_id",
  "notification_type",
  "center_path",
  "recipient_address",
]);

// notification_job_context's one row read strictly, or null.
export function notificationJobContextOf(
  rows: readonly unknown[] | null,
): NotificationJobContext | null {
  if (rows === null || rows.length !== 1) {
    return null;
  }
  const fields = readExact(rows[0], CONTEXT_COLUMNS);
  if (fields === null) {
    return null;
  }
  const outcome = fields.get("outcome");
  const id = fields.get("notification_id");
  const type = fields.get("notification_type");
  const path = fields.get("center_path");
  const address = fields.get("recipient_address");
  if (outcome === "act") {
    if (
      !isUuid(id) ||
      !oneOf(NOTIFICATION_TYPES, type) ||
      typeof path !== "string" ||
      !CENTER_PATH.test(path) ||
      typeof address !== "string"
    ) {
      return null;
    }
    return isEmailAddress(address)
      ? Object.freeze({
          outcome,
          notificationId: id,
          type,
          centerPath: path,
          address,
        })
      : Object.freeze({ outcome: "address_unsupported" });
  }
  if (
    (outcome === "nothing_to_do" ||
      outcome === "no_recipient" ||
      outcome === "not_running") &&
    path === null &&
    address === null &&
    (id === null || isUuid(id)) &&
    (type === null || oneOf(NOTIFICATION_TYPES, type))
  ) {
    return Object.freeze({ outcome });
  }
  return null;
}

// ---------------------------------------------------------------------------
// The job handler (the S2 protocol runs it; MBS section 21)
// ---------------------------------------------------------------------------

export type NotificationJobWiring = {
  // The email adapter's provider code, recorded with every attempt (also
  // when the adapter is not configured).
  readonly providerCode: string;
  readonly provider: () => Promise<EmailProvider | null>;
  readonly recorder: () => Promise<NotificationRecorder | null>;
  // The configured site origin, or null.
  readonly origin: () => string | null;
};

// Thrown so the S2 protocol retries the job with backoff (and escalates it
// once its attempts are used up). It carries no payload, address or provider
// message.
export class NotificationJobRetry extends Error {
  constructor() {
    super("notification delivery attempt did not finish");
    this.name = "NotificationJobRetry";
  }
}

const retry = (): never => {
  throw new NotificationJobRetry();
};

// The recorded outcomes after which the job is finished.
const FINISHED: readonly string[] = Object.freeze([
  "sent",
  "permanently_failed",
  "no_effect",
  "not_running",
]);

async function recorded(
  recorder: NotificationRecorder,
  job: JobRun,
  providerCode: string,
  attempt: DeliveryAttempt,
): Promise<typeof JOB_DONE> {
  if (!isDeliveryAttempt(attempt)) {
    return retry();
  }
  const outcome = await recorder.recordAttempt(
    job.jobId,
    providerCode,
    attempt,
  );
  // retrying: the job protocol tries again after its backoff.
  return FINISHED.includes(outcome) ? JOB_DONE : retry();
}

function deliverHandler(wiring: NotificationJobWiring): JobHandler {
  return async (job: JobRun) => {
    if (!isProviderCode(wiring.providerCode)) {
      return retry();
    }
    const recorder = await wiring.recorder();
    if (recorder === null) {
      return retry();
    }
    const context = notificationJobContextOf(
      await recorder.jobContext(job.jobId),
    );
    if (context === null) {
      return retry();
    }
    if (context.outcome !== "act") {
      if (context.outcome === "no_recipient") {
        return recorded(recorder, job, wiring.providerCode, {
          result: "not_sent",
          failureCode: "recipient_unavailable",
        });
      }
      if (context.outcome === "address_unsupported") {
        return recorded(recorder, job, wiring.providerCode, {
          result: "not_sent",
          failureCode: "recipient_address_unsupported",
        });
      }
      // The Notification is no longer deliverable (or the job no longer
      // runs): nothing is sent.
      return JOB_DONE;
    }
    const provider = await wiring.provider();
    const origin = wiring.origin();
    const centerUrl =
      origin === null ? null : centerUrlOf(origin, context.centerPath);
    if (
      provider === null ||
      provider.providerCode !== wiring.providerCode ||
      centerUrl === null
    ) {
      return recorded(recorder, job, wiring.providerCode, {
        result: "not_sent",
        failureCode: "provider_unconfigured",
      });
    }
    let result: unknown;
    try {
      result = await provider.send(
        emailMessageOf(context.type, context.address, centerUrl),
        emailIdempotencyKeyOf(context.notificationId),
      );
    } catch {
      result = null;
    }
    if (!isEmailSendResult(result)) {
      return recorded(recorder, job, wiring.providerCode, {
        result: "failed_transient",
        failureCode: "provider_error",
      });
    }
    return recorded(
      recorder,
      job,
      wiring.providerCode,
      result.kind === "accepted"
        ? { result: "accepted", reference: result.reference }
        : result.kind === "not_sent"
          ? { result: "not_sent", failureCode: result.failureCode }
          : {
              result:
                result.permanence === "permanent"
                  ? "failed_permanent"
                  : "failed_transient",
              failureCode: result.failureCode,
            },
    );
  };
}

// The notification job handlers, keyed by job type.
export function createNotificationJobHandlers(
  wiring: NotificationJobWiring,
): ReadonlyMap<string, JobHandler> {
  return new Map<string, JobHandler>([
    ["notification.deliver", deliverHandler(wiring)],
  ]);
}

// ---------------------------------------------------------------------------
// Provider events (after the webhook adapter verified authenticity)
// ---------------------------------------------------------------------------

export type NotificationEventHandling = "accepted" | "rejected" | "unavailable";

// Records one authenticated provider event: accepted when the database
// recorded it or already had it (a replay), rejected when it refused the
// event as malformed, unavailable when the answer is unknown (the provider
// delivers again; the receipt key keeps that idempotent).
export async function recordNotificationEvent(
  recorder: NotificationRecorder,
  event: NotificationEvent,
): Promise<NotificationEventHandling> {
  try {
    if (!isNotificationEvent(event)) {
      return "rejected";
    }
    const answer = await recorder.recordEvent(event);
    if (answer.kind !== "answer") {
      return "unavailable";
    }
    return answer.outcome === "invalid" ? "rejected" : "accepted";
  } catch {
    return "unavailable";
  }
}
