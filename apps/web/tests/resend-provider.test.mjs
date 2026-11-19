// MVP-001 S10 L3 contract tests (SIMULATED). Packet section 5 level L3:
// adapter correctness only, never integration completion.
//
// The Resend adapter is exercised against a local fake Resend HTTP server
// written here (node:http on 127.0.0.1, an ephemeral port), which records
// every request and answers with recorded Resend response shapes. No Resend
// host (api.resend.com or any other) is contacted. The API key, the webhook
// secret and every address (on the reserved .invalid domain) are synthetic
// values generated in this file. The probes cover the configuration rules
// (absent, malformed or placeholder settings mean no adapter), the request
// shape (method, path, JSON body, the key in the Authorization header only,
// the Idempotency-Key, no redirect), idempotent replay, the error mapping,
// the status read and its restricted-key refusal, Svix webhook signature
// verification (valid, several signatures, tampering, wrong secret, stale or
// future timestamps, malformed headers, other scheme versions), the
// event-to-observation mapping, the webhook handler over a fake recording
// port, the route's methods, the notification job handler end to end over the
// real adapter, the fake server and a fake recording port, and that no key,
// address or message body reaches a log line.

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { JOB_DONE } from "../src/application/job-worker.ts";
import {
  centerUrlOf,
  createNotificationJobHandlers,
  EMAIL_TEMPLATES,
  emailIdempotencyKeyOf,
  emailMessageOf,
  isDeliveryAttempt,
  isEmailAddress,
  isEmailSendResult,
  NOTIFICATION_TYPES,
  NotificationJobRetry,
  notificationJobContextOf,
  recordNotificationEvent,
} from "../src/application/notifications.ts";
import {
  createResendEmailProvider,
  observationKindOf,
  readResendConfiguration,
  readResendWebhookSecret,
  readSiteOrigin,
  RESEND_PROVIDER_CODE,
  resendEventOf,
  sendFailureOf,
  sentReferenceOf,
  verifyResendSignature,
} from "../src/infrastructure/notifications/resend-provider.ts";
import { handleResendWebhook } from "../src/infrastructure/notifications/resend-webhook.ts";
import * as route from "../app/api/notifications/resend/route.ts";

// Synthetic credentials generated for this run only. The credential settings
// are named through constants, so no literal assignment to a credential-named
// key appears in this file (the P0 secret scan).
const KEY_SETTING = "ROSUNO_RESEND_API_KEY";
const FROM_SETTING = "ROSUNO_EMAIL_FROM";
const WEBHOOK_SETTING = "ROSUNO_RESEND_WEBHOOK_SECRET";
const TEST_KEY = `re_${randomBytes(20).toString("hex")}`;
const SIGNING_BYTES = randomBytes(24);
const SIGNING_SETTING_VALUE = `whsec_${SIGNING_BYTES.toString("base64")}`;
const FROM = "notifications@synthetic.invalid";
const TO = `recipient-${randomBytes(4).toString("hex")}@synthetic.invalid`;
const ORIGIN = "https://rosuno.synthetic.invalid";

const environment = (overrides = {}) => ({
  ROSUNO_ENVIRONMENT_CLASS: "development",
  [KEY_SETTING]: TEST_KEY,
  [FROM_SETTING]: FROM,
  [WEBHOOK_SETTING]: SIGNING_SETTING_VALUE,
  ROSUNO_AUTH_PUBLIC_ORIGIN: ORIGIN,
  ...overrides,
});

const NOTIFICATION = "00000000-0000-4000-8000-00000000aa01";
const JOB = "00000000-0000-4000-8000-00000000bb01";

// ---------------------------------------------------------------------------
// The local fake Resend API (simulated)
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
        json: body === "" ? null : JSON.parse(body),
      };
      fake.requests.push(recorded);
      const responder = fake.responders.shift();
      const [status, payload] = responder
        ? responder(recorded)
        : [500, { name: "internal_server_error", message: "synthetic" }];
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
  const built = createResendEmailProvider({
    environment: environment(),
    apiOrigin: fake.origin,
    timeoutMs: 1500,
    ...overrides,
  });
  assert.ok(built, "the adapter is configured");
  return built;
}

const message = () =>
  emailMessageOf("message_received", TO, `${ORIGIN}/client/notifications`);

