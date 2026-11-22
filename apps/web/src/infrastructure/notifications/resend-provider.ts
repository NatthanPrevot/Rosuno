// Server-only Resend email adapter (MVP-001 S10; Packet section 1 "Resend ...
// on fetch + node:crypto; no provider SDK"; MB section 97; ROS section 15;
// IMP section 23 provider security gate).
//
// It translates Rosuno's provider-neutral email operation into Resend's API
// and Resend's webhook events into Rosuno's observation vocabulary; it decides
// nothing about Notification state. Provider-specific calls, credentials,
// webhook authentication and status mappings live only here: the
// notification lifecycle stores the provider code and the provider's message
// reference only. Another email adapter (or another channel) implements the
// same EmailProvider port and the same event mapping in its own module.
//
// Configuration (server-only settings, read through the provider
// configuration reader; names only here):
// - ROSUNO_RESEND_API_KEY: a Resend API key (re_ followed by letters, digits
//   and underscores); a key restricted to sending is enough (status reads are
//   then unavailable and delivery is learned from webhooks only);
// - ROSUNO_EMAIL_FROM: the sender address Resend permits for the account (a
//   bare address; no display name, which the placeholder rule would refuse);
// - ROSUNO_AUTH_PUBLIC_ORIGIN: the site's trusted public origin (the same
//   setting the confirmation route and the payment return URLs use), for the
//   one link an email carries; MVP-001 S11 D9: https outside development;
// - ROSUNO_RESEND_WEBHOOK_SECRET: the webhook endpoint's signing secret
//   (whsec_ followed by the base64 key), read only by the webhook route.
// Anything absent, malformed or a placeholder means email is unavailable: no
// fallback, mock or default exists, and the delivery attempts record not_sent
// provider_unconfigured.
//
// Sending: POST /emails with a JSON body (from, one recipient, subject, text
// and HTML), the key in the Authorization header only, the caller's
// deterministic Idempotency-Key (Resend answers a repeated key with the first
// answer), a bounded time and no redirect. Answers are read strictly into
// neutral results: accepted with Resend's message id, or a transient or
// permanent failure with a fixed failure code. A message the adapter refuses
// itself is never sent and answers not_sent: recipient_address_unsupported
// for a recipient outside the one fixed address rule (isEmailAddress, the
// same rule the database applies; the apostrophe and the other RFC 5322
// atext characters are accepted), invalid_request for anything else. Status
// reads (GET
// /emails/{id}) map the last event into the same vocabulary; a send-only key
// answers 401 restricted_api_key, reported as unavailable (restricted_key).
//
// Webhooks are signed with the Svix scheme: the svix-id, svix-timestamp and
// svix-signature headers; the signed content is "<id>.<timestamp>.<raw body>";
// HMAC-SHA256 with the base64-decoded part of the secret after "whsec_"; the
// header holds one or more space-separated "v1,<base64 signature>" entries,
// any of which may match; the comparison is constant time and the timestamp
// must be within the tolerance (five minutes either way). This follows the
// published Svix scheme Resend documents; the provider's documentation could
// not be fetched from this environment when it was written (see the S10
// report).
//
// No key, address, subject, body, signature or provider payload is ever
// logged or returned.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  isEmailAddress,
  isProviderReference,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
  type NotificationEvent,
  type ObservationKind,
} from "../../application/notifications.ts";
import {
  readProviderConfiguration,
  type ProviderSetting,
} from "../environment/provider-configuration.ts";

export const RESEND_API_ORIGIN = "https://api.resend.com";
// The provider code Rosuno records.
export const RESEND_PROVIDER_CODE = "resend";

export const RESEND_KEY_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_RESEND_API_KEY",
  pattern: /^re_[A-Za-z0-9_]{16,128}$/,
});
export const EMAIL_FROM_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_EMAIL_FROM",
  pattern:
    /^[A-Za-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
});
// MVP-001 S11 D9: outside development the public origin must be https.
const HTTPS_ORIGIN = /^https:\/\//;

