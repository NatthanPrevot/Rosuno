// Targeted P2-005 existing-account sign-in and sign-out tests.
//
// Tests 1 to 10 run the application orchestration against isolated in-memory
// provider stand-ins and the existing trusted claims boundary. Tests 11 on run
// it through the installed @supabase/ssr and auth-js clients over Next.js's own
// Server Action cookie store, wired exactly as the server actions wire them,
// against a synthetic in-memory identity provider. No real provider, account,
// credential, network, or database is contacted. The server actions and the
// sign-in page need the Next.js and React runtime, so their wiring is held to
// these models as source contracts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { types } from "node:util";

import { createServerClient } from "@supabase/ssr";

import * as entry from "../src/application/authentication-entry.ts";
import { getShellView } from "../src/application/shell.ts";
import { createSupabaseServerSessionSource } from "../src/infrastructure/identity/server-session-source.ts";

const {
  INITIAL_SIGN_IN_STATE,
  signInExistingAccount,
  signOutCurrentSession,
  validateSignIn,
} = entry;

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

// Synthetic, test-only values. None is a real account or credential.
const EMAIL = "member@synthetic.invalid";
const PW = "synthetic-pw-7f3a";
const SUBJECT = "synthetic-subject-p2-005";
const DETAIL = "internal 7f3a";
// Opaque session ids: the one a sign-in issues, and one already stored.
const ISSUED = "synthetic-session-issued";
const EXISTING = "synthetic-session-existing";

function form(entries) {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
}

const validForm = () =>
  form([
    ["email", EMAIL],
    ["password", PW],
  ]);

// One browser's cookie jar: the id of the provider session it stores, if
// any, and how a claims read of it goes: "ok", an "error" result, or a
// "throw".
function browser(session = null) {
  return { session, read: "ok" };
}

// The claims client the trusted boundary reads, over a jar. An errored or
// thrown read says nothing about whether a session is there.
function claimsClient(jar) {
  return {
    auth: {
      getClaims: async () => {
        if (jar.read === "throw") {
          throw new Error(DETAIL);
        }
        if (jar.read === "error") {
          return { data: null, error: new Error(DETAIL) };
        }
        return jar.session === null
          ? { data: null, error: null }
          : {
              data: { claims: { sub: SUBJECT, session_id: jar.session } },
              error: null,
            };
      },
    },
  };
}

// The session read the server actions build over a claims client.
function sessionReadOver(client) {
  return () => sessionOf(client);
}

// The trusted server session source a fresh request would build.
function freshRequestSource(jar) {
  return createSupabaseServerSessionSource(async () => claimsClient(jar));
}

// In-memory provider stand-in for one request. Like the real server client,
// it keeps its own copy of what it holds apart from the browser's jar, which
// is what the request stores for the browser. It accepts only the synthetic
// credentials, then holds and stores the issued session; sign-out drops both.
// overrides is an object, or a function given the provider's own copy. Every
// call is recorded.
function stubProvider(jar, overrides = {}) {
  const calls = { sources: 0, signIn: [], signOut: 0, stored: 0 };
  const held = browser(jar.session);
  const provider = {
    signInWithPassword: async (...args) => {
      calls.signIn.push(args);
      const [{ email, password }] = args;
      if (email !== EMAIL || password !== PW) {
        return "rejected";
      }
      held.session = ISSUED;
      jar.session = ISSUED;
      return "accepted";
    },
    signOut: async () => {
      calls.signOut += 1;
      held.session = null;
      jar.session = null;
      return true;
    },
    issuedSession: sessionReadOver(claimsClient(held)),
    storedSession: sessionReadOver(claimsClient(jar)),
    session: freshRequestSource(jar),
    ...(typeof overrides === "function" ? overrides(held) : overrides),
  };
  // Every read of the stored state is counted, whichever one the provider
  // holds.
  const check = provider.storedSession;
  provider.storedSession = (...args) => {
    calls.stored += 1;
    return check(...args);
  };
  const source = async () => {
    calls.sources += 1;
    return provider;
  };
  return { calls, provider, source };
}

function assertNothingLeaks(state) {
  const serialized = JSON.stringify(ownData(state), (_key, value) =>
    typeof value === "symbol" ? String(value) : value,
  );
  for (const value of [EMAIL, PW, SUBJECT, "7f3a", "synthetic"]) {
    assert.equal(serialized.includes(value), false, value);
  }
}

const thrownValues = [
  new Error(DETAIL),
  Object.assign(new Error("internal"), { code: DETAIL }),
  { detail: DETAIL },
  DETAIL,
  null,
  undefined,
];

// Session reads that prove nothing: a failed read, malformed answers, and
// throws.
const malformedReads = [
  async () => ({ kind: "unreadable" }),
  async () => false,
  async () => "none",
  async () => 1,
  async () => null,
  async () => undefined,
  async () => ({ absent: true }),
  async () => ({ kind: "NONE" }),
  async () => ({ kind: "none", id: ISSUED }),
  async () => ({ kind: "session" }),
  async () => ({ kind: "session", id: "" }),
  async () => ({ kind: "session", id: "  " }),
  async () => ({ kind: "session", id: 42 }),
  async () => ({
    get kind() {
      throw new Error(DETAIL);
    },
  }),
  ...thrownValues.map((thrown) => async () => {
    throw thrown;
  }),
];

test("1. verified provider acceptance signs in, and a fresh trusted read is authenticated", async () => {
  const jar = browser();
  assertExactly(await getShellView(freshRequestSource(jar)), {
    session: "anonymous",
  });
  const { calls, source } = stubProvider(jar);
  const state = await signInExistingAccount(
    source,
    form([
      ["email", `  ${EMAIL}  `],
      ["password", PW],
    ]),
  );
  assertExactly(state, { status: "signed-in" });
  assertNothingLeaks(state);
  // The provider is asked once, with the trimmed email and the password
  // exactly as typed, and nothing else.
  assert.equal(calls.sources, 1);
  assert.equal(calls.signIn.length, 1);
  assert.equal(calls.signIn[0].length, 1);
  assertExactly(calls.signIn[0][0], { email: EMAIL, password: PW });
  assert.equal(calls.signOut, 0);
  // The session lives in the browser's jar. A fresh request reads it through
  // the trusted boundary, and presentation learns only that it is
  // authenticated: never the subject, and never a role or capability.
  const view = await getShellView(freshRequestSource(jar));
  assertExactly(view, { session: "authenticated" });
  assert.equal(JSON.stringify(view).includes(SUBJECT), false);
  // Another browser is untouched.
  assertExactly(await getShellView(freshRequestSource(browser())), {
    session: "anonymous",
  });
  // A password is never trimmed or otherwise changed.
  const spaced = stubProvider(browser());
  await signInExistingAccount(
    spaced.source,
    form([
      ["email", EMAIL],
      ["password", ` ${PW} `],
    ]),
  );
  assertExactly(spaced.calls.signIn[0][0], {
    email: EMAIL,
    password: ` ${PW} `,
  });
});

test("2. only email and password are read; caller-supplied destination or identity is ignored", async () => {
  const jar = browser();
  const { calls, source } = stubProvider(jar);
  const state = await signInExistingAccount(
    source,
    form([
      ["next", "https://elsewhere.invalid/"],
      ["returnTo", "//elsewhere.invalid"],
      ["redirect", "/elsewhere"],
      ["role", "staff"],
      ["capability", "all"],
      ["subject", "client-claimed-subject"],
      ["user_id", "client-claimed-id"],
      ["email", EMAIL],
      ["email", "second@synthetic.invalid"],
      ["password", PW],
      ["password", "second-password"],
    ]),
  );
  // The result is a fixed code: it carries no destination, identity, role,
  // or anything else the caller sent.
  assertExactly(state, { status: "signed-in" });
  assert.deepEqual(Reflect.ownKeys(state), ["status"]);
  assertExactly(calls.signIn[0][0], { email: EMAIL, password: PW });
  // The previous state is not an input: the operation takes only the request's
  // provider source and the submission.
  assert.equal(signInExistingAccount.length, 2);
  assert.equal(signOutCurrentSession.length, 1);
});

