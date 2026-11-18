// MVP-001 S7 L4 provider verification runner (Stripe TEST MODE only).
//
// Packet section 5 level L4: the real provider in test mode. This runner is
// committed but is not part of any suite and never runs on its own: it does
// nothing unless the operator opts in explicitly, and it refuses every key
// that is not a Stripe test-mode secret or restricted key (sk_test_ or
// rk_test_). It talks only to api.stripe.com with the pinned Stripe-Version,
// creates test-mode objects only (synthetic amounts, Stripe's documented test
// payment methods, no customer and no personal data), and writes one JSON
// evidence document to stdout. It never prints the key, a header, a Checkout
// URL or a provider message; it prints object identifiers (test-mode), statuses,
// amounts, neutral result kinds and the observation kinds Rosuno derives.
//
// Usage (the operator supplies the key through the environment; never pass it
// on the command line):
//
//   ROSUNO_S7_STRIPE_L4=run ROSUNO_STRIPE_SECRET_KEY=<test-mode key> \
//     node apps/web/tests/mvp-001-s7-stripe-l4.mjs > s7-stripe-l4.json
//
// STRIPE_SECRET_KEY is read when ROSUNO_STRIPE_SECRET_KEY is absent.
// ROSUNO_AUTH_PUBLIC_ORIGIN (optional) is used for the Checkout return URLs;
// http://localhost:3000 otherwise (the S1 provider-configuration guard refuses
// placeholder-like origins such as example.com; the session is expired, never
// completed).
// Exit status: 0 every assertion passed; 1 an assertion failed or a call was
// refused unexpectedly; 2 not run (no opt-in, or the key is not test mode).
//
// Scenarios (each through the S7 adapter where the adapter has the operation;
// PaymentIntents are confirmed directly with Stripe's test payment methods,
// which stands in for the client's hosted Checkout confirmation):
//   C1 Checkout Session in payment mode with manual capture: create, read,
//      expire, replay the expire with the same Idempotency-Key, expire again
//      with a new key (observed kind recorded);
//   A1 authorization (pm_card_visa, manual capture) then full capture; the
//      same capture key replayed answers the same capture; a capture with a
//      new key after capture is invalid_state;
//   A2 authorization then release (cancel); capture after release is
//      invalid_state;
//   A3 a declined authorization (pm_card_chargeDeclined) is declined;
//   R1 capture, partial refund, its replay with the same key returns the same
//      refund, a second refund of the remainder, a third refund is
//      invalid_state;
//   D1 a dispute (pm_card_createDispute): authorization, capture, the dispute
//      read back and mapped to dispute_opened;
//   E1 the account's events for the objects above are listed and each is
//      mapped through the webhook's event reader (test mode, digest) and the
//      observation mapping; the expected observation kinds (checkout expiry,
//      authorization, capture, release, dispute) must appear; refund events
//      are recorded when the account emits them.
// Webhook signature verification needs an endpoint's signing secret and a
// delivery; it is covered by the L3 tests with locally generated secrets and
// by the lead's separate endpoint check.

import { randomUUID } from "node:crypto";

import {
  CHECKOUT_MIN_SECONDS,
  idempotencyKeyFor,
} from "../src/application/payments.ts";
import {
  STRIPE_API_ORIGIN,
  STRIPE_API_VERSION,
  createStripeProvider,
  errorKindOf,
  formEncode,
  isTestModeKey,
  observationOf,
  stripeEventOf,
} from "../src/infrastructure/payments/stripe-provider.ts";

const OPT_IN = process.env.ROSUNO_S7_STRIPE_L4 === "run";
const KEY =
  process.env.ROSUNO_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? null;

function emit(document, code) {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.exitCode = code;
}

const RUN = {
  runner: "mvp-001-s7-stripe-l4",
  level: "L4",
  provider: "stripe",
  mode: "test",
  api_version: STRIPE_API_VERSION,
  run_id: randomUUID(),
  started_at: new Date().toISOString(),
};

