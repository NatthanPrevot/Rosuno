// MVP-001 S7 application tests (L1): the provider-neutral payment core (the
// observation vocabulary, idempotency keys, the checkout expiry bound, the
// strict job context reader, the five payment job handlers over a fake
// provider and a fake recording port, and the recording of an authenticated
// provider event), the client payment step, authorization and receipt, the
// attorney's ledger-derived earnings, and the staff finance workspace, all
// over synthetic in-memory ports; and the source contracts of the S7
// routes. No database, provider or network is reached; every identifier,
// amount and reference is synthetic test data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  AUTHORIZE_OUTCOMES,
  authorizeRequestPayment,
  INITIAL_AUTHORIZE_STATE,
  PAYMENT_STEPS,
  resolveAttorneyEarnings,
  resolvePaymentReceipt,
  resolveRequestPayment,
} from "../src/application/client-payments.ts";
import {
  assignFinanceException,
  componentMinorOf,
  refundableOf,
  requestFinanceReconciliation,
  requestFinanceRefund,
  resolveFinanceException,
  resolveFinanceExceptions,
  resolveFinancePayment,
  resolveFinancePayments,
} from "../src/application/finance-workspace.ts";
import { JOB_DONE } from "../src/application/job-worker.ts";
import {
  CHECKOUT_MAX_SECONDS,
  CHECKOUT_MIN_SECONDS,
  checkoutExpiryOf,
  createPaymentJobHandlers,
  eventAnswerOf,
  idempotencyKeyFor,
  isObservation,
  jobContextOf,
  OBSERVATION_KINDS,
  PAYMENT_JOB_TYPES,
  PAYMENT_STATES,
  recordProviderEvent,
} from "../src/application/payments.ts";
import {
  addStaff,
  configurationSources,
  createWorld,
  grant,
} from "./configuration-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(101);
const USER = id(201);
const CLIENT = id(301);
const REQUEST = id(901);
const PAYMENT = id(1001);
const OTHER_PAYMENT = id(1002);
const JOB = id(2001);
const REFUND_REQUEST = id(3001);
const EXCEPTION = id(4001);
const JURISDICTION = id(5001);
const MODE = id(5002);
const T = "2026-11-20T10:00:00+00:00";
const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });

// ---------------------------------------------------------------------------
// The payment core
// ---------------------------------------------------------------------------

test("S7-1. the state and observation vocabularies are exactly the database's own (migration 20261123010000 and 20261123020000)", () => {
  const integrity = readFileSync(
    new URL(
      "supabase/migrations/20261123010000_mvp_001_s7_payment_integrity.sql",
      repositoryRoot,
    ),
    "utf8",
  );
  const states =
    /payment_transactions_state_v1_check\s+check \(state in \(([^)]*)\)\)/.exec(
      integrity,
    )[1];
  assert.deepEqual(
    [...states.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    [...PAYMENT_STATES],
  );
  const engine = readFileSync(
    new URL(
      "supabase/migrations/20261123020000_mvp_001_s7_payment_engine.sql",
      repositoryRoot,
    ),
    "utf8",
  );
  const kinds = /\(p_observation ->> 'kind'\) not in \(([^)]*)\)/.exec(
    engine,
  )[1];
  assert.deepEqual(
    [...kinds.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    [...OBSERVATION_KINDS],
  );
  assert.deepEqual(
    [...PAYMENT_JOB_TYPES],
    [
      "payment.checkout",
      "payment.capture",
      "payment.release",
      "payment.refund",
      "payment.reconcile",
    ],
  );
});

test("S7-2. an observation has exactly the database's members, each of its own form; anything else is refused before it is sent", () => {
  assert.ok(
    isObservation({
      kind: "authorization_confirmed",
      payment_transaction_id: PAYMENT,
      payment_reference: "pi_synthetic_1",
      amount_minor: 5225,
      currency_code: "USD",
    }),
  );
  assert.ok(isObservation({ kind: "ignored" }));
  assert.ok(
    isObservation({ kind: "checkout_expired", checkout_reference: null }),
  );
  for (const bad of [
    {},
    { kind: "made_up" },
    { kind: "authorization_confirmed", amount_minor: -1 },
    { kind: "authorization_confirmed", amount_minor: 1.5 },
    { kind: "authorization_confirmed", currency_code: "usd" },
    { kind: "authorization_confirmed", payment_reference: "pi with spaces" },
    { kind: "authorization_confirmed", payment_transaction_id: "not-a-uuid" },
    { kind: "authorization_confirmed", raw: {} },
    { kind: "provider_state", provider_status: "Requires Capture" },
    [],
    null,
  ]) {
    assert.equal(isObservation(bad), false, JSON.stringify(bad));
  }
});

test("S7-3. idempotency keys are deterministic per payment, operation and refund request; the checkout expiry stays within the provider's bounds around the canonical deadline", () => {
  assert.equal(
    idempotencyKeyFor(PAYMENT, "capture"),
    `rosuno-payment-${PAYMENT}-capture`,
  );
  assert.equal(
    idempotencyKeyFor(PAYMENT, "capture"),
    idempotencyKeyFor(PAYMENT, "capture"),
  );
  assert.notEqual(
    idempotencyKeyFor(PAYMENT, "capture"),
    idempotencyKeyFor(OTHER_PAYMENT, "capture"),
  );
  assert.notEqual(
    idempotencyKeyFor(PAYMENT, "cancel"),
    idempotencyKeyFor(PAYMENT, "capture"),
  );
  assert.equal(
    idempotencyKeyFor(PAYMENT, "refund", REFUND_REQUEST),
    `rosuno-payment-${PAYMENT}-refund-${REFUND_REQUEST}`,
  );
  const now = Date.parse("2026-11-20T10:00:00Z");
  const seconds = Math.floor(now / 1000);
  assert.equal(
    checkoutExpiryOf("2026-11-20T10:05:00Z", now),
    seconds + CHECKOUT_MIN_SECONDS,
  );
  assert.equal(
    checkoutExpiryOf("2026-11-25T10:00:00Z", now),
    seconds + CHECKOUT_MAX_SECONDS,
  );
  assert.equal(checkoutExpiryOf("2026-11-20T12:00:00Z", now), seconds + 7200);
  assert.equal(checkoutExpiryOf(null, now), seconds + CHECKOUT_MIN_SECONDS);
  assert.ok(
    CHECKOUT_MIN_SECONDS >= 30 * 60 && CHECKOUT_MAX_SECONDS <= 24 * 3600,
  );
});

const CONTEXT = (overrides = {}) => ({
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
  checkout_expires_at: "2026-11-20T10:15:00+00:00",
  ...overrides,
});

