// MVP-001 S2 operational job worker: the provider-neutral drain and the
// strict worker answer readers (fixture-only).
//
// The drain runs against an in-memory stand-in for the worker port that
// records every call and answers what each test configures, and against
// synthetic handlers that exist only here. No provider, network, database,
// or credential is contacted; every id and job type is synthetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  areJobWorkerSettings,
  claimAnswerOf,
  COMPLETE_OUTCOMES,
  completeAnswerOf,
  drainJobs,
  FAIL_OUTCOMES,
  failAnswerOf,
  idempotencyKeyOf,
  JOB_DONE,
  JOB_ERROR_CODES,
  JOB_ERROR_MESSAGES,
  REFUSED_DRAIN,
  UNKNOWN_CLAIM,
} from "../src/application/job-worker.ts";

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

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORKER = "synthetic-worker:1";

const SETTINGS = Object.freeze({
  workerId: WORKER,
  leaseSeconds: 60,
  batchLimit: 3,
  maxBatches: 4,
  handlerDeadlineMs: 40,
  callDeadlineMs: 40,
  budgetMs: 60_000,
});

function job(n, overrides = {}) {
  return Object.freeze({
    jobId: ID(n),
    jobType: "synthetic.check",
    subjectType: "synthetic",
    subjectId: ID(1000 + n),
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  });
}

const claimed = (...jobs) =>
  Object.freeze({ kind: "claimed", jobs: Object.freeze(jobs) });

// A recording worker port. Each claim answers the next configured answer
// (a value or a function), and nothing once they run out.
function fakePort({
  claims = [],
  complete = () => "completed",
  fail = () => "retry_scheduled",
} = {}) {
  const calls = [];
  const queue = [...claims];
  return {
    calls,
    port: {
      claim: async (...args) => {
        calls.push(["claim", ...args]);
        const next = queue.shift();
        return typeof next === "function" ? next() : (next ?? claimed());
      },
      complete: async (...args) => {
        calls.push(["complete", ...args]);
        return complete(...args);
      },
      fail: async (...args) => {
        calls.push(["fail", ...args]);
        return fail(...args);
      },
    },
  };
}

function recordingObserver() {
  const notes = [];
  return {
    notes,
    observer: {
      batch: (counts) => notes.push(["batch", counts]),
      failureReported: (...args) => notes.push(["failure", ...args]),
      completionUnconfirmed: (...args) => notes.push(["unconfirmed", ...args]),
      claimFailed: () => notes.push(["claimFailed"]),
    },
  };
}

const handlers = (entries) => new Map(Object.entries(entries));
const done = async () => JOB_DONE;

async function drain(port, registry, overrides = {}) {
  return drainJobs({
    port,
    handlers: registry,
    settings: { ...SETTINGS, ...(overrides.settings ?? {}) },
    clock: overrides.clock ?? (() => 0),
    observer: overrides.observer,
  });
}

const counts = (overrides = {}) => ({
  status: "ran",
  batches: 1,
  claimed: 0,
  completed: 0,
  retried: 0,
  escalated: 0,
  superseded: 0,
  unconfirmed: 0,
  claimFailures: 0,
  ...overrides,
});

test("W-1. a handler that resolves to JOB_DONE completes its job, given its deterministic idempotency key and a live signal", async () => {
  const seen = [];
  const { port, calls } = fakePort({ claims: [claimed(job(1), job(2))] });
  const { notes, observer } = recordingObserver();
  const result = await drain(
    port,
    handlers({
      "synthetic.check": async (run) => {
        seen.push(run);
        return JOB_DONE;
      },
    }),
    { observer },
  );
  assert.deepEqual(result, counts({ claimed: 2, completed: 2 }));
  assert.deepEqual(calls, [
    ["claim", WORKER, 60, 3],
    ["complete", ID(1), WORKER],
    ["complete", ID(2), WORKER],
  ]);
  assert.deepEqual(
    seen.map((run) => [run.jobId, run.idempotencyKey, run.signal.aborted]),
    [
      [ID(1), `rosuno-job-${ID(1)}`, false],
      [ID(2), `rosuno-job-${ID(2)}`, false],
    ],
  );
  assert.equal(idempotencyKeyOf(ID(1)), `rosuno-job-${ID(1)}`);
  assert.deepEqual(
    Object.keys(seen[0]).sort(),
    [
      "attempt",
      "idempotencyKey",
      "jobId",
      "jobType",
      "maxAttempts",
      "signal",
      "subjectId",
      "subjectType",
    ].sort(),
  );
  assert.ok(Object.isFrozen(seen[0]));
  assert.deepEqual(notes, [
    [
      "batch",
      {
        claimed: 2,
        completed: 2,
        retried: 0,
        escalated: 0,
        superseded: 0,
        unconfirmed: 0,
      },
    ],
  ]);
  assert.ok(Object.isFrozen(result));
});

