// MVP-001 S2 operational job worker infrastructure: the privileged worker
// port, the server-only worker adapter, the after-commit drain, and the
// protected worker route (fixture-only).
//
// The privileged port runs against a recording client factory; the route
// runs from its own source with server settings set and restored around
// each case, and once end to end against a stand-in for the network that
// answers the worker functions, so no request ever leaves this process.
// Every key, value, id, and job type is synthetic.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  claimAnswerOf,
  JOB_ERROR_MESSAGES,
  UNKNOWN_CLAIM,
} from "../src/application/job-worker.ts";
import { createJobWorkerPort } from "../src/infrastructure/identity/registration-provisioning.ts";
import { scheduleJobDrainAfterCommit } from "../src/infrastructure/jobs/after-commit.ts";
import {
  AFTER_COMMIT_BOUNDS,
  drainOperationalJobs,
  handleJobWorkerRequest,
  isAuthorizedWorkerRequest,
  JOB_WORKER_SETTING,
  JOB_WORKER_WIRING,
  PRODUCTION_JOB_HANDLERS,
  readJobWorkerValue,
  WORKER_ROUTE_BOUNDS,
} from "../src/infrastructure/jobs/job-worker-adapter.ts";
import { allowedFields } from "../src/infrastructure/observability/log.ts";
import * as workerRoute from "../app/api/jobs/run/route.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*\n/gm, "");
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LOCAL = "http://127.0.0.1:54321";
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const ADMIN = "sb_secret_synthetic7f3a";
const SETTING = JOB_WORKER_SETTING.name;
// A synthetic worker value: 64 hexadecimal characters.
const VALUE = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const bearer = (value) => ["Bearer", value].join(" ");

const localEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: LOCAL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined,
  ROSUNO_ENVIRONMENT_CLASS: "development",
  ...overrides,
});

// A recording client factory whose rpc builder answers what the test
// configures and records the abort signal it is given.
function recordingFactory(answer = () => ({ data: null, error: null })) {
  const made = [];
  const calls = [];
  const create = (...args) => {
    made.push(args);
    return {
      rpc: (name, rpcArgs) => {
        const call = { name, args: rpcArgs, signal: null };
        calls.push(call);
        return {
          abortSignal: (signal) => {
            call.signal = signal;
            return Promise.resolve().then(() => answer(call));
          },
        };
      },
    };
  };
  return { made, calls, create };
}

// Captures the lines the request logger writes outside a request.
async function captured(work) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (line) => lines.push(JSON.parse(line));
  console.error = (line) => lines.push(JSON.parse(line));
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