test("S7-4. the job context is read strictly: exactly its columns and forms, and an act context carries a payment, an amount and a consistent reference", () => {
  const context = jobContextOf([CONTEXT()]);
  assert.equal(context.outcome, "act");
  assert.equal(context.paymentId, PAYMENT);
  assert.equal(jobContextOf([CONTEXT(), CONTEXT()]), null);
  assert.equal(jobContextOf([]), null);
  assert.equal(jobContextOf(null), null);
  assert.equal(jobContextOf([{ ...CONTEXT(), extra: 1 }]), null);
  assert.equal(jobContextOf([CONTEXT({ outcome: "maybe" })]), null);
  assert.equal(jobContextOf([CONTEXT({ amount_minor: -5 })]), null);
  assert.equal(
    jobContextOf([
      CONTEXT({ reference_kind: "checkout", provider_reference: null }),
    ]),
    null,
  );
  assert.equal(
    jobContextOf([
      CONTEXT({ reference_kind: "none", provider_reference: "cs_x123" }),
    ]),
    null,
  );
  assert.equal(
    jobContextOf([
      CONTEXT({
        outcome: "not_running",
        operation: null,
        payment_transaction_id: null,
        consultation_request_id: null,
        state: null,
        reference_kind: null,
        currency_code: null,
        amount_minor: null,
        checkout_expires_at: null,
      }),
    ]).outcome,
    "not_running",
  );
});

// A fake provider recording every call; answers from a script.
function fakeProvider(script = {}) {
  const calls = [];
  const answer = (name, ...args) => {
    calls.push([name, ...args]);
    const entry = script[name];
    return typeof entry === "function" ? entry(...args) : entry;
  };
  const ok = (value) => ({ kind: "ok", value });
  return {
    calls,
    ok,
    provider: {
      createCheckout: async (...a) => answer("createCheckout", ...a),
      retrieveCheckout: async (...a) => answer("retrieveCheckout", ...a),
      expireCheckout: async (...a) => answer("expireCheckout", ...a),
      retrievePayment: async (...a) => answer("retrievePayment", ...a),
      capturePayment: async (...a) => answer("capturePayment", ...a),
      cancelPayment: async (...a) => answer("cancelPayment", ...a),
      createRefund: async (...a) => answer("createRefund", ...a),
      retrieveRefund: async (...a) => answer("retrieveRefund", ...a),
    },
  };
}

function fakeRecorder(context, recordOutcome = "applied") {
  const calls = [];
  return {
    calls,
    recorder: {
      jobContext: async (jobId) => {
        calls.push(["jobContext", jobId]);
        return context === null ? null : [context];
      },
      recordOperation: async (jobId, observation) => {
        calls.push(["recordOperation", jobId, observation]);
        return recordOutcome;
      },
      recordEvent: async () => ({ kind: "unknown" }),
    },
  };
}

const PI = (overrides = {}) => ({
  reference: "pi_synthetic_1",
  status: "requires_capture",
  amountMinor: 5225,
  amountCapturableMinor: 5225,
  amountReceivedMinor: 0,
  amountRefundedMinor: 0,
  currency: "USD",
  ...overrides,
});

async function runHandler(type, context, script, recordOutcome) {
  const p = fakeProvider(script);
  const r = fakeRecorder(context, recordOutcome);
  const handlers = createPaymentJobHandlers({
    provider: async () => p.provider,
    recorder: async () => r.recorder,
    clock: () => Date.parse("2026-11-20T10:00:00Z"),
  });
  const job = {
    jobId: JOB,
    jobType: type,
    subjectType: "payment_transaction",
    subjectId: PAYMENT,
    attempt: 1,
    maxAttempts: 8,
    idempotencyKey: `rosuno-job-${JOB}`,
    signal: new AbortController().signal,
  };
  let outcome;
  try {
    outcome = await handlers.get(type)(job);
  } catch (error) {
    outcome = error.name;
  }
  const recorded = r.calls
    .filter((c) => c[0] === "recordOperation")
    .map((c) => c[2]);
  return { outcome, providerCalls: p.calls, recorded };
}

test("S7-5. the checkout job creates the hosted checkout with the deterministic key and the bounded expiry, records the reference, and resolves JOB_DONE only once the database recorded it", async () => {
  const run = await runHandler("payment.checkout", CONTEXT(), {
    createCheckout: (input) => ({
      kind: "ok",
      value: {
        reference: "cs_test_synthetic",
        status: "open",
        paymentReference: null,
        url: null,
      },
    }),
  });
  assert.equal(run.outcome, JOB_DONE);
  assert.deepEqual(run.providerCalls, [
    [
      "createCheckout",
      {
        paymentId: PAYMENT,
        requestId: REQUEST,
        amountMinor: 5225,
        currency: "USD",
        expiresAt:
          Math.floor(Date.parse("2026-11-20T10:00:00Z") / 1000) +
          CHECKOUT_MIN_SECONDS,
      },
      `rosuno-payment-${PAYMENT}-checkout`,
    ],
  ]);
  assert.deepEqual(run.recorded, [
    { kind: "checkout_open", checkout_reference: "cs_test_synthetic" },
  ]);
  for (const outcome of [
    "no_effect",
    "stale",
    "contradiction",
    "not_running",
  ]) {
    const settled = await runHandler(
      "payment.checkout",
      CONTEXT(),
      {
        createCheckout: {
          kind: "ok",
          value: {
            reference: "cs_test_synthetic",
            status: "open",
            paymentReference: null,
            url: null,
          },
        },
      },
      outcome,
    );
    assert.equal(settled.outcome, JOB_DONE, outcome);
  }
  // An unknown recording answer, an invalid one, or a provider that did not
  // answer definitively: the attempt fails and the protocol retries it.
  for (const [script, recordOutcome] of [
    [
      {
        createCheckout: {
          kind: "ok",
          value: {
            reference: "cs_test_synthetic",
            status: "open",
            paymentReference: null,
            url: null,
          },
        },
      },
      "unknown",
    ],
    [
      {
        createCheckout: {
          kind: "ok",
          value: {
            reference: "cs_test_synthetic",
            status: "open",
            paymentReference: null,
            url: null,
          },
        },
      },
      "invalid",
    ],
    [{ createCheckout: { kind: "transient" } }, "applied"],
    [{ createCheckout: { kind: "rejected" } }, "applied"],
  ]) {
    const failed = await runHandler(
      "payment.checkout",
      CONTEXT(),
      script,
      recordOutcome,
    );
    assert.equal(failed.outcome, "PaymentJobRetry");
  }
});

test("S7-6. a job the payment no longer needs sends nothing; a release still waiting for its checkout, a missing recorder or provider, or an unreadable context retries", async () => {
  const done = await runHandler(
    "payment.checkout",
    CONTEXT({ outcome: "nothing_to_do" }),
    {},
  );
  assert.deepEqual(
    [done.outcome, done.providerCalls, done.recorded],
    [JOB_DONE, [], []],
  );
  const wait = await runHandler(
    "payment.release",
    CONTEXT({ outcome: "wait", operation: "release" }),
    {},
  );
  assert.deepEqual([wait.outcome, wait.providerCalls], ["PaymentJobRetry", []]);
  const unreadable = await runHandler("payment.checkout", null, {});
  assert.equal(unreadable.outcome, "PaymentJobRetry");
  const mismatched = await runHandler("payment.capture", CONTEXT(), {});
  assert.deepEqual(
    [mismatched.outcome, mismatched.providerCalls],
    ["PaymentJobRetry", []],
  );
  const handlers = createPaymentJobHandlers({
    provider: async () => null,
    recorder: async () => fakeRecorder(CONTEXT()).recorder,
    clock: () => 0,
  });
  await assert.rejects(handlers.get("payment.checkout")({ jobId: JOB }), {
    name: "PaymentJobRetry",
  });
  const noRecorder = createPaymentJobHandlers({
    provider: async () => fakeProvider().provider,
    recorder: async () => null,
    clock: () => 0,
  });
  await assert.rejects(noRecorder.get("payment.capture")({ jobId: JOB }), {
    name: "PaymentJobRetry",
  });
});