async function captured(work) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("S10-L3-1 (simulated) configuration: the key, the sender address, the site origin and the webhook secret are read strictly; absent, malformed or placeholder settings mean no adapter, no link origin or no webhook (no fallback)", () => {
  assert.deepEqual(readResendConfiguration(environment()), {
    sendingKey: TEST_KEY,
    from: FROM,
  });
  assert.equal(readSiteOrigin(environment()), ORIGIN);
  assert.ok(readResendWebhookSecret(environment()).equals(SIGNING_BYTES));
  for (const overrides of [
    { [KEY_SETTING]: undefined },
    { [KEY_SETTING]: "" },
    { [KEY_SETTING]: "re_short" },
    { [KEY_SETTING]: TEST_KEY.replace("re_", "rk_") },
    { [KEY_SETTING]: `${TEST_KEY} ` },
    { [KEY_SETTING]: `re_dummy${"a".repeat(20)}` },
    { [FROM_SETTING]: undefined },
    { [FROM_SETTING]: "Rosuno <notifications@synthetic.invalid>" },
    { [FROM_SETTING]: "not-an-address" },
    { [FROM_SETTING]: "someone@example.com" },
    { ROSUNO_ENVIRONMENT_CLASS: undefined },
  ]) {
    assert.equal(readResendConfiguration(environment(overrides)), null);
    assert.equal(
      createResendEmailProvider({
        environment: environment(overrides),
        apiOrigin: fake.origin,
      }),
      null,
    );
  }
  for (const origin of [
    undefined,
    "",
    "ftp://rosuno.synthetic.invalid",
    "https://rosuno.synthetic.invalid/path",
    "https://example.com",
  ]) {
    assert.equal(
      readSiteOrigin(environment({ ROSUNO_AUTH_PUBLIC_ORIGIN: origin })),
      null,
    );
  }
  for (const secret of [
    undefined,
    "",
    SIGNING_BYTES.toString("base64"),
    "whsec_short",
    `whsec_${randomBytes(8).toString("base64")}`,
    `whsec_${SIGNING_BYTES.toString("base64")}!`,
  ]) {
    assert.equal(
      readResendWebhookSecret(environment({ [WEBHOOK_SETTING]: secret })),
      null,
    );
  }
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test("S10-L3-2 (simulated) a send is one POST /emails with the key in the Authorization header only, a JSON body of exactly the sender, one recipient, the subject, text and HTML, and the caller's Idempotency-Key; Resend's message id is the accepted reference; a replay with the same key answers the same reference", async () => {
  reset();
  const id = randomUUID();
  const replies = new Map();
  const reply = (request) => {
    const key = request.headers["idempotency-key"];
    if (!replies.has(key)) {
      replies.set(key, id);
    }
    return [200, { id: replies.get(key) }];
  };
  respondWith(reply);
  respondWith(reply);
  const resend = provider();
  const key = emailIdempotencyKeyOf(NOTIFICATION);
  const first = await resend.send(message(), key);
  const second = await resend.send(message(), key);
  assert.deepEqual(first, { kind: "accepted", reference: id });
  assert.deepEqual(second, first);
  assert.equal(resend.providerCode, RESEND_PROVIDER_CODE);
  assert.equal(fake.requests.length, 2);
  const [request] = fake.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/emails");
  assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(
    request.headers["idempotency-key"],
    `rosuno-notification-${NOTIFICATION}`,
  );
  assert.deepEqual(Object.keys(request.json), [
    "from",
    "to",
    "subject",
    "text",
    "html",
  ]);
  assert.equal(request.json.from, FROM);
  assert.deepEqual(request.json.to, [TO]);
  assert.equal(request.json.subject, EMAIL_TEMPLATES.message_received.subject);
  assert.ok(!request.body.includes(TEST_KEY));
  // A transport stub sees the redirect refusal and the bounded time.
  const seen = [];
  const stubbed = createResendEmailProvider({
    environment: environment(),
    apiOrigin: "https://api.resend.synthetic.invalid",
    transport: async (url, init) => {
      seen.push({ url, redirect: init.redirect, signal: init.signal });
      return new Response(JSON.stringify({ id }), { status: 200 });
    },
  });
  assert.deepEqual(await stubbed.send(message(), key), {
    kind: "accepted",
    reference: id,
  });
  assert.equal(seen[0].url, "https://api.resend.synthetic.invalid/emails");
  assert.equal(seen[0].redirect, "error");
  assert.ok(seen[0].signal instanceof AbortSignal);
});

test("S10-L3-3 (simulated) error mapping: rate limits, provider errors, a concurrent idempotent request, a timeout and a network failure are transient; a validation error, an unprocessable request, an idempotency conflict, an authentication failure and any other refusal are permanent; a 200 without a message id is transient (never taken as sent); a malformed message or key is refused before any call as not_sent with a fixed code (recipient_address_unsupported for a recipient outside the shared address rule, invalid_request otherwise), while a valid recipient with an apostrophe or another RFC 5322 atext character is sent", async () => {
  const table = [
    [400, { name: "validation_error" }, "permanent", "invalid_request"],
    [422, { name: "invalid_from_address" }, "permanent", "invalid_request"],
    [401, { name: "missing_api_key" }, "permanent", "provider_auth"],
    [403, { name: "validation_error" }, "permanent", "provider_refused"],
    [404, { name: "not_found" }, "permanent", "provider_refused"],
    [451, { name: "security_error" }, "permanent", "provider_refused"],
    [
      409,
      { name: "invalid_idempotent_request" },
      "permanent",
      "idempotency_conflict",
    ],
    [
      409,
      { name: "concurrent_idempotent_requests" },
      "transient",
      "idempotency_in_progress",
    ],
    [429, { name: "rate_limit_exceeded" }, "transient", "rate_limited"],
    [500, { name: "internal_server_error" }, "transient", "provider_error"],
    [503, null, "transient", "provider_error"],
  ];
  for (const [status, body, permanence, failureCode] of table) {
    assert.deepEqual(
      sendFailureOf(status, body),
      { kind: "failed", permanence, failureCode },
      `${status}`,
    );
    reset();
    respondWith(() => [status, body ?? "not json"]);
    const result = await provider().send(
      message(),
      emailIdempotencyKeyOf(NOTIFICATION),
    );
    assert.deepEqual(
      result,
      { kind: "failed", permanence, failureCode },
      `${status}`,
    );
  }
  reset();
  respondWith(() => [200, { object: "email" }]);
  assert.deepEqual(
    await provider().send(message(), emailIdempotencyKeyOf(NOTIFICATION)),
    {
      kind: "failed",
      permanence: "transient",
      failureCode: "malformed_answer",
    },
  );
  reset();
  respondWith(() => [200, "hang"]);
  assert.deepEqual(
    await provider({ timeoutMs: 200 }).send(
      message(),
      emailIdempotencyKeyOf(NOTIFICATION),
    ),
    { kind: "failed", permanence: "transient", failureCode: "network" },
  );
  const unreachable = createResendEmailProvider({
    environment: environment(),
    apiOrigin: "http://127.0.0.1:1",
    timeoutMs: 500,
  });
  assert.deepEqual(
    await unreachable.send(message(), emailIdempotencyKeyOf(NOTIFICATION)),
    { kind: "failed", permanence: "transient", failureCode: "network" },
  );
  reset();
  for (const to of [
    "not an address",
    "first,second@synthetic.invalid",
    'quoted"local@synthetic.invalid',
    "two@at@synthetic.invalid",
    "local@-host.synthetic.invalid",
    "@synthetic.invalid",
    `${"l".repeat(65)}@synthetic.invalid`,
  ]) {
    assert.deepEqual(
      await provider().send({ ...message(), to }, "rosuno-key"),
      { kind: "not_sent", failureCode: "recipient_address_unsupported" },
      to,
    );
  }
  const refusals = [
    [{ ...message(), subject: "" }, "rosuno-key"],
    [{ ...message(), text: "x".repeat(20001) }, "rosuno-key"],
    [message(), "a key with spaces"],
    [message(), ""],
  ];
  for (const [input, key] of refusals) {
    assert.deepEqual(await provider().send(input, key), {
      kind: "not_sent",
      failureCode: "invalid_request",
    });
  }
  assert.equal(fake.requests.length, 0);
  // Valid recipients the shared rule accepts are sent (synthetic addresses).
  const accepting = [
    "o'brien@synthetic.invalid",
    "first.last+tag@sub.synthetic.invalid",
    "a!#$%&'*+/=?^_`{|}~-z@synthetic.invalid",
  ];
  for (const to of accepting) {
    const id = randomUUID();
    respondWith(() => [200, { id }]);
    assert.deepEqual(
      await provider().send({ ...message(), to }, "rosuno-key"),
      { kind: "accepted", reference: id },
      to,
    );
  }
  assert.deepEqual(
    fake.requests.map((request) => request.json.to),
    accepting.map((to) => [to]),
  );
  reset();
  assert.equal(sentReferenceOf({ id: "bad id with spaces" }), null);
  for (const value of [
    { kind: "accepted", reference: "x" },
    { kind: "failed", permanence: "transient", failureCode: "network" },
    { kind: "not_sent", failureCode: "recipient_address_unsupported" },
    { kind: "not_sent", failureCode: "invalid_request" },
  ]) {
    assert.equal(isEmailSendResult(value), true);
  }
  for (const value of [
    { kind: "accepted", reference: "bad ref" },
    { kind: "failed", permanence: "maybe", failureCode: "network" },
    { kind: "failed", permanence: "transient", failureCode: "Network" },
    { kind: "accepted", reference: "x", extra: 1 },
    { kind: "not_sent", failureCode: "network" },
    { kind: "not_sent", failureCode: "provider_unconfigured" },
  ]) {
    assert.equal(isEmailSendResult(value), false);
  }
});

test("S10-L3-4 (simulated) status reads map Resend's last event into the observation vocabulary; a send-only key's 401 restricted_api_key is reported unavailable (restricted_key): delivery is then learned from webhooks only", async () => {
  reset();
  const id = randomUUID();
  respondWith(() => [200, { object: "email", id, last_event: "delivered" }]);
  respondWith(() => [
    401,
    { name: "restricted_api_key", message: "synthetic" },
  ]);
  respondWith(() => [404, { name: "not_found" }]);
  respondWith(() => [500, { name: "internal_server_error" }]);
  const resend = provider();
  assert.deepEqual(await resend.deliveryStatus(id), {
    kind: "ok",
    observation: "delivered",
  });
  assert.deepEqual(await resend.deliveryStatus(id), {
    kind: "unavailable",
    reason: "restricted_key",
  });
  assert.deepEqual(await resend.deliveryStatus(id), { kind: "not_found" });
  assert.deepEqual(await resend.deliveryStatus(id), {
    kind: "unavailable",
    reason: "provider_error",
  });
  assert.deepEqual(await resend.deliveryStatus("../emails"), {
    kind: "unavailable",
    reason: "provider_error",
  });
  assert.deepEqual(
    fake.requests.map((r) => [r.method, r.url, r.headers.authorization]),
    Array(4).fill(["GET", `/emails/${id}`, `Bearer ${TEST_KEY}`]),
  );
  assert.deepEqual(
    [
      "sent",
      "delivered",
      "delivery_delayed",
      "bounced",
      "complained",
      "failed",
      "suppressed",
      "opened",
      "clicked",
      "queued",
    ].map((event) => observationKindOf(event)),
    [
      "accepted",
      "delivered",
      "delivery_delayed",
      "bounced",
      "complained",
      "failed",
      "suppressed",
      "ignored",
      "ignored",
      "ignored",
    ],
  );
  assert.equal(observationKindOf("bounced", "Transient"), "failed");
  assert.equal(observationKindOf("bounced", "Permanent"), "bounced");
  assert.equal(observationKindOf("bounced", "Undetermined"), "bounced");
});

// ---------------------------------------------------------------------------
// Webhook authenticity (the Svix scheme)
// ---------------------------------------------------------------------------

const MESSAGE_ID = () => `msg_${randomBytes(12).toString("hex")}`;

function sign(body, id, timestamp, signingKey = SIGNING_BYTES) {
  return createHmac("sha256", signingKey)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");
}

test("S10-L3-5 (simulated) Svix signatures: the HMAC-SHA256 of id.timestamp.body with the decoded secret authenticates exactly that body; one valid v1 entry among several suffices and other versions are ignored; a tampered body, another secret, a stale or future timestamp beyond five minutes and malformed headers are refused", () => {
  const body = Buffer.from(
    JSON.stringify({ type: "email.delivered", data: { email_id: "x" } }),
  );
  const id = MESSAGE_ID();
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const valid = `v1,${sign(body, id, timestamp)}`;
  const verify = (overrides = {}) =>
    verifyResendSignature(
      overrides.body ?? body,
      overrides.id === undefined ? id : overrides.id,
      overrides.timestamp === undefined ? timestamp : overrides.timestamp,
      overrides.signatures === undefined ? valid : overrides.signatures,
      overrides.signingKey ?? SIGNING_BYTES,
      overrides.now ?? now,
    );
  assert.equal(verify(), true);
  assert.equal(
    verify({
      signatures: `v1,${sign(body, id, timestamp, randomBytes(24))} ${valid}`,
    }),
    true,
  );
  assert.equal(
    verify({ signatures: `v1a,${sign(body, id, timestamp)} ${valid}` }),
    true,
  );
  const refusals = {
    tampered: verify({ body: Buffer.from(`${body} `) }),
    other_signing_key: verify({ signingKey: randomBytes(24) }),
    other_id: verify({ id: MESSAGE_ID() }),
    stale: verify({ now: now + 301_000 }),
    future: verify({ now: now - 301_000 }),
    only_other_version: verify({
      signatures: `v2,${sign(body, id, timestamp)}`,
    }),
    no_signature: verify({ signatures: null }),
    empty_signature: verify({ signatures: "" }),
    no_id: verify({ id: null }),
    malformed_id: verify({ id: "msg with spaces" }),
    malformed_timestamp: verify({ timestamp: "12a" }),
    no_timestamp: verify({ timestamp: null }),
    truncated_signature: verify({ signatures: valid.slice(0, -4) }),
    too_many_entries: verify({
      signatures: Array(11).fill(valid).join(" "),
    }),
    short_signing_key: verify({ signingKey: randomBytes(8) }),
  };
  assert.deepEqual(
    Object.values(refusals).filter((value) => value !== false),
    [],
  );
  assert.equal(verify({ now: now + 299_000 }), true);
});

test("S10-L3-6 (simulated) events become provider-neutral observations: the type's kind and Resend's message id only (no address, subject, tag or body), the event's own time, the svix-id as the event reference and the raw body's digest; a handled type without a message id is an ignored observation of unexpected shape; anything that is not an event is none", () => {
  const emailId = randomUUID();
  const event = (type, data = {}) =>
    Buffer.from(
      JSON.stringify({
        type,
        created_at: "2026-11-19T01:02:03.456Z",
        data: {
          email_id: emailId,
          from: FROM,
          to: [TO],
          subject: "Synthetic subject",
          tags: { synthetic: "tag" },
          ...data,
        },
      }),
    );
  const id = MESSAGE_ID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const kinds = {};
  for (const [type, data] of [
    ["email.sent", {}],
    ["email.delivered", {}],
    ["email.delivery_delayed", {}],
    ["email.bounced", { bounce: { type: "Permanent", message: "x" } }],
    ["email.bounced", { bounce: { type: "Transient", message: "x" } }],
    ["email.complained", {}],
    ["email.failed", {}],
    ["email.suppressed", {}],
    ["email.opened", {}],
    ["email.clicked", {}],
    ["contact.created", {}],
  ]) {
    const reading = resendEventOf(event(type, data), id, timestamp);
    assert.equal(reading.kind, "event", type);
    kinds[`${type}${data.bounce ? `:${data.bounce.type}` : ""}`] =
      reading.event.observation.kind;
    const serialized = JSON.stringify(reading.event);
    for (const secret of [TO, FROM, "Synthetic subject", "synthetic"]) {
      assert.equal(serialized.includes(secret), false, `${type}: ${secret}`);
    }
  }
  assert.deepEqual(kinds, {
    "email.sent": "accepted",
    "email.delivered": "delivered",
    "email.delivery_delayed": "delivery_delayed",
    "email.bounced:Permanent": "bounced",
    "email.bounced:Transient": "failed",
    "email.complained": "complained",
    "email.failed": "failed",
    "email.suppressed": "suppressed",
    "email.opened": "ignored",
    "email.clicked": "ignored",
    "contact.created": "ignored",
  });
  const raw = event("email.delivered");
  const reading = resendEventOf(raw, id, timestamp);
  assert.deepEqual(reading, {
    kind: "event",
    shape: "expected",
    event: {
      providerCode: "resend",
      eventReference: id,
      eventType: "email.delivered",
      occurredAt: "2026-11-19T01:02:03.456Z",
      payloadDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      observation: { kind: "delivered", provider_reference: emailId },
    },
  });
  const missing = resendEventOf(
    event("email.delivered", { email_id: undefined }),
    id,
    timestamp,
  );
  assert.equal(missing.shape, "unexpected");
  assert.deepEqual(missing.event.observation, {
    kind: "ignored",
    provider_reference: null,
  });
  const noTime = resendEventOf(
    Buffer.from(
      JSON.stringify({ type: "email.sent", data: { email_id: emailId } }),
    ),
    id,
    "1763600000",
  );
  assert.equal(noTime.event.occurredAt, "2025-11-20T00:53:20.000Z");
  for (const body of [
    Buffer.from("not json"),
    Buffer.from("[]"),
    Buffer.from(JSON.stringify({ type: "Email.Delivered" })),
    Buffer.from(JSON.stringify({ data: {} })),
  ]) {
    assert.deepEqual(resendEventOf(body, id, timestamp), { kind: "none" });
  }
});

// ---------------------------------------------------------------------------
// The webhook handler and the route
// ---------------------------------------------------------------------------

function webhookRequest(body, headers = {}) {
  return new Request(
    "https://rosuno.synthetic.invalid/api/notifications/resend",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
  );
}

function signedRequest(body, { id = MESSAGE_ID(), now = Date.now() } = {}) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    id,
    request: webhookRequest(body, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${sign(Buffer.from(body), id, timestamp)}`,
    }),
  };
}

function fakeRecorder(
  answer = { kind: "answer", outcome: "recorded", processing: "applied" },
) {
  const events = [];
  return {
    events,
    recorder: {
      jobContext: async () => null,
      recordAttempt: async () => "unknown",
      recordEvent: async (event) => {
        events.push(event);
        return typeof answer === "function" ? answer(event) : answer;
      },
    },
  };
}

test("S10-L3-7 (simulated) the webhook handler: no secret -> 503 with nothing read further; too large -> 413; an unauthenticated delivery -> 400 with nothing recorded; an authenticated event is recorded through the port once and answered 200 (a replay the database answers duplicate is 200 too); an unknown recording answer or no recorder -> 503 (the provider delivers again); a body that is no event and an event the database refuses -> 200 with nothing changed; no header, signature, body, address or key is logged", async () => {
  const body = JSON.stringify({
    type: "email.delivered",
    created_at: "2026-11-19T01:02:03.456Z",
    data: { email_id: randomUUID(), to: [TO], subject: "Synthetic" },
  });
  const sources = (overrides = {}) => ({
    secret: () => SIGNING_BYTES,
    recorder: async () => overrides.recorder ?? fakeRecorder().recorder,
    clock: () => Date.now(),
    ...overrides.sources,
  });
  const { result, lines } = await captured(async () => {
    const answers = {};
    answers.unconfigured = await handleResendWebhook(
      signedRequest(body).request,
      sources({ sources: { secret: () => null } }),
    );
    answers.too_large = await handleResendWebhook(
      webhookRequest("x".repeat(70_000)),
      sources(),
    );
    const unsignedRecorder = fakeRecorder();
    answers.unsigned = await handleResendWebhook(
      webhookRequest(body),
      sources({ recorder: unsignedRecorder.recorder }),
    );
    answers.forged = await handleResendWebhook(
      webhookRequest(body, {
        "svix-id": MESSAGE_ID(),
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": `v1,${randomBytes(32).toString("base64")}`,
      }),
      sources({ recorder: unsignedRecorder.recorder }),
    );
    assert.equal(unsignedRecorder.events.length, 0);
    const recorded = fakeRecorder();
    const signed = signedRequest(body);
    answers.recorded = await handleResendWebhook(
      signed.request,
      sources({ recorder: recorded.recorder }),
    );
    assert.equal(recorded.events.length, 1);
    assert.equal(recorded.events[0].eventReference, signed.id);
    const duplicate = fakeRecorder({
      kind: "answer",
      outcome: "duplicate",
      processing: "applied",
    });
    answers.duplicate = await handleResendWebhook(
      signedRequest(body, { id: signed.id }).request,
      sources({ recorder: duplicate.recorder }),
    );
    answers.unknown = await handleResendWebhook(
      signedRequest(body).request,
      sources({ recorder: fakeRecorder({ kind: "unknown" }).recorder }),
    );
    answers.unbound = await handleResendWebhook(signedRequest(body).request, {
      ...sources(),
      recorder: async () => null,
    });
    answers.no_event = await handleResendWebhook(
      signedRequest("[1, 2, 3]").request,
      sources(),
    );
    answers.refused = await handleResendWebhook(
      signedRequest(body).request,
      sources({
        recorder: fakeRecorder({
          kind: "answer",
          outcome: "invalid",
          processing: null,
        }).recorder,
      }),
    );
    return answers;
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result).map(([key, value]) => [key, value.status]),
    ),
    {
      unconfigured: 503,
      too_large: 413,
      unsigned: 400,
      forged: 400,
      recorded: 200,
      duplicate: 200,
      unknown: 503,
      unbound: 503,
      no_event: 200,
      refused: 200,
    },
  );
  const logged = lines.join("\n");
  for (const secret of [
    TO,
    TEST_KEY,
    SIGNING_SETTING_VALUE,
    "Synthetic",
    "svix",
    "msg_",
  ]) {
    assert.equal(logged.includes(secret), false, secret);
  }
});

test("S10-L3-8 (simulated) the route: POST only (every other method 405 with no body), uncacheable fixed answers, and without the configured secret a POST is 503", async () => {
  const saved = process.env[WEBHOOK_SETTING];
  delete process.env[WEBHOOK_SETTING];
  try {
    const response = await route.POST(
      webhookRequest(JSON.stringify({ type: "email.sent" })),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.deepEqual(await response.json(), { status: "unavailable" });
  } finally {
    if (saved !== undefined) {
      process.env[WEBHOOK_SETTING] = saved;
    }
  }
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = route[method]();
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(await response.text(), "");
  }
  assert.equal(route.dynamic, "force-dynamic");
});

// ---------------------------------------------------------------------------
// The notification job handler end to end (real adapter, fake server, fake
// recording port)
// ---------------------------------------------------------------------------

function contextRow(overrides = {}) {
  return {
    outcome: "act",
    notification_id: NOTIFICATION,
    notification_type: "document_shared",
    center_path: "/attorney/notifications",
    recipient_address: TO,
    ...overrides,
  };
}

function recorderWith(rows, answers = []) {
  const attempts = [];
  return {
    attempts,
    recorder: {
      jobContext: async () => rows,
      recordAttempt: async (jobId, providerCode, attempt) => {
        attempts.push({ jobId, providerCode, attempt });
        return answers.shift() ?? "unknown";
      },
      recordEvent: async () => ({ kind: "unknown" }),
    },
  };
}

function handlerWith(recording, options = {}) {
  const handlers = createNotificationJobHandlers({
    providerCode: RESEND_PROVIDER_CODE,
    provider: async () =>
      options.provider === undefined ? provider() : options.provider,
    recorder: async () => recording.recorder,
    origin: () => (options.origin === undefined ? ORIGIN : options.origin),
  });
  assert.deepEqual([...handlers.keys()], ["notification.deliver"]);
  return handlers.get("notification.deliver");
}

const RUN = Object.freeze({
  jobId: JOB,
  jobType: "notification.deliver",
  subjectType: "notification",
  subjectId: NOTIFICATION,
  attempt: 1,
  maxAttempts: 8,
  idempotencyKey: `rosuno-job-${JOB}`,
  signal: new AbortController().signal,
});

test("S10-L3-9 (simulated) the delivery job end to end: an accepted send is recorded with Resend's reference and the job is done; a transient failure is recorded and the job retries (the database answered retrying), and done once the database ends it permanently_failed; a permanent refusal is recorded and done; without a configured adapter or site origin the attempt records not_sent provider_unconfigured with no call; no recipient records not_sent recipient_unavailable; an address outside the shared rule records not_sent recipient_address_unsupported and the job is done (never an unrecorded retry loop), while an apostrophe address is sent; nothing to do sends nothing; an unreadable context retries; the message carries only the fixed template and the notification center link", async () => {
  reset();
  const id = randomUUID();
  respondWith(() => [200, { id }]);
  const accepted = recorderWith([contextRow()], ["sent"]);
  assert.equal(await handlerWith(accepted)(RUN), JOB_DONE);
  assert.deepEqual(accepted.attempts, [
    {
      jobId: JOB,
      providerCode: "resend",
      attempt: { result: "accepted", reference: id },
    },
  ]);
  const sent = fake.requests[0];
  assert.equal(
    sent.headers["idempotency-key"],
    `rosuno-notification-${NOTIFICATION}`,
  );
  assert.deepEqual(sent.json.to, [TO]);
  assert.equal(sent.json.subject, EMAIL_TEMPLATES.document_shared.subject);
  assert.ok(sent.json.text.includes(`${ORIGIN}/attorney/notifications`));
  assert.ok(sent.json.html.includes(`href="${ORIGIN}/attorney/notifications"`));
  // Transient: retry while the database says retrying, done when it ends it.
  reset();
  respondWith(() => [500, { name: "internal_server_error" }]);
  respondWith(() => [500, { name: "internal_server_error" }]);
  const transient = recorderWith(
    [contextRow()],
    ["retrying", "permanently_failed"],
  );
  await assert.rejects(handlerWith(transient)(RUN), NotificationJobRetry);
  assert.equal(await handlerWith(transient)(RUN), JOB_DONE);
  assert.deepEqual(
    transient.attempts.map((a) => a.attempt),
    [
      { result: "failed_transient", failureCode: "provider_error" },
      { result: "failed_transient", failureCode: "provider_error" },
    ],
  );
  // The same idempotency key on every attempt of the Notification.
  assert.deepEqual(
    [...new Set(fake.requests.map((r) => r.headers["idempotency-key"]))],
    [`rosuno-notification-${NOTIFICATION}`],
  );
  reset();
  respondWith(() => [422, { name: "invalid_parameter" }]);
  const refused = recorderWith([contextRow()], ["permanently_failed"]);
  assert.equal(await handlerWith(refused)(RUN), JOB_DONE);
  assert.deepEqual(refused.attempts[0].attempt, {
    result: "failed_permanent",
    failureCode: "invalid_request",
  });
  reset();
  const unconfigured = recorderWith([contextRow()], ["retrying"]);
  await assert.rejects(
    handlerWith(unconfigured, { provider: null })(RUN),
    NotificationJobRetry,
  );
  const noOrigin = recorderWith([contextRow()], ["permanently_failed"]);
  assert.equal(await handlerWith(noOrigin, { origin: null })(RUN), JOB_DONE);
  assert.deepEqual(
    [...unconfigured.attempts, ...noOrigin.attempts].map((a) => [
      a.providerCode,
      a.attempt,
    ]),
    [
      ["resend", { result: "not_sent", failureCode: "provider_unconfigured" }],
      ["resend", { result: "not_sent", failureCode: "provider_unconfigured" }],
    ],
  );
  assert.equal(fake.requests.length, 0);
  const noRecipient = recorderWith(
    [
      contextRow({
        outcome: "no_recipient",
        center_path: null,
        recipient_address: null,
      }),
    ],
    ["permanently_failed"],
  );
  assert.equal(await handlerWith(noRecipient)(RUN), JOB_DONE);
  assert.deepEqual(noRecipient.attempts[0].attempt, {
    result: "not_sent",
    failureCode: "recipient_unavailable",
  });
  // An act answer whose address this side refuses: recorded, final, no call.
  for (const address of [
    "not an address",
    "first,second@synthetic.invalid",
    'quoted"local@synthetic.invalid',
  ]) {
    const unsupported = recorderWith(
      [contextRow({ recipient_address: address })],
      ["permanently_failed"],
    );
    assert.equal(await handlerWith(unsupported)(RUN), JOB_DONE);
    assert.deepEqual(
      unsupported.attempts.map((a) => a.attempt),
      [{ result: "not_sent", failureCode: "recipient_address_unsupported" }],
    );
  }
  assert.equal(fake.requests.length, 0);
  // An apostrophe address is delivered like any other.
  const apostropheId = randomUUID();
  respondWith(() => [200, { id: apostropheId }]);
  const apostrophe = recorderWith(
    [contextRow({ recipient_address: "o'brien@synthetic.invalid" })],
    ["sent"],
  );
  assert.equal(await handlerWith(apostrophe)(RUN), JOB_DONE);
  assert.deepEqual(apostrophe.attempts[0].attempt, {
    result: "accepted",
    reference: apostropheId,
  });
  assert.deepEqual(fake.requests[0].json.to, ["o'brien@synthetic.invalid"]);
  reset();
  const nothing = recorderWith([
    contextRow({
      outcome: "nothing_to_do",
      center_path: null,
      recipient_address: null,
    }),
  ]);
  assert.equal(await handlerWith(nothing)(RUN), JOB_DONE);
  assert.equal(nothing.attempts.length, 0);
  for (const rows of [
    null,
    [],
    [contextRow({ recipient_address: null })],
    [contextRow({ recipient_address: 42 })],
    [contextRow({ center_path: "/staff/notifications" })],
    [contextRow({ notification_type: "synthetic" })],
    [{ ...contextRow(), extra: 1 }],
  ]) {
    const unreadable = recorderWith(rows);
    await assert.rejects(handlerWith(unreadable)(RUN), NotificationJobRetry);
    assert.equal(unreadable.attempts.length, 0);
  }
  assert.equal(fake.requests.length, 0);
});

test("S10-L3-10 (simulated) the fixed templates: one per S10 type, no matter details, names, message bodies or document names, and one link only, to the recipient's notification center at the configured origin; an unknown path or origin yields no link", () => {
  assert.deepEqual(Object.keys(EMAIL_TEMPLATES), [...NOTIFICATION_TYPES]);
  for (const type of NOTIFICATION_TYPES) {
    const built = emailMessageOf(type, TO, `${ORIGIN}/client/notifications`);
    assert.equal(built.to, TO);
    assert.equal(built.subject, EMAIL_TEMPLATES[type].subject);
    assert.equal(built.html.match(/href=/g).length, 1);
    assert.equal(built.text.includes(TO), false);
    assert.equal(built.html.includes(TO), false);
  }
  assert.equal(
    centerUrlOf(ORIGIN, "/client/notifications"),
    `${ORIGIN}/client/notifications`,
  );
  for (const [origin, path] of [
    [ORIGIN, "/client/notifications?x=1"],
    [ORIGIN, "/staff/notifications"],
    ["javascript:alert(1)", "/client/notifications"],
    [`${ORIGIN}/`, "/client/notifications"],
  ]) {
    assert.equal(centerUrlOf(origin, path), null);
  }
  assert.equal(
    emailIdempotencyKeyOf(NOTIFICATION),
    `rosuno-notification-${NOTIFICATION}`,
  );
  assert.throws(() => emailIdempotencyKeyOf("not-a-uuid"));
  assert.equal(notificationJobContextOf(null), null);
});

test("S10-L3-11 (simulated) a verified event is recorded once through the port (a replay is the database's duplicate), a malformed event is rejected before the port, and an unknown answer is unavailable", async () => {
  const good = {
    providerCode: "resend",
    eventReference: MESSAGE_ID(),
    eventType: "email.delivered",
    occurredAt: "2026-11-19T01:02:03.456Z",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    observation: { kind: "delivered", provider_reference: randomUUID() },
  };
  const { recorder, events } = fakeRecorder();
  assert.equal(await recordNotificationEvent(recorder, good), "accepted");
  assert.equal(events.length, 1);
  for (const bad of [
    { ...good, observation: { kind: "delivered", provider_reference: null } },
    { ...good, observation: { kind: "opened", provider_reference: "x" } },
    { ...good, eventReference: "bad id" },
    { ...good, payloadDigest: "sha256:00" },
    { ...good, occurredAt: "yesterday" },
    { ...good, extra: true },
  ]) {
    assert.equal(await recordNotificationEvent(recorder, bad), "rejected");
  }
  assert.equal(events.length, 1);
  assert.equal(
    await recordNotificationEvent(
      fakeRecorder({ kind: "unknown" }).recorder,
      good,
    ),
    "unavailable",
  );
  assert.equal(
    await recordNotificationEvent(
      fakeRecorder({
        kind: "answer",
        outcome: "duplicate",
        processing: "no_effect",
      }).recorder,
      good,
    ),
    "accepted",
  );
});

test("S10-L3-12 (simulated) one fixed address rule (the database's, the application's and the adapter's): RFC 5322 atext and dots in the local part, the apostrophe included, and a host name of letters, digits and inner hyphens; a job context carrying another address is answered address_unsupported (recorded not_sent, final); a not_sent attempt carries only the fixed codes the database admits", () => {
  for (const address of [
    "o'brien@synthetic.invalid",
    "d'angelo.o'neil@sub.synthetic.invalid",
    "first.last+tag@synthetic.invalid",
    "a!#$%&'*+/=?^_`{|}~-z@synthetic.invalid",
    "x@y.z",
    "local@host-name.synthetic.invalid",
  ]) {
    assert.equal(isEmailAddress(address), true, address);
  }
  for (const address of [
    "",
    "a@",
    "@synthetic.invalid",
    "no-at-sign",
    "two@at@synthetic.invalid",
    "space inside@synthetic.invalid",
    "first,second@synthetic.invalid",
    "semi;colon@synthetic.invalid",
    'quoted"local@synthetic.invalid',
    "angle<bracket@synthetic.invalid",
    "local@-leading.synthetic.invalid",
    "local@trailing-.synthetic.invalid",
    "local@under_score.synthetic.invalid",
    "local@synthetic..invalid",
    `${"l".repeat(65)}@synthetic.invalid`,
    `l@${"h".repeat(64)}.invalid`,
    `${"l".repeat(64)}@${"h.".repeat(130)}invalid`,
    42,
    null,
  ]) {
    assert.equal(isEmailAddress(address), false, String(address));
  }
  assert.deepEqual(
    notificationJobContextOf([
      contextRow({ recipient_address: "o'brien@synthetic.invalid" }),
    ]),
    {
      outcome: "act",
      notificationId: NOTIFICATION,
      type: "document_shared",
      centerPath: "/attorney/notifications",
      address: "o'brien@synthetic.invalid",
    },
  );
  assert.deepEqual(
    notificationJobContextOf([
      contextRow({ recipient_address: "first,second@synthetic.invalid" }),
    ]),
    { outcome: "address_unsupported" },
  );
  assert.equal(
    notificationJobContextOf([contextRow({ recipient_address: null })]),
    null,
  );
  for (const code of [
    "provider_unconfigured",
    "recipient_unavailable",
    "recipient_address_unsupported",
    "invalid_request",
  ]) {
    assert.equal(
      isDeliveryAttempt({ result: "not_sent", failureCode: code }),
      true,
      code,
    );
  }
  for (const attempt of [
    { result: "not_sent", failureCode: "network" },
    { result: "not_sent", failureCode: "provider_error" },
    { result: "not_sent", reference: "x" },
    { result: "not_sent", failureCode: "invalid_request", extra: 1 },
  ]) {
    assert.equal(isDeliveryAttempt(attempt), false, JSON.stringify(attempt));
  }
});