if (!OPT_IN) {
  emit(
    {
      ...RUN,
      status: "not_run",
      reason: "opt-in absent: set ROSUNO_S7_STRIPE_L4=run to run",
    },
    2,
  );
} else if (!isTestModeKey(KEY)) {
  emit(
    {
      ...RUN,
      status: "not_run",
      reason:
        "no Stripe test-mode key (sk_test_ or rk_test_) in ROSUNO_STRIPE_SECRET_KEY or STRIPE_SECRET_KEY",
    },
    2,
  );
} else {
  await main(KEY);
}

async function main(testKey) {
  const origin =
    process.env.ROSUNO_AUTH_PUBLIC_ORIGIN ?? "http://localhost:3000";
  const calls = [];
  // A recording transport: method, path and status only (no header, no body).
  const transport = async (url, init) => {
    const response = await fetch(url, init);
    calls.push({
      method: init.method,
      path: new URL(url).pathname,
      status: response.status,
    });
    return response;
  };
  const provider = createStripeProvider({
    environment: {
      ROSUNO_ENVIRONMENT_CLASS: "development",
      ROSUNO_STRIPE_SECRET_KEY: testKey,
      ROSUNO_AUTH_PUBLIC_ORIGIN: origin,
    },
    apiOrigin: STRIPE_API_ORIGIN,
    transport,
    timeoutMs: 20_000,
  });
  const scenarios = [];
  const created = new Set();
  const expected = new Map();

  function scenario(name) {
    const record = { scenario: name, steps: [], assertions: [], pass: true };
    scenarios.push(record);
    return {
      step(label, value) {
        record.steps.push({ step: label, ...value });
      },
      check(label, actual, wanted) {
        const ok = Array.isArray(wanted)
          ? wanted.includes(actual)
          : actual === wanted;
        record.assertions.push({
          assertion: label,
          actual,
          expected: wanted,
          ok,
        });
        if (!ok) {
          record.pass = false;
        }
        return ok;
      },
      fail(label, error) {
        record.assertions.push({
          assertion: label,
          actual: error instanceof Error ? error.name : "error",
          expected: "no error",
          ok: false,
        });
        record.pass = false;
      },
    };
  }

  function expect(reference, kinds) {
    created.add(reference);
    expected.set(reference, [...(expected.get(reference) ?? []), ...kinds]);
  }

  // An object whose events are mapped and recorded but not required (refund
  // event types depend on the account's event configuration; the refund job
  // reads every refund back, so Rosuno never depends on them).
  function track(reference) {
    if (typeof reference === "string") {
      created.add(reference);
    }
  }

  // A direct, form-encoded call for the operations the adapter does not
  // have (confirming a PaymentIntent with a test payment method, listing
  // disputes and events). Same pinned version; every POST carries a key.
  async function direct(method, path, parameters, idempotencyKey) {
    const headers = {
      authorization: `Bearer ${testKey}`,
      "stripe-version": STRIPE_API_VERSION,
    };
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["idempotency-key"] = idempotencyKey;
    }
    const response = await fetch(`${STRIPE_API_ORIGIN}${path}`, {
      method,
      headers,
      body: method === "POST" ? formEncode(parameters) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    calls.push({
      method,
      path: new URL(`${STRIPE_API_ORIGIN}${path}`).pathname,
      status: response.status,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body !== null && typeof body === "object" && body.livemode === true) {
      throw new Error("live-mode object refused");
    }
    return response.ok
      ? { kind: "ok", body }
      : { kind: errorKindOf(response.status, body), body: null };
  }

  async function authorize(paymentId, paymentMethod) {
    return direct(
      "POST",
      "/v1/payment_intents",
      {
        amount: 5225,
        currency: "usd",
        capture_method: "manual",
        confirm: "true",
        payment_method: paymentMethod,
        "payment_method_types[0]": "card",
        "metadata[rosuno_payment_transaction]": paymentId,
        "metadata[rosuno_l4_run]": RUN.run_id,
      },
      `rosuno-l4-${RUN.run_id}-${paymentId}-authorize`,
    );
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // C1 Checkout Session create, read and expire.
  {
    const s = scenario("C1 checkout session: create, read, expire, replay");
    try {
      const paymentId = randomUUID();
      const created1 = await provider.createCheckout(
        {
          paymentId,
          requestId: randomUUID(),
          amountMinor: 5225,
          currency: "USD",
          expiresAt: Math.floor(Date.now() / 1000) + CHECKOUT_MIN_SECONDS,
        },
        idempotencyKeyFor(paymentId, "checkout"),
      );
      s.check("create kind", created1.kind, "ok");
      if (created1.kind === "ok") {
        const reference = created1.value.reference;
        expect(reference, ["checkout_expired"]);
        s.step("created", {
          reference,
          status: created1.value.status,
          url_host:
            created1.value.url === null
              ? null
              : new URL(created1.value.url).host,
        });
        s.check("open", created1.value.status, "open");
        s.check("hosted url present", created1.value.url !== null, true);
        const read = await provider.retrieveCheckout(reference);
        s.check("read kind", read.kind, "ok");
        s.check("read status", read.value?.status, "open");
        const expireKey = idempotencyKeyFor(paymentId, "expire");
        const expired = await provider.expireCheckout(reference, expireKey);
        s.check("expire kind", expired.kind, "ok");
        s.check("expired", expired.value?.status, "expired");
        const replay = await provider.expireCheckout(reference, expireKey);
        s.check("replayed expire kind (same key)", replay.kind, "ok");
        s.check("replayed expire status", replay.value?.status, "expired");
        const again = await provider.expireCheckout(
          reference,
          `rosuno-l4-${RUN.run_id}-${paymentId}-expire-again`,
        );
        s.step("expire again with a new key (observed)", {
          kind: again.kind,
        });
        s.check("expire again is refused", again.kind, [
          "invalid_state",
          "rejected",
        ]);
      }
    } catch (error) {
      s.fail("no error", error);
    }
  }

  // A1 authorization then full capture.
  {
    const s = scenario("A1 authorization then capture; capture replay");
    try {
      const paymentId = randomUUID();
      const intent = await authorize(paymentId, "pm_card_visa");
      s.check("authorize kind", intent.kind, "ok");
      if (intent.kind === "ok") {
        const reference = intent.body.id;
        expect(reference, ["authorization_confirmed", "capture_confirmed"]);
        s.check("requires capture", intent.body.status, "requires_capture");
        const before = await provider.retrievePayment(reference);
        s.check("read status", before.value?.status, "requires_capture");
        s.check("capturable", before.value?.amountCapturableMinor, 5225);
        const key = idempotencyKeyFor(paymentId, "capture");
        const capture = await provider.capturePayment(reference, 5225, key);
        s.check("capture kind", capture.kind, "ok");
        s.check("succeeded", capture.value?.status, "succeeded");
        s.check("received", capture.value?.amountReceivedMinor, 5225);
        const replay = await provider.capturePayment(reference, 5225, key);
        s.check("replayed capture kind (same key)", replay.kind, "ok");
        s.check("replayed received", replay.value?.amountReceivedMinor, 5225);
        const second = await provider.capturePayment(
          reference,
          5225,
          `rosuno-l4-${RUN.run_id}-${paymentId}-capture-again`,
        );
        s.check("capture again (new key)", second.kind, "invalid_state");
        s.step("captured", { reference });
      }
    } catch (error) {
      s.fail("no error", error);
    }
  }

  // A2 authorization then release.
  {
    const s = scenario("A2 authorization then release; capture after release");
    try {
      const paymentId = randomUUID();
      const intent = await authorize(paymentId, "pm_card_visa");
      s.check("authorize kind", intent.kind, "ok");
      if (intent.kind === "ok") {
        const reference = intent.body.id;
        expect(reference, [
          "authorization_confirmed",
          "authorization_released",
        ]);
        const cancel = await provider.cancelPayment(
          reference,
          idempotencyKeyFor(paymentId, "cancel"),
        );
        s.check("release kind", cancel.kind, "ok");
        s.check("canceled", cancel.value?.status, "canceled");
        const capture = await provider.capturePayment(
          reference,
          5225,
          idempotencyKeyFor(paymentId, "capture"),
        );
        s.check("capture after release", capture.kind, "invalid_state");
        s.step("released", { reference });
      }
    } catch (error) {
      s.fail("no error", error);
    }
  }

  // A3 a declined authorization.
  {
    const s = scenario("A3 declined authorization");
    try {
      const intent = await authorize(randomUUID(), "pm_card_chargeDeclined");
      s.check("declined", intent.kind, "declined");
    } catch (error) {
      s.fail("no error", error);
    }
  }

  // R1 partial and full refunds.
  {
    const s = scenario(
      "R1 capture, partial refund, replay, remainder, over-refund",
    );
    try {
      const paymentId = randomUUID();
      const intent = await authorize(paymentId, "pm_card_visa");
      s.check("authorize kind", intent.kind, "ok");
      if (intent.kind === "ok") {
        const reference = intent.body.id;
        expect(reference, ["authorization_confirmed", "capture_confirmed"]);
        const capture = await provider.capturePayment(
          reference,
          5225,
          idempotencyKeyFor(paymentId, "capture"),
        );
        s.check("capture kind", capture.kind, "ok");
        const first = randomUUID();
        const firstKey = idempotencyKeyFor(paymentId, "refund", first);
        const partial = await provider.createRefund(
          {
            paymentId,
            refundRequestId: first,
            paymentReference: reference,
            amountMinor: 1100,
          },
          firstKey,
        );
        s.check("partial refund kind", partial.kind, "ok");
        s.check("partial refund status", partial.value?.status, [
          "succeeded",
          "pending",
        ]);
        track(partial.value?.reference);
        const replay = await provider.createRefund(
          {
            paymentId,
            refundRequestId: first,
            paymentReference: reference,
            amountMinor: 1100,
          },
          firstKey,
        );
        s.check(
          "replayed refund is the same refund (same key)",
          replay.value?.reference,
          partial.value?.reference,
        );
        const read = await provider.retrieveRefund(partial.value?.reference);
        s.check("refund read kind", read.kind, "ok");
        const afterPartial = await provider.retrievePayment(reference);
        s.check(
          "refunded so far",
          afterPartial.value?.amountRefundedMinor,
          1100,
        );
        const second = randomUUID();
        const remainder = await provider.createRefund(
          {
            paymentId,
            refundRequestId: second,
            paymentReference: reference,
            amountMinor: 4125,
          },
          idempotencyKeyFor(paymentId, "refund", second),
        );
        s.check("remainder refund kind", remainder.kind, "ok");
        track(remainder.value?.reference);
        const afterFull = await provider.retrievePayment(reference);
        s.check("fully refunded", afterFull.value?.amountRefundedMinor, 5225);
        const third = randomUUID();
        const over = await provider.createRefund(
          {
            paymentId,
            refundRequestId: third,
            paymentReference: reference,
            amountMinor: 1,
          },
          idempotencyKeyFor(paymentId, "refund", third),
        );
        s.check("refund beyond the captured amount", over.kind, [
          "invalid_state",
          "rejected",
        ]);
        s.step("refunded", {
          reference,
          refunds: [partial.value?.reference, remainder.value?.reference],
        });
      }
    } catch (error) {
      s.fail("no error", error);
    }
  }

  // D1 a dispute.
  {
    const s = scenario("D1 dispute observed");
    try {
      const paymentId = randomUUID();
      const intent = await authorize(paymentId, "pm_card_createDispute");
      s.check("authorize kind", intent.kind, "ok");
      if (intent.kind === "ok") {
        const reference = intent.body.id;
        expect(reference, ["capture_confirmed", "dispute_opened"]);
        const capture = await provider.capturePayment(
          reference,
          5225,
          idempotencyKeyFor(paymentId, "capture"),
        );
        s.check("capture kind", capture.kind, "ok");
        let dispute = null;
        for (let attempt = 0; attempt < 30 && dispute === null; attempt += 1) {
          await sleep(2000);
          const listed = await direct(
            "GET",
            `/v1/disputes?payment_intent=${encodeURIComponent(reference)}&limit=3`,
          );
          dispute =
            listed.kind === "ok" && Array.isArray(listed.body?.data)
              ? (listed.body.data[0] ?? null)
              : null;
        }
        s.check("dispute appeared", dispute !== null, true);
        if (dispute !== null) {
          const observation = observationOf("charge.dispute.created", dispute);
          s.check("dispute observation", observation.kind, "dispute_opened");
          s.check(
            "dispute references the payment",
            observation.payment_reference,
            reference,
          );
          s.step("disputed", {
            reference,
            dispute_reference: dispute.id,
            dispute_status: dispute.status,
          });
        }
      }
    } catch (error) {
      s.fail("no error", error);
    }
  }

  // E1 events mapped to observations.
  {
    const s = scenario("E1 events mapped to observations");
    try {
      const since = Math.floor(Date.parse(RUN.started_at) / 1000) - 5;
      const seen = new Map();
      const mapped = [];
      for (let round = 0; round < 10; round += 1) {
        let after = null;
        for (let page = 0; page < 5; page += 1) {
          const listed = await direct(
            "GET",
            `/v1/events?limit=100&created%5Bgte%5D=${since}${
              after === null
                ? ""
                : `&starting_after=${encodeURIComponent(after)}`
            }`,
          );
          if (listed.kind !== "ok" || !Array.isArray(listed.body?.data)) {
            break;
          }
          for (const event of listed.body.data) {
            const object = event?.data?.object ?? {};
            const related = [object.id, object.payment_intent].find((value) =>
              created.has(value),
            );
            if (related === undefined || seen.has(event.id)) {
              continue;
            }
            const receipt = stripeEventOf(
              Buffer.from(JSON.stringify(event), "utf8"),
            );
            const kind = observationOf(event.type, object).kind;
            seen.set(event.id, true);
            mapped.push({
              event_reference: event.id,
              type: event.type,
              related,
              observation: kind,
              receipt_accepted: receipt !== null,
            });
          }
          if (!listed.body.has_more || listed.body.data.length === 0) {
            break;
          }
          after = listed.body.data[listed.body.data.length - 1].id;
        }
        const missing = [...expected].flatMap(([reference, kinds]) =>
          kinds
            .filter(
              (kind) =>
                !mapped.some(
                  (entry) =>
                    entry.related === reference && entry.observation === kind,
                ),
            )
            .map((kind) => `${reference}:${kind}`),
        );
        if (missing.length === 0 || round === 9) {
          s.step("events", { mapped });
          s.check("every expected observation appeared", missing.join(","), "");
          s.check(
            "every related event is a test-mode receipt",
            mapped.every((entry) => entry.receipt_accepted),
            true,
          );
          break;
        }
        await sleep(3000);
      }
    } catch (error) {
      s.fail("no error", error);
    }
  }

  const pass = scenarios.every((record) => record.pass);
  emit(
    {
      ...RUN,
      key_kind: testKey.slice(0, 7),
      finished_at: new Date().toISOString(),
      status: pass ? "passed" : "failed",
      scenarios,
      calls,
    },
    pass ? 0 : 1,
  );
}