const CAPTURE = CONTEXT({
  operation: "capture",
  state: "capture_pending",
  provider_reference: "pi_synthetic_1",
  reference_kind: "payment",
  checkout_expires_at: null,
});

test("S7-7. (PM row 27; TA section 52) the capture job: success records capture_confirmed with the received amount; a decline or a missing payment records capture_refused; an unexpected state is read back first (succeeded: confirmed; canceled: refused; still pending: retry)", async () => {
  const success = await runHandler("payment.capture", CAPTURE, {
    capturePayment: {
      kind: "ok",
      value: PI({
        status: "succeeded",
        amountReceivedMinor: 5225,
        amountCapturableMinor: 0,
      }),
    },
  });
  assert.equal(success.outcome, JOB_DONE);
  assert.deepEqual(success.providerCalls[0], [
    "capturePayment",
    "pi_synthetic_1",
    5225,
    `rosuno-payment-${PAYMENT}-capture`,
  ]);
  assert.deepEqual(success.recorded, [
    {
      kind: "capture_confirmed",
      payment_reference: "pi_synthetic_1",
      amount_minor: 5225,
      currency_code: "USD",
    },
  ]);
  for (const kind of ["declined", "not_found"]) {
    const refused = await runHandler("payment.capture", CAPTURE, {
      capturePayment: { kind },
    });
    assert.deepEqual(
      refused.recorded,
      [{ kind: "capture_refused", payment_reference: "pi_synthetic_1" }],
      kind,
    );
  }
  const readBack = await runHandler("payment.capture", CAPTURE, {
    capturePayment: { kind: "invalid_state" },
    retrievePayment: {
      kind: "ok",
      value: PI({ status: "succeeded", amountReceivedMinor: 5225 }),
    },
  });
  assert.equal(readBack.recorded[0].kind, "capture_confirmed");
  const canceled = await runHandler("payment.capture", CAPTURE, {
    capturePayment: { kind: "invalid_state" },
    retrievePayment: { kind: "ok", value: PI({ status: "canceled" }) },
  });
  assert.equal(canceled.recorded[0].kind, "capture_refused");
  const pending = await runHandler("payment.capture", CAPTURE, {
    capturePayment: { kind: "invalid_state" },
    retrievePayment: { kind: "ok", value: PI({ status: "processing" }) },
  });
  assert.deepEqual(
    [pending.outcome, pending.recorded],
    ["PaymentJobRetry", []],
  );
  const transient = await runHandler("payment.capture", CAPTURE, {
    capturePayment: { kind: "transient" },
  });
  assert.deepEqual(
    [transient.outcome, transient.recorded],
    ["PaymentJobRetry", []],
  );
});

test("S7-8. (PM rows 3-5, 8-10) the release job: no checkout yet records the expiry; an open checkout is expired; a completed one has its authorization cancelled (recorded with the authorized amount); an authorization is cancelled; a capture found at the provider is recorded as a snapshot (a contradiction for review)", async () => {
  const release = (overrides) =>
    CONTEXT({
      operation: "release",
      state: "release_pending",
      checkout_expires_at: null,
      ...overrides,
    });
  const none = await runHandler("payment.release", release({}), {});
  assert.deepEqual(
    [none.providerCalls, none.recorded],
    [[], [{ kind: "checkout_expired" }]],
  );
  const expired = await runHandler(
    "payment.release",
    release({ provider_reference: "cs_test_open", reference_kind: "checkout" }),
    {
      expireCheckout: {
        kind: "ok",
        value: {
          reference: "cs_test_open",
          status: "expired",
          paymentReference: null,
          url: null,
        },
      },
    },
  );
  assert.deepEqual(expired.providerCalls, [
    ["expireCheckout", "cs_test_open", `rosuno-payment-${PAYMENT}-expire`],
  ]);
  assert.deepEqual(expired.recorded, [
    { kind: "checkout_expired", checkout_reference: "cs_test_open" },
  ]);
  const completed = await runHandler(
    "payment.release",
    release({ provider_reference: "cs_test_done", reference_kind: "checkout" }),
    {
      expireCheckout: { kind: "invalid_state" },
      retrieveCheckout: {
        kind: "ok",
        value: {
          reference: "cs_test_done",
          status: "complete",
          paymentReference: "pi_synthetic_2",
          url: null,
        },
      },
      retrievePayment: {
        kind: "ok",
        value: PI({ reference: "pi_synthetic_2" }),
      },
      cancelPayment: {
        kind: "ok",
        value: PI({
          reference: "pi_synthetic_2",
          status: "canceled",
          amountCapturableMinor: 0,
        }),
      },
    },
  );
  assert.deepEqual(
    completed.providerCalls.map((c) => c[0]),
    ["expireCheckout", "retrieveCheckout", "retrievePayment", "cancelPayment"],
  );
  assert.deepEqual(completed.recorded, [
    {
      kind: "authorization_released",
      payment_reference: "pi_synthetic_2",
      amount_minor: 5225,
      currency_code: "USD",
    },
  ]);
  const authorized = await runHandler(
    "payment.release",
    release({
      provider_reference: "pi_synthetic_1",
      reference_kind: "payment",
    }),
    {
      retrievePayment: { kind: "ok", value: PI() },
      cancelPayment: { kind: "ok", value: PI({ status: "canceled" }) },
    },
  );
  assert.deepEqual(authorized.providerCalls[1], [
    "cancelPayment",
    "pi_synthetic_1",
    `rosuno-payment-${PAYMENT}-cancel`,
  ]);
  assert.equal(authorized.recorded[0].kind, "authorization_released");
  const captured = await runHandler(
    "payment.release",
    release({
      provider_reference: "pi_synthetic_1",
      reference_kind: "payment",
    }),
    {
      retrievePayment: {
        kind: "ok",
        value: PI({ status: "succeeded", amountReceivedMinor: 5225 }),
      },
    },
  );
  assert.equal(captured.recorded[0].kind, "provider_state");
  assert.equal(captured.recorded[0].provider_status, "succeeded");
});

