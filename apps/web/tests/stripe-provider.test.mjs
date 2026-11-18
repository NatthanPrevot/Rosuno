// MVP-001 S7 L3 contract tests (SIMULATED). Packet section 5 level L3:
// adapter correctness only, never integration completion.
//
// The Stripe adapter is exercised against a local fake Stripe HTTP server
// written here (node:http on 127.0.0.1, an ephemeral port), which records
// every request and answers with recorded Stripe response shapes. No Stripe
// host (api.stripe.com or any other) is contacted. The secret key and the
// webhook signing secret are synthetic values generated in this file; they
// only have the test-mode shape the adapter requires. The probes cover the
// request shape (method, path, form encoding, the pinned Stripe-Version,
// the Idempotency-Key on every POST, no key on GET), the configuration rules
// (test-mode keys only; live keys refused; absent configuration means no
// adapter), the error mapping, webhook signature verification (valid,
// tampered body, wrong secret, stale and future timestamps, several
// signatures, missing or malformed header), the event-to-observation
// mapping, the webhook handler's behaviour over a fake recording port, the
// route's methods, and the payment job handlers end to end over the real
// adapter, the fake server and a fake recording port.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import {
  createPaymentJobHandlers,
  idempotencyKeyFor,
} from "../src/application/payments.ts";
import {
  checkoutOf,
  createStripeProvider,
  errorKindOf,
  formEncode,
  isTestModeKey,
  observationOf,
  paymentOf,
  readStripeApiConfiguration,
  readStripeWebhookSecret,
  refundOf,
  STRIPE_API_VERSION,
  stripeEventOf,
  verifyStripeSignature,
} from "../src/infrastructure/payments/stripe-provider.ts";
import { handleStripeWebhook } from "../src/infrastructure/payments/stripe-webhook.ts";
import * as route from "../app/api/payments/stripe/route.ts";

// Synthetic test-mode credentials generated for this run only.
const SECRET_KEY = `sk_test_${randomBytes(24).toString("hex")}`;
const WEBHOOK_SETTING = "ROSUNO_STRIPE_WEBHOOK_SECRET";
const SIGNING_KEY = `whsec_${randomBytes(24).toString("base64url").replace(/[-_]/g, "A")}`;
const ORIGIN = "https://rosuno-l3.invalid";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PAYMENT = id(1001);
const REQUEST = id(901);
const REFUND_REQUEST = id(3001);
const JOB = id(2001);

const environment = (overrides = {}) => ({
  ROSUNO_ENVIRONMENT_CLASS: "development",
  ROSUNO_STRIPE_SECRET_KEY: SECRET_KEY,
  ROSUNO_AUTH_PUBLIC_ORIGIN: ORIGIN,
  [WEBHOOK_SETTING]: SIGNING_KEY,
  ...overrides,
});

// ---------------------------------------------------------------------------
// The local fake Stripe API (simulated)
// ---------------------------------------------------------------------------

const fake = { requests: [], responders: [], server: null, origin: null };

function respondWith(handler) {
  fake.responders.push(handler);
}