test("3. missing or malformed input is refused before the provider is asked", async () => {
  const bothMissing = {
    email: ["Enter your email address."],
    password: ["Enter your password."],
  };
  const cases = [
    [new FormData(), bothMissing],
    [form([["email", "   "]]), bothMissing],
    [
      form([
        ["email", EMAIL],
        ["password", ""],
      ]),
      { password: ["Enter your password."] },
    ],
    [form([["password", PW]]), { email: ["Enter your email address."] }],
    ...[
      "no-at-sign",
      "member@",
      "@synthetic.invalid",
      "two words@synthetic.invalid",
      "member@@synthetic.invalid",
      `${"m".repeat(245)}@synthetic.invalid`,
    ].map((email) => [
      form([
        ["email", email],
        ["password", PW],
      ]),
      { email: ["Enter a valid email address."] },
    ]),
    [
      form([
        ["email", EMAIL],
        ["password", "p".repeat(1025)],
      ]),
      { password: ["Enter a valid password."] },
    ],
    // A file is not a password.
    [
      form([
        ["email", EMAIL],
        ["password", new Blob([PW])],
      ]),
      { password: ["Enter your password."] },
    ],
    // Anything other than form data is an empty submission.
    ...[
      null,
      undefined,
      `email=${EMAIL}&password=${PW}`,
      { email: EMAIL, password: PW },
      new Map([
        ["email", EMAIL],
        ["password", PW],
      ]),
      [
        ["email", EMAIL],
        ["password", PW],
      ],
    ].map((payload) => [payload, bothMissing]),
  ];
  for (const [payload, fieldErrors] of cases) {
    const { calls, source } = stubProvider(browser());
    const state = await signInExistingAccount(source, payload);
    assertExactly(state, { status: "invalid", fieldErrors });
    assertNothingLeaks(state);
    assert.equal(calls.sources, 0);
  }
  // The bounds only refuse malformed submissions; they set no password rule.
  for (const password of ["p", " ", "p".repeat(1024)]) {
    const validation = validateSignIn(
      new Map([
        ["email", EMAIL],
        ["password", password],
      ]),
    );
    assert.equal(validation.ok, true);
    assertExactly(validation.value, { email: EMAIL, password });
  }
  assert.equal(
    validateSignIn(
      new Map([
        ["email", `${"m".repeat(235)}@synthetic.invalid`],
        ["password", PW],
      ]),
    ).ok,
    true,
  );
});

test("4. rejected credentials and an unavailable provider fail without detail or side effects", async () => {
  // Rejection starts no session and leaves any existing one alone.
  for (const existing of [null, "synthetic-existing-session"]) {
    const jar = browser(existing);
    const { calls, source } = stubProvider(jar);
    const state = await signInExistingAccount(
      source,
      form([
        ["email", EMAIL],
        ["password", "not-the-synthetic-password"],
      ]),
    );
    assertExactly(state, { status: "rejected" });
    assertNothingLeaks(state);
    assert.equal(calls.signOut, 0);
    assert.equal(jar.session, existing);
  }
  // A provider that reports it could not answer.
  const jar = browser();
  const unavailable = stubProvider(jar, {
    signInWithPassword: async () => "unavailable",
  });
  assertExactly(await signInExistingAccount(unavailable.source, validForm()), {
    status: "unavailable",
  });
  assert.equal(unavailable.calls.signOut, 0);
  // An unconfigured provider, a failing provider factory, or anything that is
  // not a provider is unavailable.
  const factories = [
    async () => null,
    async () => undefined,
    async () => 42,
    async () => DETAIL,
    ...thrownValues.map((thrown) => async () => {
      throw thrown;
    }),
    () => {
      throw new Error(DETAIL);
    },
  ];
  for (const factory of factories) {
    const state = await signInExistingAccount(factory, validForm());
    assertExactly(state, { status: "unavailable" });
    assertNothingLeaks(state);
  }
});

test("5. thrown, unexpected, or unverified provider results fail closed and clear the partial session", async () => {
  // The provider throws after it may have started a session.
  for (const thrown of thrownValues) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, {
      signInWithPassword: async () => {
        jar.session = ISSUED;
        throw thrown;
      },
    });
    const state = await signInExistingAccount(source, validForm());
    assertExactly(state, { status: "unavailable" });
    assertNothingLeaks(state);
    assert.equal(calls.signOut, 1);
    assert.equal(jar.session, null);
  }
  // Only the exact "accepted", "rejected", or "unavailable" answers count.
  for (const outcome of [
    "ACCEPTED",
    "accepted ",
    "yes",
    true,
    1,
    { status: "accepted" },
    ["accepted"],
    null,
    undefined,
  ]) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, {
      signInWithPassword: async () => {
        jar.session = ISSUED;
        return outcome;
      },
    });
    assertExactly(await signInExistingAccount(source, validForm()), {
      status: "unavailable",
    });
    assert.equal(calls.signOut, 1);
    assert.equal(jar.session, null);
  }
  // The provider reports acceptance, holds the issued session, and stores it,
  // but the trusted claims boundary does not verify an authenticated request:
  // missing, errored, blank, or throwing claims, or no client at all.
  const unverified = [
    async () => ({
      auth: { getClaims: async () => ({ data: null, error: null }) },
    }),
    async () => ({
      auth: {
        getClaims: async () => ({
          data: { claims: { sub: SUBJECT } },
          error: new Error(DETAIL),
        }),
      },
    }),
    async () => ({
      auth: {
        getClaims: async () => ({
          data: { claims: { sub: " " } },
          error: null,
        }),
      },
    }),
    async () => ({
      auth: {
        getClaims: async () => {
          throw new Error(DETAIL);
        },
      },
    }),
    async () => null,
  ];
  for (const clientSource of unverified) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, {
      session: createSupabaseServerSessionSource(clientSource),
    });
    const state = await signInExistingAccount(source, validForm());
    assertExactly(state, { status: "unavailable" });
    assertNothingLeaks(state);
    assert.equal(calls.signIn.length, 1);
    assert.equal(calls.signOut, 1);
    assert.equal(jar.session, null);
  }
  // A session port that breaks its contract is not verification either. It
  // cannot confirm that the partial session is gone, so the failure says the
  // browser may still be signed in.
  for (const session of [
    { currentSubject: async () => 42 },
    {
      currentSubject: async () => {
        throw new Error(DETAIL);
      },
    },
    { status: "authenticated", subject: SUBJECT },
    null,
  ]) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, { session });
    assertExactly(await signInExistingAccount(source, validForm()), {
      status: "uncertain",
    });
    assert.equal(calls.signOut, 1);
  }
  // When clearing the partial session also fails, the result is never
  // success, and never the plain failure that implies nothing remains.
  for (const signOut of [
    async () => false,
    async () => {
      throw new Error(DETAIL);
    },
  ]) {
    const { source } = stubProvider(browser(), {
      session: createSupabaseServerSessionSource(async () => null),
      signOut,
    });
    const state = await signInExistingAccount(source, validForm());
    assertExactly(state, { status: "uncertain" });
    assertNothingLeaks(state);
  }
});