test("S7-9. (PM rows 28, 29) the refund job: the refund carries the payment, the refund request and the deterministic key; a pending answer is read again; a decline or an unexpected state records refund_refused", async () => {
  const refund = CONTEXT({
    operation: "refund",
    state: "refund_pending",
    provider_reference: "pi_synthetic_1",
    reference_kind: "payment",
    amount_minor: 1100,
    refund_request_id: REFUND_REQUEST,
    checkout_expires_at: null,
  });
  const run = await runHandler("payment.refund", refund, {
    createRefund: {
      kind: "ok",
      value: {
        reference: "re_synthetic",
        status: "pending",
        amountMinor: 1100,
      },
    },
    retrieveRefund: {
      kind: "ok",
      value: {
        reference: "re_synthetic",
        status: "succeeded",
        amountMinor: 1100,
      },
    },
  });
  assert.equal(run.outcome, JOB_DONE);
  assert.deepEqual(run.providerCalls[0], [
    "createRefund",
    {
      paymentId: PAYMENT,
      refundRequestId: REFUND_REQUEST,
      paymentReference: "pi_synthetic_1",
      amountMinor: 1100,
    },
    `rosuno-payment-${PAYMENT}-refund-${REFUND_REQUEST}`,
  ]);
  assert.deepEqual(run.recorded, [
    {
      kind: "refund_confirmed",
      payment_reference: "pi_synthetic_1",
      refund_reference: "re_synthetic",
      refund_request_id: REFUND_REQUEST,
      amount_minor: 1100,
      currency_code: "USD",
    },
  ]);
  for (const kind of ["declined", "invalid_state"]) {
    const refused = await runHandler("payment.refund", refund, {
      createRefund: { kind },
    });
    assert.deepEqual(refused.recorded, [
      {
        kind: "refund_refused",
        payment_reference: "pi_synthetic_1",
        refund_request_id: REFUND_REQUEST,
      },
    ]);
  }
  const stillPending = await runHandler("payment.refund", refund, {
    createRefund: {
      kind: "ok",
      value: {
        reference: "re_synthetic",
        status: "pending",
        amountMinor: 1100,
      },
    },
    retrieveRefund: {
      kind: "ok",
      value: {
        reference: "re_synthetic",
        status: "pending",
        amountMinor: 1100,
      },
    },
  });
  assert.deepEqual(
    [stillPending.outcome, stillPending.recorded],
    ["PaymentJobRetry", []],
  );
});

test("S7-10. (IMP section 23 reconciliation; TA section 26) the reconciliation job records the provider's snapshot as an observation; the database compares it", async () => {
  const reconcile = (overrides) =>
    CONTEXT({
      operation: "reconcile",
      state: "captured",
      checkout_expires_at: null,
      ...overrides,
    });
  const payment = await runHandler(
    "payment.reconcile",
    reconcile({
      provider_reference: "pi_synthetic_1",
      reference_kind: "payment",
    }),
    {
      retrievePayment: {
        kind: "ok",
        value: PI({
          status: "succeeded",
          amountReceivedMinor: 5225,
          amountRefundedMinor: 100,
        }),
      },
    },
  );
  assert.deepEqual(payment.recorded, [
    {
      kind: "provider_state",
      checkout_reference: null,
      payment_reference: "pi_synthetic_1",
      provider_status: "succeeded",
      amount_capturable_minor: 5225,
      amount_received_minor: 5225,
      amount_refunded_minor: 100,
      currency_code: "USD",
    },
  ]);
  const open = await runHandler(
    "payment.reconcile",
    reconcile({
      provider_reference: "cs_test_open",
      reference_kind: "checkout",
      state: "pending_authorization",
    }),
    {
      retrieveCheckout: {
        kind: "ok",
        value: {
          reference: "cs_test_open",
          status: "open",
          paymentReference: null,
          url: null,
        },
      },
    },
  );
  assert.deepEqual(open.recorded, [
    {
      kind: "provider_state",
      checkout_reference: "cs_test_open",
      provider_status: "checkout_open",
    },
  ]);
  const complete = await runHandler(
    "payment.reconcile",
    reconcile({
      provider_reference: "cs_test_done",
      reference_kind: "checkout",
      state: "pending_authorization",
    }),
    {
      retrieveCheckout: {
        kind: "ok",
        value: {
          reference: "cs_test_done",
          status: "complete",
          paymentReference: "pi_synthetic_9",
          url: null,
        },
      },
      retrievePayment: {
        kind: "ok",
        value: PI({ reference: "pi_synthetic_9" }),
      },
    },
  );
  assert.equal(complete.recorded[0].provider_status, "requires_capture");
  assert.equal(complete.recorded[0].checkout_reference, "cs_test_done");
  assert.equal(complete.recorded[0].payment_reference, "pi_synthetic_9");
});

test("S7-11. (PM row 33) an authenticated provider event is accepted when the database recorded it or already had it, rejected when it refused it as malformed, and unavailable (so the provider delivers again) when the answer is unknown", async () => {
  const event = {
    providerCode: "stripe",
    eventReference: "evt_synthetic_1",
    eventType: "payment_intent.payment_failed",
    occurredAt: "2026-11-20T10:00:00.000Z",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    observation: {
      kind: "authorization_failed",
      payment_reference: "pi_synthetic_1",
    },
  };
  const recorder = (answer) => ({
    jobContext: async () => null,
    recordOperation: async () => "unknown",
    recordEvent: async () => answer,
  });
  assert.equal(
    await recordProviderEvent(
      recorder(
        eventAnswerOf([{ outcome: "recorded", processing_state: "applied" }]),
      ),
      event,
    ),
    "accepted",
  );
  assert.equal(
    await recordProviderEvent(
      recorder(
        eventAnswerOf([{ outcome: "duplicate", processing_state: "applied" }]),
      ),
      event,
    ),
    "accepted",
  );
  assert.equal(
    await recordProviderEvent(
      recorder(eventAnswerOf([{ outcome: "invalid", processing_state: null }])),
      event,
    ),
    "rejected",
  );
  assert.equal(
    await recordProviderEvent(recorder({ kind: "unknown" }), event),
    "unavailable",
  );
  assert.equal(
    await recordProviderEvent(
      {
        ...recorder(null),
        recordEvent: async () => {
          throw new Error("synthetic");
        },
      },
      event,
    ),
    "unavailable",
  );
  assert.equal(
    await recordProviderEvent(
      recorder(
        eventAnswerOf([{ outcome: "recorded", processing_state: "applied" }]),
      ),
      {
        ...event,
        observation: { kind: "authorization_failed", raw: true },
      },
    ),
    "rejected",
  );
  // The strict event answer reader.
  assert.deepEqual(
    eventAnswerOf([{ outcome: "recorded", processing_state: "made_up" }]),
    { kind: "unknown" },
  );
  assert.deepEqual(
    eventAnswerOf([{ outcome: "recorded", processing_state: null }]),
    { kind: "unknown" },
  );
  assert.deepEqual(eventAnswerOf([]), { kind: "unknown" });
});

// ---------------------------------------------------------------------------
// The client's payment step, authorization and receipt
// ---------------------------------------------------------------------------

function paymentRow(overrides = {}) {
  return {
    consultation_request_id: REQUEST,
    payment_step: "authorization_required",
    payable: true,
    payment_transaction_id: null,
    payment_state: null,
    amount_authorized_minor: null,
    amount_captured_minor: null,
    amount_refunded_minor: null,
    total_client_amount_minor: 5225,
    currency_code: "USD",
    created_at: null,
    authorized_at: null,
    captured_at: null,
    failed_at: null,
    ...overrides,
  };
}

function receiptRow(overrides = {}) {
  return {
    payment_transaction_id: PAYMENT,
    consultation_request_id: REQUEST,
    payment_state: "partially_refunded",
    attorney_listed_price_minor: 5000,
    client_fee_minor: 175,
    tax_or_other_required_fee_minor: 50,
    total_client_amount_minor: 5225,
    currency_code: "USD",
    amount_authorized_minor: 5225,
    amount_captured_minor: 5225,
    amount_refunded_minor: 1100,
    created_at: T,
    authorized_at: T,
    captured_at: T,
    refunds: [{ amount_minor: 1100, effective_at: T }],
    ...overrides,
  };
}

