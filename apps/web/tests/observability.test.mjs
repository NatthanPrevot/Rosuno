// MVP-001 D-8: the server-side structured logging foundation, its data
// minimization, and the per-request correlation id.
//
// The logger is dependency-free and runs here through Node.js type
// stripping. Call sites are checked as source, so no request is needed.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  allowedFields,
  CORRELATION_HEADER,
  createLogger,
  errorFieldsOf,
  isCorrelationId,
  newCorrelationId,
} from "../src/infrastructure/observability/log.ts";

const appRoot = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, appRoot), "utf8");

function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

function importsOf(source) {
  return [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-11-17T09:30:00.000Z");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function capture() {
  const lines = [];
  const log = createLogger(
    (level, line) => lines.push({ level, line }),
    () => NOW,
  );
  return {
    lines,
    log,
    parsed: () => lines.map(({ line }) => JSON.parse(line)),
  };
}

// Synthetic values that must never reach a log line.
const SECRETS = [
  "person@example.test",
  "Bearer synthetic.jwt.token",
  "sb-access-token=<synthetic>",
  "correct horse battery staple",
  "My landlord kept my deposit after I moved out",
  "https://storage.example.test/object?token=<synthetic-signed>",
  "synthetic stack line at module.js:1:1",
];

test("1. a line is one JSON object with a timestamp, level, fixed event code, correlation id, and only allowlisted fields", () => {
  const { lines, log, parsed } = capture();
  log(
    "warn",
    "client_intake.call_failed",
    {
      route: "/client",
      operation: "intakesOf",
      outcome: "deadline",
      errorClass: "TypeError",
      errorCode: "42501",
      status: 503,
    },
    ID,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line.includes("\n"), false);
  assert.deepEqual(parsed()[0], {
    timestamp: "2026-11-17T09:30:00.000Z",
    level: "warn",
    event: "client_intake.call_failed",
    correlationId: ID,
    route: "/client",
    operation: "intakesOf",
    outcome: "deadline",
    errorClass: "TypeError",
    errorCode: "42501",
    status: 503,
  });
  // Info goes to the info stream; warn and error to the error stream.
  log("info", "app.started");
  log("error", "app.failed");
  assert.deepEqual(
    lines.map(({ level }) => level),
    ["warn", "info", "error"],
  );
  // An unknown level writes nothing.
  log("debug", "app.debug");
  assert.equal(lines.length, 3);
});

test("2. keys outside the allowlist are never read or written, and allowlisted values of the wrong shape are dropped", () => {
  const { log, parsed } = capture();
  const fields = {
    email: SECRETS[0],
    ...Object.fromEntries([
      ["password", SECRETS[3]],
      ["token", SECRETS[1]],
    ]),
    cookie: SECRETS[2],
    description: SECRETS[4],
    url: SECRETS[5],
    stack: SECRETS[6],
    error: new Error(SECRETS[3]),
    payload: { nested: SECRETS[0] },
    // Allowlisted names whose values carry content instead of a code.
    route: SECRETS[5],
    operation: SECRETS[0],
    outcome: SECRETS[4],
    errorClass: SECRETS[1],
    errorCode: SECRETS[0],
    status: "503",
  };
  // A disallowed key is never even read.
  Object.defineProperty(fields, "secret", {
    enumerable: true,
    get() {
      throw new Error("a disallowed key was read");
    },
  });
  log("error", "auth.sign_in.provider_unavailable", fields, ID);
  const [line] = parsed();
  assert.deepEqual(Object.keys(line), [
    "timestamp",
    "level",
    "event",
    "correlationId",
  ]);
  const text = JSON.stringify(line);
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, secret);
  }
  // Getters on allowlisted keys are not run either.
  const guarded = {};
  Object.defineProperty(guarded, "status", {
    enumerable: true,
    get() {
      throw new Error("a getter was run");
    },
  });
  assert.deepEqual(allowedFields(guarded), {});
  for (const value of [null, undefined, "text", 42, [1], new Proxy({}, {})]) {
    assert.deepEqual(allowedFields(value), {});
  }
  // Statuses are whole numbers from 0 to 599 only.
  for (const [status, kept] of [
    [0, true],
    [400, true],
    [599, true],
    [600, false],
    [-1, false],
    [4.5, false],
    [Number.NaN, false],
  ]) {
    assert.equal("status" in allowedFields({ status }), kept, String(status));
  }
});