test("5a. a failed sign-in is plain unavailability only when the partial session is confirmed gone", async () => {
  // Two ways an attempt can leave a session behind: the provider throws
  // after starting one, or reports acceptance the trusted boundary does not
  // verify (here, a claims boundary with no client). The second reads the
  // stored state once more, to verify the sign-in, before cleanup.
  const attempts = [
    {
      verifying: 0,
      overrides: (jar) => ({
        signInWithPassword: async () => {
          jar.session = ISSUED;
          throw new Error(DETAIL);
        },
      }),
    },
    {
      verifying: 1,
      overrides: (jar, held) => ({
        signInWithPassword: async () => {
          held.session = ISSUED;
          jar.session = ISSUED;
          return "accepted";
        },
        session: createSupabaseServerSessionSource(async () => null),
      }),
    },
  ];
  for (const { verifying, overrides } of attempts) {
    const attempt = (jar) => (held) => overrides(jar, held);
    // Cleanup succeeds and a successful read finds no session.
    const cleared = browser();
    const ok = stubProvider(cleared, attempt(cleared));
    assertExactly(await signInExistingAccount(ok.source, validForm()), {
      status: "unavailable",
    });
    assert.equal(ok.calls.signOut, 1);
    assert.equal(ok.calls.stored, verifying + 1);
    assert.equal(cleared.session, null);

    // Cleanup fails: the provider does not confirm, or throws. The session
    // it started remains, and no absence is claimed.
    for (const signOut of [
      async () => false,
      async () => "true",
      async () => 1,
      async () => undefined,
      async () => ({ error: null }),
      ...thrownValues.map((thrown) => async () => {
        throw thrown;
      }),
    ]) {
      const jar = browser();
      let cleanups = 0;
      const failed = stubProvider(jar, (held) => ({
        ...attempt(jar)(held),
        signOut: async () => {
          cleanups += 1;
          return signOut();
        },
      }));
      const state = await signInExistingAccount(failed.source, validForm());
      assertExactly(state, { status: "uncertain" });
      assertNothingLeaks(state);
      assert.equal(cleanups, 1);
      assert.equal(failed.calls.stored, verifying);
      assert.equal(jar.session, ISSUED);
      assertExactly(await getShellView(freshRequestSource(jar)), {
        session: "authenticated",
      });
    }

    // The provider reports cleanup, but the session cookie is still there.
    const residual = browser();
    const stale = stubProvider(residual, (held) => ({
      ...attempt(residual)(held),
      signOut: async () => true,
    }));
    assertExactly(await signInExistingAccount(stale.source, validForm()), {
      status: "uncertain",
    });
    assert.equal(stale.calls.stored, verifying + 1);
    assertExactly(await getShellView(freshRequestSource(residual)), {
      session: "authenticated",
    });

    // The provider reports cleanup, but the read that would confirm it fails.
    // The trusted boundary reads such a failure as no identity, which denies
    // access but proves nothing, so it is never taken as cleanup.
    for (const read of ["error", "throw"]) {
      for (const clears of [true, false]) {
        const jar = browser();
        const unread = stubProvider(jar, (held) => ({
          ...attempt(jar)(held),
          signOut: async () => {
            if (clears) {
              jar.session = null;
            }
            jar.read = read;
            return true;
          },
        }));
        const state = await signInExistingAccount(unread.source, validForm());
        assertExactly(state, { status: "uncertain" });
        assertNothingLeaks(state);
        assert.equal(unread.calls.stored, verifying + 1);
        assertExactly(await getShellView(freshRequestSource(jar)), {
          session: "anonymous",
        });
      }
    }

    // A stored-state read that answers anything but a well-formed "none", or
    // throws, is not a confirmation, even when the session is in fact gone.
    for (const storedSession of [...malformedReads, undefined]) {
      const jar = browser();
      const unconfirmed = stubProvider(jar, (held) => ({
        ...attempt(jar)(held),
        storedSession,
      }));
      const state = await signInExistingAccount(
        unconfirmed.source,
        validForm(),
      );
      assertExactly(state, { status: "uncertain" });
      assertNothingLeaks(state);
      assert.equal(jar.session, null);
    }
  }
  // The stored-state read finds no session, but the trusted boundary still
  // reads an authenticated request: the two disagree, so nothing is
  // confirmed.
  const disagreeing = browser();
  const split = stubProvider(disagreeing, {
    ...attempts[0].overrides(disagreeing),
    storedSession: async () => ({ kind: "none" }),
    signOut: async () => true,
  });
  assertExactly(await signInExistingAccount(split.source, validForm()), {
    status: "uncertain",
  });
  assert.equal(split.calls.stored, 1);
  assertExactly(await getShellView(freshRequestSource(disagreeing)), {
    session: "authenticated",
  });
  // Rejection and a provider that could not answer started no session, so
  // they need no cleanup and stay plain failures.
  for (const outcome of ["rejected", "unavailable"]) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, {
      signInWithPassword: async () => outcome,
    });
    assertExactly(await signInExistingAccount(source, validForm()), {
      status: outcome,
    });
    assert.equal(calls.signOut, 0);
    assert.equal(calls.stored, 0);
  }
});

test("6. sign-out succeeds only when the provider confirms and a fresh trusted read is anonymous", async () => {
  const jar = browser(EXISTING);
  const { calls, source } = stubProvider(jar);
  assertExactly(await getShellView(freshRequestSource(jar)), {
    session: "authenticated",
  });
  // The same account is also signed in from another browser.
  const elsewhere = browser("synthetic-session-elsewhere");
  const state = await signOutCurrentSession(source);
  assertExactly(state, { status: "signed-out" });
  assert.equal(calls.signOut, 1);
  assert.equal(calls.stored, 1);
  assertExactly(await getShellView(freshRequestSource(jar)), {
    session: "anonymous",
  });
  // Only this browser's session ends; the other is left as it is.
  assertExactly(await getShellView(freshRequestSource(elsewhere)), {
    session: "authenticated",
  });
  // The provider does not confirm, or throws.
  for (const signOut of [
    async () => false,
    async () => "true",
    async () => 1,
    async () => undefined,
    async () => ({ error: null }),
    ...thrownValues.map((thrown) => async () => {
      throw thrown;
    }),
  ]) {
    const failing = stubProvider(browser(EXISTING), { signOut });
    const result = await signOutCurrentSession(failing.source);
    assertExactly(result, { status: "failed" });
    assertNothingLeaks(result);
  }
  // The provider claims success, but a fresh read is still authenticated, or
  // cannot be read at all.
  const lingering = browser(EXISTING);
  const claimed = stubProvider(lingering, { signOut: async () => true });
  assertExactly(await signOutCurrentSession(claimed.source), {
    status: "failed",
  });
  assert.equal(lingering.session, EXISTING);
  for (const session of [
    { currentSubject: async () => 42 },
    {
      currentSubject: async () => {
        throw new Error(DETAIL);
      },
    },
    null,
  ]) {
    const unreadable = stubProvider(browser(EXISTING), { session });
    assertExactly(await signOutCurrentSession(unreadable.source), {
      status: "failed",
    });
  }
  // The provider claims success, but the read that would confirm it errors
  // or throws, whether or not the session is in fact gone. The trusted
  // boundary reads that failure as no identity, which denies access but is
  // not proof of sign-out, so sign-out is never reported.
  for (const read of ["error", "throw"]) {
    for (const clears of [true, false]) {
      const unread = browser(EXISTING);
      const failedRead = stubProvider(unread, {
        signOut: async () => {
          if (clears) {
            unread.session = null;
          }
          unread.read = read;
          return true;
        },
      });
      const result = await signOutCurrentSession(failedRead.source);
      assertExactly(result, { status: "failed" });
      assertNothingLeaks(result);
      assert.equal(failedRead.calls.stored, 1);
      assertExactly(await getShellView(freshRequestSource(unread)), {
        session: "anonymous",
      });
      // Once the read works again, a session left behind is still there.
      unread.read = "ok";
      assertExactly(await getShellView(freshRequestSource(unread)), {
        session: clears ? "anonymous" : "authenticated",
      });
    }
  }
  // A stored-state read that answers anything but a well-formed "none", or
  // throws, is not a confirmation, even when the session is in fact gone.
  for (const storedSession of [...malformedReads, undefined]) {
    const jar = browser(EXISTING);
    const unconfirmed = stubProvider(jar, { storedSession });
    const result = await signOutCurrentSession(unconfirmed.source);
    assertExactly(result, { status: "failed" });
    assertNothingLeaks(result);
    assert.equal(jar.session, null);
  }
  // The stored-state read finds no session, but the trusted boundary still
  // reads an authenticated request: the two disagree, so sign-out is not
  // confirmed.
  const split = stubProvider(browser(EXISTING), {
    signOut: async () => true,
    storedSession: async () => ({ kind: "none" }),
  });
  assertExactly(await signOutCurrentSession(split.source), {
    status: "failed",
  });
  // A provider that does not confirm sign-out is not asked to verify it.
  const refused = stubProvider(browser(EXISTING), {
    signOut: async () => false,
  });
  assertExactly(await signOutCurrentSession(refused.source), {
    status: "failed",
  });
  assert.equal(refused.calls.stored, 0);
  // No configured provider, or a failing factory, cannot sign anyone out.
  for (const factory of [
    async () => null,
    async () => {
      throw new Error(DETAIL);
    },
  ]) {
    assertExactly(await signOutCurrentSession(factory), { status: "failed" });
  }
});

test("7. each request is handled on its own and no state is shared", async () => {
  assertExactly(INITIAL_SIGN_IN_STATE, { status: "idle" });
  // Concurrent submissions from different browsers each get their own
  // provider and their own outcome.
  const first = browser();
  const second = browser();
  const third = browser();
  const [accepted, rejected, invalid] = await Promise.all([
    signInExistingAccount(stubProvider(first).source, validForm()),
    signInExistingAccount(
      stubProvider(second).source,
      form([
        ["email", EMAIL],
        ["password", "not-the-synthetic-password"],
      ]),
    ),
    signInExistingAccount(stubProvider(third).source, new FormData()),
  ]);
  assertExactly(accepted, { status: "signed-in" });
  assertExactly(rejected, { status: "rejected" });
  assert.equal(invalid.status, "invalid");
  assert.equal(first.session, ISSUED);
  assert.equal(second.session, null);
  assert.equal(third.session, null);
  // Every request asks its source afresh: nothing is cached between calls.
  const shared = stubProvider(browser());
  await signInExistingAccount(shared.source, validForm());
  await signInExistingAccount(shared.source, validForm());
  await signOutCurrentSession(shared.source);
  assert.equal(shared.calls.sources, 3);
  // The module exports only its operations, validation, and initial state.
  assert.deepEqual(Object.keys(entry).sort(), [
    "INITIAL_SIGN_IN_STATE",
    "signInExistingAccount",
    "signOutCurrentSession",
    "validateSignIn",
  ]);
});