function clientWorld(overrides = {}) {
  const calls = [];
  const state = {
    subject: ACCOUNT,
    payment: [paymentRow()],
    receipt: [receiptRow()],
    checkout: [
      {
        outcome: "ready",
        checkout_reference: "cs_test_synthetic",
        consultation_request_id: REQUEST,
      },
    ],
    environment: [{ environment_class: "development", project_ref: null }],
    configuredClass: "development",
    authorizeAnswer: {
      kind: "answer",
      outcome: "created",
      paymentId: PAYMENT,
      problem: null,
    },
    links: {
      checkoutUrl: async (reference) => {
        calls.push(["checkoutUrl", reference]);
        return "https://checkout.stripe.com/c/pay/cs_test_synthetic";
      },
    },
    ...overrides,
  };
  const clientIntake = {
    session: { currentSubject: async () => state.subject },
    contexts: { contextsOf: async () => ["client"] },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: state.subject,
        emailConfirmedAt: "2026-11-01T00:00:00Z",
      }),
    },
    reads: async () => ({
      usersOf: async (a) =>
        rows(
          a === ACCOUNT
            ? [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }]
            : [],
        ),
      clientProfilesOf: async (u) =>
        rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
    }),
    writes: async () => ({}),
  };
  const sources = {
    clientIntake,
    reads: async () => ({
      requestPayment: async (request) => {
        calls.push(["requestPayment", request]);
        return state.payment === null ? UNREADABLE : rows(state.payment);
      },
      receipt: async (payment) => {
        calls.push(["receipt", payment]);
        return rows(state.receipt);
      },
      checkout: async (payment) => {
        calls.push(["checkout", payment]);
        return rows(state.checkout);
      },
      environmentIdentity: async () => {
        calls.push(["environmentIdentity"]);
        return rows(state.environment);
      },
    }),
    writes: async () => ({
      authorize: async (request) => {
        calls.push(["authorize", request]);
        return state.authorizeAnswer;
      },
    }),
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
    checkoutLinks: async () => state.links,
    drain: async () => {
      calls.push(["drain"]);
    },
  };
  return { sources, calls, state };
}

function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

test("S7-12. the payment step is read strictly for the client's own Request: the step, whether an attempt can start, and the latest attempt; another client's or an unknown Request is not-found", async () => {
  const w = clientWorld();
  const view = await resolveRequestPayment(w.sources, REQUEST);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    [
      view.payment.step,
      view.payment.payable,
      view.payment.totalMinor,
      view.payment.latest,
    ],
    ["authorization_required", true, 5225, null],
  );
  const latest = clientWorld({
    payment: [
      paymentRow({
        payment_transaction_id: PAYMENT,
        payment_state: "failed",
        amount_refunded_minor: 0,
        created_at: T,
        failed_at: T,
      }),
    ],
  });
  const withLatest = await resolveRequestPayment(latest.sources, REQUEST);
  assert.equal(withLatest.payment.latest.state, "failed");
  assert.equal(
    (await resolveRequestPayment(clientWorld({ payment: [] }).sources, REQUEST))
      .status,
    "not-found",
  );
  assert.equal(
    (await resolveRequestPayment(w.sources, "not-a-uuid")).status,
    "not-found",
  );
  for (const bad of [
    [paymentRow({ payment_step: "pay_now" })],
    [paymentRow({ payable: true, payment_step: "not_required_now" })],
    [paymentRow({ consultation_request_id: id(999) })],
    [paymentRow({ payment_transaction_id: PAYMENT })],
    [paymentRow({ extra: 1 })],
    [paymentRow(), paymentRow()],
    null,
  ]) {
    assert.equal(
      (
        await resolveRequestPayment(
          clientWorld({ payment: bad }).sources,
          REQUEST,
        )
      ).status,
      "unavailable",
    );
  }
  assert.equal(
    (
      await resolveRequestPayment(
        clientWorld({ subject: null }).sources,
        REQUEST,
      )
    ).status,
    "sign-in-required",
  );
  // MVP-001 S8: exactly one more step, the authorization of an accepted
  // Request whose flow authorizes at the attorney's acceptance; it is the
  // only other step with which an attempt can start.
  assert.deepEqual(
    [...PAYMENT_STEPS],
    [
      "authorization_required",
      "not_required_now",
      "unavailable",
      "not_applicable",
      "authorization_after_acceptance",
    ],
  );
  const afterAcceptance = await resolveRequestPayment(
    clientWorld({
      payment: [paymentRow({ payment_step: "authorization_after_acceptance" })],
    }).sources,
    REQUEST,
  );
  assert.deepEqual(
    [afterAcceptance.payment.step, afterAcceptance.payment.payable],
    ["authorization_after_acceptance", true],
  );
  for (const step of ["unavailable", "not_applicable"]) {
    assert.equal(
      (
        await resolveRequestPayment(
          clientWorld({
            payment: [paymentRow({ payable: true, payment_step: step })],
          }).sources,
          REQUEST,
        )
      ).status,
      "unavailable",
      step,
    );
  }
});

test("S7-13. (Packet rule 7; MBS section 12) authorizing: with payments unconfigured the client gets the fixed unavailable outcome and nothing is sent; an unbound environment refuses before the database is asked; otherwise the database's attempt, one bounded worker run and the provider's hosted page (read by the server) answer a redirect", async () => {
  const unconfigured = clientWorld({ links: null });
  assert.deepEqual(
    await authorizeRequestPayment(
      unconfigured.sources,
      form({ request: REQUEST }),
    ),
    { status: "payments-unavailable" },
  );
  assert.deepEqual(unconfigured.calls, []);
  const mismatch = clientWorld({ configuredClass: "staging" });
  assert.deepEqual(
    await authorizeRequestPayment(mismatch.sources, form({ request: REQUEST })),
    { status: "unavailable" },
  );
  assert.deepEqual(mismatch.calls, [["environmentIdentity"]]);
  const w = clientWorld();
  assert.deepEqual(
    await authorizeRequestPayment(w.sources, form({ request: REQUEST })),
    {
      status: "redirect",
      url: "https://checkout.stripe.com/c/pay/cs_test_synthetic",
    },
  );
  assert.deepEqual(w.calls, [
    ["environmentIdentity"],
    ["authorize", REQUEST],
    ["drain"],
    ["checkout", PAYMENT],
    ["checkoutUrl", "cs_test_synthetic"],
  ]);
  const preparing = clientWorld({
    checkout: [
      {
        outcome: "preparing",
        checkout_reference: null,
        consultation_request_id: REQUEST,
      },
    ],
  });
  assert.deepEqual(
    await authorizeRequestPayment(
      preparing.sources,
      form({ request: REQUEST }),
    ),
    { status: "preparing" },
  );
  const notOpen = clientWorld({ links: { checkoutUrl: async () => null } });
  assert.deepEqual(
    await authorizeRequestPayment(notOpen.sources, form({ request: REQUEST })),
    { status: "preparing" },
  );
  const otherRequest = clientWorld({
    checkout: [
      {
        outcome: "ready",
        checkout_reference: "cs_test_synthetic",
        consultation_request_id: id(999),
      },
    ],
  });
  assert.deepEqual(
    await authorizeRequestPayment(
      otherRequest.sources,
      form({ request: REQUEST }),
    ),
    { status: "outcome-unknown" },
  );
  const outcomes = {
    pending: "redirect",
    invalid: "invalid",
    not_found: "not-found",
    expired: "expired",
    not_payable: "not-payable",
    not_required: "not-required",
    policy_unavailable: "configuration-unavailable",
    production_gate_closed: "configuration-unavailable",
  };
  for (const [outcome, status] of Object.entries(outcomes)) {
    const run = clientWorld({
      authorizeAnswer: {
        kind: "answer",
        outcome,
        paymentId: outcome === "pending" ? PAYMENT : null,
        problem: null,
      },
    });
    assert.equal(
      (await authorizeRequestPayment(run.sources, form({ request: REQUEST })))
        .status,
      status,
      outcome,
    );
  }
  assert.deepEqual(
    [...AUTHORIZE_OUTCOMES].sort(),
    [...Object.keys(outcomes), "created"].sort(),
  );
  for (const answer of [
    { kind: "unreadable" },
    { kind: "answer", outcome: "made_up", paymentId: null, problem: null },
  ]) {
    assert.equal(
      (
        await authorizeRequestPayment(
          clientWorld({ authorizeAnswer: answer }).sources,
          form({ request: REQUEST }),
        )
      ).status,
      "outcome-unknown",
    );
  }
  assert.equal(
    (
      await authorizeRequestPayment(
        clientWorld({ authorizeAnswer: { kind: "rejected" } }).sources,
        form({ request: REQUEST }),
      )
    ).status,
    "unavailable",
  );
  assert.equal(
    (await authorizeRequestPayment(w.sources, form({ request: "x" }))).status,
    "invalid",
  );
  const twice = new FormData();
  twice.append("request", REQUEST);
  twice.append("request", REQUEST);
  assert.equal(
    (await authorizeRequestPayment(w.sources, twice)).status,
    "invalid",
  );
  assert.equal(
    (await authorizeRequestPayment(w.sources, null)).status,
    "unavailable",
  );
  assert.equal(
    (
      await authorizeRequestPayment(
        clientWorld({ subject: null }).sources,
        form({ request: REQUEST }),
      )
    ).status,
    "sign-in-required",
  );
  assert.deepEqual(INITIAL_AUTHORIZE_STATE, { status: "idle" });
});

