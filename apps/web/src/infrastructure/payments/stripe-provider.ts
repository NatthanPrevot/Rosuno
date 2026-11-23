// Server-only Stripe adapter (MVP-001 S7; Packet section 1 "Stripe (test
// mode) ... on fetch + node:crypto; no provider SDK"; TA section 16.1; IMP
// sections 3 and 23; PS section 38).
//
// It translates Rosuno's provider-neutral payment operations into Stripe API
// calls and Stripe events into Rosuno observations; it decides nothing about
// Rosuno state. Card data never reaches Rosuno: the client authorizes on
// Stripe's hosted Checkout page (a Checkout Session in payment mode whose
// PaymentIntent uses manual capture), and Rosuno stores only Stripe object
// references.
//
// Configuration (server-only settings, read through the provider
// configuration reader; names only here):
// - ROSUNO_STRIPE_SECRET_KEY: a Stripe test-mode secret or restricted key
//   (sk_test_ or rk_test_). Live keys are excluded from S7 entirely and are
//   refused in every environment class; MVP-001 S11 D1: in a production
//   class the test-mode key is refused too, so payments are unavailable there
//   until live mode is separately authorized;
// - ROSUNO_AUTH_PUBLIC_ORIGIN: the site's trusted public origin (the same
//   setting the confirmation route uses), for Checkout's return URLs;
//   MVP-001 S11 D9: https outside development;
// - ROSUNO_STRIPE_WEBHOOK_SECRET: the webhook endpoint's signing secret
//   (whsec_), read only by the webhook route; MVP-001 S11 D1: refused in a
//   production class, so no test-mode event is recorded there.
// Anything absent, malformed or a placeholder means payments are
// unavailable: no fallback, mock or default exists.
//
// Every API call: POST with a form-encoded body (or GET), the pinned
// Stripe-Version, a bounded time, and on every POST the caller's
// deterministic Idempotency-Key. Answers are read strictly into neutral
// results (ok, declined, invalid_state, not_found, rejected, transient). No
// key, card detail, provider message or raw payload is ever logged or
// returned.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  isAmountMinor,
  isCurrencyCode,
  isObservation,
  isProviderReference,
  type CheckoutInput,
  type CheckoutView,
  type Observation,
  type PaymentProvider,
  type PaymentView,
  type ProviderEvent,
  type ProviderPaymentStatus,
  type ProviderResult,
  type RefundInput,
  type RefundView,
} from "../../application/payments.ts";
import { isUuid } from "../../application/professional-records.ts";
import {
  readProviderConfiguration,
  type ProviderSetting,
} from "../environment/provider-configuration.ts";

// The pinned API version (Checkout creates the PaymentIntent when the client
// confirms; payment_intent is null on an open session).
export const STRIPE_API_VERSION = "2024-06-20";
export const STRIPE_API_ORIGIN = "https://api.stripe.com";
export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com/";
// The provider code Rosuno records.
export const STRIPE_PROVIDER_CODE = "stripe";
// The metadata keys Rosuno sets (identifiers only).
export const PAYMENT_METADATA_KEY = "rosuno_payment_transaction";
export const REFUND_METADATA_KEY = "rosuno_refund_request";

// MVP-001 S11 D1: no value matches in a production class. Test mode is
// refused there and live mode is not authorized, so in production payments
// report unavailable and the webhook route refuses every delivery (no
// test-mode event is recorded) until live mode is separately authorized.
const REFUSED_IN_CLASS = /(?!)/;

// MVP-001 S11 D9: outside development the public origin must be https.
const HTTPS_ORIGIN = /^https:\/\//;

export const STRIPE_SECRET_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_STRIPE_SECRET_KEY",
  pattern: /^(?:sk|rk)_test_[A-Za-z0-9]{16,247}$/,
  classPatterns: Object.freeze({ production: REFUSED_IN_CLASS }),
});
export const PUBLIC_ORIGIN_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_AUTH_PUBLIC_ORIGIN",
  pattern: /^https?:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/,
  classPatterns: Object.freeze({
    staging: HTTPS_ORIGIN,
    production: HTTPS_ORIGIN,
  }),
});
export const STRIPE_WEBHOOK_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_STRIPE_WEBHOOK_SECRET",
  pattern: /^whsec_[A-Za-z0-9+/=]{16,128}$/,
  classPatterns: Object.freeze({ production: REFUSED_IN_CLASS }),
});

// Whether a key is a test-mode key (the only kind S7 accepts).
export function isTestModeKey(key: unknown): key is string {
  return typeof key === "string" && STRIPE_SECRET_SETTING.pattern.test(key);
}