test("8. the application boundary is provider-neutral and holds no credential", () => {
  const file = "src/application/authentication-entry.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), ["./form-operation.ts", "./session.ts"]);
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  assert.doesNotMatch(
    code,
    /\bimport\s*\(|\brequire\s*\(|next|react|supabase|postgres|database|\bprocess\b|\bconsole\b|\bfetch\s*\(|cookie|header|localStorage|sessionStorage|indexedDB|globalThis|\bwindow\b|\bdocument\b|import\.meta|Math\.random|\bDate\b|access_?token|refresh_?token|\bjwt\b/i,
  );
  // No business, role, or capability decision is made here.
  assert.doesNotMatch(
    code,
    /attorney|lawyer|\bstaff\b|\bclient\b|\brole\b|capabilit|permission|profile|eligib|jurisdiction|booking|payment|\badmin\b/i,
  );
  // Module-level values are frozen fixed states and input bounds; nothing
  // module-level can hold a credential or a session between requests.
  assert.doesNotMatch(code, /^(?:let|var) /m);
  assert.deepEqual(
    [...code.matchAll(/^(?:export )?const (\w+)/gm)].map((match) => match[1]),
    [
      "INITIAL_SIGN_IN_STATE",
      "REJECTED",
      "UNAVAILABLE",
      "UNCERTAIN",
      "SIGNED_IN",
      "SIGNED_OUT",
      "SIGN_OUT_FAILED",
      "EMAIL_MAX_LENGTH",
      "PASSWORD_MAX_LENGTH",
      "EMAIL_SHAPE",
    ],
  );
  // The fixed result codes are the only states it reports.
  assert.deepEqual(
    [...new Set([...code.matchAll(/status: "([a-z-]+)"/g)].map((m) => m[1]))],
    [
      "idle",
      "invalid",
      "rejected",
      "unavailable",
      "uncertain",
      "signed-in",
      "signed-out",
      "failed",
    ],
  );
  // Partial-session cleanup reports three outcomes, and only a confirmed
  // clear becomes the plain unavailable result.
  assert.match(
    code,
    /type CleanupOutcome = "cleared" \| "failed" \| "unverified";/,
  );
  assert.match(
    code,
    /return \(await discardSession\(provider\)\) === "cleared"\n {4}\? UNAVAILABLE\n {4}: UNCERTAIN;/,
  );
  assert.equal(code.match(/\bUNAVAILABLE\b/g)?.length, 4);
  // Absence is confirmed only by a well-formed "none" from a fresh read of
  // the stored state and an anonymous trusted read together. A sign-in is
  // confirmed only when that fresh read holds the very session the provider
  // issued and the trusted read is authenticated. The provider's own copy is
  // read only to name the session it issued, never as proof of storage.
  assert.match(
    code,
    /return \(\n {4}\(await sessionIdOf\(\(\) => provider\.storedSession\(\)\)\) === null &&\n {4}\(await isAuthenticated\(provider\)\) === false\n {2}\);/,
  );
  assert.match(
    code,
    /const issued = await sessionIdOf\(\(\) => provider\.issuedSession\(\)\);\n {2}if \(typeof issued !== "string"\) \{\n {4}return false;\n {2}\}\n {2}return \(\n {4}\(await sessionIdOf\(\(\) => provider\.storedSession\(\)\)\) === issued &&\n {4}\(await isAuthenticated\(provider\)\) === true\n {2}\);/,
  );
  assert.equal(code.match(/provider\.issuedSession\(\)/g)?.length, 1);
  assert.equal(code.match(/provider\.storedSession\(\)/g)?.length, 2);
  assert.match(
    code,
    /if \(outcome === "accepted" && \(await isConfirmedSignIn\(provider\)\)\) \{\n {4}return SIGNED_IN;/,
  );
  assert.equal(code.match(/\bSIGNED_IN\b/g)?.length, 2);
});

test("9. the server actions are POST-only, fixed-destination, and request-scoped", () => {
  const file = "app/sign-in/actions.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.match(source, /^"use server";\n/);
  assert.deepEqual(importsOf(source), [
    "next/cache",
    "next/navigation",
    "../../src/application/authentication-entry.ts",
    "../../src/infrastructure/identity/server-session-source.ts",
    "../../src/infrastructure/identity/supabase-server.ts",
  ]);
  // Exactly two actions, and nothing else, are exported.
  assert.deepEqual(
    [...code.matchAll(/\bexport\b[^\n]*/g)].map((match) => match[0]),
    [
      "export async function signIn(",
      "export async function signOut(): Promise<void> {",
    ],
  );
  // The only destination is the fixed home page, and only after success.
  assert.deepEqual(
    [...code.matchAll(/\b(?:permanentRedirect|redirect)\([^)]*\)/g)].map(
      (match) => match[0],
    ),
    ['redirect("/")', 'redirect("/")'],
  );
  assert.equal(code.match(/revalidatePath\("\/"\);/g)?.length, 2);
  assert.match(
    code,
    /if \(state\.status === "signed-in"\) \{\n {4}revalidatePath\("\/"\);\n {4}redirect\("\/"\);\n {2}\}\n {2}return state;/,
  );
  assert.match(
    code,
    /if \(state\.status !== "signed-out"\) \{\n {4}throw new Error\("Sign-out could not be completed\."\);\n {2}\}\n {2}revalidatePath\("\/"\);\n {2}redirect\("\/"\);/,
  );
  // Nothing the caller sends picks a destination or an identity, and the
  // browser's previous state is never read.
  assert.doesNotMatch(
    code,
    /searchParams|returnTo|callbackUrl|\bnext\b(?!\/)|\bheaders\s*\(|\bcookies\s*\(|formData\.get|\brole\b|capabilit|claims\.sub|\bsubject\b/,
  );
  assert.equal(code.match(/\b_previous\b/g)?.length, 1);
  // The provider is asked for a password sign-in with exactly the email and
  // password and a local sign-out of this session only, over one
  // request-scoped client.
  assert.match(
    code,
    /client\.auth\.signInWithPassword\(\{\n {8}email,\n {8}password,\n {6}\}\)/,
  );
  assert.equal(code.match(/\.signInWithPassword\(/g)?.length, 1);
  assert.match(code, /client\.auth\.signOut\(\{ scope: "local" \}\)/);
  assert.equal(code.match(/\.signOut\(/g)?.length, 1);
  // That client is read only to name the session it issued. The stored state
  // is read through a freshly initialized client, and the trusted boundary
  // through a fresh client on every read, so no verification sees the
  // changing client's own memory. Tests 11 on run this exact wiring.
  assert.match(code, /\n {4}issuedSession: \(\) => sessionOf\(client\),\n/);
  assert.match(
    code,
    /\n {4}storedSession: async \(\) => sessionOf\(await createSupabaseServerClient\(\)\),\n/,
  );
  assert.match(code, /\n {4}session: SUPABASE_SERVER_SESSION_SOURCE,\n/);
  assert.equal(code.match(/createSupabaseServerClient\(\)/g)?.length, 2);
  assert.equal(code.match(/\bsessionOf\(client\)/g)?.length, 1);
  assert.doesNotMatch(code, /createSupabaseServerSessionSource/);
  // One verified claims read reduces a client's session to its opaque id,
  // and only a successful read that finds nothing is "none". An errored read
  // never counts. Without its type annotations it is the sessionOf these
  // tests run.
  const sessionRead = sessionOf
    .toString()
    .replace("sessionOf(client)", "sessionOf(client: ServerClient)")
    .replace(") {", "): Promise<SessionRead> {")
    .replace("const id =", "const id: unknown =");
  assert.equal(code.split(sessionRead).length, 2);
  assert.equal(code.match(/\.getClaims\(/g)?.length, 1);
  // Provider detail is never returned, logged, or trusted beyond its status
  // and its opaque session id.
  assert.doesNotMatch(
    code.replace(sessionRead, " "),
    /\bconsole\b|\bprocess\b|getSession|getUser|access_?token|refresh_?token|error\.message|\bdata\b|\.session\b(?!:)|session_id/,
  );
  // GET cannot sign out. The only route handler is the P2-006 email
  // confirmation handler, admitted by its exact path and nothing broader, and
  // the sign-out form is a POST server action on the home page.
  assert.deepEqual(
    filesIn("app/").filter((path) => /(?:^|\/)route\.[jt]sx?$/.test(path)),
    ["app/auth/confirm/route.ts"],
  );
  // That handler has no sign-out capability: it takes nothing from the
  // sign-in actions and never ends a session. Its GET renders only: no token
  // verification or consumption, provider client, cookie, or provisioning.
  const confirmation = codeOf(read("app/auth/confirm/route.ts"));
  assert.doesNotMatch(
    confirmation,
    /sign-in\/actions|signOut|sign-?out|\.auth\.signOut\b/i,
  );
  assert.deepEqual(
    [...confirmation.matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (match) => match[1],
    ),
    ["GET", "POST"],
  );
  const confirmationGet = confirmation.slice(
    confirmation.indexOf("export function GET("),
    confirmation.indexOf("export async function POST("),
  );
  assert.ok(
    confirmationGet.startsWith("export function GET(request: Request)"),
  );
  assert.doesNotMatch(
    confirmationGet,
    /verifyOtp|verifyEmailToken|confirmRegistrationEmail|resumeRegistration|CONFIRMATION_SOURCES|requestConfirmationProvider|createSupabaseServerClient|createRegistrationProvisioning|cookies|await\b|\bimport\s*\(/,
  );
  // The existing sign-out stays a POST server action, reached only through
  // the home page's one form.
  assert.match(source, /^"use server";\n/);
  assert.match(code, /export async function signOut\(\): Promise<void> \{/);
  assert.deepEqual(filesIn("app/sign-in/"), [
    "app/sign-in/actions.ts",
    "app/sign-in/page.tsx",
  ]);
  const home = read("app/page.tsx");
  assert.equal(home.match(/<form\b[^>]*>/g)?.length, 1);
  assert.match(home, /<form action=\{signOut\}>/);
  assert.doesNotMatch(home, /\bmethod=|href="[^"]*sign-?out/i);
  // The home page reads session state only through the trusted source.
  assert.match(
    home,
    /const view = await getShellView\(SUPABASE_SERVER_SESSION_SOURCE\);/,
  );
});

test("10. the sign-in page is an accessible design-system form that shows only fixed messages", () => {
  const file = "app/sign-in/page.tsx";
  const source = read(file);
  const code = codeOf(source);
  assert.match(source, /^"use client";\n/);
  assert.deepEqual(importsOf(source), [
    "react",
    "../../src/application/authentication-entry.ts",
    "../../src/application/form-operation.ts",
    "../../src/presentation/design-system.tsx",
    "./actions.ts",
  ]);
  assert.match(
    code,
    /useActionState\(\n {4}signIn,\n {4}INITIAL_SIGN_IN_STATE,\n {2}\);/,
  );
  // One semantic form submitted through the server action: no GET method, no
  // client-side handler, and no client-held identity.
  assert.equal(code.match(/<form\b[^>]*>/g)?.length, 1);
  assert.match(code, /<form action=\{formAction\}>/);
  assert.doesNotMatch(
    code,
    /\bmethod=|\bonSubmit\b|\bon[A-Z]\w*=|\bfetch\s*\(|localStorage|sessionStorage|document\.cookie|indexedDB|useEffect|\bdefaultValue\b|\bvalue=|dangerouslySetInnerHTML/,
  );
  // Labelled email and password controls with matching input types,
  // autocomplete tokens, and native required validation.
  assert.match(
    code,
    /<TextField\n\s+id="sign-in-email"\n\s+name="email"\n\s+label="Email address"\n\s+type="email"\n\s+autoComplete="email"\n\s+autoCapitalize="none"\n\s+spellCheck=\{false\}\n\s+required\n\s+errors=\{fieldErrors\.email\}\n\s+\/>/,
  );
  assert.match(
    code,
    /<TextField\n\s+id="sign-in-password"\n\s+name="password"\n\s+label="Password"\n\s+type="password"\n\s+autoComplete="current-password"\n\s+required\n\s+errors=\{fieldErrors\.password\}\n\s+\/>/,
  );
  assert.match(
    code,
    /<Button variant="primary" type="submit" disabled=\{pending\}>\n\s+Sign in\n\s+<\/Button>/,
  );
  // State is read only to choose a fixed message or to present the fixed
  // field messages from validation.
  assert.deepEqual(
    [...new Set([...code.matchAll(/\bstate\.\w+/g)].map((match) => match[0]))],
    ["state.status", "state.fieldErrors"],
  );
  for (const status of ["rejected", "unavailable", "invalid"]) {
    assert.match(
      code,
      new RegExp(
        `\\{state\\.status === "${status}" \\? \\(\\n\\s+<Alert tone="error" title="[^"]+" role="alert">`,
      ),
      status,
    );
  }
  // A failure that may have left this browser signed in says so, and points
  // to the home page, where the session shows and sign-out is offered.
  assert.ok(
    code
      .replace(/\s+/g, " ")
      .includes(
        '{state.status === "uncertain" ? ( <Alert tone="warning" title="Sign-in could not be confirmed" role="alert" > Sign-in did not complete, and this browser may still be signed in. Return to the home page to check, and sign out there if it shows you as signed in. </Alert> ) : null}',
      ),
  );
  assert.equal(code.match(/<Alert\b/g)?.length, 4);
  // Every component comes from the design system: no class, inline style,
  // color, or stylesheet of its own. Its only native element is the form.
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
    [...code.matchAll(/\bdensity="([^"]+)"/g)].map((match) => match[1]),
    ["public"],
  );
  // The copy holds no record, placeholder, or certification claim.
  assert.doesNotMatch(
    source,
    /\b(?:demo|fake|mock|sample|dummy|lorem|ipsum|todo|fixme)\b|@[a-z0-9-]+\.[a-z]{2,}|WCAG|certif/i,
  );
  assert.doesNotMatch(
    code,
    /attorney|lawyer|\bstaff\b|\brole=(?!"alert")|capabilit|eligib|jurisdiction|booking|payment|subject/i,
  );
});

// ---------------------------------------------------------------------------
// Realistic request model for tests 11 on.
//
// The defects these tests guard against live in how the installed libraries
// behave, so the model runs them instead of imitating them:
// - @supabase/ssr's createServerClient with auth-js. Its server storage
//   answers from its own memory ahead of the request's cookies, and hands
//   every cookie write to setAll, whose failures the adapter swallows.
// - Next.js's own Server Action cookie store. A write changes the store's
//   state first and publishes it to the outgoing response afterwards, so
//   publishing can fail after a fresh read already sees the change.
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
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000a11c";
const SIGNINGS = ["asymmetric", "symmetric"];
let providerCount = 0;

function encoded(value) {
  return Buffer.from(value).toString("base64url");
}

// A synthetic identity provider for one test. It knows the one synthetic
// account, issues a new opaque session id for every accepted password grant,
// and ends a session on logout. Access tokens are signed either with an
// asymmetric key it publishes, which getClaims verifies locally, so a token
// keeps verifying after logout until it expires; or with a symmetric key,
// which getClaims checks by asking the provider, which refuses ended
// sessions. Each instance has its own origin, so the clients' process-wide
// key cache never mixes instances. Routes in outage answer 500; routes in
// unreachable fail at the transport.
async function identityProvider({ signing = "asymmetric", metadata = 0 } = {}) {
  providerCount += 1;
  const origin = `http://p2005-${providerCount}.synthetic.invalid`;
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
  const user = {
    id: ACCOUNT_ID,
    aud: "authenticated",
    role: "authenticated",
    email: EMAIL,
    app_metadata: {},
    user_metadata: metadata > 0 ? { note: "m".repeat(metadata) } : {},
    created_at: "2026-01-01T00:00:00Z",
  };
  const provider = {
    origin,
    issued: [],
    active: new Set(),
    outage: new Set(),
    unreachable: new Set(),
  };
  const reply = (status, body) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  // The session id inside the access token a request presents.
  const presentedSession = (init) => {
    const bearer = new Headers(init.headers).get("authorization") ?? "";
    const payload = bearer.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString() || "{}")
      .session_id;
  };
  async function grant() {
    const id = `synthetic-session-${providerCount}-${provider.issued.length + 1}`;
    provider.issued.push(id);
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
        sub: ACCOUNT_ID,
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
    const signed = `${head}.${body}.${signature}`;
    const refresh = `synthetic-refresh-${id}`;
    return {
      access_token: signed,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: refresh,
      user,
    };
  }
  provider.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const route = url.pathname.replace(/^\/auth\/v1/, "");
    if (provider.unreachable.has(route)) {
      throw new TypeError("fetch failed");
    }
    if (provider.outage.has(route)) {
      return reply(500, { error_code: "unexpected_failure", msg: "outage" });
    }
    if (route === "/token") {
      const submitted = JSON.parse(init.body);
      return submitted.email === EMAIL && submitted.password === PW
        ? reply(200, await grant())
        : reply(400, { error_code: "invalid_credentials", msg: "refused" });
    }
    if (route === "/.well-known/jwks.json") {
      return reply(200, { keys: [published] });
    }
    if (route === "/user") {
      return provider.active.has(presentedSession(init))
        ? reply(200, user)
        : reply(403, { error_code: "session_not_found", msg: "ended" });
    }
    if (route === "/logout") {
      provider.active.delete(presentedSession(init));
      return reply(204);
    }
    throw new Error(`unexpected provider request: ${route}`);
  };
  return provider;
}

// Cookie writes a request's store refuses: every write, only removals, or
// only the writes to one cookie chunk.
const EVERY_WRITE = () => true;
const REMOVALS = (_name, value) => value === "";
const chunkWrites = (suffix) => (name) => name.endsWith(suffix);

// A browser: the Cookie header it sends.
function userAgent() {
  return { cookie: "" };
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
// request's cookie store (test 21 holds the two to the same cookie methods).
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

// The session read the server actions run (test 9 holds actions.ts to it).
async function sessionOf(client) {
  if (client === null) {
    return { kind: "unreadable" };
  }
  const read = await client.auth.getClaims();
  if (read.error !== null) {
    return { kind: "unreadable" };
  }
  if (read.data === null) {
    return { kind: "none" };
  }
  const id = read.data.claims.session_id;
  return typeof id === "string"
    ? { kind: "session", id }
    : { kind: "unreadable" };
}

// The provider port as the server actions build it over one request (tests
// 9 and 21 hold the two together): the request-scoped client makes the
// changes and names the session it issued, and the stored state and the
// trusted boundary are read through freshly initialized clients over the
// same request's cookie store. verify "same-client" instead reads all of it
// through the changing client, as the server actions did before this
// correction. It is kept only as a control: each defect scenario must fool
// it, or the scenario would prove nothing.
function actionProvider(provider, request, verify = "fresh") {
  const client = serverClient(provider, request);
  const fresh =
    verify === "fresh"
      ? async () => serverClient(provider, request)
      : async () => client;
  return Object.freeze({
    signInWithPassword: async ({ email, password }) => {
      const { error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error === null) {
        return "accepted";
      }
      return error.status === 400 ? "rejected" : "unavailable";
    },
    signOut: async () => {
      const { error } = await client.auth.signOut({ scope: "local" });
      return error === null;
    },
    issuedSession: () => sessionOf(client),
    storedSession: async () => sessionOf(await fresh()),
    session: createSupabaseServerSessionSource(fresh),
  });
}

// One sign-in or sign-out request from a browser, as the server action runs
// it. Its response is not delivered: tests deliver it, or not, themselves.
async function signInRequest(provider, agent, options = {}) {
  const { verify, payload = validForm(), ...conditions } = options;
  const request = actionRequest(agent, conditions);
  const state = await signInExistingAccount(
    async () => actionProvider(provider, request, verify),
    payload,
  );
  return { state, request };
}

async function signOutRequest(provider, agent, options = {}) {
  const { verify, ...conditions } = options;
  const request = actionRequest(agent, conditions);
  const state = await signOutCurrentSession(async () =>
    actionProvider(provider, request, verify),
  );
  return { state, request };
}

// A browser signed in by a verified, delivered sign-in, and its session id.
async function signedIn(provider) {
  const agent = userAgent();
  const { state, request } = await signInRequest(provider, agent);
  assertExactly(state, { status: "signed-in" });
  request.deliver();
  return { agent, id: provider.issued.at(-1) };
}

// What a request's cookie store holds now, read through a fresh client.
function storedIn(provider, request) {
  return sessionOf(serverClient(provider, request));
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
function endedRead(signing, id) {
  return signing === "asymmetric"
    ? { kind: "session", id }
    : { kind: "unreadable" };
}

function endedView(signing) {
  return { session: signing === "asymmetric" ? "authenticated" : "anonymous" };
}

test("11. a sign-in is confirmed only when the stored state holds the very session the provider issued", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const agent = userAgent();
      const { state, request } = await signInRequest(provider, agent);
      assertExactly(state, { status: "signed-in" });
      assertNothingLeaks(state);
      assert.equal(provider.issued.length, 1);
      const [id] = provider.issued;
      // A fresh read of the request's stored state holds the issued session,
      // and the response carries it.
      assert.deepEqual(await storedIn(provider, request), {
        kind: "session",
        id,
      });
      assert.ok(request.response.setCookie.length > 0);
      // Once the browser receives it, its next request holds that session,
      // and the page learns only that it is authenticated.
      request.deliver();
      assert.deepEqual(await nextSession(provider, agent), {
        kind: "session",
        id,
      });
      assertExactly(await nextView(provider, agent), {
        session: "authenticated",
      });
      assert.ok(provider.active.has(id));
      // Another browser is untouched.
      assertExactly(await nextView(provider, userAgent()), {
        session: "anonymous",
      });
      // Rejected credentials store nothing and need no cleanup.
      const refused = userAgent();
      const rejected = await signInRequest(provider, refused, {
        payload: form([
          ["email", EMAIL],
          ["password", "not-the-synthetic-password"],
        ]),
      });
      assertExactly(rejected.state, { status: "rejected" });
      assert.deepEqual(rejected.request.response.setCookie, []);
      assert.equal(provider.issued.length, 1);
    });
  }
});

test("12. a session already stored never confirms a new sign-in", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const { agent, id: earlier } = await signedIn(provider);
      // The provider accepts a second sign-in, but none of its cookie writes
      // reach the store, so the earlier, still valid session stays stored.
      // The trusted boundary reads that request as authenticated; it is
      // still not the session this sign-in issued.
      const { state, request } = await signInRequest(provider, agent, {
        refuse: EVERY_WRITE,
      });
      assertExactly(state, { status: "uncertain" });
      assertNothingLeaks(state);
      const attempted = provider.issued.at(-1);
      assert.notEqual(attempted, earlier);
      assert.deepEqual(await storedIn(provider, request), {
        kind: "session",
        id: earlier,
      });
      // Cleanup ended the session this sign-in issued. The earlier one,
      // still stored and still valid, is why the result says this browser
      // may still be signed in.
      assert.equal(provider.active.has(attempted), false);
      assert.equal(provider.active.has(earlier), true);
      request.deliver();
      assert.deepEqual(await nextSession(provider, agent), {
        kind: "session",
        id: earlier,
      });
      assertExactly(await nextView(provider, agent), {
        session: "authenticated",
      });
      // Control: reading through the changing client confirms this sign-in.
      const control = await signInRequest(provider, agent, {
        refuse: EVERY_WRITE,
        verify: "same-client",
      });
      assertExactly(control.state, { status: "signed-in" });
    });
  }
  // The same rule with a provider stand-in: a stored session other than the
  // one issued confirms nothing, even with an authenticated trusted read.
  const jar = browser(EXISTING);
  const { calls, source } = stubProvider(jar, (held) => ({
    signInWithPassword: async () => {
      held.session = ISSUED;
      return "accepted";
    },
  }));
  assertExactly(await signInExistingAccount(source, validForm()), {
    status: "unavailable",
  });
  assert.equal(calls.signOut, 1);
  assert.equal(jar.session, null);
});

test("13. a provider sign-in whose cookies never reach the store is not a sign-in", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const agent = userAgent();
      // The provider accepts, and the request's own client holds the new
      // session, but every cookie write is refused and the adapter swallows
      // the failure.
      const { state, request } = await signInRequest(provider, agent, {
        refuse: EVERY_WRITE,
      });
      // Cleanup ended the session at the provider, and nothing is stored, so
      // this is the plain failure, not the uncertain one.
      assertExactly(state, { status: "unavailable" });
      assertNothingLeaks(state);
      const [id] = provider.issued;
      assert.equal(provider.active.has(id), false);
      assert.deepEqual(await storedIn(provider, request), { kind: "none" });
      assert.deepEqual(request.response.setCookie, []);
      request.deliver();
      assert.deepEqual(await nextSession(provider, agent), { kind: "none" });
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
      // Control: reading through the changing client confirms this sign-in.
      const control = await signInRequest(provider, userAgent(), {
        refuse: EVERY_WRITE,
        verify: "same-client",
      });
      assertExactly(control.state, { status: "signed-in" });
    });
  }
});

