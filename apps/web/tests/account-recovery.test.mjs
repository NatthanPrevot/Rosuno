// Targeted P2-008 existing-account password recovery tests.
//
// Tests 1 to 14 run the application orchestration against isolated in-memory
// provider stand-ins and the existing trusted claims boundary. Tests 15 to 25
// run it through the installed @supabase/ssr and auth-js clients over
// Next.js's own Server Action cookie store, wired exactly as the two server
// actions wire them, against a synthetic in-memory identity provider that
// answers the recovery request, PKCE code exchange, user read and update,
// logout, and signing-key endpoints. Its recovery "email" is an in-memory
// outbox holding the address the provider's link finally returns the browser
// to: the provider's own upstream verification step, its email template, and
// real delivery are outside these fixtures and remain deployment gates, so
// nothing here claims a live email or provider completion. The server
// actions and the pages need the Next.js and React runtime, so their wiring
// is held to these models as source contracts (tests 26 on). No real
// provider, account, credential, email, network, or database is contacted,
// and every value here is synthetic test data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { types } from "node:util";

import { createServerClient } from "@supabase/ssr";

import * as recovery from "../src/application/account-recovery.ts";
import { getShellView } from "../src/application/shell.ts";
import { createSupabaseServerSessionSource } from "../src/infrastructure/identity/server-session-source.ts";

const {
  INITIAL_RECOVERY_COMPLETION_STATE,
  INITIAL_RECOVERY_REQUEST_STATE,
  completeAccountRecovery,
  recoveryCodeOf,
  recoveryRedirectFor,
  requestAccountRecovery,
  validateNewPassword,
  validateRecoveryRequest,
} = recovery;

const appRoot = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
}

function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => !/(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/.test(file))
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

// A value as plain data: its prototype and every own property, so nothing
// hidden (a non-enumerable message, a Proxy) can ride along with a state.
function ownData(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  assert.equal(types.isProxy(value), false);
  return [
    Object.getPrototypeOf(value),
    ...Reflect.ownKeys(value).map((key) => [key, ownData(value[key])]),
  ];
}