before(async () => {
  fake.server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const recorded = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        form: Object.fromEntries(new URLSearchParams(body)),
      };
      fake.requests.push(recorded);
      const responder = fake.responders.shift();
      const [status, payload] = responder
        ? responder(recorded)
        : [500, { error: { type: "api_error" } }];
      if (payload === "hang") {
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    });
  });
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${fake.server.address().port}`;
});

after(async () => {
  fake.server.closeAllConnections();
  await new Promise((resolve) => fake.server.close(resolve));
});

function reset() {
  fake.requests.length = 0;
  fake.responders.length = 0;
}

function provider(overrides = {}) {
  const built = createStripeProvider({
    environment: environment(),
    apiOrigin: fake.origin,
    timeoutMs: 2000,
    ...overrides,
  });
  assert.ok(built, "the adapter is configured");
  return built;
}

// Recorded Stripe response shapes (synthetic values).
const SESSION = (overrides = {}) => ({
  id: "cs_test_l3session",
  object: "checkout.session",
  status: "open",
  payment_status: "unpaid",
  payment_intent: null,
  url: "https://checkout.stripe.com/c/pay/cs_test_l3session",
  ...overrides,
});
const INTENT = (overrides = {}) => ({
  id: "pi_l3intent",
  object: "payment_intent",
  status: "requires_capture",
  amount: 5225,
  amount_capturable: 5225,
  amount_received: 0,
  currency: "usd",
  latest_charge: null,
  metadata: { rosuno_payment_transaction: PAYMENT },
  ...overrides,
});
const REFUND = (overrides = {}) => ({
  id: "re_l3refund",
  object: "refund",
  status: "succeeded",
  amount: 1100,
  currency: "usd",
  payment_intent: "pi_l3intent",
  metadata: { rosuno_refund_request: REFUND_REQUEST },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("S7-L3-1 (simulated) configuration: only test-mode keys; a live key, a placeholder, a missing key or origin means no adapter and payments are unavailable (no fallback)", () => {
  assert.ok(isTestModeKey(SECRET_KEY));
  assert.ok(isTestModeKey(`rk_test_${"a".repeat(24)}`));
  for (const key of [
    `sk_live_${"a".repeat(24)}`,
    `rk_live_${"a".repeat(24)}`,
    `pk_test_${"a".repeat(24)}`,
    "sk_test_short",
    `sk_test_${"a".repeat(20)} `,
  ]) {
    assert.equal(isTestModeKey(key), false, key);
  }
  assert.ok(readStripeApiConfiguration(environment()));
  for (const overrides of [
    { ROSUNO_STRIPE_SECRET_KEY: `sk_live_${"a".repeat(24)}` },
    { ROSUNO_STRIPE_SECRET_KEY: undefined },
    { ROSUNO_STRIPE_SECRET_KEY: `sk_test_dummy${"a".repeat(20)}` },
    { ROSUNO_AUTH_PUBLIC_ORIGIN: undefined },
    { ROSUNO_AUTH_PUBLIC_ORIGIN: "https://rosuno-l3.invalid/path" },
    { ROSUNO_ENVIRONMENT_CLASS: undefined },
  ]) {
    assert.equal(
      readStripeApiConfiguration(environment(overrides)),
      null,
      JSON.stringify(Object.keys(overrides)),
    );
    assert.equal(
      createStripeProvider({
        environment: environment(overrides),
        apiOrigin: fake.origin,
      }),
      null,
    );
  }
  // A live key is refused in production too: live mode is excluded from S7.
  assert.equal(
    readStripeApiConfiguration(
      environment({
        ROSUNO_ENVIRONMENT_CLASS: "production",
        ROSUNO_STRIPE_SECRET_KEY: `sk_live_${"a".repeat(24)}`,
      }),
    ),
    null,
  );
  assert.equal(readStripeWebhookSecret(environment()), SIGNING_KEY);
  assert.equal(
    readStripeWebhookSecret(environment({ [WEBHOOK_SETTING]: "whsec_" })),
    null,
  );
  assert.equal(
    readStripeWebhookSecret(environment({ [WEBHOOK_SETTING]: undefined })),
    null,
  );
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

test("S7-L3-2 (simulated) a Checkout Session in payment mode with manual capture, form-encoded, with the pinned Stripe-Version, the caller's Idempotency-Key, the payment id as the only metadata, return URLs on the request page and the bounded expiry", async () => {
  reset();
  respondWith(() => [200, SESSION()]);
  const key = idempotencyKeyFor(PAYMENT, "checkout");
  const answer = await provider().createCheckout(
    {
      paymentId: PAYMENT,
      requestId: REQUEST,
      amountMinor: 5225,
      currency: "USD",
      expiresAt: 1800000000,
    },
    key,
  );
  assert.deepEqual(answer, {
    kind: "ok",
    value: {
      reference: "cs_test_l3session",
      status: "open",
      paymentReference: null,
      url: "https://checkout.stripe.com/c/pay/cs_test_l3session",
    },
  });
  const [request] = fake.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/checkout/sessions");
  assert.equal(request.headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(request.headers["stripe-version"], STRIPE_API_VERSION);
  assert.equal(
    request.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(request.headers["idempotency-key"], key);
  assert.deepEqual(request.form, {
    mode: "payment",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": "5225",
    "line_items[0][price_data][product_data][name]": "Consultation",
    "line_items[0][quantity]": "1",
    "payment_intent_data[capture_method]": "manual",
    "payment_intent_data[metadata][rosuno_payment_transaction]": PAYMENT,
    "metadata[rosuno_payment_transaction]": PAYMENT,
    client_reference_id: PAYMENT,
    success_url: `${ORIGIN}/client/requests/${REQUEST}`,
    cancel_url: `${ORIGIN}/client/requests/${REQUEST}`,
    expires_at: "1800000000",
  });
  assert.match(
    request.body,
    /line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd/,
  );
  // Invalid input is refused before anything is sent.
  reset();
  for (const input of [
    {
      paymentId: "x",
      requestId: REQUEST,
      amountMinor: 1,
      currency: "USD",
      expiresAt: 1,
    },
    {
      paymentId: PAYMENT,
      requestId: REQUEST,
      amountMinor: 0,
      currency: "USD",
      expiresAt: 1,
    },
    {
      paymentId: PAYMENT,
      requestId: REQUEST,
      amountMinor: 1,
      currency: "usd",
      expiresAt: 1,
    },
  ]) {
    assert.deepEqual(await provider().createCheckout(input, key), {
      kind: "rejected",
    });
  }
  assert.equal(fake.requests.length, 0);
});

test("S7-L3-3 (simulated) retrieve, expire, capture, cancel and refund: GET carries no body or Idempotency-Key; every POST carries its deterministic key; answers are read strictly into neutral views", async () => {
  reset();
  const p = provider();
  respondWith(() => [
    200,
    SESSION({ status: "complete", payment_intent: "pi_l3intent", url: null }),
  ]);
  assert.deepEqual((await p.retrieveCheckout("cs_test_l3session")).value, {
    reference: "cs_test_l3session",
    status: "complete",
    paymentReference: "pi_l3intent",
    url: null,
  });
  respondWith(() => [200, SESSION({ status: "expired", url: null })]);
  assert.equal(
    (
      await p.expireCheckout(
        "cs_test_l3session",
        idempotencyKeyFor(PAYMENT, "expire"),
      )
    ).value.status,
    "expired",
  );
  respondWith(() => [
    200,
    INTENT({ latest_charge: { id: "ch_l3", amount_refunded: 300 } }),
  ]);
  assert.deepEqual((await p.retrievePayment("pi_l3intent")).value, {
    reference: "pi_l3intent",
    status: "requires_capture",
    amountMinor: 5225,
    amountCapturableMinor: 5225,
    amountReceivedMinor: 0,
    amountRefundedMinor: 300,
    currency: "USD",
  });
  respondWith((r) => [
    200,
    INTENT({
      status: "succeeded",
      amount_capturable: 0,
      amount_received: Number(r.form.amount_to_capture),
    }),
  ]);
  assert.equal(
    (
      await p.capturePayment(
        "pi_l3intent",
        5225,
        idempotencyKeyFor(PAYMENT, "capture"),
      )
    ).value.amountReceivedMinor,
    5225,
  );
  respondWith(() => [
    200,
    INTENT({ status: "canceled", amount_capturable: 0 }),
  ]);
  assert.equal(
    (await p.cancelPayment("pi_l3intent", idempotencyKeyFor(PAYMENT, "cancel")))
      .value.status,
    "canceled",
  );
  respondWith(() => [200, REFUND({ status: "pending" })]);
  assert.equal(
    (
      await p.createRefund(
        {
          paymentId: PAYMENT,
          refundRequestId: REFUND_REQUEST,
          paymentReference: "pi_l3intent",
          amountMinor: 1100,
        },
        idempotencyKeyFor(PAYMENT, "refund", REFUND_REQUEST),
      )
    ).value.status,
    "pending",
  );
  respondWith(() => [200, REFUND({ status: "requires_action" })]);
  assert.equal((await p.retrieveRefund("re_l3refund")).value.status, "pending");
  const [
    retrieveSession,
    expire,
    retrievePayment,
    capture,
    cancel,
    refund,
    retrieveRefund,
  ] = fake.requests;
  assert.deepEqual(
    fake.requests.map((r) => [r.method, r.url]),
    [
      ["GET", "/v1/checkout/sessions/cs_test_l3session"],
      ["POST", "/v1/checkout/sessions/cs_test_l3session/expire"],
      ["GET", "/v1/payment_intents/pi_l3intent?expand%5B%5D=latest_charge"],
      ["POST", "/v1/payment_intents/pi_l3intent/capture"],
      ["POST", "/v1/payment_intents/pi_l3intent/cancel"],
      ["POST", "/v1/refunds"],
      ["GET", "/v1/refunds/re_l3refund"],
    ],
  );
  for (const get of [retrieveSession, retrievePayment, retrieveRefund]) {
    assert.equal(get.body, "");
    assert.equal(get.headers["idempotency-key"], undefined);
    assert.equal(get.headers["stripe-version"], STRIPE_API_VERSION);
  }
  assert.equal(
    expire.headers["idempotency-key"],
    `rosuno-payment-${PAYMENT}-expire`,
  );
  assert.equal(
    capture.headers["idempotency-key"],
    `rosuno-payment-${PAYMENT}-capture`,
  );
  assert.deepEqual(capture.form, { amount_to_capture: "5225" });
  assert.equal(
    cancel.headers["idempotency-key"],
    `rosuno-payment-${PAYMENT}-cancel`,
  );
  assert.equal(
    refund.headers["idempotency-key"],
    `rosuno-payment-${PAYMENT}-refund-${REFUND_REQUEST}`,
  );
  assert.deepEqual(refund.form, {
    payment_intent: "pi_l3intent",
    amount: "1100",
    "metadata[rosuno_payment_transaction]": PAYMENT,
    "metadata[rosuno_refund_request]": REFUND_REQUEST,
  });
  // A reference that is not an identifier is never put into a path.
  reset();
  assert.deepEqual(await p.retrievePayment("../v1/charges"), {
    kind: "rejected",
  });
  assert.deepEqual(await p.retrieveCheckout("cs test"), { kind: "rejected" });
  assert.equal(fake.requests.length, 0);
});

test("S7-L3-4 (simulated) error mapping: card errors and 402 decline; an unexpected-state invalid request is invalid_state; other 400s, 401 and 403 are rejected; 404 not_found; 409, 429, 5xx, a malformed 200, a refused connection and a timeout are transient", async () => {
  const cases = [
    [402, { error: { type: "card_error", code: "card_declined" } }, "declined"],
    [400, { error: { type: "card_error", code: "card_declined" } }, "declined"],
    [
      400,
      {
        error: {
          type: "invalid_request_error",
          code: "payment_intent_unexpected_state",
        },
      },
      "invalid_state",
    ],
    [
      400,
      {
        error: {
          type: "invalid_request_error",
          code: "charge_already_refunded",
        },
      },
      "invalid_state",
    ],
    [
      400,
      { error: { type: "invalid_request_error", code: "parameter_missing" } },
      "rejected",
    ],
    [401, { error: { type: "invalid_request_error" } }, "rejected"],
    [403, { error: { type: "invalid_request_error" } }, "rejected"],
    [
      404,
      { error: { type: "invalid_request_error", code: "resource_missing" } },
      "not_found",
    ],
    [409, { error: { type: "idempotency_error" } }, "transient"],
    [429, { error: { type: "rate_limit_error" } }, "transient"],
    [500, { error: { type: "api_error" } }, "transient"],
    [503, "not json", "transient"],
    [200, { object: "payment_intent", id: "pi_l3intent" }, "transient"],
  ];
  for (const [status, body, kind] of cases) {
    reset();
    respondWith(() => [status, body]);
    const answer = await provider().capturePayment(
      "pi_l3intent",
      5225,
      "rosuno-l3-key",
    );
    assert.equal(answer.kind, kind, `${status} ${JSON.stringify(body)}`);
    if (status !== 200 && typeof body === "object") {
      assert.equal(errorKindOf(status, body), kind);
    }
  }
  const refused = createStripeProvider({
    environment: environment(),
    apiOrigin: "http://127.0.0.1:1",
    timeoutMs: 1000,
  });
  assert.deepEqual(await refused.retrievePayment("pi_l3intent"), {
    kind: "transient",
  });
  reset();
  respondWith(() => [200, "hang"]);
  const slow = provider({ timeoutMs: 200 });
  assert.deepEqual(await slow.retrievePayment("pi_l3intent"), {
    kind: "transient",
  });
  // The readers accept only the expected objects.
  assert.equal(checkoutOf(INTENT()), null);
  assert.equal(paymentOf(SESSION()), null);
  assert.equal(paymentOf(INTENT({ currency: "USD" })), null);
  assert.equal(refundOf(REFUND({ status: "unknown" })), null);
  assert.equal(
    checkoutOf(SESSION({ url: "https://evil.invalid/pay" })).url,
    null,
  );
  assert.equal(formEncode({ "a[b]": "c d", e: 1 }), "a%5Bb%5D=c+d&e=1");
});

// ---------------------------------------------------------------------------
// Webhook authenticity
// ---------------------------------------------------------------------------

const NOW = 1800000000;
const sign = (body, timestamp = NOW, key = SIGNING_KEY) =>
  createHmac("sha256", key).update(`${timestamp}.`).update(body).digest("hex");
const header = (body, timestamp = NOW, key = SIGNING_KEY) =>
  `t=${timestamp},v1=${sign(body, timestamp, key)}`;

const EVENT = (type, object, overrides = {}) => ({
  id: "evt_l3event",
  object: "event",
  type,
  created: NOW,
  livemode: false,
  data: { object },
  ...overrides,
});
const bytes = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

test("S7-L3-5 (simulated) signature verification: HMAC-SHA256 over the timestamp and the raw body, any v1 in constant time, within the tolerance; a tampered body, a wrong secret, a stale or future timestamp, a missing or malformed header is refused", () => {
  const body = bytes(EVENT("payment_intent.succeeded", INTENT()));
  assert.ok(verifyStripeSignature(body, header(body), SIGNING_KEY, NOW));
  assert.ok(
    verifyStripeSignature(body, header(body, NOW - 299), SIGNING_KEY, NOW),
  );
  // Several signatures (a rolled secret): any v1 match is enough.
  assert.ok(
    verifyStripeSignature(
      body,
      `t=${NOW},v1=${"0".repeat(64)},v1=${sign(body)},v0=${"1".repeat(64)}`,
      SIGNING_KEY,
      NOW,
    ),
  );
  const tampered = Buffer.from(body);
  tampered[tampered.length - 2] ^= 1;
  assert.equal(
    verifyStripeSignature(tampered, header(body), SIGNING_KEY, NOW),
    false,
  );
  assert.equal(
    verifyStripeSignature(
      body,
      header(body, NOW, `whsec_${"B".repeat(32)}`),
      SIGNING_KEY,
      NOW,
    ),
    false,
  );
  assert.equal(
    verifyStripeSignature(body, header(body, NOW - 301), SIGNING_KEY, NOW),
    false,
  );
  assert.equal(
    verifyStripeSignature(body, header(body, NOW + 301), SIGNING_KEY, NOW),
    false,
  );
  for (const bad of [
    null,
    "",
    `v1=${sign(body)}`,
    `t=${NOW}`,
    `t=${NOW},v0=${sign(body)}`,
    `t=${NOW},t=${NOW},v1=${sign(body)}`,
    `t=abc,v1=${sign(body)}`,
    `t=${NOW},v1=${sign(body).toUpperCase()}`,
    "x".repeat(4096),
  ]) {
    assert.equal(
      verifyStripeSignature(body, bad, SIGNING_KEY, NOW),
      false,
      String(bad).slice(0, 40),
    );
  }
  assert.equal(verifyStripeSignature(body, header(body), "", NOW), false);
});

test("S7-L3-6 (simulated) events become Rosuno observations (identifiers, amounts, currencies and statuses only); an event Rosuno does not act on is ignored; a live-mode or malformed event is refused", () => {
  const cases = [
    [
      "checkout.session.completed",
      SESSION({
        status: "complete",
        payment_intent: "pi_l3intent",
        metadata: { rosuno_payment_transaction: PAYMENT },
      }),
      {
        kind: "checkout_completed",
        payment_transaction_id: PAYMENT,
        checkout_reference: "cs_test_l3session",
        payment_reference: "pi_l3intent",
      },
    ],
    [
      "checkout.session.expired",
      SESSION({ status: "expired", client_reference_id: PAYMENT }),
      {
        kind: "checkout_expired",
        payment_transaction_id: PAYMENT,
        checkout_reference: "cs_test_l3session",
      },
    ],
    [
      "payment_intent.amount_capturable_updated",
      INTENT(),
      {
        kind: "authorization_confirmed",
        payment_transaction_id: PAYMENT,
        payment_reference: "pi_l3intent",
        amount_minor: 5225,
        currency_code: "USD",
      },
    ],
    [
      "payment_intent.amount_capturable_updated",
      INTENT({ status: "processing" }),
      { kind: "ignored" },
    ],
    [
      "payment_intent.payment_failed",
      INTENT({ status: "requires_payment_method" }),
      {
        kind: "authorization_failed",
        payment_transaction_id: PAYMENT,
        payment_reference: "pi_l3intent",
      },
    ],
    [
      "payment_intent.canceled",
      INTENT({ status: "canceled" }),
      {
        kind: "authorization_released",
        payment_transaction_id: PAYMENT,
        payment_reference: "pi_l3intent",
      },
    ],
    [
      "payment_intent.succeeded",
      INTENT({ status: "succeeded", amount_received: 5225 }),
      {
        kind: "capture_confirmed",
        payment_transaction_id: PAYMENT,
        payment_reference: "pi_l3intent",
        amount_minor: 5225,
        currency_code: "USD",
      },
    ],
    [
      "refund.updated",
      REFUND(),
      {
        kind: "refund_observed",
        payment_transaction_id: null,
        payment_reference: "pi_l3intent",
        refund_reference: "re_l3refund",
        refund_request_id: REFUND_REQUEST,
        amount_minor: 1100,
        currency_code: "USD",
        provider_status: "succeeded",
      },
    ],
    [
      "charge.dispute.created",
      {
        id: "dp_l3dispute",
        object: "dispute",
        payment_intent: "pi_l3intent",
        amount: 5225,
        currency: "usd",
        status: "needs_response",
        evidence: { customer_email_address: "synthetic@invalid" },
      },
      {
        kind: "dispute_opened",
        payment_reference: "pi_l3intent",
        dispute_reference: "dp_l3dispute",
        amount_minor: 5225,
        currency_code: "USD",
        provider_status: "needs_response",
      },
    ],
    [
      "charge.dispute.closed",
      {
        id: "dp_l3dispute",
        object: "dispute",
        payment_intent: "pi_l3intent",
        amount: 5225,
        currency: "usd",
        status: "won",
      },
      {
        kind: "dispute_closed",
        payment_reference: "pi_l3intent",
        dispute_reference: "dp_l3dispute",
        amount_minor: 5225,
        currency_code: "USD",
        provider_status: "won",
      },
    ],
    [
      "customer.created",
      { id: "cus_l3", object: "customer", email: "synthetic@invalid" },
      { kind: "ignored" },
    ],
  ];
  for (const [type, object, observation] of cases) {
    assert.deepEqual(observationOf(type, object), observation, type);
  }
  const raw = bytes(
    EVENT(
      "payment_intent.succeeded",
      INTENT({ status: "succeeded", amount_received: 5225 }),
    ),
  );
  const event = stripeEventOf(raw);
  assert.equal(event.providerCode, "stripe");
  assert.equal(event.eventReference, "evt_l3event");
  assert.equal(event.occurredAt, new Date(NOW * 1000).toISOString());
  assert.match(event.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(event).includes("synthetic@invalid"), false);
  assert.equal(
    stripeEventOf(
      bytes(EVENT("payment_intent.succeeded", INTENT(), { livemode: true })),
    ),
    null,
  );
  assert.equal(stripeEventOf(bytes("not json")), null);
  assert.equal(
    stripeEventOf(
      bytes({
        object: "event",
        id: "evt_x123",
        type: "x",
        created: NOW,
        livemode: false,
      }),
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// The webhook handler and the route
// ---------------------------------------------------------------------------

function deliveryOf(body, signature) {
  return new Request("https://rosuno-l3.invalid/api/payments/stripe", {
    method: "POST",
    headers: signature === null ? {} : { "stripe-signature": signature },
    body,
  });
}

function webhookSources({
  signingKey = SIGNING_KEY,
  answer = { kind: "answer", outcome: "recorded", processing: "applied" },
} = {}) {
  const recorded = [];
  let scheduled = 0;
  return {
    recorded,
    scheduled: () => scheduled,
    sources: {
      secret: () => signingKey,
      recorder: async () => ({
        jobContext: async () => null,
        recordOperation: async () => "unknown",
        recordEvent: async (event) => {
          recorded.push(event);
          return answer;
        },
      }),
      clock: () => NOW * 1000,
      afterResponse: async () => {
        scheduled += 1;
        return true;
      },
    },
  };
}

test("S7-L3-7 (simulated; IMP section 23 provider security gate) the webhook handler: unconfigured 503 with nothing read; an invalid signature 400 with nothing recorded; a verified event is recorded once (a replay answers 200 too), then a worker run is scheduled; an unknown recording answer 503 so Stripe delivers again; an oversized body 413", async () => {
  const body = JSON.stringify(
    EVENT("payment_intent.amount_capturable_updated", INTENT()),
  );
  const unconfigured = webhookSources({ signingKey: null });
  assert.deepEqual(
    await handleStripeWebhook(
      deliveryOf(body, header(body)),
      unconfigured.sources,
    ),
    {
      status: 503,
      body: { status: "unavailable" },
    },
  );
  assert.equal(unconfigured.recorded.length, 0);
  for (const signature of [
    null,
    header(body, NOW, `whsec_${"C".repeat(32)}`),
    header(body, NOW - 3600),
  ]) {
    const refused = webhookSources();
    assert.deepEqual(
      await handleStripeWebhook(deliveryOf(body, signature), refused.sources),
      {
        status: 400,
        body: { status: "invalid" },
      },
    );
    assert.equal(refused.recorded.length, 0);
    assert.equal(refused.scheduled(), 0);
  }
  const tampered = webhookSources();
  assert.equal(
    (
      await handleStripeWebhook(
        deliveryOf(body.replace("5225", "1"), header(body)),
        tampered.sources,
      )
    ).status,
    400,
  );
  assert.equal(tampered.recorded.length, 0);
  const accepted = webhookSources();
  assert.deepEqual(
    await handleStripeWebhook(deliveryOf(body, header(body)), accepted.sources),
    {
      status: 200,
      body: { status: "received" },
    },
  );
  assert.equal(accepted.recorded.length, 1);
  assert.deepEqual(accepted.recorded[0].observation, {
    kind: "authorization_confirmed",
    payment_transaction_id: PAYMENT,
    payment_reference: "pi_l3intent",
    amount_minor: 5225,
    currency_code: "USD",
  });
  assert.equal(accepted.scheduled(), 1);
  const replay = webhookSources({
    answer: { kind: "answer", outcome: "duplicate", processing: "applied" },
  });
  assert.equal(
    (await handleStripeWebhook(deliveryOf(body, header(body)), replay.sources))
      .status,
    200,
  );
  const unknown = webhookSources({ answer: { kind: "unknown" } });
  assert.equal(
    (await handleStripeWebhook(deliveryOf(body, header(body)), unknown.sources))
      .status,
    503,
  );
  const rejected = webhookSources({
    answer: { kind: "answer", outcome: "invalid", processing: null },
  });
  assert.equal(
    (
      await handleStripeWebhook(
        deliveryOf(body, header(body)),
        rejected.sources,
      )
    ).status,
    400,
  );
  const live = JSON.stringify(
    EVENT("payment_intent.succeeded", INTENT(), { livemode: true }),
  );
  const liveRun = webhookSources();
  assert.equal(
    (await handleStripeWebhook(deliveryOf(live, header(live)), liveRun.sources))
      .status,
    400,
  );
  assert.equal(liveRun.recorded.length, 0);
  const large = "x".repeat(512 * 1024 + 1);
  const largeRun = webhookSources();
  assert.equal(
    (
      await handleStripeWebhook(
        deliveryOf(large, header(large)),
        largeRun.sources,
      )
    ).status,
    413,
  );
  assert.equal(largeRun.recorded.length, 0);
});

test("S7-L3-8 (simulated) the route answers POST through the webhook handler (unconfigured here: 503) and every other method 405 with no body", async () => {
  const saved = process.env[WEBHOOK_SETTING];
  delete process.env[WEBHOOK_SETTING];
  try {
    const answer = await route.POST(deliveryOf("{}", "t=1,v1=00"));
    assert.equal(answer.status, 503);
    assert.equal(answer.headers.get("cache-control"), "no-store, max-age=0");
    assert.deepEqual(await answer.json(), { status: "unavailable" });
  } finally {
    if (saved !== undefined) {
      process.env[WEBHOOK_SETTING] = saved;
    }
  }
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const answer = route[method]();
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.get("allow"), "POST");
    assert.equal(await answer.text(), "");
  }
});

// ---------------------------------------------------------------------------
// The payment job handlers over the real adapter and the fake API
// ---------------------------------------------------------------------------

async function runJob(type, context) {
  const recorded = [];
  const handlers = createPaymentJobHandlers({
    provider: async () => provider(),
    recorder: async () => ({
      jobContext: async () => [context],
      recordOperation: async (_job, observation) => {
        recorded.push(observation);
        return "applied";
      },
      recordEvent: async () => ({ kind: "unknown" }),
    }),
    clock: () => NOW * 1000,
  });
  let outcome;
  try {
    outcome = await handlers.get(type)({ jobId: JOB, jobType: type });
  } catch (error) {
    outcome = error.name;
  }
  return { outcome, recorded };
}

const CONTEXT = (overrides) => ({
  outcome: "act",
  operation: "checkout",
  payment_transaction_id: PAYMENT,
  consultation_request_id: REQUEST,
  state: "pending_authorization",
  provider_reference: null,
  reference_kind: "none",
  currency_code: "USD",
  amount_minor: 5225,
  refund_request_id: null,
  checkout_expires_at: new Date((NOW + 600) * 1000).toISOString(),
  ...overrides,
});

test("S7-L3-9 (simulated; IMP section 23 outbound idempotency) the job handlers end to end over the adapter: a retried checkout reuses its key; a declined capture is recorded as refused; a release of a completed checkout cancels its authorization; a pending refund is read back; a reconciliation reads the expanded payment", async () => {
  reset();
  respondWith(() => [500, { error: { type: "api_error" } }]);
  respondWith(() => [200, SESSION()]);
  const first = await runJob("payment.checkout", CONTEXT({}));
  const second = await runJob("payment.checkout", CONTEXT({}));
  assert.deepEqual(
    [first.outcome, second.outcome],
    ["PaymentJobRetry", "done"],
  );
  assert.equal(
    fake.requests[0].headers["idempotency-key"],
    fake.requests[1].headers["idempotency-key"],
  );
  assert.equal(
    fake.requests[0].headers["idempotency-key"],
    `rosuno-payment-${PAYMENT}-checkout`,
  );
  assert.equal(fake.requests[1].form.expires_at, String(NOW + 31 * 60));
  assert.deepEqual(second.recorded, [
    { kind: "checkout_open", checkout_reference: "cs_test_l3session" },
  ]);

  reset();
  respondWith(() => [
    402,
    { error: { type: "card_error", code: "card_declined" } },
  ]);
  const capture = await runJob(
    "payment.capture",
    CONTEXT({
      operation: "capture",
      state: "capture_pending",
      provider_reference: "pi_l3intent",
      reference_kind: "payment",
    }),
  );
  assert.deepEqual(capture.recorded, [
    { kind: "capture_refused", payment_reference: "pi_l3intent" },
  ]);

  reset();
  respondWith(() => [
    400,
    {
      error: {
        type: "invalid_request_error",
        code: "checkout_session_not_open",
      },
    },
  ]);
  respondWith(() => [
    200,
    SESSION({ status: "complete", payment_intent: "pi_l3intent", url: null }),
  ]);
  respondWith(() => [200, INTENT()]);
  respondWith(() => [
    200,
    INTENT({ status: "canceled", amount_capturable: 0 }),
  ]);
  const release = await runJob(
    "payment.release",
    CONTEXT({
      operation: "release",
      state: "release_pending",
      provider_reference: "cs_test_l3session",
      reference_kind: "checkout",
    }),
  );
  assert.deepEqual(
    fake.requests.map((r) => [r.method, r.url]),
    [
      ["POST", "/v1/checkout/sessions/cs_test_l3session/expire"],
      ["GET", "/v1/checkout/sessions/cs_test_l3session"],
      ["GET", "/v1/payment_intents/pi_l3intent?expand%5B%5D=latest_charge"],
      ["POST", "/v1/payment_intents/pi_l3intent/cancel"],
    ],
  );
  assert.deepEqual(release.recorded, [
    {
      kind: "authorization_released",
      payment_reference: "pi_l3intent",
      amount_minor: 5225,
      currency_code: "USD",
    },
  ]);

  reset();
  respondWith(() => [200, REFUND({ status: "pending" })]);
  respondWith(() => [200, REFUND({ status: "succeeded" })]);
  const refund = await runJob(
    "payment.refund",
    CONTEXT({
      operation: "refund",
      state: "refund_pending",
      provider_reference: "pi_l3intent",
      reference_kind: "payment",
      amount_minor: 1100,
      refund_request_id: REFUND_REQUEST,
    }),
  );
  assert.equal(refund.recorded[0].kind, "refund_confirmed");
  assert.equal(
    fake.requests[0].headers["idempotency-key"],
    `rosuno-payment-${PAYMENT}-refund-${REFUND_REQUEST}`,
  );

  reset();
  respondWith(() => [
    200,
    INTENT({
      status: "succeeded",
      amount_capturable: 0,
      amount_received: 5225,
      latest_charge: { id: "ch_l3", amount_refunded: 1100 },
    }),
  ]);
  const reconcile = await runJob(
    "payment.reconcile",
    CONTEXT({
      operation: "reconcile",
      state: "partially_refunded",
      provider_reference: "pi_l3intent",
      reference_kind: "payment",
    }),
  );
  assert.deepEqual(reconcile.recorded, [
    {
      kind: "provider_state",
      checkout_reference: null,
      payment_reference: "pi_l3intent",
      provider_status: "succeeded",
      amount_capturable_minor: 0,
      amount_received_minor: 5225,
      amount_refunded_minor: 1100,
      currency_code: "USD",
    },
  ]);
});