test("14. a provider logout that leaves the session cookie stored is not a sign-out", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const { agent, id } = await signedIn(provider);
      // The provider ends the session and the request's own client drops
      // it, but the cookie removal is refused and the adapter swallows it.
      const { state, request } = await signOutRequest(provider, agent, {
        refuse: EVERY_WRITE,
      });
      assertExactly(state, { status: "failed" });
      assertNothingLeaks(state);
      assert.equal(provider.active.has(id), false);
      assert.deepEqual(
        await storedIn(provider, request),
        endedRead(signing, id),
      );
      request.deliver();
      assert.match(agent.cookie, /-auth-token=/);
      assert.deepEqual(
        await nextSession(provider, agent),
        endedRead(signing, id),
      );
      assertExactly(await nextView(provider, agent), endedView(signing));
      // Control: reading through the changing client confirms this sign-out.
      const control = await signOutRequest(provider, agent, {
        refuse: EVERY_WRITE,
        verify: "same-client",
      });
      assertExactly(control.state, { status: "signed-out" });
      // Signing out again with a working cookie store removes it, and the
      // next request shows it gone.
      const retry = await signOutRequest(provider, agent);
      assertExactly(retry.state, { status: "signed-out" });
      retry.request.deliver();
      assert.equal(agent.cookie, "");
      assert.deepEqual(await nextSession(provider, agent), { kind: "none" });
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
    });
  }
});