// Sets server settings for one case and restores them afterwards.
async function withEnvironment(values, work) {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "ROSUNO_SUPABASE_ADMIN_KEY",
    "ROSUNO_SUPABASE_EXPECTED_PROJECT_REF",
    "ROSUNO_ENVIRONMENT_CLASS",
    SETTING,
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (values[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = values[name];
    }
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The privileged worker port
// ---------------------------------------------------------------------------

test("J-I1. the worker port is built only from a verified binding, as one cookie-free privileged client that is never returned", async () => {
  const unbound = recordingFactory();
  for (const environment of [
    {},
    localEnvironment({ ROSUNO_ENVIRONMENT_CLASS: undefined }),
    localEnvironment({ ROSUNO_SUPABASE_ADMIN_KEY: PUBLISHABLE }),
    localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://example.test" }),
  ]) {
    assert.equal(await createJobWorkerPort(environment, unbound.create), null);
  }
  assert.deepEqual(unbound.made, []);
  const factory = recordingFactory();
  const port = await createJobWorkerPort(localEnvironment(), factory.create);
  assert.deepEqual(factory.made, [
    [
      LOCAL,
      ADMIN,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    ],
  ]);
  assert.ok(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port), ["claim", "complete", "fail"]);
  assert.deepEqual(factory.calls, []);
});

test("J-I2. each worker call is one fixed function with exactly its named arguments and a deadline, and its answer is read strictly", async () => {
  const answers = [];
  const factory = recordingFactory(() => answers.shift());
  const port = await createJobWorkerPort(localEnvironment(), factory.create);
  const row = {
    job_id: ID(1),
    job_type: "synthetic.check",
    subject_type: "synthetic",
    subject_id: ID(2),
    attempt: 1,
    max_attempts: 3,
  };
  answers.push({ data: [row], error: null });
  assert.deepEqual(
    await port.claim("synthetic-worker", 120, 10),
    claimAnswerOf([row], 10),
  );
  answers.push({ data: "completed", error: null });
  assert.equal(await port.complete(ID(1), "synthetic-worker"), "completed");
  answers.push({ data: "escalated", error: null });
  assert.equal(
    await port.fail(
      ID(1),
      "synthetic-worker",
      "unknown_job_type",
      JOB_ERROR_MESSAGES.unknown_job_type,
    ),
    "escalated",
  );
  assert.deepEqual(
    factory.calls.map(({ name, args }) => [name, args]),
    [
      [
        "job_claim",
        { p_worker: "synthetic-worker", p_lease_seconds: 120, p_limit: 10 },
      ],
      ["job_complete", { p_job_id: ID(1), p_worker: "synthetic-worker" }],
      [
        "job_fail",
        {
          p_job_id: ID(1),
          p_worker: "synthetic-worker",
          p_error_code: "unknown_job_type",
          p_error_message: JOB_ERROR_MESSAGES.unknown_job_type,
        },
      ],
    ],
  );
  for (const call of factory.calls) {
    assert.ok(call.signal instanceof AbortSignal, call.name);
    assert.equal(call.signal.aborted, false, call.name);
  }
  // A failed, refused, malformed, or thrown call is unknown.
  for (const answer of [
    { data: [row], error: { code: "42501" } },
    { data: [row, row], error: null },
    { data: "completed", error: null },
    { data: null, error: null },
  ]) {
    answers.push(answer);
    assert.deepEqual(
      await port.claim("synthetic-worker", 120, 10),
      UNKNOWN_CLAIM,
    );
  }
  for (const answer of [
    { data: "completed", error: { code: "57014" } },
    { data: "retry_scheduled", error: null },
    { data: ["completed"], error: null },
  ]) {
    answers.push(answer);
    assert.equal(await port.complete(ID(1), "synthetic-worker"), "unknown");
  }
  for (const answer of [
    { data: "escalated", error: { code: "22023" } },
    { data: "completed", error: null },
  ]) {
    answers.push(answer);
    assert.equal(
      await port.fail(ID(1), "synthetic-worker", "handler_failed", null),
      "unknown",
    );
  }
  const throwing = recordingFactory(() => {
    throw new Error("synthetic");
  });
  const brittle = await createJobWorkerPort(
    localEnvironment(),
    throwing.create,
  );
  assert.deepEqual(await brittle.claim("w", 120, 1), UNKNOWN_CLAIM);
  assert.equal(await brittle.complete(ID(1), "w"), "unknown");
  assert.equal(
    await brittle.fail(ID(1), "w", "handler_failed", null),
    "unknown",
  );
  // Arguments outside the database's own bounds are never sent.
  const before = factory.calls.length;
  for (const call of [
    () => port.claim("synthetic worker", 120, 10),
    () => port.claim("w".repeat(65), 120, 10),
    () => port.claim("w", 4, 10),
    () => port.claim("w", 3601, 10),
    () => port.claim("w", 120, 0),
    () => port.claim("w", 120, 51),
    () => port.claim("w", "120", 10),
    () => port.complete("not-an-id", "w"),
    () => port.complete(ID(1), ""),
    () => port.fail(ID(1), "w", "Handler Failed", null),
    () => port.fail(ID(1), "w", "handler_failed", "x".repeat(501)),
    () => port.fail(ID(1), "w", "handler_failed", ""),
    () => port.fail("x", "w", "handler_failed", null),
  ]) {
    const answer = await call();
    assert.ok(answer === "unknown" || answer.kind === "unknown");
  }
  assert.equal(factory.calls.length, before);
});

// ---------------------------------------------------------------------------
// The worker adapter
// ---------------------------------------------------------------------------

test("J-I3. the worker value is one server-only setting: unset, placeholder, padded, or malformed values configure nothing", () => {
  assert.equal(SETTING, "ROSUNO_JOB_WORKER_SECRET");
  const environment = (value, klass = "development") => ({
    ROSUNO_ENVIRONMENT_CLASS: klass,
    [SETTING]: value,
  });
  assert.equal(readJobWorkerValue(environment(VALUE)), VALUE);
  assert.equal(readJobWorkerValue(environment(VALUE, "production")), VALUE);
  for (const [label, env] of [
    ["unset", { ROSUNO_ENVIRONMENT_CLASS: "development" }],
    ["empty", environment("")],
    ["no environment class", { [SETTING]: VALUE }],
    ["unknown environment class", environment(VALUE, "local")],
    ["too short", environment("a".repeat(31))],
    ["too long", environment("a".repeat(129))],
    ["padded", environment(` ${VALUE}`)],
    ["other characters", environment(`${VALUE.slice(0, 40)}+/=`)],
    ["placeholder", environment(`changeme${"0".repeat(32)}`)],
    ["documentation", environment(`your_secret_${"0".repeat(32)}`)],
  ]) {
    assert.equal(readJobWorkerValue(env), null, label);
  }
});

test("J-I4. only exactly the configured bearer value is authorized, compared as equal-length digests in constant time", () => {
  assert.equal(isAuthorizedWorkerRequest(bearer(VALUE), VALUE), true);
  for (const [label, header] of [
    ["absent", null],
    ["empty", ""],
    ["other value", bearer(OTHER)],
    ["prefix only", bearer(VALUE.slice(0, 63))],
    ["longer", bearer(`${VALUE}0`)],
    ["lower-case scheme", `bearer ${VALUE}`],
    ["other scheme", `Basic ${VALUE}`],
    ["no scheme", VALUE],
    ["trailing space", `${bearer(VALUE)} `],
    ["two spaces", `Bearer  ${VALUE}`],
    ["oversized", bearer(`${VALUE}${"0".repeat(300)}`)],
  ]) {
    assert.equal(isAuthorizedWorkerRequest(header, VALUE), false, label);
  }
  assert.equal(isAuthorizedWorkerRequest(bearer(""), ""), false);
  // The comparison runs on SHA-256 digests with timingSafeEqual, always,
  // and the values are never compared directly.
  const adapter = codeOf(read("src/infrastructure/jobs/job-worker-adapter.ts"));
  assert.equal(adapter.match(/timingSafeEqual\(/g).length, 1);
  assert.ok(
    adapter.includes(
      '  const equal = timingSafeEqual(\n    digestOf(presented ?? ""),\n    digestOf(configured),\n  );\n  return presented !== undefined && configured !== "" && equal;\n',
    ),
  );
  assert.ok(
    adapter.includes(
      'return createHash("sha256").update(value, "utf8").digest();',
    ),
  );
  assert.doesNotMatch(
    adapter,
    /presented\s*[!=]==\s*configured|configured\s*[!=]==\s*presented|presented\s*===\s*["'`]|\.startsWith\(configured|\.includes\(configured|localeCompare/,
  );
});

test("J-I5. a worker request is unavailable without a configured value, unauthorized without the exact bearer value, and otherwise answered by one drain's counts", async () => {
  let drains = 0;
  const ran = {
    status: "ran",
    batches: 1,
    claimed: 2,
    completed: 1,
    retried: 1,
    escalated: 0,
    superseded: 0,
    unconfirmed: 0,
    claimFailures: 0,
  };
  const sources = (configured, result = ran) => ({
    configured: () => configured,
    drain: async () => {
      drains += 1;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  });
  const unconfigured = await captured(() =>
    handleJobWorkerRequest(bearer(VALUE), sources(null)),
  );
  assert.deepEqual(unconfigured.result, {
    status: 503,
    body: { status: "unavailable" },
  });
  const unauthorized = await captured(() =>
    handleJobWorkerRequest(bearer(OTHER), sources(VALUE)),
  );
  assert.deepEqual(unauthorized.result, {
    status: 401,
    body: { status: "unauthorized" },
  });
  assert.equal(drains, 0);
  for (const { lines } of [unconfigured, unauthorized]) {
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "operational_jobs.worker_refused");
    const text = JSON.stringify(lines);
    assert.equal(text.includes(VALUE.slice(0, 16)), false);
    assert.equal(text.includes(OTHER.slice(0, 16)), false);
  }
  assert.deepEqual(
    [unconfigured.lines[0].outcome, unauthorized.lines[0].outcome],
    ["unconfigured", "unauthorized"],
  );
  assert.deepEqual(
    await handleJobWorkerRequest(bearer(VALUE), sources(VALUE)),
    {
      status: 200,
      body: {
        status: "ran",
        batches: 1,
        claimed: 2,
        completed: 1,
        retried: 1,
        escalated: 0,
        superseded: 0,
        unconfirmed: 0,
        claimFailures: 0,
      },
    },
  );
  assert.equal(drains, 1);
  for (const result of [
    { ...ran, status: "unavailable" },
    { ...ran, status: "refused" },
    new Error("synthetic"),
  ]) {
    assert.deepEqual(
      await handleJobWorkerRequest(bearer(VALUE), sources(VALUE, result)),
      { status: 503, body: { status: "unavailable" } },
    );
  }
});

test("J-I6. a drain without a binding claims nothing; with a port it uses its own worker identity, the drain settings, the empty production registry, and logs counts and codes only", async () => {
  const none = await captured(() =>
    drainOperationalJobs(WORKER_ROUTE_BOUNDS, {
      ...JOB_WORKER_WIRING,
      port: async () => null,
    }),
  );
  assert.equal(none.result.status, "unavailable");
  assert.equal(none.result.claimed, 0);
  assert.deepEqual(
    none.lines.map((line) => [line.event, line.outcome]),
    [["operational_jobs.worker_unavailable", "unbound"]],
  );
  // The deployed wiring, unconfigured here, builds no port at all.
  assert.equal(await JOB_WORKER_WIRING.port(), null);
  // The production registry was empty in S2; MVP-001 S7 registers exactly
  // the five payment job types, and MVP-001 S9 exactly the four media job
  // types after them, and MVP-001 S10 exactly the one notification job type
  // after those, and no other.
  assert.deepEqual(
    [...PRODUCTION_JOB_HANDLERS.keys()],
    [
      "payment.checkout",
      "payment.capture",
      "payment.release",
      "payment.refund",
      "payment.reconcile",
      "media.room_create",
      "media.room_update",
      "media.room_delete",
      "media.observe",
      "notification.deliver",
    ],
  );
  assert.ok(
    [...PRODUCTION_JOB_HANDLERS.values()].every((h) => typeof h === "function"),
  );
  assert.equal(PRODUCTION_JOB_HANDLERS.has("synthetic.check"), false);
  const calls = [];
  let claims = 0;
  const port = {
    claim: async (...args) => {
      calls.push(["claim", ...args]);
      claims += 1;
      return claims === 1
        ? claimAnswerOf(
            [
              {
                job_id: ID(1),
                job_type: "synthetic.check",
                subject_type: "synthetic",
                subject_id: ID(2),
                attempt: 1,
                max_attempts: 2,
              },
            ],
            10,
          )
        : UNKNOWN_CLAIM;
    },
    complete: async () => "completed",
    fail: async (...args) => {
      calls.push(["fail", ...args]);
      return "retry_scheduled";
    },
  };
  const workerIds = [];
  const wiring = {
    ...JOB_WORKER_WIRING,
    port: async () => port,
    workerId: () => {
      const id = JOB_WORKER_WIRING.workerId();
      workerIds.push(id);
      return id;
    },
  };
  const { result, lines } = await captured(() =>
    drainOperationalJobs(WORKER_ROUTE_BOUNDS, wiring),
  );
  assert.deepEqual(result, {
    status: "ran",
    batches: 1,
    claimed: 1,
    completed: 0,
    retried: 1,
    escalated: 0,
    superseded: 0,
    unconfirmed: 0,
    claimFailures: 0,
  });
  assert.match(
    workerIds[0],
    /^rosuno-web:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(workerIds[0], /^[A-Za-z0-9._:-]{1,64}$/);
  assert.deepEqual(calls, [
    ["claim", workerIds[0], 120, 10],
    [
      "fail",
      ID(1),
      workerIds[0],
      "unknown_job_type",
      JOB_ERROR_MESSAGES.unknown_job_type,
    ],
  ]);
  assert.deepEqual(
    lines.map(({ timestamp, correlationId, ...rest }) => {
      assert.equal(typeof timestamp, "string");
      assert.equal(correlationId, null);
      return rest;
    }),
    [
      {
        level: "warn",
        event: "operational_jobs.job_failed",
        errorCode: "unknown_job_type",
        outcome: "retry_scheduled",
        jobType: "synthetic.check",
      },
      {
        level: "info",
        event: "operational_jobs.batch",
        claimed: 1,
        completed: 0,
        retried: 1,
        escalated: 0,
        superseded: 0,
        unconfirmed: 0,
      },
    ],
  );
  assert.equal(JSON.stringify(lines).includes(ID(2)), false);
  // Each drain has its own worker identity.
  await captured(() => drainOperationalJobs(AFTER_COMMIT_BOUNDS, wiring));
  assert.equal(workerIds.length, 2);
  assert.notEqual(workerIds[0], workerIds[1]);
  assert.deepEqual(calls.at(-1), ["claim", workerIds[1], 120, 5]);
  // The bounds: the route drains up to five batches of ten, an after-commit
  // drain one batch of five.
  assert.deepEqual(WORKER_ROUTE_BOUNDS, { batchLimit: 10, maxBatches: 5 });
  assert.deepEqual(AFTER_COMMIT_BOUNDS, { batchLimit: 5, maxBatches: 1 });
});

test("J-I7. the job log fields are kept only in their own narrow shapes", () => {
  assert.deepEqual(
    allowedFields({
      jobType: "synthetic.check",
      claimed: 3,
      completed: 0,
      retried: 1000,
      escalated: 1,
      superseded: 2,
      unconfirmed: 0,
    }),
    {
      jobType: "synthetic.check",
      claimed: 3,
      completed: 0,
      retried: 1000,
      escalated: 1,
      superseded: 2,
      unconfirmed: 0,
    },
  );
  assert.deepEqual(
    allowedFields({
      jobType: "person@example.test",
      claimed: 1001,
      completed: -1,
      retried: "3",
      escalated: 1.5,
      superseded: Number.NaN,
      unconfirmed: null,
    }),
    {},
  );
  for (const jobType of [
    "Synthetic.check",
    "ab",
    `a${"b".repeat(64)}`,
    "a b c",
  ]) {
    assert.deepEqual(allowedFields({ jobType }), {}, jobType);
  }
});

// ---------------------------------------------------------------------------
// The after-commit drain
// ---------------------------------------------------------------------------

test("J-I8. an after-commit drain is scheduled after the response, bounded to one small batch, and never throws or runs outside a request", async () => {
  const scheduled = [];
  const drains = [];
  const drain = async (bounds) => {
    drains.push(bounds);
    return { status: "ran" };
  };
  assert.equal(
    await scheduleJobDrainAfterCommit((task) => scheduled.push(task), drain),
    true,
  );
  assert.equal(scheduled.length, 1);
  // Nothing runs until the runtime runs the scheduled task.
  assert.deepEqual(drains, []);
  await scheduled[0]();
  assert.deepEqual(drains, [AFTER_COMMIT_BOUNDS]);
  // A runtime that refuses to schedule leaves nothing running.
  assert.equal(
    await scheduleJobDrainAfterCommit(() => {
      throw new Error("synthetic: outside a request scope");
    }, drain),
    false,
  );
  // Without the runtime (plain Node.js here), nothing is scheduled.
  assert.equal(await scheduleJobDrainAfterCommit(undefined, drain), false);
  assert.equal(drains.length, 1);
  // S2 had no action that enqueues a job. MVP-001 S7: exactly one module
  // wires it, the Stripe webhook adapter, after an event is recorded.
  // MVP-001 S9: and exactly one more, the Daily webhook adapter, after an
  // event is recorded.
  const importers = [...filesIn("app/"), ...filesIn("src/")].filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      importsOf(read(file)).some((s) => /(?:^|\/)after-commit\.ts$/.test(s)),
  );
  assert.deepEqual(importers, [
    "src/infrastructure/media/daily-webhook.ts",
    "src/infrastructure/payments/stripe-webhook.ts",
  ]);
  const source = read("src/infrastructure/jobs/after-commit.ts");
  assert.deepEqual(importsOf(source), ["./job-worker-adapter.ts"]);
  assert.deepEqual(
    [...codeOf(source).matchAll(/\bimport\s*\(([^)]*)\)/g)].map((m) => m[1]),
    ['"next/server"'],
  );
});

// ---------------------------------------------------------------------------
// The protected worker route
// ---------------------------------------------------------------------------

const post = (authorization) =>
  workerRoute.POST(
    new Request("http://localhost/api/jobs/run", {
      method: "POST",
      headers: authorization === null ? {} : { authorization },
      body: "ignored synthetic body",
    }),
  );

function assertJsonHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
}

test("J-I9. every method but POST is refused with 405 and no body", async () => {
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = workerRoute[method](
      new Request("http://localhost/api/jobs/run", { method }),
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST", method);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(await response.text(), "", method);
  }
  assert.equal(workerRoute.dynamic, "force-dynamic");
});

test("J-I10. POST without a configured value is 503 and runs nothing; a missing or wrong bearer value is 401 with a fixed body; without a binding nothing is claimed", async () => {
  await captured(async () => {
    for (const env of [
      { ROSUNO_ENVIRONMENT_CLASS: "development" },
      { ROSUNO_ENVIRONMENT_CLASS: "development", [SETTING]: "x".repeat(10) },
      {
        ROSUNO_ENVIRONMENT_CLASS: "development",
        [SETTING]: `placeholder${"0".repeat(30)}`,
      },
      { [SETTING]: VALUE },
    ]) {
      await withEnvironment(env, async () => {
        const response = await post(bearer(VALUE));
        assert.equal(response.status, 503);
        assertJsonHeaders(response);
        assert.deepEqual(await response.json(), { status: "unavailable" });
      });
    }
    await withEnvironment(
      { ROSUNO_ENVIRONMENT_CLASS: "development", [SETTING]: VALUE },
      async () => {
        for (const header of [
          null,
          "",
          bearer(OTHER),
          `bearer ${VALUE}`,
          VALUE,
        ]) {
          const response = await post(header);
          assert.equal(response.status, 401, String(header));
          assertJsonHeaders(response);
          assert.equal(response.headers.get("www-authenticate"), "Bearer");
          const text = await response.text();
          assert.equal(text, '{"status":"unauthorized"}');
        }
        // The right value, but no verified project binding: nothing runs.
        const response = await post(bearer(VALUE));
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "unavailable" });
      },
    );
  });
});