test("3. an error contributes only its class name, code, and HTTP status", () => {
  const error = Object.assign(new TypeError(SECRETS[3]), {
    code: "PGRST116",
    status: 406,
    details: SECRETS[4],
    hint: SECRETS[0],
    cause: new Error(SECRETS[1]),
  });
  assert.deepEqual(errorFieldsOf(error), {
    errorClass: "TypeError",
    errorCode: "PGRST116",
    status: 406,
  });
  // A provider error object carries its own name.
  class AuthApiError extends Error {
    constructor() {
      super(SECRETS[1]);
      this.name = "AuthApiError";
      this.status = 500;
      this.code = "unexpected_failure";
    }
  }
  assert.deepEqual(errorFieldsOf(new AuthApiError()), {
    errorClass: "AuthApiError",
    errorCode: "unexpected_failure",
    status: 500,
  });
  // A database answer's plain error object gives its code only.
  assert.deepEqual(
    errorFieldsOf({ code: "23505", message: SECRETS[4], details: SECRETS[0] }),
    { errorCode: "23505" },
  );
  // A code or name that carries content is dropped; getters never run; and
  // anything that is not an object gives nothing.
  assert.deepEqual(
    errorFieldsOf({ code: SECRETS[0], name: "Synthetic", status: "500" }),
    {},
  );
  const trap = new Error("synthetic");
  Object.defineProperty(trap, "code", {
    get() {
      throw new Error("a getter was run");
    },
  });
  assert.deepEqual(errorFieldsOf(trap), { errorClass: "Error" });
  for (const value of [null, undefined, SECRETS[3], 7]) {
    assert.deepEqual(errorFieldsOf(value), {});
  }
});

test("4. an unusable event code, correlation id, or sink never leaks content or throws", () => {
  const { log, parsed } = capture();
  for (const event of [
    SECRETS[0],
    "Client.Failed",
    "client failed",
    "",
    "a".repeat(81),
    42,
  ]) {
    log("warn", event, { status: 500, outcome: "unavailable" }, ID);
  }
  for (const line of parsed()) {
    // The event is replaced by a fixed code, and its fields are dropped.
    assert.deepEqual(line, {
      timestamp: "2026-11-17T09:30:00.000Z",
      level: "warn",
      event: "log.malformed_event",
      correlationId: ID,
    });
  }
  const { log: other, parsed: otherParsed } = capture();
  for (const correlationId of [
    "attacker-chosen",
    ID.toUpperCase(),
    `${ID}\nforged`,
    undefined,
    null,
  ]) {
    other("info", "app.event", {}, correlationId);
  }
  for (const line of otherParsed()) {
    assert.equal(line.correlationId, null);
  }
  const failing = createLogger(() => {
    throw new Error("sink failure");
  });
  assert.doesNotThrow(() => failing("error", "app.event", { status: 500 }));
  const badClock = createLogger(
    () => {},
    () => {
      throw new Error("clock failure");
    },
  );
  assert.doesNotThrow(() => badClock("error", "app.event"));
});