test("15. partial cookie updates are judged by what the stored state yields", async (t) => {
  // The client reports, and ignores, a chunked value it cannot reassemble.
  const warn = t.mock.method(console, "warn", () => {});
  const provider = await identityProvider({ metadata: 4000 });
  // A session this large is stored as several cookie chunks.
  const chunked = await signedIn(provider);
  const names = chunked.agent.cookie
    .split("; ")
    .map((pair) => pair.slice(0, pair.indexOf("=")));
  assert.ok(names.length >= 2);
  names.forEach((name, index) => assert.ok(name.endsWith(`.${index}`)));

  // Sign-in stores the first chunk, and the second is refused. What is
  // stored yields no session, so nothing is confirmed; cleanup removes the
  // stray chunk and ends the session, so the failure is the plain one.
  const partial = userAgent();
  const signIn = await signInRequest(provider, partial, {
    refuse: chunkWrites(".1"),
  });
  assertExactly(signIn.state, { status: "unavailable" });
  assert.equal(provider.active.has(provider.issued.at(-1)), false);
  signIn.request.deliver();
  assert.equal(partial.cookie, "");
  assertExactly(await nextView(provider, partial), { session: "anonymous" });

  // Sign-out removes the first chunk, and the second removal is refused.
  // The fragment left behind yields no session, in this request and in the
  // next, so the sign-out is confirmed and the next request agrees.
  const fragment = await signedIn(provider);
  const signOut = await signOutRequest(provider, fragment.agent, {
    refuse: (name, value) => REMOVALS(name, value) && name.endsWith(".1"),
  });
  assertExactly(signOut.state, { status: "signed-out" });
  signOut.request.deliver();
  assert.match(fragment.agent.cookie, /\.1=/);
  assert.doesNotMatch(fragment.agent.cookie, /\.0=/);
  assert.deepEqual(await nextSession(provider, fragment.agent), {
    kind: "none",
  });
  assertExactly(await nextView(provider, fragment.agent), {
    session: "anonymous",
  });

  // The first removal is refused, which stops the rest: the whole session
  // stays stored, so nothing is confirmed, and the next request still holds
  // it.
  const whole = await signedIn(provider);
  const stuck = await signOutRequest(provider, whole.agent, {
    refuse: (name, value) => REMOVALS(name, value) && name.endsWith(".0"),
  });
  assertExactly(stuck.state, { status: "failed" });
  stuck.request.deliver();
  assert.deepEqual(await nextSession(provider, whole.agent), {
    kind: "session",
    id: whole.id,
  });
  assert.ok(
    warn.mock.calls.some((call) => /chunk/i.test(String(call.arguments[0]))),
  );
});

