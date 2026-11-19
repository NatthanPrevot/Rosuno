// Server-only Resend webhook handling (MVP-001 S10; IMP section 23 provider
// security gate; Packet section 2 rule 12; PS section 23; ROS section 15).
//
// Order, for every delivery: the raw body is read as bytes, at most
// WEBHOOK_BODY_MAX of them (413 beyond); the configured webhook secret is
// required (503 without it); the svix-id, svix-timestamp and svix-signature
// headers must authenticate exactly that body (HMAC-SHA256 with the decoded
// secret, constant time, within the timestamp tolerance) or it is refused
// (400) with no database write. An authenticated delivery is never answered
// with an error for its content (repeated non-2xx answers can make the
// provider disable the endpoint): its event is recorded through the
// server-only notification recording port, receipt first and unique per
// event (the svix-id), so a replay is a no-op; an event of an unhandled type
// or a handled type with an unexpected shape is recorded as an ignored
// observation (its receipt, no state); a body that is not an event, or one
// the database refuses, changes nothing; each answers 200 with one log line
// naming a fixed outcome. Only an unknown recording answer (or an unbound
// recorder) is 503, so the provider delivers again.
//
// Each refusal writes one log line naming only the outcome; nothing the
// request carried (no header, signature, body, identifier, address or
// provider message) is logged or echoed, and every answer is a fixed body.

import {
  recordNotificationEvent,
  type NotificationRecorder,
} from "../../application/notifications.ts";
import { createNotificationRecorder } from "../identity/registration-provisioning.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  readResendWebhookSecret,
  resendEventOf,
  verifyResendSignature,
} from "./resend-provider.ts";

// Email events are small; anything larger is refused before it is read.
export const WEBHOOK_BODY_MAX = 64 * 1024;

export type ResendWebhookResponse = {
  readonly status: 200 | 400 | 413 | 503;
  readonly body: Readonly<Record<string, string>>;
};

export type ResendWebhookSources = {
  readonly secret: () => Buffer | null;
  readonly recorder: () => Promise<NotificationRecorder | null>;
  readonly clock: () => number;
};

export const RESEND_WEBHOOK_SOURCES: ResendWebhookSources = Object.freeze({
  secret: () => readResendWebhookSecret(),
  recorder: () => createNotificationRecorder(),
  clock: () => Date.now(),
});

const RESPONSES = Object.freeze({
  received: Object.freeze({
    status: 200,
    body: Object.freeze({ status: "received" }),
  }),
  invalid: Object.freeze({
    status: 400,
    body: Object.freeze({ status: "invalid" }),
  }),
  tooLarge: Object.freeze({
    status: 413,
    body: Object.freeze({ status: "too_large" }),
  }),
  unavailable: Object.freeze({
    status: 503,
    body: Object.freeze({ status: "unavailable" }),
  }),
} satisfies Record<string, ResendWebhookResponse>);

const TOO_LARGE = Symbol("too large");

// The raw body bytes, at most the bound, or TOO_LARGE / null.
async function rawBodyOf(
  request: Request,
): Promise<Uint8Array | typeof TOO_LARGE | null> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]{1,9}$/.test(declared) || Number(declared) > WEBHOOK_BODY_MAX)
  ) {
    return TOO_LARGE;
  }
  if (request.body === null) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > WEBHOOK_BODY_MAX) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function refuse(
  response: ResendWebhookResponse,
  outcome: string,
): Promise<ResendWebhookResponse> {
  await logRequestEvent("warn", "notification.webhook_refused", { outcome });
  return response;
}

// Decides one webhook delivery. It never throws.
export async function handleResendWebhook(
  request: Request,
  sources: ResendWebhookSources = RESEND_WEBHOOK_SOURCES,
): Promise<ResendWebhookResponse> {
  try {
    const body = await rawBodyOf(request);
    if (body === TOO_LARGE) {
      return await refuse(RESPONSES.tooLarge, "too_large");
    }
    const signingKey = sources.secret();
    if (signingKey === null) {
      return await refuse(RESPONSES.unavailable, "unconfigured");
    }
    if (body === null) {
      return await refuse(RESPONSES.invalid, "no_body");
    }
    const messageId = request.headers.get("svix-id");
    const timestamp = request.headers.get("svix-timestamp");
    if (
      !verifyResendSignature(
        body,
        messageId,
        timestamp,
        request.headers.get("svix-signature"),
        signingKey,
        sources.clock(),
      ) ||
      messageId === null ||
      timestamp === null
    ) {
      return await refuse(RESPONSES.invalid, "signature_invalid");
    }
    const reading = resendEventOf(body, messageId, timestamp);
    if (reading.kind !== "event") {
      await logRequestEvent("warn", "notification.webhook_unprocessable", {
        outcome: "no_event",
      });
      return RESPONSES.received;
    }
    const recorder = await sources.recorder();
    if (recorder === null) {
      return await refuse(RESPONSES.unavailable, "unbound");
    }
    const handling = await recordNotificationEvent(recorder, reading.event);
    if (handling === "rejected") {
      await logRequestEvent("warn", "notification.webhook_unprocessable", {
        outcome: "rejected",
      });
      return RESPONSES.received;
    }
    if (handling === "unavailable") {
      return await refuse(RESPONSES.unavailable, "not_recorded");
    }
    if (reading.shape === "unexpected") {
      await logRequestEvent("warn", "notification.webhook_unprocessable", {
        outcome: "unexpected_shape",
      });
    } else {
      await logRequestEvent("info", "notification.webhook_recorded", {
        outcome: "recorded",
      });
    }
    return RESPONSES.received;
  } catch {
    return RESPONSES.unavailable;
  }
}