test("S7-14. a receipt is read strictly: the client-side quote amounts, the recorded state and amounts, and refunds that add up to the refunded amount", async () => {
  const view = await resolvePaymentReceipt(clientWorld().sources, PAYMENT);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    [
      view.receipt.totalMinor,
      view.receipt.amountRefundedMinor,
      view.receipt.refunds.length,
    ],
    [5225, 1100, 1],
  );
  assert.ok(!("platformFeeMinor" in view.receipt));
  for (const bad of [
    [receiptRow({ refunds: [] })],
    [receiptRow({ refunds: [{ amount_minor: 1000, effective_at: T }] })],
    [receiptRow({ payment_transaction_id: OTHER_PAYMENT })],
    [receiptRow({ platform_fee_minor: 500 })],
    [receiptRow({ payment_state: "paid" })],
  ]) {
    assert.equal(
      (
        await resolvePaymentReceipt(
          clientWorld({ receipt: bad }).sources,
          PAYMENT,
        )
      ).status,
      "unavailable",
    );
  }
  assert.equal(
    (await resolvePaymentReceipt(clientWorld({ receipt: [] }).sources, PAYMENT))
      .status,
    "not-found",
  );
});

test("S7-15. the attorney's earnings: only with the attorney principal, read strictly per payment, with one total per currency and never across currencies", async () => {
  const line = (overrides = {}) => ({
    payment_transaction_id: PAYMENT,
    consultation_request_id: REQUEST,
    captured_at: T,
    currency_code: "USD",
    attributed_minor: 4500,
    reversed_minor: 1000,
    net_minor: 3500,
    ...overrides,
  });
  const sourcesOf = (stage, answer) => ({
    session: { currentSubject: async () => ACCOUNT },
    attorney: {
      contextsOf: async () => (stage === null ? [] : ["attorney"]),
      principalOf: async () =>
        stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage },
    },
    reads: async () => ({ earnings: async () => answer }),
  });
  const view = await resolveAttorneyEarnings(
    sourcesOf(
      "approved",
      rows([
        line(),
        line({
          payment_transaction_id: OTHER_PAYMENT,
          currency_code: "EUR",
          attributed_minor: 900,
          reversed_minor: 0,
          net_minor: 900,
        }),
      ]),
    ),
  );
  assert.equal(view.status, "ready");
  assert.deepEqual(view.totals, [
    { currency: "EUR", attributedMinor: 900, reversedMinor: 0, netMinor: 900 },
    {
      currency: "USD",
      attributedMinor: 4500,
      reversedMinor: 1000,
      netMinor: 3500,
    },
  ]);
  assert.equal(
    (await resolveAttorneyEarnings(sourcesOf(null, rows([line()])))).status,
    "denied",
  );
  for (const bad of [
    rows([line({ net_minor: 1 })]),
    rows([line(), line()]),
    UNREADABLE,
  ]) {
    assert.equal(
      (await resolveAttorneyEarnings(sourcesOf("approved", bad))).status,
      "unavailable",
    );
  }
});

// ---------------------------------------------------------------------------
// The staff finance workspace
// ---------------------------------------------------------------------------

function financeWorld({
  capability = true,
  environment = "development",
  answers = {},
  payment = null,
} = {}) {
  const world = createWorld();
  const staff = addStaff(world, 7);
  if (capability) {
    grant(world, staff.userId, "manage_financial_operations");
  }
  const calls = [];
  const detail = payment ?? {
    payment_transaction_id: PAYMENT,
    consultation_request_id: REQUEST,
    request_path: "instant",
    request_state: "accepted",
    state: "captured",
    currency_code: "USD",
    attorney_listed_price_minor: 5000,
    platform_fee_minor: 500,
    client_fee_minor: 175,
    tax_or_other_required_fee_minor: 50,
    total_client_amount_minor: 5225,
    amount_authorized_minor: 5225,
    amount_captured_minor: 5225,
    amount_refunded_minor: 0,
    provider_code: "stripe",
    provider_payment_reference: "pi_synthetic_1",
    jurisdiction_id: JURISDICTION,
    regulatory_mode_id: MODE,
    referral_policy_version_id: id(6001),
    payment_policy_version_id: id(6002),
    fee_policy_version_id: id(6003),
    payment_flow_policy_version_id: id(6004),
    engagement_policy_version_id: id(6005),
    cancellation_policy_version_id: id(6006),
    refund_policy_version_id: id(6007),
    created_at: T,
    authorized_at: T,
    captured_at: T,
    failed_at: null,
    updated_at: T,
  };
  const ledgerLine = (entry_type, direction, amount_minor, n) => ({
    ledger_entry_id: id(7000 + n),
    entry_type,
    direction,
    amount_minor,
    currency_code: "USD",
    effective_at: T,
    source_reference: `capture:${PAYMENT}`,
    reason_code: "payment_captured",
  });
  const ledger = [
    ledgerLine("client_payment", "debit", 5225, 1),
    ledgerLine("attorney_share", "credit", 4500, 2),
    ledgerLine("platform_fee", "credit", 500, 3),
    ledgerLine("client_fee", "credit", 175, 4),
    ledgerLine("other_required_fee", "credit", 50, 5),
  ];
  const sources = {
    staff: configurationSources(world, staff.authId),
    reads: async () => ({
      payments: async (group, offset) => {
        calls.push(["payments", group, offset]);
        return rows(answers.payments ?? []);
      },
      payment: async (paymentId) => {
        calls.push(["payment", paymentId]);
        return rows(paymentId === PAYMENT ? [detail] : []);
      },
      ledger: async () => rows(answers.ledger ?? ledger),
      receipts: async () => rows(answers.receipts ?? []),
      exceptions: async (status, offset) => {
        calls.push(["exceptions", status, offset]);
        return rows(answers.exceptions ?? []);
      },
      environmentIdentity: async () =>
        rows([{ environment_class: "development", project_ref: null }]),
    }),
    writes: async () => ({
      requestRefund: async (input) => {
        calls.push(["requestRefund", input]);
        return answers.refund ?? { kind: "answer", outcome: "requested" };
      },
      assignException: async (exceptionId, assign) => {
        calls.push(["assignException", exceptionId, assign]);
        return { kind: "answer", outcome: "applied" };
      },
      resolveException: async (exceptionId, notes) => {
        calls.push(["resolveException", exceptionId, notes]);
        return answers.resolve ?? { kind: "answer", outcome: "applied" };
      },
      requestReconciliation: async (paymentId) => {
        calls.push(["requestReconciliation", paymentId]);
        return { kind: "answer", outcome: "requested" };
      },
    }),
    environment: () => ({
      configuredClass: environment,
      expectedProjectRef: null,
    }),
  };
  return { sources, calls, staff };
}