test("16. failed, thrown, or unverifiable claims reads confirm nothing", async (t) => {
  // The provider cannot verify the issued session: its signing keys or its
  // user check are unavailable. Sign-in is not confirmed, and cleanup, which
  // needs no verification to find an empty store, is.
  for (const [signing, route] of [
    ["asymmetric", "/.well-known/jwks.json"],
    ["symmetric", "/user"],
  ]) {
    await t.test(`${signing} sign-in`, async () => {
      const provider = await identityProvider({ signing });
      provider.outage.add(route);
      const agent = userAgent();
      const { state, request } = await signInRequest(provider, agent);
      assertExactly(state, { status: "unavailable" });
      assert.equal(provider.active.has(provider.issued.at(-1)), false);
      request.deliver();
      assert.deepEqual(await nextSession(provider, agent), { kind: "none" });
    });
  }
  await t.test("symmetric sign-out", async () => {
    const provider = await identityProvider({ signing: "symmetric" });
    // A removed cookie leaves nothing to verify: confirmed even while the
    // provider cannot check sessions.
    const removed = await signedIn(provider);
    provider.outage.add("/user");
    const confirmed = await signOutRequest(provider, removed.agent);
    assertExactly(confirmed.state, { status: "signed-out" });
    // A cookie left behind cannot be read while the provider cannot check
    // it. The trusted boundary reads that failure as anonymous, which
    // denies access but is no proof of sign-out.
    provider.outage.delete("/user");
    const kept = await signedIn(provider);
    provider.outage.add("/user");
    const { state, request } = await signOutRequest(provider, kept.agent, {
      refuse: EVERY_WRITE,
    });
    assertExactly(state, { status: "failed" });
    assert.deepEqual(await storedIn(provider, request), {
      kind: "unreadable",
    });
    assertExactly(
      await getShellView(
        createSupabaseServerSessionSource(async () =>
          serverClient(provider, request),
        ),
      ),
      { session: "anonymous" },
    );
  });
  // The provider's own read of what it issued fails, throws, or is
  // malformed: nothing is confirmed, and cleanup runs.
  for (const issuedSession of [...malformedReads, undefined]) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, { issuedSession });
    const state = await signInExistingAccount(source, validForm());
    assertExactly(state, { status: "unavailable" });
    assertNothingLeaks(state);
    assert.equal(calls.signOut, 1);
    assert.equal(jar.session, null);
  }
  // The stored-state read fails, throws, or is malformed while the session
  // is in fact stored: nothing is confirmed, and since the same read cannot
  // confirm cleanup either, the result says the browser may be signed in.
  for (const storedSession of [...malformedReads, undefined]) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, { storedSession });
    const state = await signInExistingAccount(source, validForm());
    assertExactly(state, { status: "uncertain" });
    assert.equal(calls.signOut, 1);
  }
});

test("17. failed or unverifiable cleanup leaves the result uncertain and the residual session visible", async (t) => {
  for (const [signing, route] of [
    ["asymmetric", "/.well-known/jwks.json"],
    ["symmetric", "/user"],
  ]) {
    await t.test(`${signing}, removal refused`, async () => {
      // The issued session is stored but cannot be verified, and cleanup's
      // logout succeeds while its cookie removal is refused. The stored
      // read cannot confirm anything, so the failure is uncertain.
      const provider = await identityProvider({ signing });
      provider.outage.add(route);
      const agent = userAgent();
      const { state, request } = await signInRequest(provider, agent, {
        refuse: REMOVALS,
      });
      assertExactly(state, { status: "uncertain" });
      const id = provider.issued.at(-1);
      assert.equal(provider.active.has(id), false);
      // The cookie is still in the browser; once the provider recovers,
      // the next request shows what it amounts to.
      request.deliver();
      provider.outage.delete(route);
      assert.match(agent.cookie, /-auth-token=/);
      assert.deepEqual(
        await nextSession(provider, agent),
        endedRead(signing, id),
      );
      assertExactly(await nextView(provider, agent), endedView(signing));
    });
    for (const failure of ["outage", "unreachable"]) {
      await t.test(`${signing}, logout ${failure}`, async () => {
        // Cleanup's logout fails or cannot be reached and its cookie
        // removal is refused: the issued session is still valid and still
        // stored, and the result says so.
        const provider = await identityProvider({ signing });
        provider.outage.add(route);
        provider[failure].add("/logout");
        const agent = userAgent();
        const { state, request } = await signInRequest(provider, agent, {
          refuse: REMOVALS,
        });
        assertExactly(state, { status: "uncertain" });
        const id = provider.issued.at(-1);
        assert.equal(provider.active.has(id), true);
        request.deliver();
        provider.outage.clear();
        provider.unreachable.clear();
        assert.deepEqual(await nextSession(provider, agent), {
          kind: "session",
          id,
        });
        assertExactly(await nextView(provider, agent), {
          session: "authenticated",
        });
      });
    }
  }
});