type Environment = Readonly<Record<string, string | undefined>>;

export type StripeApiConfiguration = {
  readonly secretKey: string;
  readonly origin: string;
};

// The API configuration, or null when payments are unavailable.
export function readStripeApiConfiguration(
  environment: Environment = process.env,
): StripeApiConfiguration | null {
  const configuration = readProviderConfiguration(
    [STRIPE_SECRET_SETTING, PUBLIC_ORIGIN_SETTING],
    environment,
  );
  if (configuration.kind !== "configured") {
    return null;
  }
  const secretKey = configuration.values[STRIPE_SECRET_SETTING.name];
  const origin = configuration.values[PUBLIC_ORIGIN_SETTING.name];
  try {
    if (
      typeof secretKey !== "string" ||
      typeof origin !== "string" ||
      new URL(origin).origin !== origin
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({ secretKey, origin });
}

// The webhook signing secret, or null when the route is unavailable.
export function readStripeWebhookSecret(
  environment: Environment = process.env,
): string | null {
  const configuration = readProviderConfiguration(
    [STRIPE_WEBHOOK_SETTING],
    environment,
  );
  if (configuration.kind !== "configured") {
    return null;
  }
  const signingKey = configuration.values[STRIPE_WEBHOOK_SETTING.name];
  return typeof signingKey === "string" ? signingKey : null;
}

// ---------------------------------------------------------------------------
// Form encoding
// ---------------------------------------------------------------------------

export type FormParameters = Readonly<Record<string, string | number>>;

// application/x-www-form-urlencoded with Stripe's bracketed nested keys; the
// keys are written by this module, never taken from input.
export function formEncode(parameters: FormParameters): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    body.append(key, String(value));
  }
  return body.toString();
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

// The invalid_request_error codes that mean "not in a state for this".
const INVALID_STATE_CODES = Object.freeze([
  "payment_intent_unexpected_state",
  "charge_already_captured",
  "charge_already_refunded",
  "charge_disputed",
  "charge_expired_for_capture",
  "checkout_session_not_open",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// An error answer's neutral kind.
export function errorKindOf(
  status: number,
  body: unknown,
): Exclude<ProviderResult<never>["kind"], "ok"> {
  if (status === 402) {
    return "declined";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409 || status === 429 || status >= 500) {
    return "transient";
  }
  if (status === 400) {
    const error = isRecord(body) ? body.error : undefined;
    const type = isRecord(error) ? error.type : undefined;
    const code = isRecord(error) ? error.code : undefined;
    if (type === "card_error") {
      return "declined";
    }
    if (
      type === "invalid_request_error" &&
      INVALID_STATE_CODES.includes(code as string)
    ) {
      return "invalid_state";
    }
    return "rejected";
  }
  return "rejected";
}

const CHECKOUT_STATUSES = Object.freeze(["open", "complete", "expired"]);

export function checkoutOf(body: unknown): CheckoutView | null {
  if (!isRecord(body) || body.object !== "checkout.session") {
    return null;
  }
  const intent = isRecord(body.payment_intent)
    ? body.payment_intent.id
    : body.payment_intent;
  const url = body.url;
  if (
    !isProviderReference(body.id) ||
    !CHECKOUT_STATUSES.includes(body.status as string) ||
    !(intent === null || intent === undefined || isProviderReference(intent)) ||
    !(url === null || url === undefined || typeof url === "string")
  ) {
    return null;
  }
  return Object.freeze({
    reference: body.id,
    status: body.status as CheckoutView["status"],
    paymentReference: (intent ?? null) as string | null,
    url:
      typeof url === "string" && url.startsWith(STRIPE_CHECKOUT_ORIGIN)
        ? url
        : null,
  });
}

function paymentStatusOf(status: unknown): ProviderPaymentStatus | null {
  switch (status) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
      return "requires_payment";
    case "processing":
      return "processing";
    case "requires_capture":
      return "requires_capture";
    case "succeeded":
      return "succeeded";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

function currencyOf(value: unknown): string | null {
  return typeof value === "string" && /^[a-z]{3}$/.test(value)
    ? value.toUpperCase()
    : null;
}

export function paymentOf(body: unknown): PaymentView | null {
  if (!isRecord(body) || body.object !== "payment_intent") {
    return null;
  }
  const status = paymentStatusOf(body.status);
  const currency = currencyOf(body.currency);
  const charge = isRecord(body.latest_charge) ? body.latest_charge : null;
  const refunded = charge === null ? 0 : charge.amount_refunded;
  if (
    !isProviderReference(body.id) ||
    status === null ||
    currency === null ||
    !isAmountMinor(body.amount) ||
    !isAmountMinor(body.amount_capturable) ||
    !isAmountMinor(body.amount_received) ||
    !isAmountMinor(refunded)
  ) {
    return null;
  }
  return Object.freeze({
    reference: body.id,
    status,
    amountMinor: body.amount,
    amountCapturableMinor: body.amount_capturable,
    amountReceivedMinor: body.amount_received,
    amountRefundedMinor: refunded as number,
    currency,
  });
}

export function refundOf(body: unknown): RefundView | null {
  if (!isRecord(body) || body.object !== "refund") {
    return null;
  }
  const status =
    body.status === "requires_action" ? "pending" : (body.status as string);
  if (
    !isProviderReference(body.id) ||
    !["pending", "succeeded", "failed", "canceled"].includes(status) ||
    !isAmountMinor(body.amount)
  ) {
    return null;
  }
  return Object.freeze({
    reference: body.id,
    status: status as RefundView["status"],
    amountMinor: body.amount,
  });
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export type StripeTransport = typeof fetch;

export type StripeProviderOptions = {
  readonly environment?: Environment;
  // Test doubles only: the local simulated API origin and its transport.
  readonly apiOrigin?: string;
  readonly transport?: StripeTransport;
  readonly timeoutMs?: number;
};

const CALL_TIMEOUT_MS = 10_000;
const TRANSIENT = Object.freeze({ kind: "transient" } as const);

const ID_PATH = /^[A-Za-z0-9_]{3,255}$/;

type Reader<T> = (body: unknown) => T | null;

// Builds the provider from the server configuration, or null when payments
// are unavailable. The caller's options only replace the API origin and the
// transport in tests.
export function createStripeProvider(options: StripeProviderOptions = {}):
  | (PaymentProvider & {
      readonly checkoutUrl: (reference: string) => Promise<string | null>;
    })
  | null {
  const read = readStripeApiConfiguration(options.environment);
  if (read === null) {
    return null;
  }
  const configuration: StripeApiConfiguration = read;
  const origin = options.apiOrigin ?? STRIPE_API_ORIGIN;
  const transport: StripeTransport = options.transport ?? fetch;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    read: Reader<T>,
    parameters: FormParameters | null,
    idempotencyKey: string | null,
  ): Promise<ProviderResult<T>> {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${configuration.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
      };
      if (method === "POST") {
        headers["content-type"] = "application/x-www-form-urlencoded";
        if (idempotencyKey !== null) {
          headers["idempotency-key"] = idempotencyKey;
        }
      }
      const response = await transport(`${origin}${path}`, {
        method,
        headers,
        body: method === "POST" ? formEncode(parameters ?? {}) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.status === 200) {
        const value = read(body);
        return value === null
          ? TRANSIENT
          : Object.freeze({ kind: "ok", value });
      }
      return Object.freeze({ kind: errorKindOf(response.status, body) });
    } catch {
      return TRANSIENT;
    }
  }

  const idOk = (reference: string) => ID_PATH.test(reference);
  const REJECTED = Object.freeze({ kind: "rejected" } as const);

  const provider = {
    createCheckout: async (input: CheckoutInput, idempotencyKey: string) => {
      if (
        !isUuid(input.paymentId) ||
        !isUuid(input.requestId) ||
        !isAmountMinor(input.amountMinor) ||
        input.amountMinor < 1 ||
        !isCurrencyCode(input.currency) ||
        !Number.isSafeInteger(input.expiresAt)
      ) {
        return REJECTED;
      }
      const returnUrl = `${configuration.origin}/client/requests/${input.requestId}`;
      return call(
        "POST",
        "/v1/checkout/sessions",
        checkoutOf,
        {
          mode: "payment",
          "line_items[0][price_data][currency]": input.currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": input.amountMinor,
          "line_items[0][price_data][product_data][name]": "Consultation",
          "line_items[0][quantity]": 1,
          "payment_intent_data[capture_method]": "manual",
          [`payment_intent_data[metadata][${PAYMENT_METADATA_KEY}]`]:
            input.paymentId,
          [`metadata[${PAYMENT_METADATA_KEY}]`]: input.paymentId,
          client_reference_id: input.paymentId,
          success_url: returnUrl,
          cancel_url: returnUrl,
          expires_at: input.expiresAt,
        },
        idempotencyKey,
      );
    },
    retrieveCheckout: async (reference: string) =>
      idOk(reference)
        ? call(
            "GET",
            `/v1/checkout/sessions/${reference}`,
            checkoutOf,
            null,
            null,
          )
        : REJECTED,
    expireCheckout: async (reference: string, idempotencyKey: string) =>
      idOk(reference)
        ? call(
            "POST",
            `/v1/checkout/sessions/${reference}/expire`,
            checkoutOf,
            {},
            idempotencyKey,
          )
        : REJECTED,
    retrievePayment: async (reference: string) =>
      idOk(reference)
        ? call(
            "GET",
            `/v1/payment_intents/${reference}?expand%5B%5D=latest_charge`,
            paymentOf,
            null,
            null,
          )
        : REJECTED,
    capturePayment: async (
      reference: string,
      amountMinor: number,
      idempotencyKey: string,
    ) =>
      idOk(reference) && isAmountMinor(amountMinor) && amountMinor >= 1
        ? call(
            "POST",
            `/v1/payment_intents/${reference}/capture`,
            paymentOf,
            { amount_to_capture: amountMinor },
            idempotencyKey,
          )
        : REJECTED,
    cancelPayment: async (reference: string, idempotencyKey: string) =>
      idOk(reference)
        ? call(
            "POST",
            `/v1/payment_intents/${reference}/cancel`,
            paymentOf,
            {},
            idempotencyKey,
          )
        : REJECTED,
    createRefund: async (input: RefundInput, idempotencyKey: string) =>
      isUuid(input.paymentId) &&
      isUuid(input.refundRequestId) &&
      idOk(input.paymentReference) &&
      isAmountMinor(input.amountMinor) &&
      input.amountMinor >= 1
        ? call(
            "POST",
            "/v1/refunds",
            refundOf,
            {
              payment_intent: input.paymentReference,
              amount: input.amountMinor,
              [`metadata[${PAYMENT_METADATA_KEY}]`]: input.paymentId,
              [`metadata[${REFUND_METADATA_KEY}]`]: input.refundRequestId,
            },
            idempotencyKey,
          )
        : REJECTED,
    retrieveRefund: async (reference: string) =>
      idOk(reference)
        ? call("GET", `/v1/refunds/${reference}`, refundOf, null, null)
        : REJECTED,
    // The hosted page of an open checkout, or null.
    checkoutUrl: async (reference: string) => {
      const checkout = await provider.retrieveCheckout(reference);
      return checkout.kind === "ok" && checkout.value.status === "open"
        ? checkout.value.url
        : null;
    },
  };
  return Object.freeze(provider);
}

// ---------------------------------------------------------------------------
// Webhook authenticity (IMP section 23 provider security gate)
// ---------------------------------------------------------------------------

export const SIGNATURE_TOLERANCE_SECONDS = 300;
const SIGNATURE_HEADER_MAX = 2048;

// Whether a Stripe-Signature header authenticates the raw body: exactly one
// timestamp within the tolerance of now, and at least one v1 signature equal,
// in constant time, to HMAC-SHA256(secret, "<timestamp>.<raw body>").
export function verifyStripeSignature(
  rawBody: Uint8Array,
  header: string | null,
  secret: string,
  nowSeconds: number,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    header.length > SIGNATURE_HEADER_MAX ||
    typeof secret !== "string" ||
    secret === ""
  ) {
    return false;
  }
  const timestamps: string[] = [];
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      timestamps.push(value);
    } else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  if (
    timestamps.length !== 1 ||
    !/^[0-9]{1,12}$/.test(timestamps[0]) ||
    signatures.length === 0
  ) {
    return false;
  }
  const timestamp = Number(timestamps[0]);
  if (
    !Number.isSafeInteger(nowSeconds) ||
    Math.abs(nowSeconds - timestamp) > toleranceSeconds
  ) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamps[0]}.`, "utf8")
    .update(rawBody)
    .digest();
  let matched = false;
  for (const signature of signatures) {
    // Every candidate is compared, so the timing does not tell which matched.
    if (timingSafeEqual(signature, expected)) {
      matched = true;
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Events -> observations (TA section 16.1: provider states become
// Rosuno-relevant observations, never Rosuno state)
// ---------------------------------------------------------------------------

function reference(value: unknown): string | null {
  return isProviderReference(value) ? value : null;
}

function idOf(value: unknown): string | null {
  return isRecord(value) ? reference(value.id) : reference(value);
}

function amount(value: unknown): number | null {
  return isAmountMinor(value) ? value : null;
}

function metadataId(
  object: Record<string, unknown>,
  key: string,
): string | null {
  const metadata = isRecord(object.metadata) ? object.metadata : null;
  const value = metadata === null ? undefined : metadata[key];
  return isUuid(value) ? value : null;
}

function statusOf(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,39}$/.test(value)
    ? value
    : null;
}

const IGNORED: Observation = Object.freeze({ kind: "ignored" });

// The observation one verified Stripe event implies. An event type Rosuno
// does not act on, or one missing its object identity, is recorded as
// ignored.
export function observationOf(type: string, object: unknown): Observation {
  if (!isRecord(object)) {
    return IGNORED;
  }
  const id = reference(object.id);
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.expired": {
      if (id === null) {
        return IGNORED;
      }
      const payment =
        metadataId(object, PAYMENT_METADATA_KEY) ??
        (isUuid(object.client_reference_id)
          ? object.client_reference_id
          : null);
      return type === "checkout.session.completed"
        ? {
            kind: "checkout_completed",
            payment_transaction_id: payment,
            checkout_reference: id,
            payment_reference: idOf(object.payment_intent),
          }
        : {
            kind: "checkout_expired",
            payment_transaction_id: payment,
            checkout_reference: id,
          };
    }
    case "payment_intent.amount_capturable_updated": {
      if (id === null || object.status !== "requires_capture") {
        return IGNORED;
      }
      return {
        kind: "authorization_confirmed",
        payment_transaction_id: metadataId(object, PAYMENT_METADATA_KEY),
        payment_reference: id,
        amount_minor: amount(object.amount_capturable),
        currency_code: currencyOf(object.currency),
      };
    }
    case "payment_intent.payment_failed":
      return id === null
        ? IGNORED
        : {
            kind: "authorization_failed",
            payment_transaction_id: metadataId(object, PAYMENT_METADATA_KEY),
            payment_reference: id,
          };
    case "payment_intent.canceled":
      return id === null
        ? IGNORED
        : {
            kind: "authorization_released",
            payment_transaction_id: metadataId(object, PAYMENT_METADATA_KEY),
            payment_reference: id,
          };
    case "payment_intent.succeeded":
      return id === null
        ? IGNORED
        : {
            kind: "capture_confirmed",
            payment_transaction_id: metadataId(object, PAYMENT_METADATA_KEY),
            payment_reference: id,
            amount_minor: amount(object.amount_received),
            currency_code: currencyOf(object.currency),
          };
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated":
      return id === null
        ? IGNORED
        : {
            kind: "refund_observed",
            payment_transaction_id: metadataId(object, PAYMENT_METADATA_KEY),
            payment_reference: idOf(object.payment_intent),
            refund_reference: id,
            refund_request_id: metadataId(object, REFUND_METADATA_KEY),
            amount_minor: amount(object.amount),
            currency_code: currencyOf(object.currency),
            provider_status: statusOf(
              type === "refund.failed" ? "failed" : object.status,
            ),
          };
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
    case "charge.dispute.closed":
      return id === null
        ? IGNORED
        : {
            kind:
              type === "charge.dispute.created"
                ? "dispute_opened"
                : type === "charge.dispute.closed"
                  ? "dispute_closed"
                  : "dispute_updated",
            payment_reference: idOf(object.payment_intent),
            dispute_reference: id,
            amount_minor: amount(object.amount),
            currency_code: currencyOf(object.currency),
            provider_status: statusOf(object.status),
          };
    default:
      return IGNORED;
  }
}

// The event a verified raw body carries, as Rosuno records it, or null when it
// is not a test-mode Stripe event of the expected shape (a live-mode event is
// refused: live mode is excluded from S7).
export function stripeEventOf(rawBody: Uint8Array): ProviderEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.object !== "event" ||
    !isProviderReference(parsed.id) ||
    typeof parsed.type !== "string" ||
    !/^[a-z][a-z0-9_.]{2,99}$/.test(parsed.type) ||
    !Number.isSafeInteger(parsed.created) ||
    parsed.livemode !== false ||
    !isRecord(parsed.data)
  ) {
    return null;
  }
  const observation = observationOf(parsed.type, parsed.data.object);
  if (!isObservation(observation)) {
    return null;
  }
  return Object.freeze({
    providerCode: STRIPE_PROVIDER_CODE,
    eventReference: parsed.id,
    eventType: parsed.type,
    occurredAt: new Date((parsed.created as number) * 1000).toISOString(),
    payloadDigest: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
    observation,
  });
}
