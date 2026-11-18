// Server-only Daily webhook handling (MVP-001 S9; IMP section 23 provider
// security gate; Packet section 2 rule 12; PS sections 23 and 34; TA section
// 53).
//
// Order, for every delivery: the raw body is read as bytes, at most
// WEBHOOK_BODY_MAX of them (413 beyond); Daily's endpoint verification ping
// (exactly {"test": "test"}, which Daily may send unsigned when a webhook is
// created) is answered 200 with no receipt, no recording and no other effect,
// signed or not and with or without the configured secret; every other
// delivery needs the configured webhook secret (503 without it) and the
// X-Webhook-Signature and X-Webhook-Timestamp headers must authenticate
// exactly that body (HMAC-SHA256 with the base64-decoded secret, constant
// time, within the timestamp tolerance) or it is refused (400) with no
// database write. An authenticated delivery is never answered with an error
// for its content (repeated non-2xx answers can make Daily disable the
// webhook): an event is recorded through the server-only media recording port,
// receipt first and unique per event, so a replay is a no-op (a handled event
// type whose payload has an unexpected shape is recorded as an ignored
// observation: its receipt, no state); a body that names no recordable event,
// or one the database refuses, changes nothing; each answers 200 with one log
// line naming a fixed outcome. Only an unknown recording answer is 503, so
// Daily delivers again. After a recorded event one bounded worker run is
// scheduled after the response, so the observation job a participant event
// enqueued usually follows at once (nothing depends on it).
//
// Each refusal writes one log line naming only the outcome; nothing the
// request carried (no header, signature, body, identifier or provider
// message) is logged or echoed, and every answer is a fixed body.

import {
  recordMediaEvent,
  type MediaRecorder,
} from "../../application/media-provider.ts";
import { createMediaRecorder } from "../identity/registration-provisioning.ts";
import { scheduleJobDrainAfterCommit } from "../jobs/after-commit.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  dailyEventOf,
  isDailyVerificationPing,
  readDailyWebhookSecret,
  verifyDailySignature,
} from "./daily-provider.ts";

// Daily events are small; anything larger is refused before it is read.
export const WEBHOOK_BODY_MAX = 64 * 1024;

export type DailyWebhookResponse = {
  readonly status: 200 | 400 | 413 | 503;
  readonly body: Readonly<Record<string, string>>;
};

export type DailyWebhookSources = {
  readonly secret: () => Buffer | null;
  readonly recorder: () => Promise<MediaRecorder | null>;
  readonly clock: () => number;
  readonly afterResponse: () => Promise<boolean>;
};

export const DAILY_WEBHOOK_SOURCES: DailyWebhookSources = Object.freeze({
  secret: () => readDailyWebhookSecret(),
  recorder: () => createMediaRecorder(),
  clock: () => Date.now(),
  afterResponse: () => scheduleJobDrainAfterCommit(),
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
} satisfies Record<string, DailyWebhookResponse>);

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
  response: DailyWebhookResponse,
  outcome: string,
): Promise<DailyWebhookResponse> {
  await logRequestEvent("warn", "media.webhook_refused", { outcome });
  return response;
}

// Decides one webhook delivery. It never throws.
export async function handleDailyWebhook(
  request: Request,
  sources: DailyWebhookSources = DAILY_WEBHOOK_SOURCES,
): Promise<DailyWebhookResponse> {
  try {
    const body = await rawBodyOf(request);
    if (body === TOO_LARGE) {
      return await refuse(RESPONSES.tooLarge, "too_large");
    }
    if (body !== null && isDailyVerificationPing(body)) {
      await logRequestEvent("info", "media.webhook_check", {
        outcome: "ping",
      });
      return RESPONSES.received;
    }
    const signingKey = sources.secret();
    if (signingKey === null) {
      return await refuse(RESPONSES.unavailable, "unconfigured");
    }
    if (body === null) {
      return await refuse(RESPONSES.invalid, "no_body");
    }
    if (
      !verifyDailySignature(
        body,
        request.headers.get("x-webhook-timestamp"),
        request.headers.get("x-webhook-signature"),
        signingKey,
        sources.clock(),
      )
    ) {
      return await refuse(RESPONSES.invalid, "signature_invalid");
    }
    const reading = dailyEventOf(body);
    if (reading.kind === "check") {
      await logRequestEvent("info", "media.webhook_check", {
        outcome: "verified",
      });
      return RESPONSES.received;
    }
    if (reading.kind !== "event") {
      await logRequestEvent("warn", "media.webhook_unprocessable", {
        outcome: "no_event",
      });
      return RESPONSES.received;
    }
    const recorder = await sources.recorder();
    if (recorder === null) {
      return await refuse(RESPONSES.unavailable, "unbound");
    }
    const handling = await recordMediaEvent(recorder, reading.event);
    if (handling === "rejected") {
      await logRequestEvent("warn", "media.webhook_unprocessable", {
        outcome: "rejected",
      });
      return RESPONSES.received;
    }
    if (handling === "unavailable") {
      return await refuse(RESPONSES.unavailable, "not_recorded");
    }
    if (reading.shape === "unexpected") {
      await logRequestEvent("warn", "media.webhook_unprocessable", {
        outcome: "unexpected_shape",
      });
    } else {
      await logRequestEvent("info", "media.webhook_recorded", {
        outcome: "recorded",
      });
    }
    try {
      await sources.afterResponse();
    } catch {
      // The worker route drains the backlog later.
    }
    return RESPONSES.received;
  } catch {
    return RESPONSES.unavailable;
  }
}