test("18. each transition's next request shows its real outcome", async (t) => {
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      const agent = userAgent();
      const wrong = form([
        ["email", EMAIL],
        ["password", "not-the-synthetic-password"],
      ]);
      const steps = [
        [signInRequest, { refuse: EVERY_WRITE }, "unavailable", "anonymous"],
        [signInRequest, { payload: wrong }, "rejected", "anonymous"],
        [signInRequest, {}, "signed-in", "authenticated"],
        [signOutRequest, { refuse: EVERY_WRITE }, "failed", null],
        [signOutRequest, {}, "signed-out", "anonymous"],
        [signOutRequest, {}, "signed-out", "anonymous"],
        [signInRequest, {}, "signed-in", "authenticated"],
      ];
      for (const [operation, options, status, view] of steps) {
        const { state, request } = await operation(provider, agent, options);
        assertExactly(state, { status });
        request.deliver();
        assertExactly(
          await nextView(provider, agent),
          view === null ? endedView(signing) : { session: view },
        );
      }
    });
  }
});

test("19. stale or contradictory verification results confirm nothing", async () => {
  // Stale: the stored-state read still answers with the state from before
  // the operation, though the jar has in fact changed.
  const staleIn = browser(EXISTING);
  const signInStale = stubProvider(staleIn, {
    storedSession: async () => ({ kind: "session", id: EXISTING }),
  });
  assertExactly(await signInExistingAccount(signInStale.source, validForm()), {
    status: "uncertain",
  });
  assert.equal(staleIn.session, null);
  const staleOut = browser(EXISTING);
  const signOutStale = stubProvider(staleOut, {
    storedSession: async () => ({ kind: "session", id: EXISTING }),
  });
  assertExactly(await signOutCurrentSession(signOutStale.source), {
    status: "failed",
  });
  assert.equal(staleOut.session, null);
  // Contradictory: the reads disagree with one another, so nothing is
  // confirmed, whichever of them is right.
  const contradictions = [
    // The stored session is the one issued, but the trusted boundary over
    // the stored state reads no identity.
    { session: freshRequestSource(browser()) },
    // Both name a session, but not the same one.
    {
      storedSession: async () => ({
        kind: "session",
        id: "synthetic-session-other",
      }),
    },
    // The ids differ only in case or spacing.
    {
      storedSession: async () => ({
        kind: "session",
        id: ISSUED.toUpperCase(),
      }),
    },
    {
      storedSession: async () => ({ kind: "session", id: ` ${ISSUED}` }),
    },
    // The provider's own copy holds no session, yet one is stored.
    { issuedSession: async () => ({ kind: "none" }) },
  ];
  for (const overrides of contradictions) {
    const jar = browser();
    const { calls, source } = stubProvider(jar, overrides);
    const state = await signInExistingAccount(source, validForm());
    assert.notEqual(state.status, "signed-in");
    assertNothingLeaks(state);
    assert.equal(calls.signOut, 1);
  }
  // A read that changes between calls: the stored state first shows no
  // session, then the issued one. Verification failed on the first answer,
  // and the second means cleanup is not confirmed.
  const answers = [{ kind: "none" }, { kind: "session", id: ISSUED }];
  const flipping = stubProvider(browser(), {
    storedSession: async () => answers.shift(),
  });
  assertExactly(await signInExistingAccount(flipping.source, validForm()), {
    status: "uncertain",
  });
  assert.equal(flipping.calls.stored, 2);
  // A well-formed sign-in where every read agrees is confirmed, so the
  // checks above fail for their contradictions alone.
  assertExactly(
    await signInExistingAccount(stubProvider(browser()).source, validForm()),
    { status: "signed-in" },
  );
});

test("20. an updated cookie store is not a published response: the next request shows what the browser received", async (t) => {
  // Next.js's store changes before it publishes, so a fresh read sees a
  // change that publishing then failed to carry.
  const raw = MutableRequestCookiesAdapter.wrap(
    new RequestCookies(new Headers()),
    () => {
      throw new Error("headers already sent");
    },
  );
  assert.throws(() => raw.set("synthetic", "value"), /headers already sent/);
  assert.deepEqual(
    raw.getAll().map(({ name, value }) => [name, value]),
    [["synthetic", "value"]],
  );
  for (const signing of SIGNINGS) {
    await t.test(signing, async () => {
      const provider = await identityProvider({ signing });
      // Sign-in: the stored state is verified to hold the issued session,
      // so the server-side transition is confirmed. The response carries
      // none of it, and the browser's next request is still anonymous.
      const anonymous = userAgent();
      const signIn = await signInRequest(provider, anonymous, {
        publication: "fails",
      });
      assertExactly(signIn.state, { status: "signed-in" });
      assert.deepEqual(await storedIn(provider, signIn.request), {
        kind: "session",
        id: provider.issued.at(-1),
      });
      assert.deepEqual(signIn.request.response.setCookie, []);
      signIn.request.deliver();
      assert.equal(anonymous.cookie, "");
      assertExactly(await nextView(provider, anonymous), {
        session: "anonymous",
      });
      // Sign-out: the stored state is verified empty and the provider ended
      // the session. The response carries no removal, so the browser's next
      // request still presents the ended session, and its page shows what
      // that amounts to; signing out again ends it there too.
      const { agent, id } = await signedIn(provider);
      const signOut = await signOutRequest(provider, agent, {
        publication: "fails",
      });
      assertExactly(signOut.state, { status: "signed-out" });
      assert.deepEqual(await storedIn(provider, signOut.request), {
        kind: "none",
      });
      assert.deepEqual(signOut.request.response.setCookie, []);
      assert.equal(provider.active.has(id), false);
      signOut.request.deliver();
      assert.deepEqual(
        await nextSession(provider, agent),
        endedRead(signing, id),
      );
      assertExactly(await nextView(provider, agent), endedView(signing));
      const retry = await signOutRequest(provider, agent);
      assertExactly(retry.state, { status: "signed-out" });
      retry.request.deliver();
      assertExactly(await nextView(provider, agent), { session: "anonymous" });
    });
  }
});

test("21. the request model runs the real adapter's cookie methods and the server actions' wiring", () => {
  // The model's server client uses the very cookie methods of the adapter.
  const adapter = read("src/infrastructure/identity/supabase-server.ts");
  const cookieMethods = (source) =>
    source
      .match(
        /getAll\(\) \{[\s\S]*?Proxy owns refresh writes\.\n\s*\}\n\s*\}/,
      )[0]
      .replace(/\s+/g, " ");
  assert.equal(cookieMethods(serverClient.toString()), cookieMethods(adapter));
  assert.match(
    adapter,
    /const cookieStore = await cookies\(\);\n\n {2}return createServerClient\(configuration\.url, configuration\.publishableKey, \{\n {4}cookies: \{\n {6}getAll\(\) \{/,
  );
  // The trusted boundary the server actions use initializes a new client
  // for every read.
  const boundary = read("src/infrastructure/identity/server-session-source.ts");
  assert.match(
    boundary,
    /async function createDefaultClaimsClient\(\): Promise<ClaimsClient \| null> \{\n {2}const \{ createSupabaseServerClient \} = await import\("\.\/supabase-server\.ts"\);\n\n {2}return createSupabaseServerClient\(\);\n\}/,
  );
  assert.match(
    boundary,
    /export const SUPABASE_SERVER_SESSION_SOURCE =\n {2}createSupabaseServerSessionSource\(\);/,
  );
  // The model's provider port is wired as the server actions wire theirs.
  const port = actionProvider.toString();
  assert.match(port, /\n {4}issuedSession: \(\) => sessionOf\(client\),\n/);
  assert.match(
    port,
    /\n {4}storedSession: async \(\) => sessionOf\(await fresh\(\)\),\n/,
  );
  assert.match(
    port,
    /\n {4}session: createSupabaseServerSessionSource\(fresh\),\n/,
  );
  assert.match(
    port,
    /verify === "fresh"\n {6}\? async \(\) => serverClient\(provider, request\)\n {6}: async \(\) => client;/,
  );
  const actions = codeOf(read("app/sign-in/actions.ts"));
  for (const line of [
    'const { error } = await client.auth.signOut({ scope: "local" });',
    "return error === null;",
    'return error.status === 400 ? "rejected" : "unavailable";',
  ]) {
    assert.ok(actions.includes(line), line);
    assert.ok(port.includes(line), line);
  }
});