export const SITE_ORIGIN_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_AUTH_PUBLIC_ORIGIN",
  pattern: /^https?:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/,
  classPatterns: Object.freeze({
    staging: HTTPS_ORIGIN,
    production: HTTPS_ORIGIN,
  }),
});
export const RESEND_WEBHOOK_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_RESEND_WEBHOOK_SECRET",
  pattern: /^whsec_[A-Za-z0-9+/=]{16,128}$/,
});

type Environment = Readonly<Record<string, string | undefined>>;

export type ResendConfiguration = {
  readonly sendingKey: string;
  readonly from: string;
};

// The sending configuration, or null when email is unavailable.
export function readResendConfiguration(
  environment: Environment = process.env,
): ResendConfiguration | null {
  const configuration = readProviderConfiguration(
    [RESEND_KEY_SETTING, EMAIL_FROM_SETTING],
    environment,
  );
  if (configuration.kind !== "configured") {
    return null;
  }
  const sendingKey = configuration.values[RESEND_KEY_SETTING.name];
  const from = configuration.values[EMAIL_FROM_SETTING.name];
  return typeof sendingKey === "string" && typeof from === "string"
    ? Object.freeze({ sendingKey, from })
    : null;
}

// The site origin for the link an email carries, or null.
export function readSiteOrigin(
  environment: Environment = process.env,
): string | null {
  const configuration = readProviderConfiguration(
    [SITE_ORIGIN_SETTING],
    environment,
  );
  if (configuration.kind !== "configured") {
    return null;
  }
  const origin = configuration.values[SITE_ORIGIN_SETTING.name];
  try {
    return typeof origin === "string" && new URL(origin).origin === origin
      ? origin
      : null;
  } catch {
    return null;
  }
}

// The webhook signing key (the base64-decoded part after "whsec_"), or null
// when the route is unavailable.
export function readResendWebhookSecret(
  environment: Environment = process.env,
): Buffer | null {
  const configuration = readProviderConfiguration(
    [RESEND_WEBHOOK_SETTING],
    environment,
  );
  if (configuration.kind !== "configured") {
    return null;
  }
  const value = configuration.values[RESEND_WEBHOOK_SETTING.name];
  if (typeof value !== "string") {
    return null;
  }
  const encoded = value.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return null;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length >= 16 ? key : null;
}

// ---------------------------------------------------------------------------
// Answers -> neutral results
// ---------------------------------------------------------------------------

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

const transient = (failureCode: string): EmailSendResult =>
  Object.freeze({ kind: "failed", permanence: "transient", failureCode });
const permanent = (failureCode: string): EmailSendResult =>
  Object.freeze({ kind: "failed", permanence: "permanent", failureCode });
const notSent = (
  failureCode: "recipient_address_unsupported" | "invalid_request",
): EmailSendResult => Object.freeze({ kind: "not_sent", failureCode });

// The neutral failure of an error answer: its HTTP status and Resend's error
// name only (the message is never read).
export function sendFailureOf(status: number, body: unknown): EmailSendResult {
  const name = ownField(body, "name");
  if (status === 409) {
    return name === "concurrent_idempotent_requests"
      ? transient("idempotency_in_progress")
      : permanent("idempotency_conflict");
  }
  if (status === 429) {
    return transient("rate_limited");
  }
  if (status >= 500 && status <= 599) {
    return transient("provider_error");
  }
  if (status === 400 || status === 422) {
    return permanent("invalid_request");
  }
  if (status === 401) {
    return permanent("provider_auth");
  }
  if (status >= 400 && status <= 499) {
    return permanent("provider_refused");
  }
  return transient("provider_error");
}

// Resend's message reference in a successful send answer, or null.
export function sentReferenceOf(body: unknown): string | null {
  const id = ownField(body, "id");
  return isProviderReference(id) ? id : null;
}