const PAYMENT_LIST_ROW = (n) => ({
  payment_transaction_id: id(8000 + n),
  consultation_request_id: REQUEST,
  state: "captured",
  currency_code: "USD",
  total_client_amount_minor: 5225,
  amount_authorized_minor: 5225,
  amount_captured_minor: 5225,
  amount_refunded_minor: 0,
  created_at: T,
  updated_at: T,
  open_exceptions: 0,
});

test("S7-16. (PS section 30.4; TA section 41) the finance workspace needs the global manage_financial_operations capability; lists are paged by the database (25 rows, one more tells another page follows)", async () => {
  const denied = financeWorld({ capability: false });
  assert.equal(
    (await resolveFinancePayments(denied.sources, "open", undefined)).status,
    "denied",
  );
  assert.equal(
    (await resolveFinanceExceptions(denied.sources, "open", undefined)).status,
    "denied",
  );
  assert.deepEqual(denied.calls, []);
  const w = financeWorld({
    answers: {
      payments: Array.from({ length: 26 }, (_, n) => PAYMENT_LIST_ROW(n)),
    },
  });
  const view = await resolveFinancePayments(w.sources, "collected", "2");
  assert.equal(view.status, "ready");
  assert.deepEqual(
    [view.group, view.payments.length, view.pager],
    ["collected", 25, { page: 2, hasNext: true }],
  );
  assert.deepEqual(w.calls, [["payments", "collected", 25]]);
  const fallback = financeWorld();
  const unknown = await resolveFinancePayments(fallback.sources, "everything", [
    "1",
    "2",
  ]);
  assert.deepEqual([unknown.group, unknown.pager.page], ["open", 1]);
  const malformed = financeWorld({
    answers: { payments: [{ ...PAYMENT_LIST_ROW(1), state: "paid" }] },
  });
  assert.equal(
    (await resolveFinancePayments(malformed.sources, "open", undefined)).status,
    "unavailable",
  );
});

test("S7-17. one payment: the detail, its ledger and receipts, and what remains refundable of each component computed from the ledger alone", async () => {
  const w = financeWorld();
  const view = await resolveFinancePayment(w.sources, PAYMENT);
  assert.equal(view.status, "ready");
  assert.deepEqual(view.refundable, {
    attorney_share: 4500,
    platform_fee: 500,
    client_fee: 175,
    other_required_fee: 50,
  });
  assert.equal(view.payment.policies.refund, id(6007));
  assert.equal(
    (await resolveFinancePayment(w.sources, OTHER_PAYMENT)).status,
    "not-found",
  );
  assert.deepEqual(
    refundableOf([
      ...view.ledger,
      {
        ...view.ledger[1],
        id: id(7100),
        direction: "debit",
        amountMinor: 1000,
      },
    ]).attorney_share,
    3500,
  );
});

test("S7-18. a staff refund: the allocation is typed in the payment's own currency (from the database, never the form) and sent in minor units with the reason; invalid entries, an unbound environment or no capability send nothing; the database's refusals are reported", async () => {
  const fields = {
    payment: PAYMENT,
    attorney_share: "10.00",
    platform_fee: "1",
    client_fee: "0",
    other_required_fee: "0.5",
    reason: "Synthetic staff reason",
  };
  const w = financeWorld();
  assert.deepEqual(await requestFinanceRefund(w.sources, form(fields)), {
    status: "recorded",
  });
  assert.deepEqual(w.calls.at(-1), [
    "requestRefund",
    {
      paymentId: PAYMENT,
      amounts: {
        attorney_share: 1000,
        platform_fee: 100,
        client_fee: 0,
        other_required_fee: 50,
      },
      reason: "Synthetic staff reason",
    },
  ]);
  for (const bad of [
    { ...fields, attorney_share: "-1" },
    { ...fields, attorney_share: "1.234" },
    {
      ...fields,
      attorney_share: "0",
      platform_fee: "0",
      other_required_fee: "0",
    },
    { ...fields, reason: " " },
    { ...fields, reason: "x".repeat(501) },
    { ...fields, payment: "x" },
  ]) {
    const run = financeWorld();
    assert.equal(
      (await requestFinanceRefund(run.sources, form(bad))).status,
      "invalid",
      JSON.stringify(bad),
    );
    assert.equal(
      run.calls.some((c) => c[0] === "requestRefund"),
      false,
    );
  }
  const unbound = financeWorld({ environment: "staging" });
  assert.equal(
    (await requestFinanceRefund(unbound.sources, form(fields))).status,
    "unavailable",
  );
  assert.equal(
    unbound.calls.some((c) => c[0] === "requestRefund"),
    false,
  );
  const denied = financeWorld({ capability: false });
  assert.equal(
    (await requestFinanceRefund(denied.sources, form(fields))).status,
    "denied",
  );
  for (const outcome of [
    "exceeds_refundable",
    "refund_in_progress",
    "not_refundable",
  ]) {
    const refused = financeWorld({
      answers: { refund: { kind: "answer", outcome } },
    });
    assert.deepEqual(
      await requestFinanceRefund(refused.sources, form(fields)),
      { status: "refused", reason: outcome },
    );
  }
  assert.equal(componentMinorOf("12", "JPY"), 12);
  assert.equal(componentMinorOf("12.5", "JPY"), null);
  assert.equal(componentMinorOf("0", "USD"), 0);
});