test("W-2. a handler that throws, rejects, answers anything but JOB_DONE, or runs past its deadline fails with its fixed code and message, never completes", async () => {
  const cases = [
    [
      "throws",
      () => {
        throw new Error("synthetic provider detail person@example.test");
      },
      "handler_failed",
    ],
    [
      "rejects",
      async () => Promise.reject(new Error("synthetic")),
      "handler_failed",
    ],
    ["undefined", async () => undefined, "handler_failed"],
    ["true", async () => true, "handler_failed"],
    ["other text", async () => "DONE", "handler_failed"],
    ["object", async () => ({ status: JOB_DONE }), "handler_failed"],
    ["never settles", () => new Promise(() => {}), "handler_timeout"],
    [
      "too slow",
      () => new Promise((resolve) => setTimeout(() => resolve(JOB_DONE), 200)),
      "handler_timeout",
    ],
  ];
  for (const [label, handler, code] of cases) {
    let signal;
    const { port, calls } = fakePort({ claims: [claimed(job(1))] });
    const { notes, observer } = recordingObserver();
    const result = await drain(
      port,
      handlers({
        "synthetic.check": (run) => {
          signal = run.signal;
          return handler(run);
        },
      }),
      { observer },
    );
    assert.deepEqual(result, counts({ claimed: 1, retried: 1 }), label);
    assert.deepEqual(
      calls,
      [
        ["claim", WORKER, 60, 3],
        ["fail", ID(1), WORKER, code, JOB_ERROR_MESSAGES[code]],
      ],
      label,
    );
    assert.equal(signal.aborted, code === "handler_timeout", label);
    assert.deepEqual(
      notes[0],
      ["failure", "synthetic.check", code, "retry_scheduled"],
      label,
    );
    // Nothing the handler threw or answered reaches the report.
    assert.equal(JSON.stringify(calls).includes("example.test"), false);
  }
  // The fixed codes match the database's error code format, and every
  // message is fixed, bounded text.
  assert.deepEqual(JOB_ERROR_CODES, [
    "handler_failed",
    "handler_timeout",
    "unknown_job_type",
  ]);
  for (const code of JOB_ERROR_CODES) {
    assert.match(code, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(JOB_ERROR_MESSAGES[code].length <= 500);
    assert.doesNotMatch(JOB_ERROR_MESSAGES[code], /[\u0000-\u001f]|\$\{/);
  }
});

test("W-3. a job type without a handler is reported unknown_job_type, and each failure answer is counted as the database decided it", async () => {
  for (const [answer, key] of [
    ["retry_scheduled", "retried"],
    ["escalated", "escalated"],
    ["not_owner", "superseded"],
    ["not_running", "superseded"],
    ["unknown", "unconfirmed"],
    ["RETRY_SCHEDULED", "unconfirmed"],
    [undefined, "unconfirmed"],
  ]) {
    let ran = false;
    const { port, calls } = fakePort({
      claims: [claimed(job(1, { jobType: "synthetic.other" }))],
      fail: () => answer,
    });
    const { notes, observer } = recordingObserver();
    const result = await drain(
      port,
      handlers({
        "synthetic.check": async () => {
          ran = true;
          return JOB_DONE;
        },
      }),
      { observer },
    );
    assert.equal(ran, false);
    assert.deepEqual(result, counts({ claimed: 1, [key]: 1 }), String(answer));
    assert.deepEqual(calls[1], [
      "fail",
      ID(1),
      WORKER,
      "unknown_job_type",
      JOB_ERROR_MESSAGES.unknown_job_type,
    ]);
    assert.deepEqual(notes[0], [
      "failure",
      "synthetic.other",
      "unknown_job_type",
      key === "unconfirmed" ? "unknown" : answer,
    ]);
  }
  // The production registry may be empty: every job is then reported.
  const { port, calls } = fakePort({ claims: [claimed(job(1), job(2))] });
  assert.deepEqual(
    await drain(port, new Map()),
    counts({ claimed: 2, retried: 2 }),
  );
  assert.deepEqual(
    calls.slice(1).map((call) => call[3]),
    ["unknown_job_type", "unknown_job_type"],
  );
});

test("W-4. a completion whose answer is lost, late, thrown, or not one of job_complete's outcomes is unconfirmed, never completed", async () => {
  for (const [label, complete, key] of [
    ["completed", () => "completed", "completed"],
    ["not_owner", () => "not_owner", "superseded"],
    ["not_running", () => "not_running", "superseded"],
    ["unknown", () => "unknown", "unconfirmed"],
    ["malformed", () => "COMPLETED", "unconfirmed"],
    ["object", () => ({ outcome: "completed" }), "unconfirmed"],
    [
      "thrown",
      () => {
        throw new Error("synthetic");
      },
      "unconfirmed",
    ],
    ["late", () => new Promise(() => {}), "unconfirmed"],
  ]) {
    const { port } = fakePort({ claims: [claimed(job(1))], complete });
    const { notes, observer } = recordingObserver();
    const result = await drain(port, handlers({ "synthetic.check": done }), {
      observer,
    });
    assert.deepEqual(result, counts({ claimed: 1, [key]: 1 }), label);
    assert.deepEqual(
      notes.filter(([kind]) => kind === "unconfirmed"),
      key === "unconfirmed"
        ? [["unconfirmed", "synthetic.check", "unknown"]]
        : [],
      label,
    );
  }
});

test("W-5. a job delivered again runs its handler with the same idempotency key, so a keyed effect happens once; a job twice in one claim is never run", async () => {
  // A provider stand-in that applies each idempotency key's effect once.
  const effects = new Map();
  const keys = [];
  const registry = handlers({
    "synthetic.check": async (run) => {
      keys.push(run.idempotencyKey);
      if (!effects.has(run.idempotencyKey)) {
        effects.set(run.idempotencyKey, run.jobId);
      }
      return JOB_DONE;
    },
  });
  // First delivery: the completion answer is lost, so the lease expires and
  // the database delivers the same job again on a later claim.
  const first = fakePort({
    claims: [claimed(job(7))],
    complete: () => "unknown",
  });
  assert.deepEqual(
    await drain(first.port, registry),
    counts({ claimed: 1, unconfirmed: 1 }),
  );
  const second = fakePort({ claims: [claimed(job(7, { attempt: 2 }))] });
  assert.deepEqual(
    await drain(second.port, registry),
    counts({ claimed: 1, completed: 1 }),
  );
  assert.deepEqual(keys, [`rosuno-job-${ID(7)}`, `rosuno-job-${ID(7)}`]);
  assert.deepEqual([...effects], [[`rosuno-job-${ID(7)}`, ID(7)]]);
  // Different jobs never share a key.
  assert.notEqual(idempotencyKeyOf(ID(7)), idempotencyKeyOf(ID(8)));
  // The same job twice in one claim answer is not trusted: nothing runs.
  keys.length = 0;
  const twice = fakePort({ claims: [claimed(job(9), job(9))] });
  assert.deepEqual(
    await drain(twice.port, registry),
    counts({ batches: 0, claimFailures: 1 }),
  );
  assert.deepEqual(keys, []);
  assert.deepEqual(twice.calls, [["claim", WORKER, 60, 3]]);
});

test("W-6. a drain claims within its limit and lease, stops when work runs out, a claim is unknown, or its batches or budget are used up", async () => {
  const registry = handlers({ "synthetic.check": done });
  // Full batches continue up to the batch bound.
  const full = fakePort({
    claims: Array.from({ length: 6 }, (_, b) =>
      claimed(job(b * 10 + 1), job(b * 10 + 2), job(b * 10 + 3)),
    ),
  });
  assert.deepEqual(
    await drain(full.port, registry),
    counts({ batches: 4, claimed: 12, completed: 12 }),
  );
  assert.equal(full.calls.filter(([kind]) => kind === "claim").length, 4);
  // A batch smaller than the limit means no more due work.
  const short = fakePort({
    claims: [claimed(job(1), job(2), job(3)), claimed(job(4)), claimed(job(5))],
  });
  assert.deepEqual(
    await drain(short.port, registry),
    counts({ batches: 2, claimed: 4, completed: 4 }),
  );
  // An unknown, thrown, late, malformed, or oversized claim stops the drain.
  for (const answer of [
    UNKNOWN_CLAIM,
    () => {
      throw new Error("synthetic");
    },
    () => new Promise(() => {}),
    { kind: "claimed" },
    { kind: "claimed", jobs: [job(1)], extra: 1 },
    { kind: "claimed", jobs: [{ ...job(1), jobId: "not-an-id" }] },
    claimed(job(1), job(2), job(3), job(4)),
    "claimed",
  ]) {
    const { port, calls } = fakePort({ claims: [answer] });
    const { notes, observer } = recordingObserver();
    assert.deepEqual(
      await drain(port, registry, { observer }),
      counts({ batches: 0, claimFailures: 1 }),
    );
    assert.deepEqual(calls.length, 1);
    assert.deepEqual(notes, [["claimFailed"]]);
  }
  // After the budget has passed no further batch is claimed.
  let now = 0;
  const budget = fakePort({
    claims: Array.from({ length: 4 }, (_, b) =>
      claimed(job(b * 10 + 1), job(b * 10 + 2), job(b * 10 + 3)),
    ),
  });
  const timed = await drain(budget.port, registry, {
    clock: () => {
      now += 30_000;
      return now;
    },
  });
  assert.deepEqual(timed, counts({ batches: 2, claimed: 6, completed: 6 }));
  // An empty claim is one batch with nothing to do.
  assert.deepEqual(await drain(fakePort().port, registry), counts());
});

test("W-7. settings outside their bounds, or a lease that would not outlast a job's claim, handler, and report, are refused before anything is claimed", async () => {
  assert.equal(areJobWorkerSettings(SETTINGS), true);
  for (const [label, overrides] of [
    ["lease too short", { leaseSeconds: 4 }],
    ["lease too long", { leaseSeconds: 3601 }],
    ["lease not whole", { leaseSeconds: 60.5 }],
    ["no batch", { batchLimit: 0 }],
    ["batch too large", { batchLimit: 51 }],
    ["no batches", { maxBatches: 0 }],
    ["too many batches", { maxBatches: 21 }],
    ["no handler time", { handlerDeadlineMs: 0 }],
    ["no call time", { callDeadlineMs: 0 }],
    ["negative budget", { budgetMs: -1 }],
    [
      "lease shorter than a job",
      { leaseSeconds: 5, handlerDeadlineMs: 3000, callDeadlineMs: 1000 },
    ],
    ["empty worker", { workerId: "" }],
    ["worker with space", { workerId: "synthetic worker" }],
    ["worker too long", { workerId: "w".repeat(65) }],
    ["text number", { batchLimit: "3" }],
  ]) {
    const settings = { ...SETTINGS, ...overrides };
    assert.equal(areJobWorkerSettings(settings), false, label);
    const { port, calls } = fakePort({ claims: [claimed(job(1))] });
    assert.deepEqual(
      await drainJobs({
        port,
        handlers: new Map(),
        settings,
        clock: () => 0,
      }),
      REFUSED_DRAIN,
      label,
    );
    assert.deepEqual(calls, [], label);
  }
  assert.equal(areJobWorkerSettings({ ...SETTINGS, extra: 1 }), false);
  assert.equal(areJobWorkerSettings(null), false);
  assert.deepEqual(REFUSED_DRAIN.status, "refused");
});

test("W-8. observers only observe: a throwing observer changes no count, and a drain never throws", async () => {
  const throwing = {
    batch: () => {
      throw new Error("synthetic");
    },
    failureReported: async () => Promise.reject(new Error("synthetic")),
    completionUnconfirmed: () => {
      throw new Error("synthetic");
    },
    claimFailed: () => {
      throw new Error("synthetic");
    },
  };
  const { port } = fakePort({
    claims: [claimed(job(1), job(2, { jobType: "synthetic.other" }))],
    complete: () => "unknown",
  });
  assert.deepEqual(
    await drain(port, handlers({ "synthetic.check": done }), {
      observer: throwing,
    }),
    counts({ claimed: 2, retried: 1, unconfirmed: 1 }),
  );
  // A port whose calls throw synchronously is still only unknown.
  const brittle = {
    claim: () => {
      throw new Error("synthetic");
    },
    complete: () => {
      throw new Error("synthetic");
    },
    fail: () => {
      throw new Error("synthetic");
    },
  };
  assert.deepEqual(
    await drain(brittle, new Map(), { observer: throwing }),
    counts({ batches: 0, claimFailures: 1 }),
  );
});

test("W-9. job_claim, job_complete, and job_fail answers are read strictly; anything else is unknown", () => {
  const row = (overrides = {}) => ({
    job_id: ID(1),
    job_type: "synthetic.check",
    subject_type: "synthetic",
    subject_id: ID(2),
    attempt: 1,
    max_attempts: 3,
    ...overrides,
  });
  assert.deepEqual(claimAnswerOf([row()], 5), {
    kind: "claimed",
    jobs: [
      {
        jobId: ID(1),
        jobType: "synthetic.check",
        subjectType: "synthetic",
        subjectId: ID(2),
        attempt: 1,
        maxAttempts: 3,
      },
    ],
  });
  assert.deepEqual(claimAnswerOf([], 1), { kind: "claimed", jobs: [] });
  assert.deepEqual(
    claimAnswerOf([row({ subject_type: null, subject_id: null })], 1).jobs[0]
      .subjectId,
    null,
  );
  for (const [label, data, limit] of [
    ["not a list", { 0: row() }, 5],
    ["null", null, 5],
    ["over the limit", [row(), row({ job_id: ID(3) })], 1],
    ["limit out of bounds", [row()], 51],
    ["same job twice", [row(), row()], 5],
    ["extra column", [{ ...row(), payload: {} }], 5],
    ["missing column", [{ ...row(), max_attempts: undefined }], 5],
    ["bad id", [row({ job_id: "not-an-id" })], 5],
    ["upper-case id", [row({ job_id: ID(1).replace("4000", "4ABC") })], 5],
    ["bad type", [row({ job_type: "Synthetic Check" })], 5],
    ["short type", [row({ job_type: "ab" })], 5],
    ["subject type without id", [row({ subject_id: null })], 5],
    ["subject id without type", [row({ subject_type: null })], 5],
    ["bad subject type", [row({ subject_type: "Synthetic" })], 5],
    ["attempt zero", [row({ attempt: 0 })], 5],
    ["attempt over bound", [row({ attempt: 4 })], 5],
    ["text attempt", [row({ attempt: "1" })], 5],
    ["no attempts allowed", [row({ attempt: 1, max_attempts: 0 })], 5],
  ]) {
    assert.deepEqual(claimAnswerOf(data, limit), UNKNOWN_CLAIM, label);
  }
  for (const outcome of COMPLETE_OUTCOMES) {
    assert.equal(completeAnswerOf(outcome), outcome);
  }
  for (const outcome of FAIL_OUTCOMES) {
    assert.equal(failAnswerOf(outcome), outcome);
  }
  for (const data of ["retry_scheduled", "Completed", null, ["completed"], 1]) {
    assert.equal(completeAnswerOf(data), "unknown", String(data));
  }
  for (const data of [
    "completed",
    "ESCALATED",
    null,
    { outcome: "escalated" },
  ]) {
    assert.equal(failAnswerOf(data), "unknown", String(data));
  }
});

test("W-10. the drain stays provider-neutral: one application import, no clock, randomness, network, logging, or environment of its own", () => {
  const source = read("src/application/job-worker.ts");
  assert.deepEqual(importsOf(source), ["./professional-records.ts"]);
  assert.doesNotMatch(
    codeOf(source),
    /supabase|next\/|react|\bprocess\b|\bconsole\b|\bfetch\s*\(|Date\.now|new Date|Math\.random|crypto|cookie|header|localStorage|\.rpc\(/i,
  );
  assert.doesNotMatch(codeOf(source), /^(?:let|var) /m);
  // No handler or job type is defined in the drain itself.
  assert.doesNotMatch(codeOf(source), /new Map\(|"[a-z_]+\.[a-z_.]+"/);
});
