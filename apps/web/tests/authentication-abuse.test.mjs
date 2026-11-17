// MVP-001 S2 authentication-abuse control tests (PS-A4 sections 3 and 4;
// owner decision DEC-20261117-S2-AUTHENTICATION-PROTECTION-UNAVAILABLE-
// BEHAVIOR; MBS section 5 failure tests for authentication and recovery
// abuse, rate-limit bypass, and the suspicious-session boundary).
//
// The sign-in and recovery use cases run against recording stand-ins of the
// provider port and the abuse control. The server-only control runs against
// an injected synthetic decision port and a synthetic environment, and its
// log lines are captured as written. The narrow privileged decision port runs
// through the installed supabase-js client against a synthetic in-memory HTTP
// API, so every request it would send is checked as sent. The database
// functions themselves are proven only by the explicitly invoked disposable
// PostgreSQL proof (mvp-001-s2-db-proof.mjs). No real provider, account,
// key, network, or database is contacted, and every value is synthetic.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mock, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  RECOVERY_UNAVAILABLE_POLICY,
  SIGN_IN_UNAVAILABLE_POLICY,
  protectAttempt,
} from "../src/application/authentication-abuse-control.ts";
import { requestAccountRecovery } from "../src/application/account-recovery.ts";
import { signInExistingAccount } from "../src/application/authentication-entry.ts";
import {
  AUTH_ABUSE_KEY_SETTING,
  AUTH_ABUSE_SETTING_NAMES,
  createAuthenticationAbuseControl,
} from "../src/infrastructure/identity/authentication-abuse-control.ts";
import { createAuthenticationAbusePort } from "../src/infrastructure/identity/registration-provisioning.ts";
import { createSupabaseServerSessionSource } from "../src/infrastructure/identity/server-session-source.ts";

const appRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../", appRoot);

function read(relativePath, root = appRoot) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

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

// Source without its comments.
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*\n/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

// SQL without its line comments.
function sqlOf(source) {
  return source.replace(/^\s*--.*\n/gm, "");
}

// Synthetic, test-only values. None is a real account, address, or key.
const EMAIL = "member@synthetic.invalid";
const UNKNOWN_EMAIL = "nobody@synthetic.invalid";
const PW = "synthetic-pw-7f3a";
const ACCOUNT = "00000000-0000-4000-8000-0000000051a1";
const ISSUED = "synthetic-session-issued";
const KEY = Buffer.alloc(32, 0x5a).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 0x3c).toString("base64");
const DOMAIN = "authentication-abuse/v1";
const MIGRATION =
  "supabase/migrations/20261118040000_mvp_001_s2_authentication_abuse_control.sql";

const ENVIRONMENT = Object.freeze({
  ROSUNO_ENVIRONMENT_CLASS: "development",
  ROSUNO_AUTH_ABUSE_HMAC_SECRET: KEY,
  ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_MAX: "5",
  ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_WINDOW_SECONDS: "900",
  ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_MAX: "1000",
  ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_WINDOW_SECONDS: "3600",
  ROSUNO_AUTH_ABUSE_SIGN_IN_SUSPICIOUS_FAILURES: "3",
  ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_MAX: "3",
  ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_WINDOW_SECONDS: "3600",
  ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_MAX: "500",
  ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_WINDOW_SECONDS: "86400",
});

const SIGN_IN_LIMITS = Object.freeze({
  identityMax: 5,
  identityWindowSeconds: 900,
  globalMax: 1000,
  globalWindowSeconds: 3600,
});
const RECOVERY_LIMITS = Object.freeze({
  identityMax: 3,
  identityWindowSeconds: 3600,
  globalMax: 500,
  globalWindowSeconds: 86400,
});