test("S7-19. exceptions: assigning to oneself sends only a yes (no User id at all; the database assigns the caller), clearing sends a no, resolution needs notes, and reconciliation names one payment or every live one", async () => {
  const w = financeWorld();
  assert.deepEqual(
    await assignFinanceException(
      w.sources,
      form({ exception: EXCEPTION, assign: "me" }),
    ),
    { status: "recorded" },
  );
  assert.deepEqual(w.calls.at(-1), ["assignException", EXCEPTION, true]);
  await assignFinanceException(
    w.sources,
    form({ exception: EXCEPTION, assign: "nobody" }),
  );
  assert.deepEqual(w.calls.at(-1), ["assignException", EXCEPTION, false]);
  assert.equal(
    (
      await assignFinanceException(
        w.sources,
        form({ exception: EXCEPTION, assign: id(77) }),
      )
    ).status,
    "invalid",
  );
  assert.deepEqual(
    await resolveFinanceException(
      w.sources,
      form({ exception: EXCEPTION, notes: "Synthetic notes" }),
    ),
    { status: "recorded" },
  );
  assert.equal(
    (
      await resolveFinanceException(
        w.sources,
        form({ exception: EXCEPTION, notes: "" }),
      )
    ).status,
    "invalid",
  );
  const transition = financeWorld({
    answers: { resolve: { kind: "answer", outcome: "invalid_transition" } },
  });
  assert.deepEqual(
    await resolveFinanceException(
      transition.sources,
      form({ exception: EXCEPTION, notes: "Again" }),
    ),
    {
      status: "refused",
      reason: "invalid_transition",
    },
  );
  assert.deepEqual(
    await requestFinanceReconciliation(w.sources, form({ payment: PAYMENT })),
    { status: "recorded" },
  );
  assert.deepEqual(w.calls.at(-1), ["requestReconciliation", PAYMENT]);
  await requestFinanceReconciliation(w.sources, new FormData());
  assert.deepEqual(w.calls.at(-1), ["requestReconciliation", null]);
});

// ---------------------------------------------------------------------------
// Source contracts of the S7 surfaces
// ---------------------------------------------------------------------------

test("S7-20. the S7 pages decide on the server for every request through the S7 use cases and production sources, and never read a credential, the provider key or a table", () => {
  const pages = {
    "app/client/payments/[payment]/page.tsx":
      "resolvePaymentReceipt(CLIENT_PAYMENT_SOURCES, payment)",
    "app/attorney/earnings/page.tsx":
      "resolveAttorneyEarnings(EARNINGS_SOURCES)",
    "app/staff/finance/page.tsx":
      "resolveFinancePayments(FINANCE_SOURCES, group, page)",
    "app/staff/finance/[payment]/page.tsx":
      "resolveFinancePayment(FINANCE_SOURCES, paymentId)",
    "app/staff/finance/exceptions/page.tsx":
      "resolveFinanceExceptions(FINANCE_SOURCES, status, page)",
  };
  for (const [file, call] of Object.entries(pages)) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.ok(code.replace(/\s+/g, " ").includes(call), file);
    assert.doesNotMatch(
      code,
      /createClient\b|ADMIN_KEY|service_role|sb_secret|STRIPE|stripe-provider|registration-provisioning|\.from\(|\.rpc\(|cookies\(|headers\(|dangerouslySetInnerHTML|process\.env/,
      file,
    );
  }
  // DEV-001: the payment page also shows the payment's dispute timeline
  // (E4) through the finance workspace's own use case and the same
  // production sources, with the same payment identifier the route names,
  // and asks it only once the payment itself is ready (a refused, unknown or
  // unavailable payment reads no dispute event).
  const payment = codeOf(read("app/staff/finance/[payment]/page.tsx"));
  assert.ok(
    payment
      .replace(/\s+/g, " ")
      .includes(
        "const disputes = await resolveFinanceDisputeTimeline( FINANCE_SOURCES, paymentId, );",
      ),
  );
  assert.equal(payment.match(/resolveFinanceDisputeTimeline\(/g).length, 1);
  assert.equal(payment.match(/FINANCE_SOURCES\b/g).length, 3);
  assert.ok(
    payment.indexOf(
      'return refusalPage(view, "/staff/finance/[payment]", "Finance");',
    ) < payment.indexOf("await resolveFinanceDisputeTimeline("),
  );
  assert.ok(
    payment.indexOf("notFound();") <
      payment.indexOf("await resolveFinanceDisputeTimeline("),
  );
  // The client never sees an infrastructure module or a provider key.
  for (const file of filesIn("app/").filter(
    (f) => /\.tsx?$/.test(f) && /["']use client["']/.test(read(f)),
  )) {
    assert.ok(
      importsOf(read(file)).every((s) => !/infrastructure/.test(s)),
      file,
    );
  }
  // Only the server-only Stripe adapter names the provider settings, and the
  // provider key is read through the configuration reader only.
  for (const file of [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
    /\.tsx?$/.test(f),
  )) {
    const code = codeOf(read(file));
    if (file === "src/infrastructure/notifications/resend-provider.ts") {
      // MVP-001 S10: the server-only Resend adapter names the "whsec_"
      // prefix of its own Svix-scheme webhook secret (its setting pattern and
      // the prefix it strips), and nothing else of these.
      assert.doesNotMatch(
        code,
        /ROSUNO_STRIPE_|sk_test_|rk_test_|api\.stripe\.com/,
        file,
      );
      assert.equal(code.match(/whsec_/g).length, 2, file);
      assert.match(
        code,
        /pattern: \/\^whsec_\[A-Za-z0-9\+\/=\]\{16,128\}\$\/,/,
        file,
      );
      assert.ok(code.includes('value.slice("whsec_".length)'), file);
    } else if (file !== "src/infrastructure/payments/stripe-provider.ts") {
      assert.doesNotMatch(
        code,
        /ROSUNO_STRIPE_|sk_test_|rk_test_|whsec_|api\.stripe\.com/,
        file,
      );
    }
  }
  const adapter = codeOf(
    read("src/infrastructure/payments/stripe-provider.ts"),
  );
  assert.doesNotMatch(
    adapter,
    /process\.env\.ROSUNO_STRIPE|\bconsole\b|logRequestEvent/,
  );
  assert.equal(adapter.match(/"ROSUNO_STRIPE_SECRET_KEY"/g).length, 1);
  assert.equal(adapter.match(/"ROSUNO_STRIPE_WEBHOOK_SECRET"/g).length, 1);
  // No provider SDK and no browser payment script.
  for (const file of [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
    /\.tsx?$/.test(f),
  )) {
    for (const specifier of importsOf(read(file))) {
      // A package specifier (not a relative module path) never names Stripe.
      assert.doesNotMatch(specifier, /^[^.].*stripe/i, `${file}: ${specifier}`);
    }
    assert.doesNotMatch(read(file), /js\.stripe\.com|@stripe\//, file);
  }
});

test("S7-21. the payment wording is fixed and neutral: no entitlement, settlement, escrow or earned-fee claim, and no banned recommendation claim", () => {
  const labels = codeOf(read("src/presentation/payment-labels.ts"));
  assert.doesNotMatch(
    labels,
    /\bearned\b|entitle|guarantee|escrow|trust account|\bsettled\b|best attorney|recommended/i,
  );
  for (const file of [
    "app/client/payments/[payment]/page.tsx",
    "app/attorney/earnings/page.tsx",
    "app/client/requests/[request]/page.tsx",
  ]) {
    assert.doesNotMatch(
      codeOf(read(file)),
      /\bearned\b|entitle|guarantee|escrow/i,
      file,
    );
  }
});
