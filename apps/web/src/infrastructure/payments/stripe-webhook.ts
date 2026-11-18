// Server-only Stripe webhook handling (MVP-001 S7; IMP section 23 provider
// security gate; Packet section 2 rule 12; PS sections 23 and 34; TA section
// 53).
//
// Order, for every delivery: the route is unavailable (503, nothing read)
// without the configured signing secret; the raw body is read as bytes, at
// most WEBHOOK_BODY_MAX of them (413 beyond); the Stripe-Signature header must
// authenticate exactly those bytes (HMAC-SHA256, any v1, constant time,
// within the timestamp tolerance) or the delivery is refused (400) with no
// database write; the verified body must be a test-mode Stripe event of the
// expected shape (400 otherwise; live mode is excluded from S7); only then is
// the event recorded through the server-only recording port, receipt first
// and unique per event, so a replay is a no-op. A recorded or duplicate event
// answers 200; an unknown recording answer 503, so Stripe delivers again.
// After a recorded event one bounded worker run is scheduled after the
// response, so a release, refund or reconciliation the event caused usually
// follows at once (nothing depends on it).
//
// Each refusal writes one log line naming only the outcome; nothing the
// request carried (no header, signature, body, identifier or provider
// message) is logged or echoed, and every answer is a fixed body.

import {
  recordProviderEvent,
  type PaymentRecorder,
} from "../../application/payments.ts";
import { createPaymentRecorder } from "../identity/registration-provisioning.ts";
import { scheduleJobDrainAfterCommit } from "../jobs/after-commit.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  readStripeWebhookSecret,
  stripeEventOf,
  verifyStripeSignature,
} from "./stripe-provider.ts";

// Stripe events are small; anything larger is refused before it is read.
export const WEBHOOK_BODY_MAX = 512 * 1024;

export type WebhookResponse = {
  readonly status: 200 | 400 | 413 | 503;
  readonly body: Readonly<Record<string, string>>;
};

export type WebhookSources = {
  readonly secret: () => string | null;
  readonly recorder: () => Promise<PaymentRecorder | null>;
  readonly clock: () => number;
  readonly afterResponse: () => Promise<boolean>;
};

export const WEBHOOK_SOURCES: WebhookSources = Object.freeze({
  secret: () => readStripeWebhookSecret(),
  recorder: () => createPaymentRecorder(),
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
} satisfies Record<string, WebhookResponse>);

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
  response: WebhookResponse,
  outcome: string,
): Promise<WebhookResponse> {
  await logRequestEvent("warn", "payments.webhook_refused", { outcome });
  return response;
}

// Decides one webhook delivery. It never throws.
export async function handleStripeWebhook(
  request: Request,
  sources: WebhookSources = WEBHOOK_SOURCES,
): Promise<WebhookResponse> {
  try {
    const signingKey = sources.secret();
    if (signingKey === null) {
      return await refuse(RESPONSES.unavailable, "unconfigured");
    }
    const body = await rawBodyOf(request);
    if (body === TOO_LARGE) {
      return await refuse(RESPONSES.tooLarge, "too_large");
    }
    if (body === null) {
      return await refuse(RESPONSES.invalid, "no_body");
    }
    if (
      !verifyStripeSignature(
        body,
        request.headers.get("stripe-signature"),
        signingKey,
        Math.floor(sources.clock() / 1000),
      )
    ) {
      return await refuse(RESPONSES.invalid, "signature_invalid");
    }
    const event = stripeEventOf(body);
    if (event === null) {
      return await refuse(RESPONSES.invalid, "event_invalid");
    }
    const recorder = await sources.recorder();
    if (recorder === null) {
      return await refuse(RESPONSES.unavailable, "unbound");
    }
    const handling = await recordProviderEvent(recorder, event);
    if (handling === "rejected") {
      return await refuse(RESPONSES.invalid, "event_rejected");
    }
    if (handling === "unavailable") {
      return await refuse(RESPONSES.unavailable, "not_recorded");
    }
    await logRequestEvent("info", "payments.webhook_recorded", {
      outcome: "recorded",
    });
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