test("5. correlation ids are fresh version 4 UUIDs, and the proxy always replaces an inbound one", () => {
  assert.equal(CORRELATION_HEADER, "x-rosuno-correlation-id");
  const ids = new Set(Array.from({ length: 200 }, () => newCorrelationId()));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.ok(isCorrelationId(id), id);
  }
  const proxy = codeOf(read("proxy.ts"));
  assert.deepEqual(importsOf(read("proxy.ts")), [
    "next/server",
    "./src/infrastructure/identity/supabase-server.ts",
    "./src/infrastructure/observability/log.ts",
  ]);
  // A fresh id is set on the forwarded request before anything else reads
  // it, and the same id is returned on the response. Nothing reads the
  // browser's own value.
  assert.ok(
    proxy.includes(
      "  const correlationId = newCorrelationId();\n  request.headers.set(CORRELATION_HEADER, correlationId);\n  const response = await refreshSupabaseSession(request);\n  response.headers.set(CORRELATION_HEADER, correlationId);\n  return response;\n",
    ),
  );
  assert.doesNotMatch(proxy, /headers\.get\(|console\.|\blog\(/);
});

test("6. the logger depends on nothing, and only server modules write log lines, with fixed event codes", () => {
  assert.deepEqual(filesIn("src/infrastructure/observability/"), [
    "src/infrastructure/observability/log.ts",
    "src/infrastructure/observability/request-log.ts",
  ]);
  assert.deepEqual(
    importsOf(read("src/infrastructure/observability/log.ts")),
    [],
  );
  assert.deepEqual(
    importsOf(read("src/infrastructure/observability/request-log.ts")),
    ["./log.ts"],
  );
  // The request module loads the Next.js request API only when it writes a
  // line, so a module that logs still loads in plain Node.js (the database
  // proofs drive the real adapters there), and it reads only the
  // correlation header.
  const requestLog = codeOf(
    read("src/infrastructure/observability/request-log.ts"),
  );
  assert.deepEqual(
    [...requestLog.matchAll(/\bimport\s*\(([^)]*)\)/g)].map(
      (match) => match[1],
    ),
    ['"next/headers"'],
  );
  assert.deepEqual(
    [...requestLog.matchAll(/\.get\(([^)]*)\)/g)].map((match) => match[1]),
    ["CORRELATION_HEADER"],
  );
  const callers = [...filesIn("app/"), ...filesIn("src/")].filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      importsOf(read(file)).some((specifier) =>
        /observability\/request-log\.ts$/.test(specifier),
      ),
  );
  // MVP-001 S1: the staff configuration actions (an action not completed),
  // the shared staff configuration page frame (a view unavailable), and the
  // staff configuration adapter (a failed call) also write lines. MVP-001
  // S2: the Auth MFA adapter (a failed or refused call) does too, and so
  // does the operational job worker adapter (a refused worker request, each
  // worker batch's counts, and each failed attempt's job type and code), and
  // the authentication-abuse control (PS-A4 section 4: each unavailable
  // protection's purpose, failure kind, outcome, and audit persistence; each
  // suspicious sign-in's handling). MVP-001 S3: the staff verification
  // actions (an uploaded document's opening not completed or refused, with
  // its fixed outcome only) and the protected resource adapter (a failed
  // resource call, storage call, or read, with no bytes, digest, path, or
  // URL) write lines too; the client actions and Intake page already did.
  // MVP-001 S3 part 2: the AI suggestion sources (a late or failed provider
  // answer or recording, with the call name and how it failed only; never a
  // description, answer, suggestion or model output) write lines too.
  // MVP-001 S5: the public profile, directory and selection pages (a view
  // unavailable, with the route and outcome only), the selection action (an
  // action not completed, with its fixed outcome only) and the discovery
  // adapter (a failed call, with the call name and how it failed only) write
  // lines too. MVP-001 S6: the request review and request pages (a view
  // unavailable, with the route and outcome only), the request actions (an
  // action not completed, with its fixed outcome only) and the consultation
  // request adapter (a failed call, with the call name and how it failed
  // only) write lines too. MVP-001 S6 PS-A3: the consultation offer adapter
  // (a failed offer call, with the call name and how it failed only) writes
  // lines too.
  assert.deepEqual(callers, [
    "app/attorneys/[attorney]/page.tsx",
    "app/client/actions.ts",
    "app/client/intakes/[intake]/page.tsx",
    "app/client/page.tsx",
    "app/client/requests/[request]/page.tsx",
    "app/client/requests/actions.ts",
    "app/client/requests/new/page.tsx",
    "app/find-an-attorney/page.tsx",
    "app/find-an-attorney/select/actions.ts",
    "app/find-an-attorney/select/page.tsx",
    "app/sign-in/actions.ts",
    "app/staff/actions.ts",
    "app/staff/frame.tsx",
    "app/staff/verification/actions.ts",
    "src/infrastructure/client/client-intake-adapter.ts",
    "src/infrastructure/client/intake-suggestion-adapter.ts",
    "src/infrastructure/discovery/discovery-adapter.ts",
    "src/infrastructure/identity/authentication-abuse-control.ts",
    "src/infrastructure/identity/authenticator-provider.ts",
    "src/infrastructure/jobs/job-worker-adapter.ts",
    "src/infrastructure/offers/consultation-offer-adapter.ts",
    "src/infrastructure/requests/consultation-request-adapter.ts",
    "src/infrastructure/resources/protected-resource-adapter.ts",
    // MVP-001 S4: the schedule adapter (a failed schedule call, with the
    // call name and how it failed only, and the sign-out step's fixed
    // outcome).
    "src/infrastructure/scheduling/attorney-schedule-adapter.ts",
    "src/infrastructure/staff/staff-configuration-adapter.ts",
  ]);
  for (const file of callers) {
    const code = codeOf(read(file));
    // No client module, and every event code is a fixed string.
    assert.doesNotMatch(read(file), /["']use client["']/, file);
    const calls = [
      ...code.matchAll(/logRequestEvent\(\s*([^,)]+),\s*([^,)]+)/g),
    ];
    assert.ok(calls.length > 0, file);
    for (const [, level, event] of calls) {
      assert.match(level, /^"(?:info|warn|error)"$/, file);
      assert.match(event.trim(), /^(?:"[a-z_.]+"|CALL_FAILED)$/, file);
    }
    // Nothing a person submitted or a provider returned is passed to a log
    // line: no form data, description, email, password, token, or message.
    // MVP-001 S3: nor any bytes, recording, digest, object path, or URL.
    for (const [call] of code.matchAll(/logRequestEvent\([^;]*;/g)) {
      assert.doesNotMatch(
        call,
        /formData|description|email|password|token|cookie|message|\.data\b|answers|input\.|bytes|recording|digest|path|url|resourceId/i,
        `${file}: ${call}`,
      );
    }
  }
});