// The observation kind of a Resend event type or last-event value; bounced
// becomes failed when Resend reports the bounce as transient (a soft bounce).
export function observationKindOf(
  eventName: string,
  bounceType: unknown = undefined,
): ObservationKind {
  switch (eventName) {
    case "sent":
      return "accepted";
    case "delivered":
      return "delivered";
    case "delivery_delayed":
      return "delivery_delayed";
    case "bounced":
      return bounceType === "Transient" ? "failed" : "bounced";
    case "complained":
      return "complained";
    case "failed":
      return "failed";
    case "suppressed":
      return "suppressed";
    default:
      return "ignored";
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export type ResendTransport = typeof fetch;

export type ResendProviderOptions = {
  readonly environment?: Environment;
  // Test doubles only: the local simulated API origin and its transport.
  readonly apiOrigin?: string;
  readonly transport?: ResendTransport;
  readonly timeoutMs?: number;
};

export type DeliveryStatus =
  | { readonly kind: "ok"; readonly observation: ObservationKind }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "unavailable";
      readonly reason: "restricted_key" | "provider_error";
    };

export type ResendProvider = EmailProvider & {
  // The last event Resend reports for one message (a status read).
  readonly deliveryStatus: (reference: string) => Promise<DeliveryStatus>;
};

const CALL_TIMEOUT_MS = 10_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,256}$/;
const SUBJECT_MAX = 200;
const TEXT_MAX = 20_000;

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Builds the provider from the server configuration, or null when email is
// unavailable. The caller's options only replace the API origin and the
// transport in tests.
export function createResendEmailProvider(
  options: ResendProviderOptions = {},
): ResendProvider | null {
  const configuration = readResendConfiguration(options.environment);
  if (configuration === null) {
    return null;
  }
  const origin = options.apiOrigin ?? RESEND_API_ORIGIN;
  const transport: ResendTransport = options.transport ?? fetch;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const authorization = `Bearer ${configuration.sendingKey}`;

  const send = async (
    message: EmailMessage,
    idempotencyKey: string,
  ): Promise<EmailSendResult> => {
    if (!isEmailAddress(message?.to)) {
      return notSent("recipient_address_unsupported");
    }
    if (
      typeof message.subject !== "string" ||
      message.subject.length < 1 ||
      message.subject.length > SUBJECT_MAX ||
      typeof message.text !== "string" ||
      message.text.length < 1 ||
      message.text.length > TEXT_MAX ||
      typeof message.html !== "string" ||
      message.html.length < 1 ||
      message.html.length > TEXT_MAX ||
      typeof idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      return notSent("invalid_request");
    }
    try {
      const response = await transport(`${origin}/emails`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          from: configuration.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await bodyOf(response);
      if (response.status === 200) {
        const reference = sentReferenceOf(body);
        return reference === null
          ? transient("malformed_answer")
          : Object.freeze({ kind: "accepted", reference });
      }
      return sendFailureOf(response.status, body);
    } catch {
      return transient("network");
    }
  };

  const deliveryStatus = async (reference: string): Promise<DeliveryStatus> => {
    const unavailable: DeliveryStatus = Object.freeze({
      kind: "unavailable",
      reason: "provider_error",
    });
    if (
      !isProviderReference(reference) ||
      !/^[A-Za-z0-9_-]+$/.test(reference)
    ) {
      return unavailable;
    }
    try {
      const response = await transport(`${origin}/emails/${reference}`, {
        method: "GET",
        headers: { authorization },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await bodyOf(response);
      if (response.status === 200) {
        const last = ownField(body, "last_event");
        return typeof last === "string" && /^[a-z_]{1,40}$/.test(last)
          ? Object.freeze({ kind: "ok", observation: observationKindOf(last) })
          : unavailable;
      }
      if (response.status === 404) {
        return Object.freeze({ kind: "not_found" });
      }
      if (
        response.status === 401 &&
        ownField(body, "name") === "restricted_api_key"
      ) {
        return Object.freeze({ kind: "unavailable", reason: "restricted_key" });
      }
      return unavailable;
    } catch {
      return unavailable;
    }
  };

  return Object.freeze({
    providerCode: RESEND_PROVIDER_CODE,
    send,
    deliveryStatus,
  });
}

// ---------------------------------------------------------------------------
// Webhook authenticity (the Svix scheme)
// ---------------------------------------------------------------------------

export const SIGNATURE_TOLERANCE_SECONDS = 300;
const HEADER_MAX = 2048;
const MESSAGE_ID = /^[A-Za-z0-9_]{3,255}$/;
const SIGNATURE_ENTRY = /^v1,([A-Za-z0-9+/]{43}=)$/;

// Whether the three Svix headers authenticate exactly this raw body.
export function verifyResendSignature(
  rawBody: Uint8Array,
  messageId: string | null,
  timestamp: string | null,
  signatures: string | null,
  secret: Buffer,
  nowMs: number,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (
    !(rawBody instanceof Uint8Array) ||
    typeof messageId !== "string" ||
    typeof timestamp !== "string" ||
    typeof signatures !== "string" ||
    messageId.length > HEADER_MAX ||
    timestamp.length > HEADER_MAX ||
    signatures.length > HEADER_MAX ||
    !MESSAGE_ID.test(messageId) ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    !Buffer.isBuffer(secret) ||
    secret.length < 16 ||
    !Number.isSafeInteger(nowMs)
  ) {
    return false;
  }
  if (Math.abs(nowMs - Number(timestamp) * 1000) > toleranceSeconds * 1000) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${messageId}.${timestamp}.`, "utf8")
    .update(rawBody)
    .digest();
  const entries = signatures.split(" ").filter((entry) => entry !== "");
  if (entries.length === 0 || entries.length > 10) {
    return false;
  }
  let matched = false;
  for (const entry of entries) {
    const signature = SIGNATURE_ENTRY.exec(entry)?.[1];
    if (signature === undefined) {
      // Another scheme version: not ours to judge.
      continue;
    }
    const presented = Buffer.from(signature, "base64");
    // Every v1 entry is compared, so the timing does not tell which matched.
    if (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    ) {
      matched = true;
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Events -> observations (provider facts become Rosuno observations, never
// Rosuno state)
// ---------------------------------------------------------------------------

export type ResendEventReading =
  | {
      readonly kind: "event";
      // "expected" when the event had the shape its type documents.
      readonly shape: "expected" | "unexpected";
      readonly event: NotificationEvent;
    }
  | { readonly kind: "none" };

const EVENT_TYPE = /^[a-z][a-z0-9_.]{2,99}$/;

function instantOf(value: unknown, fallbackMs: number): string {
  if (typeof value === "string" && value.length <= 64) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString();
    }
  }
  return new Date(fallbackMs).toISOString();
}

// One verified delivery as one provider-neutral event: the observation kind
// of its type and Resend's message reference only (never an address,
// subject, tag or body). A handled type without a well-formed reference is
// recorded as an ignored observation (its receipt, no state).
export function resendEventOf(
  rawBody: Uint8Array,
  messageId: string,
  timestamp: string,
): ResendEventReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return Object.freeze({ kind: "none" });
  }
  const type = ownField(parsed, "type");
  if (
    typeof type !== "string" ||
    !EVENT_TYPE.test(type) ||
    !MESSAGE_ID.test(messageId) ||
    !/^[0-9]{1,12}$/.test(timestamp)
  ) {
    return Object.freeze({ kind: "none" });
  }
  const data = ownField(parsed, "data");
  const name = type.startsWith("email.") ? type.slice("email.".length) : "";
  const kind = observationKindOf(
    name,
    ownField(ownField(data, "bounce"), "type"),
  );
  const reference = ownField(data, "email_id");
  const referenced = isProviderReference(reference);
  const ignored = kind === "ignored" || !referenced;
  const event: NotificationEvent = Object.freeze({
    providerCode: RESEND_PROVIDER_CODE,
    eventReference: messageId,
    eventType: type,
    occurredAt: instantOf(
      ownField(parsed, "created_at"),
      Number(timestamp) * 1000,
    ),
    payloadDigest: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
    observation: Object.freeze(
      ignored
        ? { kind: "ignored" as const, provider_reference: null }
        : { kind, provider_reference: reference as string },
    ),
  });
  return Object.freeze({
    kind: "event",
    shape: kind !== "ignored" && !referenced ? "unexpected" : "expected",
    event,
  });
}