test("J-I11. end to end with a stand-in network: the right bearer value drains through the privileged worker functions and answers counts only", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? null : JSON.parse(init.body);
    requests.push({ path: url.pathname, method: init.method, headers, body });
    const answer =
      url.pathname === "/rest/v1/rpc/job_claim"
        ? requests.filter((r) => r.path === url.pathname).length === 1
          ? [
              {
                job_id: ID(1),
                job_type: "synthetic.check",
                subject_type: "synthetic",
                subject_id: ID(2),
                attempt: 1,
                max_attempts: 2,
              },
            ]
          : []
        : url.pathname === "/rest/v1/rpc/job_fail"
          ? "retry_scheduled"
          : null;
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { result, lines } = await captured(() =>
      withEnvironment(localEnvironment({ [SETTING]: VALUE }), async () => {
        const response = await post(bearer(VALUE));
        return {
          status: response.status,
          headers: response.headers,
          body: await response.json(),
        };
      }),
    );
    assert.equal(result.status, 200);
    assertJsonHeaders({ headers: result.headers });
    assert.deepEqual(result.body, {
      status: "ran",
      batches: 1,
      claimed: 1,
      completed: 0,
      retried: 1,
      escalated: 0,
      superseded: 0,
      unconfirmed: 0,
      claimFailures: 0,
    });
    assert.deepEqual(
      requests.map((r) => [r.method, r.path]),
      [
        ["POST", "/rest/v1/rpc/job_claim"],
        ["POST", "/rest/v1/rpc/job_fail"],
      ],
    );
    const [claim, fail] = requests;
    assert.match(claim.body.p_worker, /^rosuno-web:[0-9a-f-]{36}$/);
    assert.deepEqual(claim.body, {
      p_worker: claim.body.p_worker,
      p_lease_seconds: 120,
      p_limit: 10,
    });
    assert.deepEqual(fail.body, {
      p_job_id: ID(1),
      p_worker: claim.body.p_worker,
      p_error_code: "unknown_job_type",
      p_error_message: JOB_ERROR_MESSAGES.unknown_job_type,
    });
    // The privileged client sends the privileged key, never the request's
    // bearer value, and no cookie.
    for (const request of requests) {
      assert.equal(request.headers.get("apikey"), ADMIN);
      assert.equal(
        (request.headers.get("authorization") ?? "").includes(VALUE),
        false,
      );
      assert.equal(request.headers.get("cookie"), null);
    }
    assert.deepEqual(
      lines.map((line) => line.event),
      ["operational_jobs.job_failed", "operational_jobs.batch"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("J-I12. the route and the adapter stay narrow: exact imports, no cookie, session, query, body, or privileged name, and nothing echoed", () => {
  const routeSource = read("app/api/jobs/run/route.ts");
  const route = codeOf(routeSource);
  assert.doesNotMatch(routeSource, /["']use (?:client|server)["']/);
  assert.deepEqual(importsOf(routeSource), [
    "../../../../src/infrastructure/jobs/job-worker-adapter.ts",
  ]);
  assert.equal(route.match(/request\./g).length, 1);
  assert.ok(
    route.includes(
      'const answer = await handleJobWorkerRequest(\n    request.headers.get("authorization"),\n  );',
    ),
  );
  assert.doesNotMatch(
    route,
    /process\.env|\bconsole\b|cookies|next\/headers|searchParams|nextUrl|request\.url|\.json\(\)|\.text\(\)|formData|request\.body|redirect|ROSUNO_|createClient|service_role|sb_secret_|\bimport\s*\(/,
  );
  assert.equal(route.match(/JSON\.stringify\(answer\.body\)/g).length, 1);
  assert.deepEqual(
    [
      ...route.matchAll(/^export (?:async function|function|const) (\w+)/gm),
    ].map((m) => m[1]),
    ["dynamic", "POST", "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
  );
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.ok(route.includes(`export const ${method} = methodNotAllowed;`));
  }
  const adapterSource = read("src/infrastructure/jobs/job-worker-adapter.ts");
  const adapter = codeOf(adapterSource);
  assert.deepEqual(importsOf(adapterSource), [
    "node:crypto",
    "../../application/job-worker.ts",
    "../environment/provider-configuration.ts",
    "../identity/registration-provisioning.ts",
    // MVP-001 S9: the media job handlers.
    "../media/media-jobs.ts",
    // MVP-001 S10: the notification job handler.
    "../notifications/notification-jobs.ts",
    "../observability/request-log.ts",
    // MVP-001 S7: the payment job handlers, and nothing else.
    "../payments/payment-jobs.ts",
  ]);
  assert.doesNotMatch(
    adapter,
    /process\.env|\bconsole\b|ROSUNO_SUPABASE|NEXT_PUBLIC|service_role|sb_secret_|createClient\b|adminKey|\.rpc\(|\.from\(|cookies|next\/headers|\.set\(/,
  );
  // The registry held no handler in S2; MVP-001 S7: it holds exactly the
  // payment job handlers; MVP-001 S9: and exactly the media job handlers;
  // MVP-001 S10: and exactly the notification job handler.
  assert.match(
    adapter,
    /export const PRODUCTION_JOB_HANDLERS: JobHandlers = new Map<string, JobHandler>\(\n {2}\[\n {4}\.\.\.PAYMENT_JOB_HANDLERS,\n {4}\.\.\.MEDIA_JOB_HANDLERS,\n {4}\.\.\.NOTIFICATION_JOB_HANDLERS,\n {2}\],\n\);/,
  );
  assert.equal(adapter.match(/PAYMENT_JOB_HANDLERS/g).length, 2);
  assert.equal(adapter.match(/MEDIA_JOB_HANDLERS/g).length, 2);
  assert.equal(adapter.match(/NOTIFICATION_JOB_HANDLERS/g).length, 2);
  // Only the worker route loads the adapter (the after-commit helper too),
  // and (MVP-001 S7) the payment adapter, for one bounded drain after a
  // payment attempt is created, and (MVP-001 S9) the consultation adapter,
  // for one bounded drain while a consultation room is being prepared, and
  // (MVP-001 S10) the communication adapter, for one bounded drain after a
  // Message or a shared document (the recipient's email Notification).
  const importers = [...filesIn("app/"), ...filesIn("src/")].filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      importsOf(read(file)).some((s) =>
        /(?:^|\/)job-worker-adapter\.ts$/.test(s),
      ),
  );
  assert.deepEqual(importers, [
    "app/api/jobs/run/route.ts",
    "src/infrastructure/communications/communication-adapter.ts",
    "src/infrastructure/consultations/consultation-adapter.ts",
    "src/infrastructure/jobs/after-commit.ts",
    "src/infrastructure/payments/payment-adapter.ts",
  ]);
  assert.deepEqual(filesIn("src/infrastructure/jobs/"), [
    "src/infrastructure/jobs/after-commit.ts",
    "src/infrastructure/jobs/job-worker-adapter.ts",
  ]);
  // MVP-001 S7: and the Stripe webhook route, its own exact path.
  // MVP-001 S9: and the Daily webhook route, its own exact path.
  // MVP-001 S10: and the Resend webhook route, its own exact path.
  assert.deepEqual(filesIn("app/api/"), [
    "app/api/jobs/run/route.ts",
    "app/api/media/daily/route.ts",
    "app/api/notifications/resend/route.ts",
    "app/api/payments/stripe/route.ts",
  ]);
  // No page links to or calls the worker route.
  for (const file of [...filesIn("app/"), ...filesIn("src/")].filter(
    (f) => /\.tsx?$/.test(f) && f !== "app/api/jobs/run/route.ts",
  )) {
    assert.doesNotMatch(codeOf(read(file)), /\/api\/jobs/, file);
  }
});