test("7. a module that logs loads in plain Node.js, and outside a request a line carries no correlation id", async () => {
  const { logRequestEvent, requestCorrelationId } =
    await import("../src/infrastructure/observability/request-log.ts");
  assert.equal(await requestCorrelationId(), null);
  const written = [];
  const original = console.error;
  console.error = (line) => written.push(line);
  try {
    await logRequestEvent("warn", "client_intake.call_failed", {
      operation: "intakesOf",
      outcome: "deadline",
      errorCode: SECRETS[0],
    });
  } finally {
    console.error = original;
  }
  assert.equal(written.length, 1);
  const line = JSON.parse(written[0]);
  assert.equal(line.event, "client_intake.call_failed");
  assert.equal(line.correlationId, null);
  assert.equal(line.operation, "intakesOf");
  assert.equal("errorCode" in line, false);
  // The real client intake adapter, which logs, loads here as well.
  const adapter =
    await import("../src/infrastructure/client/client-intake-adapter.ts");
  assert.equal(typeof adapter.createClientIntakeReads, "function");
});

test("8. MVP-001 S2 (PS-A4 section 4): the protection report fields keep only their fixed words", () => {
  const { log, parsed } = capture();
  log(
    "error",
    "security.protection_unavailable",
    {
      purpose: "sign_in",
      failureKind: "runtime",
      outcome: "permitted",
      auditPersistence: "not_persisted",
    },
    ID,
  );
  assert.deepEqual(parsed()[0], {
    timestamp: "2026-11-17T09:30:00.000Z",
    level: "error",
    event: "security.protection_unavailable",
    correlationId: ID,
    outcome: "permitted",
    purpose: "sign_in",
    failureKind: "runtime",
    auditPersistence: "not_persisted",
  });
  for (const [field, kept, dropped] of [
    ["purpose", ["sign_in", "recovery"], ["signin", "Sign_in", "registration"]],
    [
      "failureKind",
      ["configuration", "runtime"],
      ["config", "Runtime", "database"],
    ],
    [
      "auditPersistence",
      ["persisted", "not_persisted"],
      ["unknown", "Persisted", "true"],
    ],
  ]) {
    for (const value of kept) {
      assert.deepEqual(allowedFields({ [field]: value }), { [field]: value });
    }
    for (const value of [
      ...dropped,
      ...SECRETS,
      "a".repeat(64),
      "",
      null,
      true,
      1,
      [kept[0]],
      { value: kept[0] },
    ]) {
      assert.deepEqual(allowedFields({ [field]: value }), {}, String(value));
    }
  }
});