function digestOf(key, purpose, dimension, value) {
  return createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${DOMAIN}\u0000${purpose}\u0000${dimension}\u0000`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function digestsOf(purpose, email = EMAIL, key = KEY) {
  return {
    identity: digestOf(key, purpose, "identity", email.trim().toLowerCase()),
    global: digestOf(key, purpose, "global", ""),
  };
}

function form(entries) {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
}

const signInForm = (email = EMAIL, password = PW) =>
  form([
    ["email", email],
    ["password", password],
  ]);

// A control stand-in recording every call, in order, into a shared list.
function recordingControl(events, answers = {}) {
  const reply = async (name, fallback, args) => {
    events.push([name, ...args]);
    const answer = answers[name];
    if (answer instanceof Error) {
      throw answer;
    }
    if (typeof answer === "function") {
      return answer(...args);
    }
    return answer === undefined ? fallback : answer;
  };
  return Object.freeze({
    reserve: (...args) => reply("reserve", "allow", args),
    recordFailure: (...args) => reply("recordFailure", "recorded", args),
    recordSuccess: (...args) => reply("recordSuccess", "recorded", args),
    reportUnavailable: (...args) => reply("reportUnavailable", undefined, args),
    reportSuspicious: (...args) => reply("reportSuspicious", undefined, args),
  });
}

// A sign-in provider stand-in for one request. It accepts only the
// synthetic password for an existing account, stores the issued session, and
// records every call into the same list as the control.
function signInProvider(events, control, options = {}) {
  const { exists = true, others = true } = options;
  const jar = { session: null };
  const held = { session: null };
  const readOf = (store) => async () =>
    store.session === null
      ? { kind: "none" }
      : { kind: "session", id: store.session };
  const provider = {
    signInWithPassword: async (submitted) => {
      events.push(["signInWithPassword", submitted.email]);
      if (!exists || submitted.password !== PW) {
        return "rejected";
      }
      held.session = ISSUED;
      jar.session = ISSUED;
      return "accepted";
    },
    signOut: async () => {
      events.push(["signOut"]);
      held.session = null;
      jar.session = null;
      return true;
    },
    signOutOtherSessions: async () => {
      events.push(["signOutOtherSessions"]);
      if (others instanceof Error) {
        throw others;
      }
      return others;
    },
    issuedSession: readOf(held),
    storedSession: readOf(jar),
    session: createSupabaseServerSessionSource(async () => ({
      auth: {
        getClaims: async () =>
          jar.session === null
            ? { data: null, error: null }
            : {
                data: { claims: { sub: ACCOUNT, session_id: jar.session } },
                error: null,
              },
      },
    })),
    abuseControl: control,
  };
  return { jar, provider, source: async () => provider };
}

function recoveryProvider(events, control) {
  const provider = {
    requestRecoveryEmail: async (email) => {
      events.push(["requestRecoveryEmail", email]);
    },
    abuseControl: control,
  };
  return async () => provider;
}

// ---------------------------------------------------------------------------
// Sign-in use case
// ---------------------------------------------------------------------------

test("1. sign-in reserves every validated attempt before the provider, for existing and unknown accounts alike, and records the result", async () => {
  // A protected success is judged with the trusted account id.
  const events = [];
  const stand = signInProvider(events, recordingControl(events));
  assert.deepEqual(
    await signInExistingAccount(stand.source, signInForm(`  ${EMAIL}  `)),
    { status: "signed-in" },
  );
  assert.deepEqual(events, [
    ["reserve", EMAIL],
    ["signInWithPassword", EMAIL],
    ["recordSuccess", EMAIL, ACCOUNT],
  ]);
  // A rejection is counted, and the call order is the same whether or not
  // the account exists.
  const sequences = [];
  for (const exists of [true, false]) {
    const seen = [];
    const rejected = signInProvider(seen, recordingControl(seen), { exists });
    assert.deepEqual(
      await signInExistingAccount(
        rejected.source,
        signInForm(exists ? EMAIL : UNKNOWN_EMAIL, "wrong-synthetic-pw"),
      ),
      { status: "rejected" },
    );
    sequences.push(seen.map(([name]) => name));
  }
  assert.deepEqual(sequences, [
    ["reserve", "signInWithPassword", "recordFailure"],
    ["reserve", "signInWithPassword", "recordFailure"],
  ]);
  // An invalid submission reaches neither the control nor the provider.
  const invalid = [];
  const untouched = signInProvider(invalid, recordingControl(invalid));
  assert.equal(
    (await signInExistingAccount(untouched.source, signInForm("not-an-email")))
      .status,
    "invalid",
  );
  assert.deepEqual(invalid, []);
});

test("2. a throttled sign-in gets one fixed result, reaches no provider, and is the same for existing and unknown accounts", async () => {
  for (const email of [EMAIL, UNKNOWN_EMAIL, "MEMBER@Synthetic.Invalid"]) {
    for (const exists of [true, false]) {
      const events = [];
      const stand = signInProvider(
        events,
        recordingControl(events, { reserve: "throttle" }),
        { exists },
      );
      const state = await signInExistingAccount(
        stand.source,
        signInForm(email),
      );
      assert.deepEqual(state, { status: "throttled" });
      assert.ok(Object.isFrozen(state));
      assert.deepEqual(Reflect.ownKeys(state), ["status"]);
      assert.deepEqual(events, [["reserve", email]]);
      assert.equal(stand.jar.session, null);
    }
  }
});

test("3. sign-in with unavailable protection: configuration refuses; runtime permits once, reported, without recording", async () => {
  // Configuration: refused, reported once, and the provider is never asked.
  const events = [];
  const refused = signInProvider(
    events,
    recordingControl(events, { reserve: "unavailable_configuration" }),
  );
  assert.deepEqual(await signInExistingAccount(refused.source, signInForm()), {
    status: "unavailable",
  });
  assert.deepEqual(events, [
    ["reserve", EMAIL],
    ["reportUnavailable", "configuration", "refused"],
  ]);
  // Runtime (an unavailable answer, an unknown answer, or a throw):
  // permitted, reported once before the provider is asked, and no result is
  // recorded for an attempt that was not protected.
  for (const answer of [
    "unavailable_runtime",
    "deny",
    undefined,
    null,
    new Error("synthetic runtime failure"),
  ]) {
    for (const password of [PW, "wrong-synthetic-pw"]) {
      const seen = [];
      const control = recordingControl(seen, {
        reserve: answer === undefined ? async () => undefined : answer,
      });
      const permitted = signInProvider(seen, control);
      const state = await signInExistingAccount(
        permitted.source,
        signInForm(EMAIL, password),
      );
      assert.deepEqual(state, {
        status: password === PW ? "signed-in" : "rejected",
      });
      assert.deepEqual(seen, [
        ["reserve", EMAIL],
        ["reportUnavailable", "runtime", "permitted"],
        ["signInWithPassword", EMAIL],
      ]);
    }
  }
  // A report that throws changes nothing.
  const thrown = [];
  const loud = signInProvider(
    thrown,
    recordingControl(thrown, {
      reserve: "unavailable_configuration",
      reportUnavailable: new Error("synthetic report failure"),
    }),
  );
  assert.deepEqual(await signInExistingAccount(loud.source, signInForm()), {
    status: "unavailable",
  });
});

test("4. a missing or malformed control refuses every sign-in and recovery before any provider call", async () => {
  const malformed = [
    undefined,
    null,
    "control",
    {},
    { reserve: async () => "allow" },
    {
      ...recordingControl([]),
      reportSuspicious: "not a function",
    },
  ];
  for (const control of malformed) {
    const events = [];
    const stand = signInProvider(events, control);
    assert.deepEqual(await signInExistingAccount(stand.source, signInForm()), {
      status: "unavailable",
    });
    assert.deepEqual(events, []);
    assert.deepEqual(
      await requestAccountRecovery(
        recoveryProvider(events, control),
        form([["email", EMAIL]]),
      ),
      { status: "unavailable" },
    );
    assert.deepEqual(events, []);
  }
  // A control getter that throws is no control.
  const events = [];
  const stand = signInProvider(events, recordingControl(events));
  Object.defineProperty(stand.provider, "abuseControl", {
    get() {
      throw new Error("synthetic getter failure");
    },
  });
  assert.deepEqual(await signInExistingAccount(stand.source, signInForm()), {
    status: "unavailable",
  });
  assert.deepEqual(events, []);
});

test("5. a failed attempt that reaches the threshold is reported suspicious; the result stays rejected", async () => {
  const events = [];
  const stand = signInProvider(
    events,
    recordingControl(events, { recordFailure: "suspicious" }),
  );
  assert.deepEqual(
    await signInExistingAccount(stand.source, signInForm(EMAIL, "wrong")),
    { status: "rejected" },
  );
  assert.deepEqual(events, [
    ["reserve", EMAIL],
    ["signInWithPassword", EMAIL],
    ["recordFailure", EMAIL],
    ["reportSuspicious", "failed_attempt"],
  ]);
});

test("6. a suspicious success ends the account's other sessions, keeps the new one, and is reported; the sign-in stands", async () => {
  for (const [others, handling] of [
    [true, "other_sessions_ended"],
    [false, "other_sessions_not_ended"],
    ["yes", "other_sessions_not_ended"],
    [new Error("synthetic provider failure"), "other_sessions_not_ended"],
  ]) {
    const events = [];
    const stand = signInProvider(
      events,
      recordingControl(events, { recordSuccess: "suspicious" }),
      { others },
    );
    assert.deepEqual(await signInExistingAccount(stand.source, signInForm()), {
      status: "signed-in",
    });
    assert.equal(stand.jar.session, ISSUED);
    assert.deepEqual(events, [
      ["reserve", EMAIL],
      ["signInWithPassword", EMAIL],
      ["recordSuccess", EMAIL, ACCOUNT],
      ["signOutOtherSessions"],
      ["reportSuspicious", handling],
    ]);
  }
  // A success that is not suspicious never ends other sessions.
  const events = [];
  const calm = signInProvider(events, recordingControl(events));
  await signInExistingAccount(calm.source, signInForm());
  assert.equal(
    events.some(([name]) => name === "signOutOtherSessions"),
    false,
  );
});

test("7. a result that cannot be recorded is a runtime protection failure: permitted, reported, and the result unchanged", async () => {
  for (const answer of [
    "unavailable",
    "unknown",
    undefined,
    new Error("synthetic record failure"),
  ]) {
    const failing = answer === undefined ? async () => undefined : answer;
    const rejectedEvents = [];
    const rejected = signInProvider(
      rejectedEvents,
      recordingControl(rejectedEvents, { recordFailure: failing }),
    );
    assert.deepEqual(
      await signInExistingAccount(rejected.source, signInForm(EMAIL, "wrong")),
      { status: "rejected" },
    );
    assert.deepEqual(rejectedEvents.at(-1), [
      "reportUnavailable",
      "runtime",
      "permitted",
    ]);
    const acceptedEvents = [];
    const accepted = signInProvider(
      acceptedEvents,
      recordingControl(acceptedEvents, { recordSuccess: failing }),
    );
    assert.deepEqual(
      await signInExistingAccount(accepted.source, signInForm()),
      {
        status: "signed-in",
      },
    );
    assert.deepEqual(acceptedEvents.at(-1), [
      "reportUnavailable",
      "runtime",
      "permitted",
    ]);
    assert.equal(
      acceptedEvents.some(([name]) => name === "signOutOtherSessions"),
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// Recovery use case
// ---------------------------------------------------------------------------

test("8. recovery reserves before the provider; a throttle answers neutrally without sending; every unavailable protection refuses and is reported", async () => {
  const cases = [
    ["allow", { status: "submitted" }, true, null],
    ["throttle", { status: "submitted" }, false, null],
    [
      "unavailable_configuration",
      { status: "unavailable" },
      false,
      ["reportUnavailable", "configuration", "refused"],
    ],
    [
      "unavailable_runtime",
      { status: "unavailable" },
      false,
      ["reportUnavailable", "runtime", "refused"],
    ],
    [
      "something else",
      { status: "unavailable" },
      false,
      ["reportUnavailable", "runtime", "refused"],
    ],
    [
      new Error("synthetic runtime failure"),
      { status: "unavailable" },
      false,
      ["reportUnavailable", "runtime", "refused"],
    ],
  ];
  for (const [answer, expected, sent, report] of cases) {
    const sequences = [];
    for (const email of [EMAIL, UNKNOWN_EMAIL]) {
      const events = [];
      const state = await requestAccountRecovery(
        recoveryProvider(events, recordingControl(events, { reserve: answer })),
        form([["email", ` ${email} `]]),
      );
      assert.deepEqual(state, expected);
      assert.deepEqual(events, [
        ["reserve", email],
        ...(report === null ? [] : [report]),
        ...(sent ? [["requestRecoveryEmail", email]] : []),
      ]);
      sequences.push(events.map(([name]) => name));
    }
    // The same calls and result whether or not an account exists.
    assert.deepEqual(sequences[0], sequences[1]);
  }
  // An invalid request reaches neither.
  const events = [];
  assert.equal(
    (
      await requestAccountRecovery(
        recoveryProvider(events, recordingControl(events)),
        form([["email", "holder@"]]),
      )
    ).status,
    "invalid",
  );
  assert.deepEqual(events, []);
});

test("9. the unavailable policies are the owner's recorded decision, and only an exact allow or throttle is a decision", async () => {
  assert.deepEqual(SIGN_IN_UNAVAILABLE_POLICY, {
    configuration: "refused",
    runtime: "permitted",
  });
  assert.deepEqual(RECOVERY_UNAVAILABLE_POLICY, {
    configuration: "refused",
    runtime: "refused",
  });
  assert.ok(Object.isFrozen(SIGN_IN_UNAVAILABLE_POLICY));
  assert.ok(Object.isFrozen(RECOVERY_UNAVAILABLE_POLICY));
  for (const [answer, signIn, recovery] of [
    ["allow", "allow", "allow"],
    ["throttle", "throttle", "throttle"],
    ["unavailable_configuration", "refused", "refused"],
    ["unavailable_runtime", "permitted", "refused"],
    ["ALLOW", "permitted", "refused"],
    [" allow", "permitted", "refused"],
    [{ kind: "allow" }, "permitted", "refused"],
    [true, "permitted", "refused"],
  ]) {
    for (const [policy, expected] of [
      [SIGN_IN_UNAVAILABLE_POLICY, signIn],
      [RECOVERY_UNAVAILABLE_POLICY, recovery],
    ]) {
      const events = [];
      assert.equal(
        await protectAttempt(
          recordingControl(events, { reserve: answer }),
          EMAIL,
          policy,
        ),
        expected,
        String(answer),
      );
      assert.equal(
        events.filter(([name]) => name === "reportUnavailable").length,
        expected === "refused" || expected === "permitted" ? 1 : 0,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The server-only control
// ---------------------------------------------------------------------------

function fakePort(answers = {}) {
  const calls = [];
  let built = 0;
  const reply = async (name, fallback, args) => {
    calls.push([name, ...args]);
    const answer = answers[name];
    if (answer instanceof Error) {
      throw answer;
    }
    if (typeof answer === "function") {
      return answer(...args);
    }
    return answer === undefined ? fallback : answer;
  };
  const port = {
    reserve: (...args) => reply("reserve", "allow", args),
    recordFailure: (...args) => reply("recordFailure", "recorded", args),
    recordSuccess: (...args) => reply("recordSuccess", "recorded", args),
    reportUnavailable: (...args) =>
      reply("reportUnavailable", "recorded", args),
  };
  return {
    calls,
    built: () => built,
    source: async () => {
      built += 1;
      return port;
    },
  };
}

function controlOver(purpose, port, environment = ENVIRONMENT) {
  return createAuthenticationAbuseControl(purpose, {
    environment,
    port: port.source,
  });
}

// Runs a call with console output captured; returns the parsed log lines.
async function capturingLogs(run) {
  const lines = [];
  const original = { error: console.error, log: console.log };
  const capture = (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push({ unparsed: String(line) });
    }
  };
  console.error = capture;
  console.log = capture;
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
}

function assertNoSecretIn(lines, extra = []) {
  const text = JSON.stringify(lines);
  for (const value of [
    EMAIL,
    UNKNOWN_EMAIL,
    KEY,
    ACCOUNT,
    digestsOf("sign_in").identity,
    digestsOf("sign_in").global,
    digestsOf("recovery").identity,
    ...extra,
  ]) {
    assert.equal(text.includes(value), false, value);
  }
}

test("10. the control sends only domain-separated HMAC-SHA-256 digests and the validated settings; casing and outer whitespace are one identity", async () => {
  const port = fakePort();
  const control = controlOver("sign_in", port);
  for (const email of [
    EMAIL,
    "Member@Synthetic.Invalid",
    "MEMBER@SYNTHETIC.INVALID",
    `  ${EMAIL}\t`,
  ]) {
    assert.equal(await control.reserve(email), "allow");
  }
  assert.equal(port.built(), 1, "one port per request-scoped control");
  const expected = digestsOf("sign_in");
  assert.deepEqual(
    port.calls,
    Array(4).fill(["reserve", "sign_in", expected, SIGN_IN_LIMITS]),
  );
  assert.match(expected.identity, /^[0-9a-f]{64}$/);
  // Each purpose, dimension, address, and key has its own digest.
  const recovery = digestsOf("recovery");
  const other = digestsOf("sign_in", UNKNOWN_EMAIL);
  const rekeyed = digestsOf("sign_in", EMAIL, OTHER_KEY);
  const all = [
    expected.identity,
    expected.global,
    recovery.identity,
    recovery.global,
    other.identity,
    rekeyed.identity,
    rekeyed.global,
  ];
  assert.equal(new Set(all).size, all.length);
  assert.equal(other.global, expected.global);
  const recoveryPort = fakePort();
  assert.equal(
    await controlOver("recovery", recoveryPort).reserve(EMAIL),
    "allow",
  );
  assert.deepEqual(recoveryPort.calls, [
    ["reserve", "recovery", recovery, RECOVERY_LIMITS],
  ]);
  // Nothing but lower-casing and outer trimming is applied: no Unicode,
  // dot, or plus folding.
  const folded = fakePort();
  const foldedControl = controlOver("sign_in", folded);
  await foldedControl.reserve("member+tag@synthetic.invalid");
  await foldedControl.reserve("mem.ber@synthetic.invalid");
  assert.notEqual(folded.calls[0][2].identity, expected.identity);
  assert.notEqual(folded.calls[1][2].identity, expected.identity);
});

test("11. missing, malformed, placeholder, or out-of-envelope settings are a configuration failure, never defaulted, and reach no port", async () => {
  const names = AUTH_ABUSE_SETTING_NAMES.sign_in;
  assert.equal(AUTH_ABUSE_KEY_SETTING, "ROSUNO_AUTH_ABUSE_HMAC_SECRET");
  for (const name of [
    AUTH_ABUSE_KEY_SETTING,
    ...Object.values(AUTH_ABUSE_SETTING_NAMES.sign_in),
    ...Object.values(AUTH_ABUSE_SETTING_NAMES.recovery),
  ].filter((value) => value !== null)) {
    assert.match(name, /^ROSUNO_[A-Z0-9_]{1,64}$/);
  }
  const broken = [
    { ROSUNO_ENVIRONMENT_CLASS: undefined },
    { ROSUNO_ENVIRONMENT_CLASS: "Development" },
    { [AUTH_ABUSE_KEY_SETTING]: undefined },
    { [AUTH_ABUSE_KEY_SETTING]: "" },
    { [AUTH_ABUSE_KEY_SETTING]: Buffer.alloc(31, 1).toString("base64") },
    { [AUTH_ABUSE_KEY_SETTING]: Buffer.alloc(33, 1).toString("base64") },
    { [AUTH_ABUSE_KEY_SETTING]: `${KEY.slice(0, -2)}x=` },
    { [AUTH_ABUSE_KEY_SETTING]: ` ${KEY}` },
    { [AUTH_ABUSE_KEY_SETTING]: KEY.replace(/^.{4}/, "TODO") },
    { [names.identityMax]: undefined },
    { [names.identityMax]: "0" },
    { [names.identityMax]: "1001" },
    { [names.identityMax]: "05" },
    { [names.identityMax]: "5.0" },
    { [names.identityMax]: "-5" },
    { [names.identityMax]: " 5" },
    { [names.globalMax]: "100001" },
    { [names.globalMax]: "1e3" },
    { [names.identityWindowSeconds]: "600" },
    { [names.identityWindowSeconds]: "900 " },
    { [names.globalWindowSeconds]: "7200" },
    { [names.globalWindowSeconds]: undefined },
    { [names.threshold]: undefined },
    { [names.threshold]: "0" },
    { [names.threshold]: "1001" },
    // A threshold above the identity maximum could never be reached.
    { [names.threshold]: "6" },
  ];
  for (const overrides of broken) {
    const port = fakePort();
    const control = controlOver("sign_in", port, {
      ...ENVIRONMENT,
      ...overrides,
    });
    const { result, lines } = await capturingLogs(() => control.reserve(EMAIL));
    assert.equal(
      result,
      "unavailable_configuration",
      JSON.stringify(overrides),
    );
    assert.equal(port.built(), 0);
    assert.deepEqual(port.calls, []);
    assert.deepEqual(lines, []);
    assert.equal(await control.recordFailure(EMAIL), "unavailable");
    assert.equal(await control.recordSuccess(EMAIL, ACCOUNT), "unavailable");
    assert.deepEqual(port.calls, []);
  }
  // Every envelope bound is accepted exactly.
  for (const overrides of [
    { [names.identityMax]: "1", [names.threshold]: "1" },
    { [names.identityMax]: "1000", [names.threshold]: "1000" },
    { [names.globalMax]: "1" },
    { [names.globalMax]: "100000" },
    { [names.identityWindowSeconds]: "86400" },
    { [names.globalWindowSeconds]: "900" },
  ]) {
    const port = fakePort();
    assert.equal(
      await controlOver("sign_in", port, {
        ...ENVIRONMENT,
        ...overrides,
      }).reserve(EMAIL),
      "allow",
      JSON.stringify(overrides),
    );
  }
  // Recovery needs no threshold; sign-in settings never configure it.
  const recoveryOnly = Object.fromEntries(
    Object.entries(ENVIRONMENT).filter(([name]) => !name.includes("SIGN_IN")),
  );
  assert.equal(
    await controlOver("recovery", fakePort(), recoveryOnly).reserve(EMAIL),
    "allow",
  );
  assert.equal(
    await controlOver("sign_in", fakePort(), recoveryOnly).reserve(EMAIL),
    "unavailable_configuration",
  );
  // No verified privileged binding is a configuration failure too.
  assert.equal(
    await createAuthenticationAbuseControl("sign_in", {
      environment: ENVIRONMENT,
      port: async () => null,
    }).reserve(EMAIL),
    "unavailable_configuration",
  );
  // The deployed default reads the process environment, which configures
  // nothing here.
  assert.equal(
    await createAuthenticationAbuseControl("sign_in").reserve(EMAIL),
    "unavailable_configuration",
  );
});

test("12. only an exact allow or throttle from the port is a decision; anything else, a throw, or a late answer is a runtime failure", async () => {
  for (const [answer, expected] of [
    ["allow", "allow"],
    ["throttle", "throttle"],
    ["unknown", "unavailable_runtime"],
    ["deny", "unavailable_runtime"],
    [null, "unavailable_runtime"],
    [new Error("synthetic port failure"), "unavailable_runtime"],
  ]) {
    assert.equal(
      await controlOver("sign_in", fakePort({ reserve: answer })).reserve(
        EMAIL,
      ),
      expected,
    );
  }
  // A port source that throws, or answers something else, is no port.
  for (const source of [
    async () => {
      throw new Error("synthetic binding failure");
    },
    async () => "port",
  ]) {
    assert.equal(
      await createAuthenticationAbuseControl("sign_in", {
        environment: ENVIRONMENT,
        port: source,
      }).reserve(EMAIL),
      "unavailable_configuration",
    );
  }
  // A decision unanswered after 2,500 ms is a runtime failure.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hanging = controlOver(
      "sign_in",
      fakePort({ reserve: () => new Promise(() => {}) }),
    );
    const pending = hanging.reserve(EMAIL);
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    mock.timers.tick(2499);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.equal(await pending, "unavailable_runtime");
  } finally {
    mock.timers.reset();
  }
});

test("13. failures and successes are recorded with the threshold and windows only; recovery records neither", async () => {
  const port = fakePort();
  const control = controlOver("sign_in", port);
  assert.equal(
    await control.recordFailure(` ${EMAIL.toUpperCase()} `),
    "recorded",
  );
  assert.equal(await control.recordSuccess(EMAIL, ACCOUNT), "recorded");
  const expected = digestsOf("sign_in");
  assert.deepEqual(port.calls, [
    ["recordFailure", expected, SIGN_IN_LIMITS, 3],
    ["recordSuccess", expected.identity, 900, 3, ACCOUNT],
  ]);
  for (const [answer, signal] of [
    ["suspicious", "suspicious"],
    ["recorded", "recorded"],
    ["unknown", "unavailable"],
    [undefined, "unavailable"],
    [new Error("synthetic"), "unavailable"],
  ]) {
    const answering = fakePort({
      recordFailure: answer === undefined ? async () => undefined : answer,
      recordSuccess: answer === undefined ? async () => undefined : answer,
    });
    const answeringControl = controlOver("sign_in", answering);
    assert.equal(await answeringControl.recordFailure(EMAIL), signal);
    assert.equal(await answeringControl.recordSuccess(EMAIL, ACCOUNT), signal);
  }
  const recoveryPort = fakePort();
  const recovery = controlOver("recovery", recoveryPort);
  assert.equal(await recovery.recordFailure(EMAIL), "unavailable");
  assert.equal(await recovery.recordSuccess(EMAIL, ACCOUNT), "unavailable");
  assert.equal(
    recoveryPort.calls.some(([name]) => name !== "reportUnavailable"),
    false,
  );
});

test("14. an unavailable report asks the database first and always writes one structured security line; persistence is claimed only when confirmed", async () => {
  const cases = [
    ["recorded", "persisted"],
    ["already_recorded", "persisted"],
    ["unknown", "not_persisted"],
    [undefined, "not_persisted"],
    [new Error("synthetic audit failure"), "not_persisted"],
  ];
  for (const purpose of ["sign_in", "recovery"]) {
    for (const [failure, outcome] of [
      ["configuration", "refused"],
      ["runtime", purpose === "sign_in" ? "permitted" : "refused"],
    ]) {
      for (const [answer, persistence] of cases) {
        const port = fakePort({
          reportUnavailable:
            answer === undefined ? async () => undefined : answer,
        });
        const { result, lines } = await capturingLogs(() =>
          controlOver(purpose, port).reportUnavailable(failure, outcome),
        );
        assert.equal(result, undefined);
        assert.deepEqual(port.calls, [["reportUnavailable", purpose, failure]]);
        assert.equal(lines.length, 1);
        const [line] = lines;
        assert.match(line.timestamp, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(
          { ...line, timestamp: "<time>" },
          {
            timestamp: "<time>",
            level: "error",
            event: "security.protection_unavailable",
            // Outside a request the line carries no correlation id; in a
            // request it carries the proxy's (observability tests).
            correlationId: null,
            outcome,
            purpose,
            failureKind: failure,
            auditPersistence: persistence,
          },
        );
        assertNoSecretIn(lines);
      }
    }
  }
  // Without a verified binding, or with an invalid configuration that still
  // has one, the line is written; persistence only with a confirmed write.
  const { lines: unbound } = await capturingLogs(() =>
    createAuthenticationAbuseControl("recovery", {
      environment: {},
      port: async () => null,
    }).reportUnavailable("configuration", "refused"),
  );
  assert.deepEqual(
    unbound.map((line) => [line.event, line.auditPersistence]),
    [["security.protection_unavailable", "not_persisted"]],
  );
  const configuredPort = fakePort();
  const { lines: bound } = await capturingLogs(() =>
    controlOver("sign_in", configuredPort, {}).reportUnavailable(
      "configuration",
      "refused",
    ),
  );
  assert.deepEqual(configuredPort.calls, [
    ["reportUnavailable", "sign_in", "configuration"],
  ]);
  assert.equal(bound[0].auditPersistence, "persisted");
  // A late audit answer is not persistence.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = capturingLogs(() =>
      controlOver(
        "sign_in",
        fakePort({ reportUnavailable: () => new Promise(() => {}) }),
      ).reportUnavailable("runtime", "permitted"),
    );
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    mock.timers.tick(2500);
    const { lines } = await pending;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].auditPersistence, "not_persisted");
  } finally {
    mock.timers.reset();
  }
});

test("15. a suspicious sign-in writes one non-sensitive warning line naming only how it was handled", async () => {
  for (const handling of [
    "failed_attempt",
    "other_sessions_ended",
    "other_sessions_not_ended",
  ]) {
    const port = fakePort();
    const { lines } = await capturingLogs(() =>
      controlOver("sign_in", port).reportSuspicious(handling),
    );
    assert.deepEqual(port.calls, []);
    assert.deepEqual(
      lines.map((line) => ({ ...line, timestamp: "<time>" })),
      [
        {
          timestamp: "<time>",
          level: "warn",
          event: "security.suspicious_login",
          correlationId: null,
          outcome: handling,
          purpose: "sign_in",
        },
      ],
    );
    assertNoSecretIn(lines);
  }
});

test("16. through the real use cases and control: casing variants are one identity, a throttle is enumeration-safe, and configuration failures refuse", async () => {
  // A synthetic port counting reservations per identity digest, with the
  // identity maximum of the environment (5).
  const counts = new Map();
  const port = fakePort({
    reserve: (_purpose, digests, limits) => {
      const used = counts.get(digests.identity) ?? 0;
      if (used >= limits.identityMax) {
        return "throttle";
      }
      counts.set(digests.identity, used + 1);
      return "allow";
    },
  });
  const results = [];
  for (const email of [
    EMAIL,
    "Member@Synthetic.Invalid",
    ` ${EMAIL.toUpperCase()} `,
    EMAIL,
    "mEmBeR@synthetic.invalid",
    EMAIL,
  ]) {
    const events = [];
    const stand = signInProvider(events, controlOver("sign_in", port));
    results.push(
      (await signInExistingAccount(stand.source, signInForm(email, "wrong")))
        .status,
    );
  }
  assert.deepEqual(results, [
    "rejected",
    "rejected",
    "rejected",
    "rejected",
    "rejected",
    "throttled",
  ]);
  assert.equal(counts.size, 1);
  // An unknown address throttles identically once its own count is used.
  const unknown = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const events = [];
    const stand = signInProvider(events, controlOver("sign_in", port), {
      exists: false,
    });
    unknown.push(
      (await signInExistingAccount(stand.source, signInForm(UNKNOWN_EMAIL)))
        .status,
    );
  }
  assert.deepEqual(unknown, results);
  // Configuration missing: sign-in and recovery are refused, each with one
  // security line, and nothing reaches a provider.
  for (const [purpose, run] of [
    [
      "sign_in",
      async (control, events) =>
        signInExistingAccount(
          signInProvider(events, control).source,
          signInForm(),
        ),
    ],
    [
      "recovery",
      async (control, events) =>
        requestAccountRecovery(
          recoveryProvider(events, control),
          form([["email", EMAIL]]),
        ),
    ],
  ]) {
    const events = [];
    const unconfigured = fakePort();
    const { result, lines } = await capturingLogs(() =>
      run(
        createAuthenticationAbuseControl(purpose, {
          environment: { ROSUNO_ENVIRONMENT_CLASS: "development" },
          port: unconfigured.source,
        }),
        events,
      ),
    );
    assert.deepEqual(result, { status: "unavailable" });
    assert.deepEqual(events, []);
    assert.deepEqual(unconfigured.calls, [
      ["reportUnavailable", purpose, "configuration"],
    ]);
    assert.deepEqual(
      lines.map((line) => [
        line.event,
        line.purpose,
        line.failureKind,
        line.outcome,
        line.auditPersistence,
      ]),
      [
        [
          "security.protection_unavailable",
          purpose,
          "configuration",
          "refused",
          "persisted",
        ],
      ],
    );
  }
  // A runtime failure permits sign-in (reported) and refuses recovery.
  const broken = fakePort({ reserve: "unknown", reportUnavailable: "unknown" });
  const signInEvents = [];
  const { result: signedIn, lines: signInLines } = await capturingLogs(() =>
    signInExistingAccount(
      signInProvider(signInEvents, controlOver("sign_in", broken)).source,
      signInForm(),
    ),
  );
  assert.deepEqual(signedIn, { status: "signed-in" });
  assert.deepEqual(
    signInLines.map((line) => [line.outcome, line.auditPersistence]),
    [["permitted", "not_persisted"]],
  );
  const recoveryEvents = [];
  const { result: refused, lines: recoveryLines } = await capturingLogs(() =>
    requestAccountRecovery(
      recoveryProvider(recoveryEvents, controlOver("recovery", broken)),
      form([["email", EMAIL]]),
    ),
  );
  assert.deepEqual(refused, { status: "unavailable" });
  assert.deepEqual(recoveryEvents, []);
  assert.deepEqual(
    recoveryLines.map((line) => [line.purpose, line.outcome]),
    [["recovery", "refused"]],
  );
});

// ---------------------------------------------------------------------------
// The privileged decision port (synthetic HTTP API)
// ---------------------------------------------------------------------------

const PROJECT_REF = "syntheticprojectrefa";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const ADMIN = "sb_secret_synthetic7f3a";

const boundEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: PROJECT_REF,
  ...overrides,
});

function syntheticRpcApi(answer = () => [200, "allow"]) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: await request.text(),
      signal: init.signal,
    });
    const [status, payload] = answer(requests.at(-1));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetch };
}

function factoryOver(fetch, made = []) {
  return (url, key, options) => {
    made.push([url, key, options]);
    return createClient(url, key, { ...options, global: { fetch } });
  };
}

const SIGN_IN_DIGESTS = Object.freeze(digestsOf("sign_in"));

const PORT_CALLS = [
  [
    "reserve",
    (port) => port.reserve("sign_in", SIGN_IN_DIGESTS, SIGN_IN_LIMITS),
    "authentication_abuse_reserve",
    {
      p_purpose: "sign_in",
      p_identity_digest: SIGN_IN_DIGESTS.identity,
      p_identity_max: 5,
      p_identity_window_seconds: 900,
      p_global_digest: SIGN_IN_DIGESTS.global,
      p_global_max: 1000,
      p_global_window_seconds: 3600,
    },
    ["allow", "throttle"],
  ],
  [
    "recordFailure",
    (port) => port.recordFailure(SIGN_IN_DIGESTS, SIGN_IN_LIMITS, 3),
    "authentication_abuse_record_failure",
    {
      p_identity_digest: SIGN_IN_DIGESTS.identity,
      p_identity_window_seconds: 900,
      p_global_digest: SIGN_IN_DIGESTS.global,
      p_global_window_seconds: 3600,
      p_suspicious_threshold: 3,
    },
    ["recorded", "suspicious"],
  ],
  [
    "recordSuccess",
    (port) => port.recordSuccess(SIGN_IN_DIGESTS.identity, 900, 3, ACCOUNT),
    "authentication_abuse_record_success",
    {
      p_identity_digest: SIGN_IN_DIGESTS.identity,
      p_identity_window_seconds: 900,
      p_suspicious_threshold: 3,
      p_auth_user_id: ACCOUNT,
    },
    ["recorded", "suspicious"],
  ],
  [
    "reportUnavailable",
    (port) => port.reportUnavailable("recovery", "runtime"),
    "authentication_abuse_report_unavailable",
    { p_purpose: "recovery", p_failure_kind: "runtime" },
    ["recorded", "already_recorded"],
  ],
];

test("17. the port sends one privileged, cookie-free POST per call, of exactly its named arguments, and reads each answer strictly", async () => {
  for (const [member, call, name, body, outcomes] of PORT_CALLS) {
    for (const outcome of outcomes) {
      const api = syntheticRpcApi(() => [200, outcome]);
      const made = [];
      const port = await createAuthenticationAbusePort(
        boundEnvironment(),
        factoryOver(api.fetch, made),
      );
      assert.ok(Object.isFrozen(port));
      assert.deepEqual(Object.keys(port), [
        "reserve",
        "recordFailure",
        "recordSuccess",
        "reportUnavailable",
      ]);
      assert.equal(await call(port), outcome, member);
      assert.deepEqual(made, [
        [
          PROJECT_URL,
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
      assert.equal(api.requests.length, 1);
      const [request] = api.requests;
      assert.equal(request.method, "POST");
      assert.equal(request.url.href, `${PROJECT_URL}/rest/v1/rpc/${name}`);
      assert.deepEqual(JSON.parse(request.body), body);
      assert.equal(request.headers.get("authorization"), `Bearer ${ADMIN}`);
      assert.equal(request.headers.get("apikey"), ADMIN);
      assert.equal(request.headers.get("cookie"), null);
      assert.ok(request.signal instanceof AbortSignal);
      assert.equal(request.signal.aborted, false);
      assert.equal(request.body.includes(EMAIL), false);
    }
    // Any other answer, a failed call, or a transport failure is unknown,
    // and nothing is retried.
    for (const reply of [
      () => [200, "ALLOW"],
      () => [200, "unknown"],
      () => [200, null],
      () => [200, ["allow"]],
      () => [200, { outcome: outcomes[0] }],
      () => [400, { code: "22023", message: "unavailable" }],
      () => [500, { code: "57014", message: "canceling statement" }],
      () => [404, { code: "PGRST202", message: "not found" }],
      () => [403, { code: "42501", message: "permission denied" }],
      () => {
        throw new TypeError("synthetic transport failure");
      },
    ]) {
      const api = syntheticRpcApi(reply);
      const port = await createAuthenticationAbusePort(
        boundEnvironment(),
        factoryOver(api.fetch),
      );
      assert.equal(await call(port), "unknown", member);
      assert.ok(api.requests.length <= 1, "never retried");
    }
  }
});

test("18. an unbound project builds no client, and an invalid argument sends nothing", async () => {
  for (const overrides of [
    { ROSUNO_SUPABASE_ADMIN_KEY: undefined },
    { ROSUNO_SUPABASE_ADMIN_KEY: PUBLISHABLE },
    { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "syntheticprojectrefb" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://elsewhere.invalid" },
  ]) {
    const made = [];
    assert.equal(
      await createAuthenticationAbusePort(
        boundEnvironment(overrides),
        factoryOver(syntheticRpcApi().fetch, made),
      ),
      null,
    );
    assert.deepEqual(made, []);
  }
  const api = syntheticRpcApi();
  const port = await createAuthenticationAbusePort(
    boundEnvironment(),
    factoryOver(api.fetch),
  );
  const D = SIGN_IN_DIGESTS;
  const L = SIGN_IN_LIMITS;
  const invalid = [
    () => port.reserve("registration", D, L),
    () =>
      port.reserve("sign_in", { ...D, identity: D.identity.toUpperCase() }, L),
    () => port.reserve("sign_in", { ...D, global: D.global.slice(1) }, L),
    () =>
      port.reserve("sign_in", { identity: D.identity, global: D.identity }, L),
    () => port.reserve("sign_in", { ...D, identity: EMAIL }, L),
    () => port.reserve("sign_in", D, { ...L, identityMax: 0 }),
    () => port.reserve("sign_in", D, { ...L, identityMax: 1001 }),
    () => port.reserve("sign_in", D, { ...L, globalMax: 100001 }),
    () => port.reserve("sign_in", D, { ...L, globalMax: "1000" }),
    () => port.reserve("sign_in", D, { ...L, identityWindowSeconds: 600 }),
    () => port.reserve("sign_in", D, { ...L, globalWindowSeconds: 1.5 }),
    () => port.reserve("sign_in", null, L),
    () => port.reserve("sign_in", D, undefined),
    () => port.recordFailure(D, L, 0),
    () => port.recordFailure(D, L, 1001),
    () => port.recordFailure(D, L, Number.NaN),
    () => port.recordSuccess(D.identity, 900, 3, "not-a-uuid"),
    () => port.recordSuccess(D.identity, 7200, 3, ACCOUNT),
    () => port.recordSuccess(D.global.slice(2), 900, 3, ACCOUNT),
    () => port.reportUnavailable("sign_in", "network"),
    () => port.reportUnavailable("Sign_in", "runtime"),
  ];
  for (const call of invalid) {
    assert.equal(await call(), "unknown");
  }
  assert.deepEqual(api.requests, []);
});

test("19. through the control and the installed client, only the database's own answers count", async () => {
  const api = syntheticRpcApi((request) =>
    request.url.pathname.endsWith("/authentication_abuse_reserve")
      ? [200, "throttle"]
      : [500, { code: "57014", message: "canceling statement" }],
  );
  const control = createAuthenticationAbuseControl("sign_in", {
    environment: ENVIRONMENT,
    port: () =>
      createAuthenticationAbusePort(boundEnvironment(), factoryOver(api.fetch)),
  });
  assert.equal(await control.reserve(EMAIL), "throttle");
  assert.equal(await control.recordFailure(EMAIL), "unavailable");
  const { lines } = await capturingLogs(() =>
    control.reportUnavailable("runtime", "permitted"),
  );
  assert.equal(lines[0].auditPersistence, "not_persisted");
  assert.deepEqual(
    api.requests.map((request) => request.url.pathname),
    [
      "/rest/v1/rpc/authentication_abuse_reserve",
      "/rest/v1/rpc/authentication_abuse_record_failure",
      "/rest/v1/rpc/authentication_abuse_report_unavailable",
    ],
  );
  for (const request of api.requests) {
    assert.equal(request.body.includes(EMAIL), false);
    assert.equal(request.body.includes(KEY), false);
  }
  assertNoSecretIn(lines);
});

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

test("20. the application module is provider-neutral, holds no state or credential, and decides no business question", () => {
  const source = read("src/application/authentication-abuse-control.ts");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), ["./professional-records.ts"]);
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  assert.doesNotMatch(
    code,
    /\bimport\s*\(|\brequire\s*\(|next|react|supabase|postgres|database|\bprocess\b|\bconsole\b|\bfetch\s*\(|cookie|header|localStorage|sessionStorage|globalThis|\bwindow\b|\bdocument\b|Math\.random|\bDate\b|access_?token|refresh_?token|\bjwt\b|createHmac|crypto|ROSUNO_/i,
  );
  assert.doesNotMatch(
    code,
    /attorney|\bstaff\b|\bclient\b|\brole\b|capabilit|permission|profile|eligib|jurisdiction|booking|payment|\badmin\b/i,
  );
  assert.doesNotMatch(code, /^(?:let|var) /m);
  // The two unavailable policies are the only behaviour decisions, and they
  // are frozen constants.
  assert.match(
    code,
    /export const SIGN_IN_UNAVAILABLE_POLICY: UnavailablePolicy = Object\.freeze\(\{\n {2}configuration: "refused",\n {2}runtime: "permitted",\n\}\);/,
  );
  assert.match(
    code,
    /export const RECOVERY_UNAVAILABLE_POLICY: UnavailablePolicy = Object\.freeze\(\{\n {2}configuration: "refused",\n {2}runtime: "refused",\n\}\);/,
  );
});

test("21. the server-only control reads only its settings through the configuration reader, logs two fixed events, and is loaded only by the two actions", () => {
  const file = "src/infrastructure/identity/authentication-abuse-control.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "node:crypto",
    "../../application/authentication-abuse-control.ts",
    "../environment/provider-configuration.ts",
    "../observability/request-log.ts",
    "./registration-provisioning.ts",
  ]);
  assert.match(
    code,
    /^import \{ createAuthenticationAbusePort \} from "\.\/registration-provisioning\.ts";$/m,
  );
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  assert.doesNotMatch(
    code,
    /process\.env|ROSUNO_SUPABASE|NEXT_PUBLIC|service_role|sb_secret|createClient|adminKey|\.rpc\b|(?<!Buffer)\.from\(|supabase|next\/|cookies|headers\(|forwarded|\bconsole\b|\bfetch\b|localStorage|Math\.random|\bDate\b|\beval\b|\bimport\s*\(|\brequire\s*\(|^(?:let|var) /im,
  );
  assert.deepEqual([...new Set(code.match(/"ROSUNO_[A-Z0-9_]+"/g))].sort(), [
    '"ROSUNO_AUTH_ABUSE_HMAC_SECRET"',
    '"ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_MAX"',
    '"ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_WINDOW_SECONDS"',
    '"ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_MAX"',
    '"ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_WINDOW_SECONDS"',
    '"ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_MAX"',
    '"ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_WINDOW_SECONDS"',
    '"ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_MAX"',
    '"ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_WINDOW_SECONDS"',
    '"ROSUNO_AUTH_ABUSE_SIGN_IN_SUSPICIOUS_FAILURES"',
  ]);
  // One HMAC construction, with SHA-256 and the versioned domain.
  assert.equal(code.match(/\bcreateHmac\(/g).length, 1);
  assert.match(code, /createHmac\("sha256", key\)/);
  assert.match(code, /const DIGEST_DOMAIN = "authentication-abuse\/v1";/);
  assert.match(code, /const DECISION_DEADLINE_MS = 2500;/);
  // Exactly two log calls, each with a fixed event code and only the
  // allowlisted report fields: never an address, digest, key, or account.
  const calls = [...code.matchAll(/logRequestEvent\([^;]*;/g)].map(
    (match) => match[0],
  );
  assert.equal(calls.length, 2);
  assert.match(
    calls[0],
    /^logRequestEvent\("error", "security\.protection_unavailable", \{\n {6}purpose,\n {6}failureKind: failure,\n {6}outcome,\n {6}auditPersistence: persisted \? "persisted" : "not_persisted",\n {4}\}\);$/,
  );
  assert.match(
    calls[1],
    /^logRequestEvent\("warn", "security\.suspicious_login", \{\n {6}purpose,\n {6}outcome: handling,\n {4}\}\);$/,
  );
  // Persistence is claimed only for the database's two confirmations.
  assert.equal(
    code.match(
      /persisted = answer === "recorded" \|\| answer === "already_recorded";/g,
    )?.length,
    1,
  );
  // Only the sign-in and recovery request actions load the control.
  const importers = [...filesIn("app/"), ...filesIn("src/")].filter(
    (path) =>
      /\.tsx?$/.test(path) &&
      importsOf(read(path)).some((specifier) =>
        /(?:^|\/)infrastructure\/identity\/authentication-abuse-control\.ts$/.test(
          specifier,
        ),
      ),
  );
  assert.deepEqual(importers, [
    "app/forgot-password/actions.ts",
    "app/sign-in/actions.ts",
  ]);
  assert.match(
    codeOf(read("app/sign-in/actions.ts")),
    /abuseControl: createAuthenticationAbuseControl\("sign_in"\),/,
  );
  assert.match(
    codeOf(read("app/forgot-password/actions.ts")),
    /abuseControl: createAuthenticationAbuseControl\("recovery"\),/,
  );
});

test("22. the migration is one private counter relation per PS-A4 section 2 and four service_role-only decision functions", () => {
  const sql = read(MIGRATION, repositoryRoot);
  const code = sqlOf(sql);
  assert.match(sql, /^-- MVP-001 S2: authentication-abuse control/);
  assert.equal(
    code.match(/^create table public\.authentication_abuse_counters \(/gm)
      .length,
    1,
  );
  assert.equal(code.match(/^create table/gm).length, 1);
  const table = code.slice(
    code.indexOf("create table"),
    code.indexOf("alter table"),
  );
  assert.deepEqual(
    [
      ...table.matchAll(
        /^ {2}([a-z_]+) (text|timestamptz|integer) not null(?: default statement_timestamp\(\))?,$/gm,
      ),
    ].map((match) => `${match[1]} ${match[2]}`),
    [
      "purpose text",
      "dimension text",
      "digest text",
      "window_start timestamptz",
      "window_end timestamptz",
      "expires_at timestamptz",
      "attempt_count integer",
      "failure_count integer",
      "created_at timestamptz",
      "updated_at timestamptz",
    ],
  );
  assert.match(
    table,
    /primary key \(purpose, dimension, digest, window_start\)/,
  );
  assert.match(table, /check \(purpose in \('sign_in', 'recovery'\)\)/);
  assert.match(table, /check \(dimension in \('identity', 'global'\)\)/);
  assert.match(table, /check \(digest collate "C" ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(table, /in \(900, 3600, 86400\)/);
  assert.match(
    table,
    /check \(expires_at = window_end \+ interval '24 hours'\)/,
  );
  assert.match(table, /attempt_count <= 1000000/);
  assert.doesNotMatch(table, /references|foreign key/i);
  assert.doesNotMatch(
    code,
    /create policy|grant [^;]* on table public\.authentication_abuse_counters|alter role|alter default|set role|bypassrls|create extension|execute format|\bnow\(\)|current_timestamp|drop\b|truncate/i,
  );
  assert.match(
    code,
    /^alter table public\.authentication_abuse_counters enable row level security;$/m,
  );
  assert.match(
    code,
    /revoke all on table public\.authentication_abuse_counters\n {2}from public, anon, authenticated, service_role;/,
  );
  // The four decision functions: SECURITY DEFINER, a fixed search path and
  // timeouts, revoked from every API role and granted to service_role only.
  const decisions = [
    "authentication_abuse_reserve",
    "authentication_abuse_record_failure",
    "authentication_abuse_record_success",
    "authentication_abuse_report_unavailable",
  ];
  for (const name of decisions) {
    const start = code.indexOf(`create function public.${name}(`);
    assert.ok(start > 0, name);
    const header = code.slice(start, code.indexOf("as $function$", start));
    assert.match(
      header,
      /\nreturns text\nlanguage plpgsql\nvolatile\nsecurity definer\nset search_path = pg_catalog, pg_temp\nset lock_timeout = '1s'\nset statement_timeout = '1500ms'\n$/,
      name,
    );
    assert.equal(
      code.match(
        new RegExp(`grant execute on function public\\.${name}\\(`, "g"),
      ).length,
      1,
      name,
    );
  }
  assert.deepEqual(
    [...code.matchAll(/^grant ([^\n]*)/gm)].map((match) => match[1]),
    decisions
      .map((name) => `execute on function public.${name}(`)
      .map((prefix, index) =>
        index === 1
          ? `${prefix}text, integer, text, integer, integer)`
          : index === 2
            ? `${prefix}text, integer, integer, uuid)`
            : index === 3
              ? `${prefix}text, text)`
              : prefix,
      ),
  );
  assert.equal(
    [...code.matchAll(/\bto service_role;/g)].length,
    decisions.length,
  );
  assert.doesNotMatch(code, /\bto (?:public|anon|authenticated)\b/);
  // Every helper is revoked from every API role and granted to none.
  for (const helper of [
    "authentication_abuse_window_start",
    "authentication_abuse_audit",
    "authentication_abuse_current_attempts",
    "authentication_abuse_mark_throttled",
  ]) {
    assert.match(
      code,
      new RegExp(`revoke all on function public\\.${helper}\\(`),
    );
    assert.doesNotMatch(code, new RegExp(`grant [^;]*${helper}`));
  }
  // The database owns the clock; the system actor writes the three events;
  // no event or counter stores an address, digest, or email.
  assert.equal(code.match(/:= clock_timestamp\(\);/g).length, 4);
  assert.match(
    code,
    /null, 'system', p_action, p_resource_type, p_resource_id,/,
  );
  assert.deepEqual([...new Set(code.match(/'security\.[a-z_]+'/g))].sort(), [
    "'security.protection_unavailable'",
    "'security.rate_limited'",
    "'security.suspicious_login'",
  ]);
  for (const snapshot of code.matchAll(/jsonb_build_object\(([^;]*?)\)\s*,/g)) {
    assert.doesNotMatch(snapshot[1], /digest|email|address|device|ip/i);
  }
  assert.doesNotMatch(
    code.slice(0, code.indexOf("\ncomment on table")),
    /email|\baddress\b|ip_address|inet|attorney|jurisdiction|password|token/i,
  );
  assert.match(code, /limit 100\n/);
  assert.match(code, /for update skip locked/);
  // The comments cite PS-A4 sections; no locked text is reproduced.
  assert.match(sql, /PS-A4 section 2/);
  assert.match(sql, /PS-A4 section 3/);
  assert.match(sql, /PS-A4 section 4/);
});