function assertFrozenData(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.ok(Object.isFrozen(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(Object.hasOwn(descriptor, "value"), String(key));
    assertFrozenData(descriptor.value);
  }
}

function assertExactly(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.deepEqual(ownData(actual), ownData(expected));
  assertFrozenData(actual);
}

// Synthetic, test-only values. None is a real account, address, or
// credential.
const EMAIL = "holder@synthetic.invalid";
const OTHER_EMAIL = "other-holder@synthetic.invalid";
const UNKNOWN_EMAIL = "nobody@synthetic.invalid";
const OLD_PW = "synthetic-old-pw-7f3a";
const ALT_PW = "synthetic-other-pw-7f3a";
const NEW_PW = " synthetic new pw 7f3a ";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000a11ce";
const OTHER_ID = "00000000-0000-4000-8000-00000000b0b0";
const ORIGIN = "https://app.synthetic.invalid";
const REDIRECT = `${ORIGIN}/reset-password`;
const CODE = "0f".repeat(16);
const ISSUED = "synthetic-session-issued";
const EXISTING = "synthetic-session-existing";
const DETAIL = "internal 7f3a";

const SUBMITTED = { status: "submitted" };
const REQUEST_UNAVAILABLE = { status: "unavailable" };
const COMPLETED = { status: "completed" };
const UNUSABLE = { status: "unusable" };
const UNAVAILABLE = { status: "unavailable" };
const NOT_CHANGED = { status: "not-changed" };
const SESSION_UNCERTAIN = { status: "session-uncertain" };
const UNCERTAIN = { status: "uncertain" };

function form(entries) {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
}

// Form data that hands its fields back exactly as given. The platform's own
// FormData turns an unpaired surrogate into U+FFFD before any check, so ill-
// formed text can only arrive this way.
class RawForm extends FormData {
  #fields;
  constructor(fields) {
    super();
    this.#fields = fields;
  }
  getAll(name) {
    return Object.hasOwn(this.#fields, name) ? [this.#fields[name]] : [];
  }
}

const completionForm = ({
  code = CODE,
  password = NEW_PW,
  confirmation = password,
  extra = [],
} = {}) =>
  form([
    ["code", code],
    ["password", password],
    ["confirm_password", confirmation],
    ...extra,
  ]);

function assertNothingLeaks(value) {
  const serialized = JSON.stringify(ownData(value), (_key, item) =>
    typeof item === "symbol" ? String(item) : item,
  );
  for (const secret of [
    EMAIL,
    UNKNOWN_EMAIL,
    NEW_PW.trim(),
    OLD_PW,
    CODE,
    ACCOUNT_ID,
    ISSUED,
    EXISTING,
    REDIRECT,
    "7f3a",
    "synthetic",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
}

// A link's query as Next.js hands it to a page: one string per key, and an
// array for a repeated key. A fragment never reaches the server.
function queryOf(link) {
  const params = new URL(link).searchParams;
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
}

const thrownValues = [
  new Error(DETAIL),
  Object.assign(new Error("internal"), { code: DETAIL }),
  { detail: DETAIL },
  DETAIL,
  null,
  undefined,
];

const UNREADABLE = Object.freeze({ kind: "unreadable" });
const NO_SESSION = Object.freeze({ kind: "none" });
const REJECTED = Object.freeze({ kind: "rejected" });
const REFUSED = Object.freeze({ kind: "refused" });
const UNKNOWN = Object.freeze({ kind: "unknown" });

// The claims read the completion action runs (test 26 holds the two
// together): only a successful read that finds nothing is "none".
function sessionOf(read) {
  if (read.error !== null) {
    return UNREADABLE;
  }
  if (read.data === null) {
    return NO_SESSION;
  }
  const id = read.data.claims.session_id;
  const subject = read.data.claims.sub;
  return typeof id === "string" && typeof subject === "string"
    ? Object.freeze({ kind: "session", id, subject })
    : UNREADABLE;
}

// Session reads that prove nothing: a failed read, malformed answers, and
// throws.
const malformedReads = [
  async () => ({ kind: "unreadable" }),
  async () => false,
  async () => "none",
  async () => null,
  async () => undefined,
  async () => ({ kind: "NONE" }),
  async () => ({ kind: "none", id: ISSUED }),
  async () => ({ kind: "none", subject: ACCOUNT_ID }),
  async () => ({ kind: "session" }),
  async () => ({ kind: "session", id: ISSUED }),
  async () => ({ kind: "session", id: "", subject: ACCOUNT_ID }),
  async () => ({ kind: "session", id: ISSUED, subject: "  " }),
  async () => ({ kind: "session", id: 42, subject: ACCOUNT_ID }),
  async () => ({
    get kind() {
      throw new Error(DETAIL);
    },
  }),
  ...thrownValues.map((thrown) => async () => {
    throw thrown;
  }),
];

// ---------------------------------------------------------------------------
// In-memory stand-ins for tests 1 to 14.
// ---------------------------------------------------------------------------

// A recovery request port answering one fixed way, recording what it is
// asked and how often it is built.
function stubRequest(answer) {
  const calls = [];
  let built = 0;
  const provider = {
    requestRecoveryEmail: async (...args) => {
      calls.push(args);
      if (typeof answer === "function") {
        return answer();
      }
      return answer;
    },
  };
  return {
    calls,
    built: () => built,
    source: async () => {
      built += 1;
      return provider;
    },
  };
}

// One store of session state: what the browser stores, or what a request's
// own client holds. read is how a claims read of it goes: "ok", an "error"
// result, or a "throw".
function store(session = null) {
  return { session, read: "ok" };
}

function claimsClient(held) {
  return {
    auth: {
      getClaims: async () => {
        if (held.read === "throw") {
          throw new Error(DETAIL);
        }
        if (held.read === "error") {
          return { data: null, error: new Error(DETAIL) };
        }
        return held.session === null
          ? { data: null, error: null }
          : {
              data: {
                claims: {
                  sub: held.session.subject,
                  session_id: held.session.id,
                },
              },
              error: null,
            };
      },
    },
  };
}

const RECOVERED = Object.freeze({ id: ISSUED, subject: ACCOUNT_ID });

// In-memory completion port for one request. Like the real server client it
// keeps its own copy of what it holds apart from the browser's stored state.
// The exchange issues the recovered session to both, the update succeeds for
// the recovered account, and sign-out drops both. overrides is an object, or
// a function given the stores. Every call is recorded in order.
function stubRecovery(jar, overrides = {}) {
  const calls = [];
  const held = store(jar.session);
  const issued = store(RECOVERED);
  const provider = {
    exchangeCode: async (...args) => {
      calls.push(["exchangeCode", ...args]);
      held.session = RECOVERED;
      jar.session = RECOVERED;
      return {
        kind: "exchanged",
        userId: ACCOUNT_ID,
        sessionUserId: ACCOUNT_ID,
        issuedSession: async () => {
          calls.push(["issuedSession"]);
          return sessionOf(await claimsClient(issued).auth.getClaims());
        },
      };
    },
    updatePassword: async (...args) => {
      calls.push(["updatePassword", ...args]);
      return { kind: "updated", userId: ACCOUNT_ID };
    },
    signOut: async () => {
      calls.push(["signOut"]);
      held.session = null;
      jar.session = null;
      return true;
    },
    heldSession: async () => {
      calls.push(["heldSession"]);
      return sessionOf(await claimsClient(held).auth.getClaims());
    },
    storedSession: async () => {
      calls.push(["storedSession"]);
      return sessionOf(await claimsClient(jar).auth.getClaims());
    },
    session: createSupabaseServerSessionSource(async () => {
      calls.push(["session"]);
      return claimsClient(jar);
    }),
    ...(typeof overrides === "function"
      ? overrides({ held, issued, jar, calls })
      : overrides),
  };
  let built = 0;
  return {
    calls,
    names: () => calls.map((call) => call[0]),
    provider,
    held,
    issued,
    built: () => built,
    source: async () => {
      built += 1;
      return provider;
    },
  };
}

const FULL_RUN = [
  "exchangeCode",
  "issuedSession",
  "heldSession",
  "updatePassword",
  "signOut",
  "storedSession",
  "session",
];

// The run up to a rejected update or a failed coherence check, then cleanup.
const CLEANUP = ["signOut", "storedSession", "session"];

// ---------------------------------------------------------------------------
// 1. Recovery request
// ---------------------------------------------------------------------------

test("1. a valid request asks the provider once, for the trimmed address only, and answers neutrally", async () => {
  const stub = stubRequest(undefined);
  const state = await requestAccountRecovery(
    stub.source,
    form([["email", `  ${EMAIL}  `]]),
  );
  assertExactly(state, SUBMITTED);
  assertNothingLeaks(state);
  assert.equal(stub.built(), 1);
  assert.deepEqual(stub.calls, [[EMAIL]]);
  // Nothing else the caller sends is read: not a destination, a password, a
  // code, an identity, a role, or the framework's own action fields.
  const extra = stubRequest(undefined);
  assertExactly(
    await requestAccountRecovery(
      extra.source,
      form([
        ["redirectTo", "https://elsewhere.invalid/"],
        ["redirect_to", "//elsewhere.invalid"],
        ["next", "/elsewhere"],
        ["password", OLD_PW],
        ["code", CODE],
        ["role", "staff"],
        ["subject", ACCOUNT_ID],
        ["user_id", OTHER_ID],
        ["$ACTION_REF_1", ""],
        ["$ACTION_KEY", "k0"],
        ["email", EMAIL],
      ]),
    ),
    SUBMITTED,
  );
  assert.deepEqual(extra.calls, [[EMAIL]]);
  // The previous state is not an input.
  assert.equal(requestAccountRecovery.length, 2);
  assertExactly(INITIAL_RECOVERY_REQUEST_STATE, { status: "idle" });
});

test("2. a missing, malformed, repeated, or non-text address is refused before any provider is built", async () => {
  const missing = { email: ["Enter your email address."] };
  const malformed = { email: ["Enter a valid email address."] };
  const cases = [
    [new FormData(), missing],
    [form([["email", ""]]), missing],
    [form([["email", "   "]]), missing],
    [form([["email", "holder"]]), malformed],
    [form([["email", "holder@"]]), malformed],
    [form([["email", "holder@@synthetic.invalid"]]), malformed],
    [form([["email", "hol der@synthetic.invalid"]]), malformed],
    [form([["email", `${"a".repeat(240)}@synthetic.invalid`]]), malformed],
    [new RawForm({ email: "\uD800holder@synthetic.invalid" }), malformed],
    [
      form([
        ["email", EMAIL],
        ["email", OTHER_EMAIL],
      ]),
      malformed,
    ],
    [form([["email", new Blob([EMAIL])]]), malformed],
    [null, missing],
    [{ email: EMAIL }, missing],
    [new URLSearchParams({ email: EMAIL }), missing],
  ];
  for (const [payload, fieldErrors] of cases) {
    const stub = stubRequest(undefined);
    assertExactly(await requestAccountRecovery(stub.source, payload), {
      status: "invalid",
      fieldErrors,
    });
    assert.equal(stub.built(), 0);
    assert.deepEqual(stub.calls, []);
    const validation = validateRecoveryRequest(payload);
    assert.deepEqual(validation, { ok: false, fieldErrors });
    assertFrozenData(validation.fieldErrors);
  }
  const accepted = validateRecoveryRequest(form([["email", ` ${EMAIL}\n`]]));
  assert.deepEqual(accepted, { ok: true, value: { email: EMAIL } });
  assertFrozenData(accepted.value);
});

test("3. every provider answer, failure, or throw gets the same neutral result, and nothing is retried", async () => {
  const answers = [
    undefined,
    true,
    false,
    { data: {}, error: null },
    { data: null, error: { status: 429, message: DETAIL } },
    { data: null, error: { status: 500, message: DETAIL } },
    ...thrownValues.map((thrown) => () => {
      throw thrown;
    }),
    ...thrownValues.map((thrown) => () => Promise.reject(thrown)),
  ];
  for (const email of [EMAIL, UNKNOWN_EMAIL]) {
    for (const answer of answers) {
      const stub = stubRequest(answer);
      const state = await requestAccountRecovery(
        stub.source,
        form([["email", email]]),
      );
      assertExactly(state, SUBMITTED);
      assertNothingLeaks(state);
      assert.deepEqual(stub.calls, [[email]]);
    }
  }
});

test("4. an unconfigured provider is unavailable for every valid address, and the recovery address is fixed", async () => {
  const sources = [
    async () => null,
    async () => undefined,
    async () => "provider",
    async () => 42,
    async () => {
      throw new Error(DETAIL);
    },
    () => {
      throw new Error(DETAIL);
    },
  ];
  for (const source of sources) {
    for (const email of [EMAIL, UNKNOWN_EMAIL]) {
      assertExactly(
        await requestAccountRecovery(source, form([["email", email]])),
        REQUEST_UNAVAILABLE,
      );
    }
  }
  // Only an exact http(s) origin from server configuration yields the one
  // fixed recovery address; anything else configures nothing.
  assert.equal(recoveryRedirectFor(ORIGIN), REDIRECT);
  assert.equal(
    recoveryRedirectFor("http://localhost:3000"),
    "http://localhost:3000/reset-password",
  );
  for (const configured of [
    undefined,
    null,
    "",
    42,
    [ORIGIN],
    { origin: ORIGIN },
    new String(ORIGIN),
    ` ${ORIGIN}`,
    `${ORIGIN} `,
    `${ORIGIN}/`,
    `${ORIGIN}/reset-password`,
    `${ORIGIN}/?next=/elsewhere`,
    `${ORIGIN}#fragment`,
    "https://user:secret@app.synthetic.invalid",
    "HTTPS://APP.SYNTHETIC.INVALID",
    "https://app.synthetic.invalid:443",
    "ftp://app.synthetic.invalid",
    "javascript:alert(1)",
    "//app.synthetic.invalid",
    "app.synthetic.invalid",
  ]) {
    assert.equal(recoveryRedirectFor(configured), null, String(configured));
  }
});

test("5. a recovery link is exactly one well-formed code; anything else is unusable and never forwarded", () => {
  const uuidCode = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  assert.equal(recoveryCodeOf({ code: CODE }), CODE);
  assert.equal(recoveryCodeOf({ code: uuidCode }), uuidCode);
  assert.equal(recoveryCodeOf(queryOf(`${REDIRECT}?code=${CODE}`)), CODE);
  const throwingKeys = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(DETAIL);
      },
    },
  );
  for (const [index, query] of [
    {},
    { code: "" },
    { code: "short" },
    { code: "x".repeat(129) },
    { code: `${CODE}.` },
    { code: `${CODE} ` },
    { code: `${CODE}/` },
    { code: `<${CODE}>` },
    { code: [CODE, CODE] },
    { code: [CODE] },
    { code: undefined },
    { code: 42 },
    { code: CODE, type: "recovery" },
    { code: CODE, next: "/elsewhere" },
    { code: CODE, redirect_to: "https://elsewhere.invalid" },
    { code: CODE, sb_flow_id: "0123456789abcdef" },
    { token_hash: CODE, type: "recovery" },
    { access_token: CODE, refresh_token: CODE, type: "recovery" },
    {
      error: "access_denied",
      error_code: "otp_expired",
      error_description: "Email link is invalid or has expired",
    },
    queryOf(`${REDIRECT}?code=${CODE}&code=${CODE}`),
    queryOf(`${REDIRECT}#access_token=${CODE}&type=recovery`),
    queryOf(`${REDIRECT}?error=server_error#code=${CODE}`),
    null,
    undefined,
    `code=${CODE}`,
    new URLSearchParams({ code: CODE }),
    throwingKeys,
    {
      get code() {
        throw new Error(DETAIL);
      },
    },
  ].entries()) {
    assert.equal(recoveryCodeOf(query), null, `query ${index}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Recovery completion
// ---------------------------------------------------------------------------

test("6. the whole form is validated before the code is used: nothing is built or exchanged for an invalid submission", async () => {
  // A missing, repeated, or malformed code is an unusable link.
  for (const payload of [
    form([
      ["password", NEW_PW],
      ["confirm_password", NEW_PW],
    ]),
    completionForm({ code: "" }),
    completionForm({ code: "short" }),
    completionForm({ code: `${CODE}#` }),
    completionForm({ extra: [["code", CODE]] }),
    completionForm({ code: new Blob([CODE]) }),
    new FormData(),
    null,
    { code: CODE, password: NEW_PW, confirm_password: NEW_PW },
  ]) {
    const stub = stubRecovery(store());
    assertExactly(
      await completeAccountRecovery(stub.source, payload),
      UNUSABLE,
    );
    assert.equal(stub.built(), 0);
    assert.deepEqual(stub.calls, []);
  }
  // A valid code with a password problem keeps the code unused. The same
  // text in composed and decomposed form is not the same password.
  const nfc = "caf\u00e9 pw";
  const nfd = "cafe\u0301 pw";
  assert.equal(nfc.normalize("NFD"), nfd);
  const cases = [
    [
      completionForm({ password: "", confirmation: "" }),
      {
        password: ["Enter a new password."],
        confirm_password: ["Confirm your new password."],
      },
    ],
    [
      form([["code", CODE]]),
      {
        password: ["Enter a new password."],
        confirm_password: ["Confirm your new password."],
      },
    ],
    [
      completionForm({ confirmation: "" }),
      { confirm_password: ["Confirm your new password."] },
    ],
    [
      completionForm({ confirmation: "different synthetic pw" }),
      { confirm_password: ["The passwords don't match."] },
    ],
    [
      completionForm({ confirmation: NEW_PW.trim() }),
      { confirm_password: ["The passwords don't match."] },
    ],
    [
      completionForm({ password: nfc, confirmation: nfd }),
      { confirm_password: ["The passwords don't match."] },
    ],
    [
      new RawForm({
        code: CODE,
        password: "pw \uD800 7f",
        confirm_password: "pw \uD800 7f",
      }),
      { password: ["Enter a valid password."] },
    ],
    [
      new RawForm({
        code: CODE,
        password: "\uDC00 pw 7f",
        confirm_password: "\uDC00 pw 7f",
      }),
      { password: ["Enter a valid password."] },
    ],
    [
      completionForm({ password: "p".repeat(1025) }),
      { password: ["Enter a valid password."] },
    ],
    [
      completionForm({ extra: [["password", NEW_PW]] }),
      {
        password: ["Enter a valid password."],
        confirm_password: ["The passwords don't match."],
      },
    ],
    [
      completionForm({ extra: [["confirm_password", NEW_PW]] }),
      { confirm_password: ["Confirm your new password."] },
    ],
    [
      completionForm({ password: new Blob([NEW_PW]), confirmation: NEW_PW }),
      {
        password: ["Enter a valid password."],
        confirm_password: ["The passwords don't match."],
      },
    ],
  ];
  for (const [payload, fieldErrors] of cases) {
    const stub = stubRecovery(store());
    const state = await completeAccountRecovery(stub.source, payload);
    assertExactly(state, { status: "invalid", fieldErrors });
    assertNothingLeaks(state);
    assert.equal(stub.built(), 0);
    assert.deepEqual(stub.calls, []);
  }
  // No recovery password rule is invented: within the malformation bounds
  // the provider alone decides, and nothing is trimmed or normalized.
  for (const password of ["a", NEW_PW, "p".repeat(1024), "\u{1F511} key"]) {
    const validation = validateNewPassword(completionForm({ password }));
    assert.deepEqual(validation, { ok: true, value: { password } });
    assertFrozenData(validation.value);
  }
  // Through the platform's FormData an unpaired surrogate is already U+FFFD,
  // an ordinary character, before any check.
  assert.equal(
    completionForm({ password: "pw \uD800" }).get("password"),
    "pw \uFFFD",
  );
});

test("7. a valid submission exchanges once, updates only through the issued session, ends it, and completes", async () => {
  const jar = store();
  const stub = stubRecovery(jar);
  const state = await completeAccountRecovery(
    stub.source,
    completionForm({
      extra: [
        ["subject", OTHER_ID],
        ["role", "staff"],
      ],
    }),
  );
  assertExactly(state, COMPLETED);
  assertNothingLeaks(state);
  assert.deepEqual(Reflect.ownKeys(state), ["status"]);
  assert.equal(stub.built(), 1);
  assert.deepEqual(stub.names(), FULL_RUN);
  // The code goes only to the exchange, and the password, exactly as typed,
  // only to the update. The confirmation goes nowhere.
  assert.deepEqual(stub.calls[0], ["exchangeCode", CODE]);
  assert.deepEqual(stub.calls[3], ["updatePassword", NEW_PW]);
  assert.equal(JSON.stringify(stub.calls).split(NEW_PW).length, 2);
  // Nothing is stored afterwards, and a fresh trusted read is anonymous.
  assert.equal(jar.session, null);
  assertExactly(
    await getShellView(
      createSupabaseServerSessionSource(async () => claimsClient(jar)),
    ),
    { session: "anonymous" },
  );
  assert.equal(completeAccountRecovery.length, 2);
  assertExactly(INITIAL_RECOVERY_COMPLETION_STATE, { status: "idle" });
});

test("8. a refused code starts no session: unusable, with no update and no sign-out", async () => {
  // Even a browser already signed in keeps its session untouched.
  for (const existing of [null, { id: EXISTING, subject: OTHER_ID }]) {
    const jar = store(existing);
    const stub = stubRecovery(jar, ({ calls }) => ({
      exchangeCode: async (...args) => {
        calls.push(["exchangeCode", ...args]);
        return { kind: "rejected" };
      },
    }));
    assertExactly(
      await completeAccountRecovery(stub.source, completionForm()),
      UNUSABLE,
    );
    assert.deepEqual(stub.names(), ["exchangeCode"]);
    assert.deepEqual(jar.session, existing);
  }
});

test("9. a thrown or malformed exchange is contained: no update, the session is ended, and only a confirmed end is plainly unusable", async () => {
  const answers = [
    ...thrownValues.map((thrown) => async () => {
      throw thrown;
    }),
    ...[
      undefined,
      null,
      "rejected",
      "exchanged",
      { kind: "REJECTED" },
      { kind: "rejected", detail: DETAIL },
      { kind: "exchanged" },
      {
        get kind() {
          throw new Error(DETAIL);
        },
      },
    ].map((answer) => async () => answer),
  ];
  for (const answer of answers) {
    // The provider may have stored a session before failing.
    const stub = stubRecovery(store(), ({ held, jar, calls }) => ({
      exchangeCode: async (...args) => {
        calls.push(["exchangeCode", ...args]);
        held.session = RECOVERED;
        jar.session = RECOVERED;
        return answer();
      },
    }));
    const state = await completeAccountRecovery(stub.source, completionForm());
    assertExactly(state, UNUSABLE);
    assertNothingLeaks(state);
    assert.equal(stub.names().includes("updatePassword"), false);
    assert.deepEqual(stub.names().slice(-3), CLEANUP);
  }
  // When that session cannot be shown gone, the result says so.
  for (const failure of [
    { signOut: async () => false },
    {
      signOut: async () => {
        throw new Error(DETAIL);
      },
    },
    { storedSession: async () => ({ kind: "unreadable" }) },
  ]) {
    const stub = stubRecovery(store(), ({ calls }) => ({
      exchangeCode: async (...args) => {
        calls.push(["exchangeCode", ...args]);
        throw new Error(DETAIL);
      },
      ...failure,
    }));
    assertExactly(
      await completeAccountRecovery(stub.source, completionForm()),
      SESSION_UNCERTAIN,
    );
    assert.equal(stub.names().includes("updatePassword"), false);
  }
});

test("10. an exchange that does not prove one recovered account holding the very session it issued never reaches an update", async () => {
  const exchanged = (fields) => ({
    kind: "exchanged",
    userId: ACCOUNT_ID,
    sessionUserId: ACCOUNT_ID,
    issuedSession: async () => ({
      kind: "session",
      id: ISSUED,
      subject: ACCOUNT_ID,
    }),
    ...fields,
  });
  const cases = {
    "missing user": exchanged({ userId: undefined }),
    "blank user": exchanged({ userId: "  ", sessionUserId: "  " }),
    "non-text user": exchanged({ userId: 7, sessionUserId: 7 }),
    "session of another user": exchanged({ sessionUserId: OTHER_ID }),
    "missing session user": exchanged({ sessionUserId: undefined }),
    "no issued-session read": exchanged({ issuedSession: undefined }),
    "issued session of another user": exchanged({
      issuedSession: async () => ({
        kind: "session",
        id: ISSUED,
        subject: OTHER_ID,
      }),
    }),
    "issued session absent": exchanged({
      issuedSession: async () => ({ kind: "none" }),
    }),
    ...Object.fromEntries(
      malformedReads.map((issuedSession, index) => [
        `issued read ${index}`,
        exchanged({ issuedSession }),
      ]),
    ),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const stub = stubRecovery(store(), ({ calls }) => ({
      exchangeCode: async (...args) => {
        calls.push(["exchangeCode", ...args]);
        return answer;
      },
    }));
    const state = await completeAccountRecovery(stub.source, completionForm());
    assertExactly(state, UNUSABLE);
    assert.equal(stub.names().includes("updatePassword"), false, name);
    assert.deepEqual(stub.names().slice(-3), CLEANUP, name);
  }
  // The request's own client must hold the session the exchange issued. A
  // session stored before, of this account or another, or a failed read,
  // never stands in for it, so an earlier session cannot authorize a change.
  const heldCases = [
    { id: EXISTING, subject: ACCOUNT_ID },
    { id: EXISTING, subject: OTHER_ID },
    { id: ISSUED, subject: OTHER_ID },
    null,
  ];
  for (const held of heldCases) {
    const stub = stubRecovery(store(), ({ calls }) => ({
      exchangeCode: async (...args) => {
        calls.push(["exchangeCode", ...args]);
        return exchanged({});
      },
      heldSession: async () => {
        calls.push(["heldSession"]);
        return held === null ? { kind: "none" } : { kind: "session", ...held };
      },
    }));
    assertExactly(
      await completeAccountRecovery(stub.source, completionForm()),
      UNUSABLE,
    );
    assert.equal(stub.names().includes("updatePassword"), false);
  }
  for (const heldSession of malformedReads) {
    const stub = stubRecovery(store(), { heldSession });
    assertExactly(
      await completeAccountRecovery(stub.source, completionForm()),
      UNUSABLE,
    );
    assert.equal(stub.names().includes("updatePassword"), false);
  }
  // With cleanup unconfirmed, the result warns that a session may remain.
  const stub = stubRecovery(store(), {
    heldSession: async () => ({ kind: "unreadable" }),
    signOut: async () => false,
  });
  assertExactly(
    await completeAccountRecovery(stub.source, completionForm()),
    SESSION_UNCERTAIN,
  );
});

test("11. a refused update changes nothing: not-changed once the session is confirmed gone, session-uncertain otherwise", async () => {
  const refusing = ({ calls }) => ({
    updatePassword: async (...args) => {
      calls.push(["updatePassword", ...args]);
      return { kind: "refused" };
    },
  });
  const stub = stubRecovery(store(), refusing);
  const state = await completeAccountRecovery(stub.source, completionForm());
  assertExactly(state, NOT_CHANGED);
  assert.deepEqual(stub.names(), FULL_RUN);
  for (const failure of [
    { signOut: async () => false },
    { storedSession: async () => ({ kind: "unreadable" }) },
  ]) {
    const uncleared = stubRecovery(store(), (stores) => ({
      ...refusing(stores),
      ...failure,
    }));
    assertExactly(
      await completeAccountRecovery(uncleared.source, completionForm()),
      SESSION_UNCERTAIN,
    );
  }
});

test("12. an update with an unknown outcome is never reported as a change or a plain failure", async () => {
  const answers = [
    ...thrownValues.map((thrown) => async () => {
      throw thrown;
    }),
    ...[
      { kind: "unknown" },
      undefined,
      null,
      "updated",
      { kind: "updated" },
      { kind: "updated", userId: OTHER_ID },
      { kind: "updated", userId: ` ${ACCOUNT_ID}` },
      { kind: "refused", detail: DETAIL },
      { kind: "REFUSED" },
      {
        get kind() {
          throw new Error(DETAIL);
        },
      },
    ].map((answer) => async () => answer),
  ];
  for (const answer of answers) {
    const stub = stubRecovery(store(), ({ calls }) => ({
      updatePassword: async (...args) => {
        calls.push(["updatePassword", ...args]);
        return answer();
      },
    }));
    // The session is still ended and confirmed gone, and the result still
    // says the password may have changed.
    const state = await completeAccountRecovery(stub.source, completionForm());
    assertExactly(state, UNCERTAIN);
    assertNothingLeaks(state);
    assert.deepEqual(stub.names(), FULL_RUN);
  }
});

test("13. a changed password is completed only when the session's end is confirmed", async () => {
  const failures = [
    ...[false, undefined, null, "true", 1, {}].map((ended) => ({
      signOut: async () => ended,
    })),
    ...thrownValues.map((thrown) => ({
      signOut: async () => {
        throw thrown;
      },
    })),
    ...malformedReads.map((storedSession) => ({ storedSession })),
    // The provider reports the session ended, but it is still stored.
    ({ held, calls }) => ({
      signOut: async () => {
        calls.push(["signOut"]);
        held.session = null;
        return true;
      },
    }),
    // A stored session of any kind is never an end.
    {
      storedSession: async () => ({
        kind: "session",
        id: EXISTING,
        subject: OTHER_ID,
      }),
    },
    // The trusted boundary must agree, and a failed boundary read is not
    // agreement.
    {
      session: { currentSubject: async () => ACCOUNT_ID },
    },
    {
      session: {
        currentSubject: async () => {
          throw new Error(DETAIL);
        },
      },
    },
    { session: { currentSubject: async () => 42 } },
    { session: null },
  ];
  for (const failure of failures) {
    const jar = store();
    const stub = stubRecovery(jar, failure);
    const state = await completeAccountRecovery(stub.source, completionForm());
    assertExactly(state, UNCERTAIN);
    assertNothingLeaks(state);
    assert.ok(stub.names().includes("updatePassword"));
  }
  // The trusted boundary alone is never enough: it reports a failed read as
  // no identity, so the stored state must also be read and found empty.
  const jar = store();
  jar.read = "error";
  const stub = stubRecovery(jar, ({ held, calls }) => ({
    signOut: async () => {
      calls.push(["signOut"]);
      held.session = null;
      return true;
    },
  }));
  assertExactly(
    await completeAccountRecovery(stub.source, completionForm()),
    UNCERTAIN,
  );
});

test("14. an unconfigured provider attempts nothing, and every result is fixed, frozen data without detail", async () => {
  for (const source of [
    async () => null,
    async () => undefined,
    async () => "provider",
    async () => {
      throw new Error(DETAIL);
    },
  ]) {
    assertExactly(
      await completeAccountRecovery(source, completionForm()),
      UNAVAILABLE,
    );
  }
  // Each request is handled on its own: concurrent attempts share nothing.
  const first = stubRecovery(store());
  const second = stubRecovery(store(), ({ calls }) => ({
    updatePassword: async (...args) => {
      calls.push(["updatePassword", ...args]);
      return { kind: "refused" };
    },
  }));
  const [one, two] = await Promise.all([
    completeAccountRecovery(first.source, completionForm()),
    completeAccountRecovery(
      second.source,
      completionForm({ password: "second synthetic pw" }),
    ),
  ]);
  assertExactly(one, COMPLETED);
  assertExactly(two, NOT_CHANGED);
  assert.deepEqual(first.calls[3], ["updatePassword", NEW_PW]);
  assert.deepEqual(second.calls[3], ["updatePassword", "second synthetic pw"]);
  for (const state of [
    INITIAL_RECOVERY_REQUEST_STATE,
    INITIAL_RECOVERY_COMPLETION_STATE,
    one,
    two,
  ]) {
    assertFrozenData(state);
    assertNothingLeaks(state);
  }
});

// ---------------------------------------------------------------------------
// Realistic request model for tests 15 to 25.
//
// The defects these tests guard against live in how the installed libraries
// behave, so the model runs them instead of imitating them:
// - @supabase/ssr's createServerClient with auth-js. Its server storage
//   writes the PKCE verifier to the request's cookies at once, answers from
//   its own memory ahead of the request's cookies, and hands every other
//   cookie write to setAll on an auth event; the adapter swallows failures.
// - Next.js's own Server Action cookie store. A write changes the store's
//   state first and publishes it to the outgoing response afterwards.
// Only the identity provider's HTTP API is a synthetic in-memory stand-in,
// reached through the fetch each client is given.
// ---------------------------------------------------------------------------

const requireHere = createRequire(import.meta.url);
const { MutableRequestCookiesAdapter } = requireHere(
  "next/dist/server/web/spec-extension/adapters/request-cookies.js",
);
const { RequestCookies } = requireHere(
  "next/dist/server/web/spec-extension/cookies.js",
);

const PUBLISHABLE = "synthetic-publishable-value";
const SIGNINGS = ["asymmetric", "symmetric"];
let providerCount = 0;

function encoded(value) {
  return Buffer.from(value).toString("base64url");
}

function syntheticId(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

// A synthetic identity provider for one test, with two synthetic accounts.
// A recovery request for a known address puts the link the provider's email
// would finally return the browser to in the outbox, bound to the PKCE
// challenge the request sent; for any other address it does nothing, and
// answers the same. A code is exchanged once, only with the verifier that
// matches its challenge, for a new session of its account. Access tokens are
// signed either with an asymmetric key it publishes, which getClaims verifies
// locally, so a token keeps verifying after logout until it expires; or with
// a symmetric key, which getClaims checks by asking the provider, which
// refuses ended sessions. Each instance has its own origin, so the clients'
// process-wide key cache never mixes instances. Routes are keyed by method
// and path: those in outage answer 500, those unreachable fail at the
// transport.
async function identityProvider({ signing = "asymmetric" } = {}) {
  providerCount += 1;
  const origin = `http://p2008-${providerCount}.synthetic.invalid`;
  const kid = `synthetic-key-${providerCount}`;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const published = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
    alg: "ES256",
    use: "sig",
    key_ops: ["verify"],
  };
  const accounts = new Map([
    [ACCOUNT_ID, { id: ACCOUNT_ID, email: EMAIL, password: OLD_PW }],
    [OTHER_ID, { id: OTHER_ID, email: OTHER_EMAIL, password: ALT_PW }],
  ]);
  const provider = {
    origin,
    key: `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    accounts,
    log: [],
    recoveries: [],
    outbox: [],
    flows: new Map(),
    issued: [],
    owners: new Map(),
    active: new Set(),
    updates: [],
    delivery: "deliver",
    updateMode: "accept",
    outage: new Set(),
    unreachable: new Set(),
    password: (id) => accounts.get(id).password,
  };
  let sequence = 0;
  const reply = (status, body) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const userOf = (account) => ({
    id: account.id,
    aud: "authenticated",
    role: "authenticated",
    email: account.email,
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  });
  // The session id inside the access token a request presents.
  const presentedSession = (init) => {
    const bearer = new Headers(init.headers).get("authorization") ?? "";
    const payload = bearer.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString() || "{}")
      .session_id;
  };
  async function grant(accountId) {
    const id = `synthetic-session-${providerCount}-${provider.issued.length + 1}`;
    provider.issued.push(id);
    provider.owners.set(id, accountId);
    provider.active.add(id);
    const now = Math.floor(Date.now() / 1000);
    const head = encoded(
      JSON.stringify(
        signing === "asymmetric"
          ? { alg: "ES256", kid, typ: "JWT" }
          : { alg: "HS256", typ: "JWT" },
      ),
    );
    const body = encoded(
      JSON.stringify({
        iss: `${origin}/auth/v1`,
        aud: "authenticated",
        sub: accountId,
        exp: now + 3600,
        iat: now,
        role: "authenticated",
        aal: "aal1",
        session_id: id,
      }),
    );
    const signature =
      signing === "asymmetric"
        ? encoded(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              pair.privateKey,
              Buffer.from(`${head}.${body}`),
            ),
          )
        : encoded(`synthetic-signature-${id}`);
    const refresh = `synthetic-refresh-${id}`;
    return {
      access_token: `${head}.${body}.${signature}`,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: refresh,
      user: userOf(accounts.get(accountId)),
    };
  }
  const challengeOf = async (verifier) =>
    Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
  provider.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const route = `${init.method ?? "GET"} ${url.pathname.replace(/^\/auth\/v1/, "")}`;
    provider.log.push(route);
    if (provider.unreachable.has(route)) {
      throw new TypeError("fetch failed");
    }
    if (provider.outage.has(route)) {
      return reply(500, { error_code: "unexpected_failure", msg: "outage" });
    }
    if (route === "POST /recover") {
      const submitted = JSON.parse(init.body);
      const redirectTo = url.searchParams.get("redirect_to");
      provider.recoveries.push({
        email: submitted.email,
        redirectTo,
        method: submitted.code_challenge_method,
      });
      const account = [...accounts.values()].find(
        (entry) => entry.email === submitted.email.toLowerCase(),
      );
      if (account !== undefined && provider.delivery === "deliver") {
        sequence += 1;
        const code = syntheticId(sequence);
        provider.flows.set(code, {
          accountId: account.id,
          challenge: submitted.code_challenge,
          method: submitted.code_challenge_method,
          used: false,
        });
        provider.outbox.push({
          to: account.email,
          link: `${redirectTo}?code=${code}`,
        });
      }
      return reply(200, {});
    }
    if (route === "POST /token") {
      const submitted = JSON.parse(init.body);
      if (url.searchParams.get("grant_type") === "pkce") {
        const flow = provider.flows.get(submitted.auth_code);
        if (flow === undefined || flow.used) {
          return reply(404, {
            error_code: "flow_state_not_found",
            msg: "refused",
          });
        }
        if (
          flow.method !== "s256" ||
          (await challengeOf(submitted.code_verifier)) !== flow.challenge
        ) {
          return reply(403, {
            error_code: "bad_code_verifier",
            msg: "refused",
          });
        }
        flow.used = true;
        return reply(200, await grant(flow.accountId));
      }
      const account = [...accounts.values()].find(
        (entry) => entry.email === submitted.email,
      );
      return account !== undefined && account.password === submitted.password
        ? reply(200, await grant(account.id))
        : reply(400, { error_code: "invalid_credentials", msg: "refused" });
    }
    if (route === "GET /.well-known/jwks.json") {
      return reply(200, { keys: [published] });
    }
    if (route === "GET /user" || route === "PUT /user") {
      const session = presentedSession(init);
      if (!provider.active.has(session)) {
        return reply(403, { error_code: "session_not_found", msg: "ended" });
      }
      const account = accounts.get(provider.owners.get(session));
      if (route === "GET /user") {
        return reply(200, userOf(account));
      }
      const { password: chosen } = JSON.parse(init.body);
      if (provider.updateMode === "refuse") {
        return reply(422, { error_code: "same_password", msg: "refused" });
      }
      account.password = chosen;
      provider.updates.push({ session, account: account.id });
      return provider.updateMode === "fail-after-change"
        ? reply(500, { error_code: "unexpected_failure", msg: "outage" })
        : reply(200, userOf(account));
    }
    if (route === "POST /logout") {
      provider.active.delete(presentedSession(init));
      return reply(204);
    }
    throw new Error(`unexpected provider request: ${route}`);
  };
  return provider;
}

// A browser: the Cookie header it sends.
function userAgent(cookie = "") {
  return { cookie };
}

// The browser receiving a response: it applies each Set-Cookie line to its
// jar, as a browser does, and sends the result with its next request.
function receive(agent, setCookie) {
  const jar = new Map(
    (agent.cookie === "" ? [] : agent.cookie.split("; ")).map((pair) => [
      pair.slice(0, pair.indexOf("=")),
      pair.slice(pair.indexOf("=") + 1),
    ]),
  );
  for (const line of setCookie) {
    const [pair, ...attributes] = line.split("; ");
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (value === "" || attributes.some((a) => /^max-age=0$/i.test(a))) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
  agent.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

// One Server Action request from a browser, over Next.js's own cookie store.
// As the default Node response does, publishing sets the response's
// Set-Cookie header to every cookie the store changed. refuse picks the
// cookie writes that throw before they change anything; publication "fails"
// throws from publishing after the store has changed, as setting a header on
// a response already sent does. The response reaches the browser only when a
// test delivers it.
function actionRequest(agent, { refuse = () => false, publication } = {}) {
  const response = { setCookie: [] };
  const store = MutableRequestCookiesAdapter.wrap(
    new RequestCookies(
      new Headers(agent.cookie === "" ? {} : { cookie: agent.cookie }),
    ),
    (serialized) => {
      if (publication === "fails") {
        throw new Error("headers already sent");
      }
      response.setCookie = serialized;
    },
  );
  const cookieStore = {
    getAll: () => store.getAll(),
    set: (name, value, options) => {
      if (refuse(name, value)) {
        throw new Error("cookie write refused");
      }
      store.set(name, value, options);
    },
  };
  return {
    cookieStore,
    response,
    deliver: () => receive(agent, response.setCookie),
  };
}

// The server client as createSupabaseServerClient builds it over a
// request's cookie store (test 26 holds the two to the same cookie methods).
// Only the transport is the synthetic provider's.
function serverClient(provider, request) {
  const cookieStore = request.cookieStore;
  return createServerClient(provider.origin, PUBLISHABLE, {
    global: { fetch: provider.fetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, _headers) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies.
          // Proxy owns refresh writes.
        }
      },
    },
  });
}

// The request port as the request action builds it over one request (test
// 26 holds the two together), with configured standing in for the server's
// configured origin.
function requestSource(provider, request, configured) {
  return async () => {
    const redirectTo = recoveryRedirectFor(configured);
    if (redirectTo === null) {
      return null;
    }
    const client = serverClient(provider, request);
    return Object.freeze({
      requestRecoveryEmail: async (email) => {
        await client.auth.resetPasswordForEmail(email, { redirectTo });
      },
    });
  };
}

// The completion port as the completion action builds it over one request
// (test 26 holds the two together): the request-scoped client makes the
// changes and reads what it holds, and the stored state and the trusted
// boundary are read through freshly initialized clients over the same
// request's cookie store.
function recoveryPort(provider, request) {
  const client = serverClient(provider, request);
  const freshClient = async () => serverClient(provider, request);
  return Object.freeze({
    exchangeCode: async (code) => {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error !== null) {
        return REJECTED;
      }
      const issued = data.session?.access_token;
      return Object.freeze({
        kind: "exchanged",
        userId: data.user?.id,
        sessionUserId: data.session?.user?.id,
        issuedSession: async () =>
          typeof issued === "string" && issued !== ""
            ? sessionOf(await client.auth.getClaims(issued))
            : UNREADABLE,
      });
    },
    updatePassword: async (password) => {
      const { data, error } = await client.auth.updateUser({ password });
      if (error === null) {
        return Object.freeze({ kind: "updated", userId: data.user?.id });
      }
      return typeof error.status === "number" &&
        error.status >= 400 &&
        error.status < 500
        ? REFUSED
        : UNKNOWN;
    },
    signOut: async () => {
      const { error } = await client.auth.signOut({ scope: "local" });
      return error === null;
    },
    heldSession: async () => sessionOf(await client.auth.getClaims()),
    storedSession: async () => {
      const fresh = await freshClient();
      return fresh === null
        ? UNREADABLE
        : sessionOf(await fresh.auth.getClaims());
    },
    session: createSupabaseServerSessionSource(freshClient),
  });
}

// One recovery request or completion from a browser, as the server actions
// run them. Their responses are not delivered: tests deliver them, or not,
// themselves.
async function recoveryRequest(provider, agent, options = {}) {
  const { email = EMAIL, configured, ...conditions } = options;
  const request = actionRequest(agent, conditions);
  const state = await requestAccountRecovery(
    requestSource(
      provider,
      request,
      Object.hasOwn(options, "configured") ? configured : ORIGIN,
    ),
    form([["email", email]]),
  );
  return { state, request };
}

async function completionRequest(provider, agent, code, options = {}) {
  const { password = NEW_PW, ...conditions } = options;
  const request = actionRequest(agent, conditions);
  const state = await completeAccountRecovery(
    async () => recoveryPort(provider, request),
    completionForm({ code, password }),
  );
  return { state, request };
}

// A browser that asked for recovery and received the response, the link the
// provider's email returns it to, and the code the inert page reads from it.
async function requested(provider, agent = userAgent()) {
  const { state, request } = await recoveryRequest(provider, agent);
  assertExactly(state, SUBMITTED);
  request.deliver();
  const { link } = provider.outbox.at(-1);
  return { agent, link, code: recoveryCodeOf(queryOf(link)) };
}

// A browser signed in through the provider's password grant, as the
// existing sign-in leaves it, and its session id.
async function signedIn(provider, email, password) {
  const agent = userAgent();
  const request = actionRequest(agent);
  const { error } = await serverClient(
    provider,
    request,
  ).auth.signInWithPassword({ email, password });
  assert.equal(error, null);
  request.deliver();
  return { agent, id: provider.issued.at(-1) };
}

// What a request's cookie store holds now, read through a fresh client.
async function storedIn(provider, request) {
  return sessionOf(await serverClient(provider, request).auth.getClaims());
}

// What the browser's next request holds, and what its page shows through the
// trusted boundary.
function nextSession(provider, agent) {
  return storedIn(provider, actionRequest(agent));
}

function nextView(provider, agent) {
  const request = actionRequest(agent);
  return getShellView(
    createSupabaseServerSessionSource(async () =>
      serverClient(provider, request),
    ),
  );
}

// How a stored session the provider has ended reads: an asymmetric token
// still verifies locally until it expires; a symmetric one is refused.
function endedRead(signing, id, subject) {
  return signing === "asymmetric"
    ? { kind: "session", id, subject }
    : { kind: "unreadable" };
}

function endedView(signing) {
  return { session: signing === "asymmetric" ? "authenticated" : "anonymous" };
}

function cookieNames(lines) {
  return lines.map((line) => line.slice(0, line.indexOf("="))).sort();
}

// The session cookie, whole or as one of its chunks.
function isSessionCookie(provider, name) {
  return (
    name === provider.key ||
    (name.startsWith(`${provider.key}.`) &&
      /^\d+$/.test(name.slice(provider.key.length + 1)))
  );
}

function isVerifierCookie(provider, name) {
  return name.startsWith(provider.key) && name.endsWith("-code-verifier");
}

// The cookies a browser holds, by name.
function heldCookies(agent) {
  return agent.cookie === ""
    ? []
    : agent.cookie
        .split("; ")
        .map((pair) => pair.slice(0, pair.indexOf("=")))
        .sort();
}

// ---------------------------------------------------------------------------
// 3. The installed clients over Next.js's cookie store
// ---------------------------------------------------------------------------

test("15. the fixture path: request, emailed link, inert GET, deliberate POST, password changed, and no session left", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const agent = userAgent();
      // Request: the provider is asked once, for that address and the fixed
      // recovery address, with an S256 challenge. Only the verifier is
      // stored for this browser; no session is started.
      const { state, request } = await recoveryRequest(provider, agent, {
        email: ` ${EMAIL} `,
      });
      assertExactly(state, SUBMITTED);
      assertNothingLeaks(state);
      assert.deepEqual(provider.log, ["POST /recover"]);
      assert.deepEqual(provider.recoveries, [
        { email: EMAIL, redirectTo: REDIRECT, method: "s256" },
      ]);
      const written = cookieNames(request.response.setCookie);
      assert.ok(written.length > 0);
      assert.ok(written.every((name) => isVerifierCookie(provider, name)));
      assert.ok(written.includes(`${provider.key}-code-verifier`));
      request.deliver();
      assert.deepEqual(heldCookies(agent), written);
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
      // The provider's email returns the browser to the fixed address with
      // one code. The page reads it into its form and calls nothing.
      assert.equal(provider.outbox.length, 1);
      const [{ to, link }] = provider.outbox;
      assert.equal(to, EMAIL);
      assert.ok(link.startsWith(`${REDIRECT}?code=`));
      const before = provider.log.length;
      const code = recoveryCodeOf(queryOf(link));
      assert.equal(typeof code, "string");
      assert.equal(provider.log.length, before);
      assert.equal(provider.flows.get(code).used, false);
      // The deliberate POST exchanges the code with this browser's verifier,
      // changes the password through the session that exchange issued, ends
      // that session, and confirms that none remains.
      const completion = await completionRequest(provider, agent, code);
      assertExactly(completion.state, COMPLETED);
      assertNothingLeaks(completion.state);
      assert.equal(provider.flows.get(code).used, true);
      assert.equal(provider.issued.length, 1);
      const [recoverySession] = provider.issued;
      assert.equal(provider.owners.get(recoverySession), ACCOUNT_ID);
      assert.deepEqual(provider.updates, [
        { session: recoverySession, account: ACCOUNT_ID },
      ]);
      assert.equal(provider.password(ACCOUNT_ID), NEW_PW);
      assert.equal(provider.password(OTHER_ID), ALT_PW);
      assert.equal(provider.active.has(recoverySession), false);
      // Besides claims reads, the provider saw exactly these, in order.
      assert.deepEqual(
        provider.log.filter((route) => !route.startsWith("GET ")),
        ["POST /recover", "POST /token", "PUT /user", "POST /logout"],
      );
      // The response removes the recovery session and every verifier. Once
      // the browser receives it, it holds no Supabase cookie at all, and its
      // next page is anonymous.
      assert.deepEqual(await storedIn(provider, completion.request), {
        kind: "none",
      });
      completion.request.deliver();
      assert.deepEqual(heldCookies(agent), []);
      assert.deepEqual(await nextSession(provider, agent), { kind: "none" });
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
    });
  }
});

test("16. requests for unknown, undelivered, refused, or unconfigured addresses claim nothing", async () => {
  const provider = await identityProvider();
  const known = await recoveryRequest(provider, userAgent());
  const unknown = await recoveryRequest(provider, userAgent(), {
    email: UNKNOWN_EMAIL,
  });
  // Same result and the same cookies for a known and an unknown address;
  // only the known one has an email waiting.
  assertExactly(known.state, SUBMITTED);
  assertExactly(unknown.state, SUBMITTED);
  assert.deepEqual(
    cookieNames(unknown.request.response.setCookie).map((name) =>
      name.replace(/-flow-[A-Za-z0-9_-]+-/, "-flow-*-"),
    ),
    cookieNames(known.request.response.setCookie).map((name) =>
      name.replace(/-flow-[A-Za-z0-9_-]+-/, "-flow-*-"),
    ),
  );
  assert.equal(provider.outbox.length, 1);
  assert.equal(provider.outbox[0].to, EMAIL);
  // A provider that accepts but delivers nothing gets the same result.
  provider.delivery = "none";
  const undelivered = await recoveryRequest(provider, userAgent());
  assertExactly(undelivered.state, SUBMITTED);
  assert.equal(provider.outbox.length, 1);
  provider.delivery = "deliver";
  // A provider failure, such as a rate limit, gets the same result, and the
  // request is never repeated.
  provider.outage.add("POST /recover");
  const recoveries = provider.log.length;
  const refused = await recoveryRequest(provider, userAgent());
  assertExactly(refused.state, SUBMITTED);
  assert.equal(provider.log.length, recoveries + 1);
  provider.outage.delete("POST /recover");
  provider.unreachable.add("POST /recover");
  assertExactly(
    (await recoveryRequest(provider, userAgent())).state,
    SUBMITTED,
  );
  provider.unreachable.delete("POST /recover");
  // Without a trusted origin nothing is asked and nothing is stored.
  for (const configured of [undefined, "", `${ORIGIN}/`, "not an origin"]) {
    const log = provider.log.length;
    const unconfigured = await recoveryRequest(provider, userAgent(), {
      configured,
    });
    assertExactly(unconfigured.state, REQUEST_UNAVAILABLE);
    assert.equal(provider.log.length, log);
    assert.deepEqual(unconfigured.request.response.setCookie, []);
  }
  // No request starts a session.
  assert.deepEqual(provider.issued, []);
});

test("17. a link opened in another browser, or after its verifier is gone, is refused before the provider is asked", async () => {
  const provider = await identityProvider();
  const { agent, code } = await requested(provider);
  // Another browser holds no verifier: the client refuses before any
  // provider call, so the code stays unused and nothing is stored.
  const other = userAgent();
  const elsewhere = await completionRequest(provider, other, code);
  assertExactly(elsewhere.state, UNUSABLE);
  assert.equal(provider.log.includes("POST /token"), false);
  assert.equal(provider.flows.get(code).used, false);
  assert.deepEqual(elsewhere.request.response.setCookie, []);
  assert.equal(provider.password(ACCOUNT_ID), OLD_PW);
  assert.deepEqual(provider.issued, []);
  // The browser that asked can still use it.
  const completion = await completionRequest(provider, agent, code);
  assertExactly(completion.state, COMPLETED);
  completion.request.deliver();
  // Afterwards its verifier is gone, so the same link is refused at once.
  const tokens = provider.log.filter((route) => route === "POST /token").length;
  const again = await completionRequest(provider, agent, code, {
    password: "another synthetic pw",
  });
  assertExactly(again.state, UNUSABLE);
  assert.equal(
    provider.log.filter((route) => route === "POST /token").length,
    tokens,
  );
  assert.equal(provider.password(ACCOUNT_ID), NEW_PW);
});

test("18. a replayed or unknown code is refused by the provider and changes nothing", async () => {
  const provider = await identityProvider();
  const { agent, code } = await requested(provider);
  // A copy of the browser as it was before completing, verifier included.
  const replay = userAgent(agent.cookie);
  const completion = await completionRequest(provider, agent, code);
  assertExactly(completion.state, COMPLETED);
  const issued = provider.issued.length;
  const replayed = await completionRequest(provider, replay, code, {
    password: "another synthetic pw",
  });
  assertExactly(replayed.state, UNUSABLE);
  assert.equal(provider.log.at(-1), "POST /token");
  assert.equal(provider.password(ACCOUNT_ID), NEW_PW);
  assert.equal(provider.issued.length, issued);
  assert.deepEqual(replayed.request.response.setCookie, []);
  // A well-formed code the provider never issued fares the same.
  const fresh = await requested(provider);
  const unknown = await completionRequest(provider, fresh.agent, CODE);
  assertExactly(unknown.state, UNUSABLE);
  assert.equal(provider.issued.length, issued);
  assert.equal(provider.flows.get(fresh.code).used, false);
});

test("19. a browser already signed in, to this or another account, never authorizes the change, and ends signed out", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      for (const [email, password, accountId] of [
        [EMAIL, OLD_PW, ACCOUNT_ID],
        [OTHER_EMAIL, ALT_PW, OTHER_ID],
      ]) {
        const { agent, id: earlier } = await signedIn(
          provider,
          email,
          password,
        );
        assertExactly(await nextView(provider, agent), {
          session: "authenticated",
        });
        // A code the provider refuses leaves the existing session as it is:
        // no session was started, so none is ended.
        const refused = await completionRequest(provider, agent, CODE);
        assertExactly(refused.state, UNUSABLE);
        assert.equal(provider.active.has(earlier), true);
        assert.deepEqual(await storedIn(provider, refused.request), {
          kind: "session",
          id: earlier,
          subject: accountId,
        });
        // Recovering the first account from this browser.
        const { code } = await requested(provider, agent);
        const updates = provider.updates.length;
        const completion = await completionRequest(provider, agent, code);
        assertExactly(completion.state, COMPLETED);
        const recoverySession = provider.issued.at(-1);
        assert.notEqual(recoverySession, earlier);
        // Only the session the exchange issued authorized the update, and
        // only the recovered account changed.
        assert.deepEqual(provider.updates.slice(updates), [
          { session: recoverySession, account: ACCOUNT_ID },
        ]);
        assert.equal(provider.owners.get(recoverySession), ACCOUNT_ID);
        assert.equal(provider.password(OTHER_ID), ALT_PW);
        assert.equal(provider.active.has(recoverySession), false);
        // No other session is signed out at the provider, but this browser
        // no longer holds any.
        assert.equal(provider.active.has(earlier), true);
        completion.request.deliver();
        assert.deepEqual(heldCookies(agent), []);
        assert.deepEqual(await nextSession(provider, agent), { kind: "none" });
        assertExactly(await nextView(provider, agent), {
          session: "anonymous",
        });
        provider.accounts.get(ACCOUNT_ID).password = OLD_PW;
      }
    });
  }
});

test("20. a refused update leaves the password unchanged and the recovery session ended", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const { agent, code } = await requested(provider);
      provider.updateMode = "refuse";
      const completion = await completionRequest(provider, agent, code);
      assertExactly(completion.state, NOT_CHANGED);
      assert.equal(provider.password(ACCOUNT_ID), OLD_PW);
      assert.deepEqual(provider.updates, []);
      assert.equal(provider.active.has(provider.issued.at(-1)), false);
      completion.request.deliver();
      assert.deepEqual(heldCookies(agent), []);
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
    });
  }
});

test("21. an update whose outcome is unknown is uncertain even after a confirmed sign-out", async () => {
  // The provider changes the password but answers with a server error.
  const changed = await identityProvider();
  const first = await requested(changed);
  changed.updateMode = "fail-after-change";
  const unknown = await completionRequest(changed, first.agent, first.code);
  assertExactly(unknown.state, UNCERTAIN);
  assert.equal(changed.password(ACCOUNT_ID), NEW_PW);
  assert.equal(changed.active.has(changed.issued.at(-1)), false);
  unknown.request.deliver();
  assertExactly(await nextView(changed, first.agent), { session: "anonymous" });
  // The update never reaches the provider, but the client cannot tell.
  const lost = await identityProvider();
  const second = await requested(lost);
  lost.unreachable.add("PUT /user");
  const unreachable = await completionRequest(lost, second.agent, second.code);
  assertExactly(unreachable.state, UNCERTAIN);
  assert.equal(lost.password(ACCOUNT_ID), OLD_PW);
  assert.equal(lost.active.has(lost.issued.at(-1)), false);
});

test("22. a failed sign-out or a session cookie that cannot be removed is never completion", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      // The provider fails the logout: the client drops the session from
      // this browser anyway, but the provider never confirmed its end.
      const failing = await identityProvider({ signing });
      const first = await requested(failing);
      failing.outage.add("POST /logout");
      const outage = await completionRequest(failing, first.agent, first.code);
      assertExactly(outage.state, UNCERTAIN);
      assert.equal(failing.password(ACCOUNT_ID), NEW_PW);
      assert.equal(failing.active.has(failing.issued.at(-1)), true);
      outage.request.deliver();
      assert.deepEqual(await nextSession(failing, first.agent), {
        kind: "none",
      });
      // The provider ends the session, but its cookie removal is refused and
      // the adapter swallows it: the stored state still holds the session.
      const stuck = await identityProvider({ signing });
      const second = await requested(stuck);
      const completion = await completionRequest(
        stuck,
        second.agent,
        second.code,
        {
          refuse: (name, value) => value === "" && isSessionCookie(stuck, name),
        },
      );
      assertExactly(completion.state, UNCERTAIN);
      const recoverySession = stuck.issued.at(-1);
      assert.equal(stuck.password(ACCOUNT_ID), NEW_PW);
      assert.equal(stuck.active.has(recoverySession), false);
      assert.deepEqual(
        await storedIn(stuck, completion.request),
        endedRead(signing, recoverySession, ACCOUNT_ID),
      );
      // That is why the result points to the home page: what the browser
      // received shows there.
      completion.request.deliver();
      assert.deepEqual(
        await nextSession(stuck, second.agent),
        endedRead(signing, recoverySession, ACCOUNT_ID),
      );
      assertExactly(await nextView(stuck, second.agent), endedView(signing));
    });
  }
});

test("23. an issued session that cannot be read never reaches an update, and is still ended", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const { agent, code } = await requested(provider);
      provider.outage.add(
        signing === "asymmetric" ? "GET /.well-known/jwks.json" : "GET /user",
      );
      const completion = await completionRequest(provider, agent, code);
      assertExactly(completion.state, UNUSABLE);
      assert.equal(provider.log.includes("PUT /user"), false);
      assert.equal(provider.password(ACCOUNT_ID), OLD_PW);
      assert.equal(provider.flows.get(code).used, true);
      assert.equal(provider.active.has(provider.issued.at(-1)), false);
      completion.request.deliver();
      assert.deepEqual(heldCookies(agent), []);
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
    });
  }
});

test("24. a response that never reaches the browser carries no recovery session to it", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const { agent, code } = await requested(provider);
      const held = agent.cookie;
      const completion = await completionRequest(provider, agent, code, {
        publication: "fails",
      });
      assertExactly(completion.state, COMPLETED);
      assert.deepEqual(completion.request.response.setCookie, []);
      assert.equal(provider.active.has(provider.issued.at(-1)), false);
      completion.request.deliver();
      assert.equal(agent.cookie, held);
      assert.ok(
        heldCookies(agent).every((name) => isVerifierCookie(provider, name)),
      );
      assert.deepEqual(await nextSession(provider, agent), { kind: "none" });
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
    });
  }
});

test("25. the installed client stores the verifier only for the requesting browser and keys the exchange to it", async () => {
  const provider = await identityProvider();
  // Two browsers ask in turn. Each holds only its own verifier, and each
  // link works only in the browser that asked for it.
  const first = await requested(provider);
  const second = await requested(provider);
  assert.notEqual(first.code, second.code);
  assert.notDeepEqual(first.agent.cookie, second.agent.cookie);
  const crossed = await completionRequest(provider, second.agent, first.code);
  assertExactly(crossed.state, UNUSABLE);
  assert.equal(provider.password(ACCOUNT_ID), OLD_PW);
  // The crossed attempt reached the provider with the wrong verifier, which
  // refused it, so the first browser's code is still unused.
  assert.equal(provider.flows.get(first.code).used, false);
  const own = await completionRequest(provider, first.agent, first.code);
  assertExactly(own.state, COMPLETED);
  // A browser that asks twice keeps only the latest link usable: the client
  // exchanges with the most recent verifier.
  provider.accounts.get(ACCOUNT_ID).password = OLD_PW;
  const twice = await requested(provider);
  const older = twice.code;
  const latest = await requested(provider, twice.agent);
  const stale = await completionRequest(provider, twice.agent, older);
  assertExactly(stale.state, UNUSABLE);
  const current = await completionRequest(provider, twice.agent, latest.code);
  assertExactly(current.state, COMPLETED);
});

// ---------------------------------------------------------------------------
// 4. Source contracts
// ---------------------------------------------------------------------------

// A port object literal, from its opening to its closing brace, with all
// whitespace collapsed.
function portIn(code, end) {
  const start = code.indexOf("return Object.freeze({");
  const stop = code.indexOf(end, start);
  assert.ok(start >= 0 && stop > start);
  return code.slice(start, stop).replace(/\s+/g, " ").trim();
}

test("26. the model runs the real adapter's cookie methods and the actions' exact wiring", () => {
  // The model's server client uses the very cookie methods of the adapter.
  const adapter = read("src/infrastructure/identity/supabase-server.ts");
  const cookieMethods = (source) =>
    source
      .match(
        /getAll\(\) \{[\s\S]*?Proxy owns refresh writes\.\n\s*\}\n\s*\}/,
      )[0]
      .replace(/\s+/g, " ");
  assert.equal(cookieMethods(serverClient.toString()), cookieMethods(adapter));
  // The completion port is the action's port, with only the fresh-client
  // construction and the trusted boundary's client source standing in.
  const completion = codeOf(read("app/reset-password/actions.ts"));
  assert.equal(
    portIn(codeOf(recoveryPort.toString()), "\n  });\n}"),
    portIn(
      completion
        .replace("const issued: unknown =", "const issued =")
        .replace(
          "const fresh = await createSupabaseServerClient();",
          "const fresh = await freshClient();",
        )
        .replace(
          "session: SUPABASE_SERVER_SESSION_SOURCE,",
          "session: createSupabaseServerSessionSource(freshClient),",
        ),
      "\n  } satisfies RecoveryProvider);",
    ),
  );
  // Without its type annotations the action's claims read is the sessionOf
  // these tests run.
  assert.equal(
    codeOf(sessionOf.toString()).replace(/\s+/g, " "),
    completion
      .match(/function sessionOf\(read: ClaimsRead\)[\s\S]*?\n\}\n/)[0]
      .replace("read: ClaimsRead): RecoverySessionRead", "read)")
      .replace(/const (id|subject): unknown =/g, "const $1 =")
      .replace(/\s+/g, " ")
      .trim(),
  );
  for (const constant of [
    'const UNREADABLE: RecoverySessionRead = Object.freeze({ kind: "unreadable" });',
    'const NO_SESSION: RecoverySessionRead = Object.freeze({ kind: "none" });',
    'const REJECTED: CodeExchange = Object.freeze({ kind: "rejected" });',
    'const REFUSED: PasswordUpdate = Object.freeze({ kind: "refused" });',
    'const UNKNOWN: PasswordUpdate = Object.freeze({ kind: "unknown" });',
  ]) {
    assert.ok(completion.includes(constant), constant);
  }
  // The request port is the action's port, over the configured origin.
  const request = codeOf(read("app/forgot-password/actions.ts"));
  assert.equal(
    portIn(codeOf(requestSource.toString()), "\n    });\n  };"),
    portIn(request, "\n  } satisfies RecoveryRequestProvider);"),
  );
  assert.match(
    request,
    /async function requestProvider\(\): Promise<RecoveryRequestProvider \| null> \{\n {2}const redirectTo = recoveryRedirectFor\(process\.env\.ROSUNO_AUTH_PUBLIC_ORIGIN\);\n {2}if \(redirectTo === null\) \{\n {4}return null;\n {2}\}\n {2}const client = await createSupabaseServerClient\(\);\n {2}if \(client === null\) \{\n {4}return null;\n {2}\}\n {2}return Object\.freeze\(\{/,
  );
  assert.match(
    codeOf(requestSource.toString()),
    /const redirectTo = recoveryRedirectFor\(configured\);\n {4}if \(redirectTo === null\) \{\n {6}return null;\n {4}\}\n {4}const client = serverClient\(provider, request\);\n {4}return Object\.freeze\(\{/,
  );
});

test("27. the request action is POST-only, reads only the trusted origin, and sends only the address and the fixed return", () => {
  const source = read("app/forgot-password/actions.ts");
  const code = codeOf(source);
  assert.match(source, /^"use server";\n/);
  assert.deepEqual(importsOf(source), [
    "../../src/application/account-recovery.ts",
    "../../src/infrastructure/identity/supabase-server.ts",
  ]);
  assert.deepEqual(
    [...code.matchAll(/\bexport\b[^\n]*/g)].map((match) => match[0]),
    ["export async function requestRecovery("],
  );
  assert.match(
    code,
    /export async function requestRecovery\(\n {2}_previous: RecoveryRequestState,\n {2}formData: FormData,\n\): Promise<RecoveryRequestState> \{\n {2}return requestAccountRecovery\(requestProvider, formData\);\n\}/,
  );
  assert.equal(code.match(/\b_previous\b/g)?.length, 1);
  // One recovery request, with the address and the fixed return only, whose
  // answer is never read, over one request-scoped unprivileged client.
  assert.match(
    code,
    /\n {6}await client\.auth\.resetPasswordForEmail\(email, \{ redirectTo \}\);\n/,
  );
  assert.equal(code.match(/\.resetPasswordForEmail\(/g)?.length, 1);
  assert.equal(code.match(/createSupabaseServerClient\(\)/g)?.length, 1);
  assert.deepEqual(code.match(/process\.env\.\w+/g), [
    "process.env.ROSUNO_AUTH_PUBLIC_ORIGIN",
  ]);
  assert.doesNotMatch(
    code,
    /=\s*await client\.auth\.resetPasswordForEmail|\bheaders\s*\(|\bcookies\s*\(|searchParams|formData\.get|\bredirect\s*\(|revalidate|\bconsole\b|\bthrow\b|signIn|signUp|signOut|verifyOtp|updateUser|exchangeCodeForSession|getClaims|getUser|getSession|setSession|\badmin\b|Authorization|captcha|emailRedirectTo|\bnext\b(?!\/)|\brole\b|\bsubject\b/,
  );
});

test("28. the completion action is POST-only, exchanges only through its port, and never redirects", () => {
  const source = read("app/reset-password/actions.ts");
  const code = codeOf(source);
  assert.match(source, /^"use server";\n/);
  assert.deepEqual(importsOf(source), [
    "../../src/application/account-recovery.ts",
    "../../src/infrastructure/identity/server-session-source.ts",
    "../../src/infrastructure/identity/supabase-server.ts",
  ]);
  assert.deepEqual(
    [...code.matchAll(/\bexport\b[^\n]*/g)].map((match) => match[0]),
    ["export async function completeRecovery("],
  );
  assert.match(
    code,
    /export async function completeRecovery\(\n {2}_previous: RecoveryCompletionState,\n {2}formData: FormData,\n\): Promise<RecoveryCompletionState> \{\n {2}return completeAccountRecovery\(recoveryProvider, formData\);\n\}/,
  );
  assert.equal(code.match(/\b_previous\b/g)?.length, 1);
  // Exactly the four provider operations, over one request-scoped client,
  // with fresh clients only for the stored-state read.
  assert.equal(
    code.match(/await client\.auth\.exchangeCodeForSession\(code\);/g)?.length,
    1,
  );
  assert.equal(code.match(/exchangeCodeForSession/g)?.length, 1);
  assert.match(code, /await client\.auth\.updateUser\(\{ password \}\);/);
  assert.equal(code.match(/\.updateUser\(/g)?.length, 1);
  assert.match(code, /await client\.auth\.signOut\(\{ scope: "local" \}\);/);
  assert.equal(code.match(/\.signOut\(/g)?.length, 1);
  assert.deepEqual(code.match(/\.getClaims\([^)]*\)/g), [
    ".getClaims(issued)",
    ".getClaims()",
    ".getClaims()",
  ]);
  assert.equal(code.match(/createSupabaseServerClient\(\)/g)?.length, 2);
  // The issued session is read with the exchange's own credential only when
  // there is one, so a missing credential never falls back to the client's
  // stored session.
  assert.match(
    code,
    /typeof issued === "string" && issued !== ""\n {12}\? sessionOf\(await client\.auth\.getClaims\(issued\)\)\n {12}: UNREADABLE,/,
  );
  assert.equal(code.match(/\baccess_token\b/g)?.length, 1);
  assert.doesNotMatch(
    code,
    /\bprocess\b|\bconsole\b|\bthrow\b|\bheaders\s*\(|\bcookies\s*\(|\bredirect\s*\(|revalidate|searchParams|formData\.get|setSession|refreshSession|verifyOtp|resetPasswordForEmail|signIn|signUp|getUser\b|getSession|reauthenticate|\badmin\b|scope: "(?:global|others)"|Authorization|error\.message|refresh_token|\bnext\b(?!\/)|\brole\b/,
  );
});

test("29. the recovery page renders only: the code goes only into its own hidden field, and nothing runs on GET", () => {
  const source = read("app/reset-password/page.tsx");
  const code = codeOf(source);
  assert.match(source, /^"use client";\n/);
  assert.deepEqual(importsOf(source), [
    "react",
    "../../src/application/account-recovery.ts",
    "../../src/application/form-operation.ts",
    "../../src/presentation/design-system.tsx",
    "./actions.ts",
  ]);
  assert.match(source, /^import \{ use, useActionState \} from "react";$/m);
  // The code is read only from the page's own query, through the strict
  // parser, and placed only in the form's hidden field while it is unused.
  assert.equal(code.match(/\bsearchParams\b/g)?.length, 3);
  assert.match(
    code,
    /\n {2}const code = recoveryCodeOf\(use\(searchParams\)\);\n/,
  );
  assert.match(
    code,
    /\n {2}const formCode =\n {4}state\.status === "idle" \|\| state\.status === "invalid" \? code : null;\n/,
  );
  assert.equal(code.match(/\bcode\b/g)?.length, 4);
  assert.equal(code.match(/\bformCode\b/g)?.length, 4);
  assert.match(code, /<input type="hidden" name="code" value=\{formCode\} \/>/);
  // The server action is only handed to the form state; nothing on the page
  // calls it, the provider, or any session operation.
  assert.match(
    code,
    /useActionState\(\n {4}completeRecovery,\n {4}INITIAL_RECOVERY_COMPLETION_STATE,\n {2}\);/,
  );
  assert.equal(code.match(/\bcompleteRecovery\b/g)?.length, 2);
  assert.equal(code.match(/<form\b[^>]*>/g)?.length, 1);
  assert.match(code, /<form action=\{formAction\}>/);
  assert.doesNotMatch(
    code,
    /exchangeCodeForSession|exchangeCode|updateUser|updatePassword|signOut|resetPasswordForEmail|getClaims|createSupabaseServerClient|\bcookies\b|\bheaders\b|\bfetch\s*\(|useEffect|useLayoutEffect|useRouter|\bwindow\b|\bdocument\b|location|history|localStorage|sessionStorage|indexedDB|redirect|navigate|\bconsole\b|dangerouslySetInnerHTML|\bmethod=|\bonSubmit\b|\bon[A-Z]\w*=|\bdefaultValue\b|\bkey=|\bsrc=|\baction="/,
  );
  // The page asks not to be indexed or archived and sends no referrer.
  assert.deepEqual(code.match(/<meta [^>]*\/>/g), [
    '<meta name="robots" content="noindex, nofollow, noarchive" />',
    '<meta name="referrer" content="no-referrer" />',
  ]);
  // Every component comes from the design system; its only native elements
  // are the two meta tags, the form, and the hidden field. No class, style,
  // color, stylesheet, script, or outside resource.
  const imported = source
    .match(
      /import \{([^}]+)\} from "\.\.\/\.\.\/src\/presentation\/design-system\.tsx";/,
    )[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  // Elements only: a type argument such as Promise<...> follows a name.
  const used = [
    ...new Set(
      [...code.matchAll(/(?<![\w$])<([A-Z]\w*)/g)].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(used, imported);
  assert.deepEqual(
    [
      ...new Set(
        [...code.matchAll(/(?<![\w$])<([a-z]\w*)/g)].map((match) => match[1]),
      ),
    ].sort(),
    ["form", "input", "meta"],
  );
  assert.doesNotMatch(
    code,
    /className|\bstyle=|#[0-9a-f]{3,8}\b|rgb\(|hsl\(|\.css|<style\b|<script\b|<link\b|<img\b|<iframe\b|https?:|\/\/[a-z]/i,
  );
  assert.deepEqual(
    [
      ...new Set([...code.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1])),
    ].sort(),
    ["/", "/forgot-password", "/sign-in"],
  );
  // State is read only to choose a fixed message or the field messages.
  assert.deepEqual(
    [...new Set([...code.matchAll(/\bstate\.\w+/g)].map((match) => match[0]))],
    ["state.status", "state.fieldErrors"],
  );
  for (const status of [
    "invalid",
    "unusable",
    "unavailable",
    "not-changed",
    "session-uncertain",
    "uncertain",
    "completed",
  ]) {
    assert.match(
      code,
      new RegExp(`\\{state\\.status === "${status}" \\? \\(\\n\\s+<Alert\\b`),
      status,
    );
  }
  // Only a completed result says the password changed, and it claims no
  // access: the browser is not signed in.
  const flat = code.replace(/\s+/g, " ");
  assert.equal(flat.match(/has been changed/g)?.length, 1);
  assert.ok(
    flat.includes(
      '{state.status === "completed" ? ( <Alert tone="success" title="Your password has been changed" role="status" > This browser isn&apos;t signed in. Use your new password the next time you sign in. </Alert> ) : null}',
    ),
  );
  assert.ok(
    flat.includes(
      "Your password may or may not have been changed, and this browser may still be signed in.",
    ),
  );
  // Labelled new-password controls, with no recovery password rule invented.
  for (const [id, name, label] of [
    ["reset-password-new", "password", "New password"],
    ["reset-password-confirm", "confirm_password", "Confirm new password"],
  ]) {
    assert.match(
      code,
      new RegExp(
        `<TextField\\n\\s+id="${id}"\\n\\s+name="${name}"\\n\\s+label="${label}"\\n\\s+type="password"\\n\\s+autoComplete="new-password"\\n\\s+autoCapitalize="none"\\n\\s+spellCheck=\\{false\\}\\n\\s+required\\n\\s+errors=\\{fieldErrors\\.${name}\\}\\n\\s+\\/>`,
      ),
    );
  }
  assert.doesNotMatch(source, /\bhint=|characters|emoji|\bminimum\b/i);
  assert.doesNotMatch(
    code,
    /attorney|lawyer|\bstaff\b|\brole=(?!"(?:alert|status)")|capabilit|eligib|jurisdiction|booking|payment|verified|you are signed in|subject/i,
  );
  assert.doesNotMatch(
    source,
    /\b(?:demo|fake|mock|sample|dummy|lorem|ipsum|todo|fixme)\b|@[a-z0-9-]+\.[a-z]{2,}|WCAG|certif/i,
  );
});

test("30. the request page is an accessible design-system form whose copy never claims delivery or reveals an account", () => {
  const source = read("app/forgot-password/page.tsx");
  const code = codeOf(source);
  assert.match(source, /^"use client";\n/);
  assert.deepEqual(importsOf(source), [
    "react",
    "../../src/application/account-recovery.ts",
    "../../src/application/form-operation.ts",
    "../../src/presentation/design-system.tsx",
    "./actions.ts",
  ]);
  assert.match(
    code,
    /useActionState\(\n {4}requestRecovery,\n {4}INITIAL_RECOVERY_REQUEST_STATE,\n {2}\);/,
  );
  assert.equal(code.match(/\brequestRecovery\b/g)?.length, 2);
  assert.equal(code.match(/<form\b[^>]*>/g)?.length, 1);
  assert.match(code, /<form action=\{formAction\}>/);
  assert.doesNotMatch(
    code,
    /\bmethod=|\bonSubmit\b|\bon[A-Z]\w*=|\bfetch\s*\(|localStorage|sessionStorage|document\.cookie|indexedDB|useEffect|\bdefaultValue\b|\bvalue=|dangerouslySetInnerHTML|searchParams|resetPasswordForEmail|createSupabaseServerClient/,
  );
  assert.match(
    code,
    /<TextField\n\s+id="forgot-password-email"\n\s+name="email"\n\s+label="Email address"\n\s+type="email"\n\s+autoComplete="email"\n\s+autoCapitalize="none"\n\s+spellCheck=\{false\}\n\s+required\n\s+errors=\{fieldErrors\.email\}\n\s+\/>/,
  );
  assert.match(
    code,
    /<Button variant="primary" type="submit" disabled=\{pending\}>\n\s+Request recovery link\n\s+<\/Button>/,
  );
  assert.deepEqual(
    [...new Set([...code.matchAll(/\bstate\.\w+/g)].map((match) => match[0]))],
    ["state.status", "state.fieldErrors"],
  );
  assert.match(
    code,
    /\{state\.status === "submitted" \? \(\n\s+<Alert tone="information" title="Check your email" role="status">/,
  );
  for (const status of ["unavailable", "invalid"]) {
    assert.match(
      code,
      new RegExp(
        `\\{state\\.status === "${status}" \\? \\(\\n\\s+<Alert\\n?\\s*tone="error"`,
      ),
      status,
    );
  }
  assert.equal(code.match(/<Alert\b/g)?.length, 3);
  // The neutral copy never says an email was sent or delivered, or whether
  // an account exists.
  const flat = code.replace(/\s+/g, " ");
  assert.ok(flat.includes("Delivery isn&apos;t guaranteed."));
  assert.ok(flat.includes("If this email address belongs to an account"));
  assert.doesNotMatch(
    flat,
    /we(?:'|&apos;)ve sent|we sent|has been sent|was sent|email sent|is on its way|no account|not registered|doesn(?:'|&apos;)t exist|unknown address|account found/i,
  );
  const imported = source
    .match(
      /import \{([^}]+)\} from "\.\.\/\.\.\/src\/presentation\/design-system\.tsx";/,
    )[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const used = [
    ...new Set([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(used, imported);
  assert.deepEqual(
    [...new Set([...code.matchAll(/<([a-z]\w*)/g)].map((match) => match[1]))],
    ["form"],
  );
  assert.doesNotMatch(
    code,
    /className|\bstyle=|#[0-9a-f]{3,8}\b|rgb\(|hsl\(|\.css|<style\b|https?:/i,
  );
  assert.deepEqual(
    [
      ...new Set([...code.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1])),
    ].sort(),
    ["/", "/sign-in"],
  );
  assert.doesNotMatch(
    code,
    /attorney|lawyer|\bstaff\b|\brole=(?!"(?:alert|status)")|capabilit|eligib|jurisdiction|booking|payment|subject/i,
  );
  assert.doesNotMatch(
    source,
    /\b(?:demo|fake|mock|sample|dummy|lorem|ipsum|todo|fixme)\b|@[a-z0-9-]+\.[a-z]{2,}|WCAG|certif/i,
  );
});

test("31. the sign-in page gains one fixed, keyboard-reachable recovery link and nothing else", () => {
  const code = codeOf(read("app/sign-in/page.tsx"));
  assert.match(
    code,
    /<Button variant="primary" type="submit" disabled=\{pending\}>\n\s+Sign in\n\s+<\/Button>\n\s+<ButtonLink variant="tertiary" href="\/forgot-password">\n\s+Forgot password\?\n\s+<\/ButtonLink>\n\s+<ButtonLink variant="secondary" href="\/sign-up">/,
  );
  assert.equal(code.match(/href="\/forgot-password"/g)?.length, 1);
  assert.deepEqual(
    [...code.matchAll(/\bhref="([^"]*)"/g)].map((match) => match[1]),
    ["/forgot-password", "/sign-up", "/"],
  );
  // Sign-in itself is untouched: one form, submitted through the same action.
  assert.equal(code.match(/<form\b[^>]*>/g)?.length, 1);
  assert.match(
    code,
    /useActionState\(\n {4}signIn,\n {4}INITIAL_SIGN_IN_STATE,\n {2}\);/,
  );
  assert.doesNotMatch(code, /recovery|reset-password|requestRecovery/i);
});

test("32. recovery adds exactly two routes, no route handler, and leaves signup confirmation alone", () => {
  assert.deepEqual(filesIn("app/forgot-password/"), [
    "app/forgot-password/actions.ts",
    "app/forgot-password/page.tsx",
  ]);
  assert.deepEqual(filesIn("app/reset-password/"), [
    "app/reset-password/actions.ts",
    "app/reset-password/page.tsx",
  ]);
  assert.deepEqual(
    filesIn("app/").filter((path) => /(?:^|\/)route\.[jt]sx?$/.test(path)),
    ["app/auth/confirm/route.ts"],
  );
  // The signup confirmation handler still verifies only signup links and
  // knows nothing of recovery.
  const confirmation = codeOf(read("app/auth/confirm/route.ts"));
  assert.match(
    confirmation,
    /client\.auth\.verifyOtp\(\{\n {8}token_hash: tokenHash,\n {8}type: "email",\n {6}\}\)/,
  );
  assert.doesNotMatch(
    confirmation,
    /recovery|reset-password|forgot-password|exchangeCodeForSession|updateUser/i,
  );
  // Only the sign-in and recovery pages link to the request route, and only
  // the recovery module names the fixed recovery address.
  const sources = [...filesIn("app/"), ...filesIn("src/")].filter((file) =>
    /\.tsx?$/.test(file),
  );
  for (const file of sources) {
    const code = codeOf(read(file));
    if (/\/forgot-password\b/.test(code)) {
      assert.ok(
        ["app/sign-in/page.tsx", "app/reset-password/page.tsx"].includes(file),
        file,
      );
    }
    if (/\/reset-password\b/.test(code)) {
      assert.equal(file, "src/application/account-recovery.ts");
    }
    // Only the two recovery actions reach the recovery application module's
    // operations, and only the completion action builds a completion port.
    if (/requestAccountRecovery|recoveryRedirectFor/.test(code)) {
      assert.ok(
        [
          "app/forgot-password/actions.ts",
          "src/application/account-recovery.ts",
        ].includes(file),
        file,
      );
    }
    if (/completeAccountRecovery/.test(code)) {
      assert.ok(
        [
          "app/reset-password/actions.ts",
          "src/application/account-recovery.ts",
        ].includes(file),
        file,
      );
    }
  }
});

test("33. the application boundary is provider-neutral, holds no state, and decides no business question", () => {
  const source = read("src/application/account-recovery.ts");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), ["./form-operation.ts", "./session.ts"]);
  assert.doesNotMatch(
    code,
    /\bimport\s*\(|\brequire\s*\(|next|react|supabase|postgres|\bprocess\b|\bconsole\b|\bfetch\s*\(|cookie|header|localStorage|sessionStorage|globalThis|\bwindow\b|\bdocument\b|Math\.random|\bDate\b|\bjwt\b|access_?token|refresh_?token/i,
  );
  assert.doesNotMatch(code, /^(?:let|var) /m);
  assert.doesNotMatch(
    code,
    /attorney|\bstaff\b|\bclient\b|capabilit|permission|eligib|jurisdiction|\brole\b|profile/i,
  );
  assert.deepEqual(
    [
      ...code.matchAll(
        /^export (?:async function|function|const|type) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    [
      "RecoveryRequestProvider",
      "RecoveryRequestProviderSource",
      "RecoveryRequestState",
      "RecoverySessionRead",
      "CodeExchange",
      "PasswordUpdate",
      "RecoveryProvider",
      "RecoveryProviderSource",
      "RecoveryCompletionState",
      "RecoverySearchParams",
      "INITIAL_RECOVERY_REQUEST_STATE",
      "INITIAL_RECOVERY_COMPLETION_STATE",
      "recoveryRedirectFor",
      "recoveryCodeOf",
      "validateRecoveryRequest",
      "validateNewPassword",
      "requestAccountRecovery",
      "completeAccountRecovery",
    ],
  );
  assert.equal(code.match(/\bexport\b/g)?.length, 18);
  // Each operation asks its provider through the port only once per attempt.
  assert.equal(code.match(/provider\.requestRecoveryEmail\(/g)?.length, 1);
  assert.equal(code.match(/provider\.exchangeCode\(/g)?.length, 1);
  assert.equal(code.match(/provider\.updatePassword\(/g)?.length, 1);
});
