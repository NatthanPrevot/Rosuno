// Targeted WI-P2-003 Security Shell tests.
//
// They run on Node.js built-ins alone. The trusted ports below are local test
// stubs that exist only to drive the Security Shell; they are not product
// sources, and every identifier, capability code, and scope in them is
// synthetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { types } from "node:util";

import * as security from "../src/application/security.ts";

const { authorize, runProtectedMutation } = security;

const appRoot = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
}

// Source without its full-line comments.
function codeOf(source) {
  return source.replace(/^\s*\/\/.*\n/gm, "");
}

function importsOf(source) {
  return [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

// A value as plain data: its prototype and every own property, enumerable or
// not, of it and of each object it holds, so nothing hidden is carried.
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

const AUTHORIZED = { status: "authorized" };
const UNAUTHENTICATED = { status: "unauthenticated" };
const FORBIDDEN = { status: "forbidden" };
const UNAVAILABLE = { status: "unavailable" };
const SUCCEEDED = { status: "succeeded" };
const OPERATION_FAILED = { status: "operation-failed" };

const SUBJECT = "synthetic-subject-7f3a-0001";
const CAPABILITY = "synthetic.capability.7f3a";
const SCOPE = "synthetic-scope-7f3a-0001";

// Values that must never appear in any result. The token-like value is built
// at run time so the repository secret scan never sees one.
const TOKEN_LIKE = ["Bear", "er ", "q7f3aZ".repeat(6)].join("");
const SENSITIVE = [SUBJECT, CAPABILITY, SCOPE, "7f3a", "Bear", "internal"];

function assertRedacted(result) {
  const text = JSON.stringify(ownData(result));
  for (const value of SENSITIVE) {
    assert.equal(text.includes(value), false, value);
  }
  assert.equal(text.includes("at "), false);
  assert.ok(Object.keys(result).length === 1 && "status" in result);
  assert.equal(result instanceof Error, false);
}

// Thrown values that carry an internal message, stack, identifiers, and a
// token-like value.
function sensitiveThrows() {
  const error = new Error(`internal 7f3a ${SUBJECT} ${TOKEN_LIKE}`);
  error.code = "INTERNAL_7f3a";
  error.subject = SUBJECT;
  error.capability = CAPABILITY;
  error.scope = SCOPE;
  return [
    error,
    new TypeError(`internal 7f3a ${CAPABILITY}`),
    Object.assign(Object.create(null), { detail: `internal ${TOKEN_LIKE}` }),
    `internal 7f3a ${SCOPE}`,
    { status: "authorized" },
    { ok: true },
    null,
    undefined,
  ];
}

// Trusted server-side ports for tests: a session source answering with one
// subject, a principal-context store, and an exact capability grant store
// keyed by subject, capability, and scope. Every call is recorded.
function stubSources({
  subject = SUBJECT,
  contexts = {},
  grants = [],
  log = [],
} = {}) {
  const calls = { session: 0, contexts: [], capabilities: [] };
  const sources = {
    session: {
      currentSubject: async (...args) => {
        assert.equal(args.length, 0);
        calls.session += 1;
        log.push("session");
        return subject;
      },
    },
    contexts: {
      contextsOf: async (...args) => {
        calls.contexts.push(args);
        log.push("contexts");
        return contexts[args[0]] ?? [];
      },
    },
    capabilities: {
      isGranted: async (...args) => {
        calls.capabilities.push(args);
        log.push("capabilities");
        const [asked, requirement] = args;
        return grants.some(
          (grant) =>
            grant.subject === asked &&
            grant.capability === requirement.capability &&
            grant.scope === requirement.scope,
        );
      },
    },
  };
  return { sources, calls, log };
}

function withContexts(...held) {
  return stubSources({ contexts: { [SUBJECT]: held } });
}

const exactCapability = { capability: CAPABILITY, scope: SCOPE };
const exactGrant = { subject: SUBJECT, ...exactCapability };

test("1. anonymous requests fail closed before any later layer is asked", async () => {
  for (const requirement of [
    {},
    { context: "client" },
    { context: "staff", capability: exactCapability },
    { capability: exactCapability },
  ]) {
    const { sources, calls } = stubSources({
      subject: null,
      contexts: { [SUBJECT]: ["client", "staff"] },
      grants: [exactGrant],
    });
    assertExactly(await authorize(sources, requirement), UNAUTHENTICATED);
    assert.equal(calls.session, 1);
    assert.deepEqual(calls.contexts, []);
    assert.deepEqual(calls.capabilities, []);
  }
});

test("2. an authenticated trusted session reaches the later layers", async () => {
  // With no further requirement, an authenticated session is enough, and no
  // context or capability source is asked.
  const plain = stubSources();
  assertExactly(await authorize(plain.sources, {}), AUTHORIZED);
  assert.deepEqual(plain.calls.contexts, []);
  assert.deepEqual(plain.calls.capabilities, []);

  // The later layers are asked about exactly the subject the session source
  // reported, kept opaque, and about nothing else.
  for (const subject of ["", " padded ", "AbC", "\u0000", "x".repeat(10000)]) {
    const { sources, calls } = stubSources({
      subject,
      contexts: { [subject]: ["staff"] },
      grants: [{ ...exactGrant, subject }],
    });
    assertExactly(
      await authorize(sources, {
        context: "staff",
        capability: exactCapability,
      }),
      AUTHORIZED,
    );
    assert.deepEqual(calls.contexts, [[subject]]);
    assert.equal(calls.capabilities.length, 1);
    assert.equal(calls.capabilities[0].length, 2);
    assert.equal(calls.capabilities[0][0], subject);
  }
});

test("3. malformed or failing session sources fail closed and stay redacted", async () => {
  // Anything other than a string or null from the session source is unusable.
  for (const answer of [
    undefined,
    0,
    42,
    true,
    {},
    [],
    { status: "authenticated", subject: SUBJECT },
    new String(SUBJECT),
    Symbol("subject"),
    1n,
  ]) {
    const { sources, calls } = stubSources({
      contexts: { [SUBJECT]: ["staff"] },
      grants: [exactGrant],
    });
    sources.session = { currentSubject: async () => answer };
    for (const requirement of [
      {},
      { context: "staff", capability: exactCapability },
    ]) {
      const result = await authorize(sources, requirement);
      assertExactly(result, UNAVAILABLE);
      assertRedacted(result);
    }
    assert.deepEqual(calls.contexts, []);
    assert.deepEqual(calls.capabilities, []);
  }
  // A throwing or missing session source denies with a fixed status: the raw
  // thrown value never comes back, and authorize itself never rejects.
  for (const thrown of sensitiveThrows()) {
    for (const session of [
      {
        currentSubject: async () => {
          throw thrown;
        },
      },
      {
        currentSubject: () => {
          throw thrown;
        },
      },
    ]) {
      const result = await authorize({ ...stubSources().sources, session }, {});
      assertExactly(result, UNAVAILABLE);
      assertRedacted(result);
    }
  }
  for (const session of [undefined, null, {}, { currentSubject: SUBJECT }]) {
    assertExactly(
      await authorize({ ...stubSources().sources, session }, {}),
      UNAVAILABLE,
    );
  }
  for (const sources of [undefined, null, {}, "authenticated", 1]) {
    assertExactly(await authorize(sources, {}), UNAVAILABLE);
  }
});

test("4. each exact principal context satisfies only its own requirement", async () => {
  const contexts = ["client", "attorney", "staff"];
  for (const held of contexts) {
    for (const required of contexts) {
      const { sources, calls } = withContexts(held);
      assertExactly(
        await authorize(sources, { context: required }),
        held === required ? AUTHORIZED : FORBIDDEN,
      );
      assert.deepEqual(calls.contexts, [[SUBJECT]]);
      // A context requirement alone never consults capabilities.
      assert.deepEqual(calls.capabilities, []);
    }
  }
});

test("5. one subject holds client and attorney contexts at the same time", async () => {
  const both = withContexts("client", "attorney");
  assertExactly(
    await authorize(both.sources, { context: "client" }),
    AUTHORIZED,
  );
  assertExactly(
    await authorize(both.sources, { context: "attorney" }),
    AUTHORIZED,
  );
  // Holding both grants neither staff context nor any capability.
  assertExactly(await authorize(both.sources, { context: "staff" }), FORBIDDEN);
  assertExactly(
    await authorize(both.sources, { capability: exactCapability }),
    FORBIDDEN,
  );
  // All three contexts together are still only contexts.
  const all = withContexts("attorney", "staff", "client");
  for (const context of ["client", "attorney", "staff"]) {
    assertExactly(await authorize(all.sources, { context }), AUTHORIZED);
  }
  // Order and repetition do not matter.
  const repeated = withContexts("attorney", "client", "attorney");
  assertExactly(
    await authorize(repeated.sources, { context: "client" }),
    AUTHORIZED,
  );
});

test("6. missing, malformed, or failing principal contexts deny", async () => {
  // Contexts the subject does not hold.
  for (const held of [[], ["client"], ["attorney"]]) {
    const { sources } = withContexts(...held);
    assertExactly(await authorize(sources, { context: "staff" }), FORBIDDEN);
  }
  // A different subject's contexts never count.
  const other = stubSources({ contexts: { "another-subject": ["staff"] } });
  assertExactly(
    await authorize(other.sources, { context: "staff" }),
    FORBIDDEN,
  );

  // Anything but an array made only of the exact context names is unusable,
  // even when it also names the required context.
  const throwing = () => {
    throw new Error(`internal 7f3a ${TOKEN_LIKE}`);
  };
  const revoked = (target) => {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
  };
  for (const reported of [
    null,
    undefined,
    "staff",
    { 0: "staff", length: 1 },
    new Set(["staff"]),
    ["staff", "admin"],
    ["staff", 7],
    ["staff", null],
    ["Staff"],
    [" staff"],
    ["staff "],
    [new String("staff")],
    ["*"],
    ["superuser"],
    ["everything"],
    [["staff"]],
    revoked(["staff"]),
    new Proxy(["staff"], { get: throwing }),
    Object.defineProperty(["staff"], "0", { get: throwing }),
  ]) {
    const { sources, calls } = stubSources({ grants: [exactGrant] });
    sources.contexts = { contextsOf: async () => reported };
    const result = await authorize(sources, {
      context: "staff",
      capability: exactCapability,
    });
    assertExactly(result, UNAVAILABLE);
    assertRedacted(result);
    // The capability layer is never reached.
    assert.deepEqual(calls.capabilities, []);
  }
  for (const thrown of sensitiveThrows()) {
    for (const contextsOf of [
      async () => {
        throw thrown;
      },
      () => {
        throw thrown;
      },
    ]) {
      const { sources } = stubSources();
      sources.contexts = { contextsOf };
      const result = await authorize(sources, { context: "client" });
      assertExactly(result, UNAVAILABLE);
      assertRedacted(result);
    }
  }
  for (const contexts of [undefined, null, {}, { contextsOf: ["staff"] }]) {
    const { sources } = stubSources();
    sources.contexts = contexts;
    assertExactly(await authorize(sources, { context: "staff" }), UNAVAILABLE);
  }
});

test("7. browser-shaped role and principal assertions grant nothing", async () => {
  // Assertions a request might carry are not part of the requirement shape,
  // so the requirement is refused before any source is asked.
  for (const requirement of [
    { context: "staff", role: "staff" },
    { context: "client", principal: "staff" },
    { context: "client", contexts: ["staff"] },
    { authenticated: true },
    { authorized: true },
    { context: "staff", authorized: true },
    { capability: { ...exactCapability, granted: true } },
    { capability: exactCapability, isAdmin: true },
    { role: "staff" },
    { status: "authenticated", subject: SUBJECT },
    Object.defineProperty({}, "context", { get: () => "client" }),
    { [Symbol("authorized")]: true },
    "authorized",
    true,
    null,
    undefined,
  ]) {
    const { sources, calls } = withContexts("client");
    const result = await authorize(sources, requirement);
    assertExactly(result, UNAVAILABLE);
    assert.equal(calls.session, 0);
    assert.deepEqual(calls.contexts, []);
  }
  // Inherited fields are never read: an inherited authorized flag beside an
  // unheld staff context leaves the request forbidden.
  const inherited = withContexts("client");
  assertExactly(
    await authorize(
      inherited.sources,
      Object.assign(Object.create({ authorized: true }), { context: "staff" }),
    ),
    FORBIDDEN,
  );
  // Only the three exact context names can be required.
  for (const context of [
    "admin",
    "superuser",
    "everything",
    "*",
    "Staff",
    "client ",
    "",
    null,
    1,
    ["staff"],
  ]) {
    const { sources, calls } = withContexts("client", "attorney", "staff");
    assertExactly(await authorize(sources, { context }), UNAVAILABLE);
    assert.equal(calls.session, 0);
  }
  // A browser-shaped claim is not a set of trusted sources.
  for (const claim of [
    { status: "authenticated", subject: SUBJECT, contexts: ["staff"] },
    { session: { status: "authenticated", subject: SUBJECT } },
    { ...withContexts("staff").sources, session: { authenticated: true } },
  ]) {
    assertExactly(await authorize(claim, { context: "staff" }), UNAVAILABLE);
    assertExactly(await authorize(claim, {}), UNAVAILABLE);
  }
});

test("8. staff context alone never grants a capability", async () => {
  const { sources, calls } = withContexts("staff");
  assertExactly(await authorize(sources, { context: "staff" }), AUTHORIZED);
  for (const requirement of [
    { capability: exactCapability },
    { context: "staff", capability: exactCapability },
  ]) {
    assertExactly(await authorize(sources, requirement), FORBIDDEN);
  }
  // The capability source was asked each time; staff context did not stand in
  // for its answer.
  assert.equal(calls.capabilities.length, 2);
});

test("9. an exact trusted grant authorizes and its scope arrives exactly", async () => {
  const { sources, calls } = stubSources({
    contexts: { [SUBJECT]: ["staff"] },
    grants: [exactGrant],
  });
  assertExactly(
    await authorize(sources, { capability: exactCapability }),
    AUTHORIZED,
  );
  assertExactly(
    await authorize(sources, {
      context: "staff",
      capability: exactCapability,
    }),
    AUTHORIZED,
  );
  // The source receives the subject and a frozen copy of exactly the required
  // capability and scope: nothing more, nothing derived.
  assert.equal(calls.capabilities.length, 2);
  for (const [subject, requirement, ...rest] of calls.capabilities) {
    assert.equal(subject, SUBJECT);
    assert.deepEqual(rest, []);
    assertExactly(requirement, exactCapability);
    assert.notEqual(requirement, exactCapability);
  }
  // Scopes and codes are opaque: each arrives exactly as written.
  for (const scope of [
    " padded ",
    "UPPER",
    "parent/child",
    "a​b",
    "x".repeat(5000),
  ]) {
    for (const capability of [CAPABILITY, " spaced ", "UPPER.code"]) {
      const exact = stubSources({
        grants: [{ subject: SUBJECT, capability, scope }],
      });
      assertExactly(
        await authorize(exact.sources, { capability: { capability, scope } }),
        AUTHORIZED,
      );
      assert.deepEqual(exact.calls.capabilities[0][1], { capability, scope });
    }
  }
});

test("10. denied, failing, or malformed capability answers fail closed", async () => {
  // A denied exact capability.
  const denied = stubSources({ grants: [] });
  assertExactly(
    await authorize(denied.sources, { capability: exactCapability }),
    FORBIDDEN,
  );
  // Only the boolean true authorizes; anything else is unusable.
  for (const answer of [
    "true",
    1,
    {},
    [],
    { granted: true },
    null,
    undefined,
    new Boolean(true),
    Symbol("granted"),
  ]) {
    const { sources } = stubSources();
    sources.capabilities = { isGranted: async () => answer };
    const result = await authorize(sources, { capability: exactCapability });
    assertExactly(result, UNAVAILABLE);
    assertRedacted(result);
  }
  for (const thrown of sensitiveThrows()) {
    for (const isGranted of [
      async () => {
        throw thrown;
      },
      () => {
        throw thrown;
      },
    ]) {
      const { sources } = stubSources();
      sources.capabilities = { isGranted };
      const result = await authorize(sources, { capability: exactCapability });
      assertExactly(result, UNAVAILABLE);
      assertRedacted(result);
    }
  }
  for (const capabilities of [undefined, null, {}, { isGranted: true }]) {
    const { sources } = stubSources();
    sources.capabilities = capabilities;
    assertExactly(
      await authorize(sources, { capability: exactCapability }),
      UNAVAILABLE,
    );
  }
});

test("11. no wildcard, admin, superuser, or everything grant is a bypass", async () => {
  // Broad-looking grants held by the subject are just other exact grants:
  // none of them satisfies a different capability or scope.
  const broad = [
    "*",
    "**",
    "all",
    "admin",
    "superuser",
    "everything",
    "root",
    `${CAPABILITY}.*`,
    `${CAPABILITY.split(".")[0]}.*`,
  ];
  const grants = broad.flatMap((value) => [
    { subject: SUBJECT, capability: value, scope: SCOPE },
    { subject: SUBJECT, capability: value, scope: "*" },
    { subject: SUBJECT, capability: CAPABILITY, scope: value },
  ]);
  const { sources } = stubSources({
    contexts: { [SUBJECT]: ["client", "attorney", "staff"] },
    grants,
  });
  for (const context of [undefined, "staff"]) {
    assertExactly(
      await authorize(sources, { context, capability: exactCapability }),
      FORBIDDEN,
    );
  }
  // The capability requirement takes exactly a non-empty code and scope and
  // nothing else: no flag, list, pattern, or missing scope is accepted.
  for (const capability of [
    { capability: CAPABILITY },
    { scope: SCOPE },
    { capability: CAPABILITY, scope: "" },
    { capability: "", scope: SCOPE },
    { capability: CAPABILITY, scope: null },
    { capability: CAPABILITY, scope: undefined },
    { capability: CAPABILITY, scope: [SCOPE] },
    { capability: [CAPABILITY], scope: SCOPE },
    { capability: /synthetic/, scope: SCOPE },
    { ...exactCapability, any: true },
    { ...exactCapability, admin: true },
    { ...exactCapability, superuser: true },
    { ...exactCapability, everything: true },
    { ...exactCapability, wildcard: true },
    { ...exactCapability, scopes: ["*"] },
    CAPABILITY,
    [CAPABILITY, SCOPE],
    null,
    true,
    Object.assign(Object.create(exactCapability), {}),
    Object.defineProperty({ capability: CAPABILITY }, "scope", {
      get: () => SCOPE,
      enumerable: true,
    }),
  ]) {
    const { sources, calls } = stubSources({ grants: [exactGrant] });
    assertExactly(await authorize(sources, { capability }), UNAVAILABLE);
    assert.equal(calls.session, 0);
    assert.deepEqual(calls.capabilities, []);
  }
  // The module offers no shortcut: exactly two functions, and nothing else.
  assert.deepEqual(Object.keys(security).sort(), [
    "authorize",
    "runProtectedMutation",
  ]);
  for (const value of Object.values(security)) {
    assert.equal(typeof value, "function");
  }
});

test("12. a mismatched scope or code is never authorized by fallback", async () => {
  const { sources } = stubSources({
    contexts: { [SUBJECT]: ["staff"] },
    grants: [exactGrant],
  });
  for (const capability of [
    { capability: CAPABILITY, scope: "synthetic-scope-7f3a-0002" },
    { capability: CAPABILITY, scope: `${SCOPE} ` },
    { capability: CAPABILITY, scope: SCOPE.toUpperCase() },
    { capability: CAPABILITY, scope: SCOPE.slice(0, -1) },
    { capability: CAPABILITY, scope: `${SCOPE}/child` },
    { capability: CAPABILITY, scope: "*" },
    { capability: `${CAPABILITY}.child`, scope: SCOPE },
    { capability: CAPABILITY.slice(0, -1), scope: SCOPE },
    { capability: "*", scope: SCOPE },
  ]) {
    for (const context of [undefined, "staff"]) {
      assertExactly(
        await authorize(sources, { context, capability }),
        FORBIDDEN,
      );
    }
  }
  // Another subject's exact grant does not carry over.
  const other = stubSources({
    grants: [{ ...exactGrant, subject: "another-subject" }],
  });
  assertExactly(
    await authorize(other.sources, { capability: exactCapability }),
    FORBIDDEN,
  );
});

test("13. a protected mutation runs only after authorization, exactly once", async () => {
  const log = [];
  const { sources } = stubSources({
    contexts: { [SUBJECT]: ["staff"] },
    grants: [exactGrant],
    log,
  });
  const received = [];
  const result = await runProtectedMutation(
    sources,
    { context: "staff", capability: exactCapability },
    async (...args) => {
      received.push(args);
      log.push("mutation");
      return { ok: true };
    },
  );
  assertExactly(result, SUCCEEDED);
  // Authorization completes first; the mutation runs once and receives
  // nothing from the Security Shell.
  assert.deepEqual(log, ["session", "contexts", "capabilities", "mutation"]);
  assert.deepEqual(received, [[]]);

  // Success carries nothing else the mutation reports.
  const reported = await runProtectedMutation(sources, {}, async () => ({
    ok: true,
    subject: SUBJECT,
    detail: `internal 7f3a ${TOKEN_LIKE}`,
    data: { capability: CAPABILITY, scope: SCOPE },
  }));
  assertExactly(reported, SUCCEEDED);
  assertRedacted(reported);

  // Only an explicit ok: true is success.
  for (const outcome of [
    { ok: false },
    { ok: "true" },
    { ok: 1 },
    {},
    true,
    null,
    undefined,
    { ok: false, detail: `internal 7f3a ${SUBJECT}` },
  ]) {
    let runs = 0;
    const state = await runProtectedMutation(sources, {}, async () => {
      runs += 1;
      return outcome;
    });
    assertExactly(state, OPERATION_FAILED);
    assertRedacted(state);
    assert.equal(runs, 1);
  }
});

test("14. denied or failing authorization never runs the mutation", async () => {
  const cases = [
    // Anonymous.
    [stubSources({ subject: null }).sources, {}, UNAUTHENTICATED],
    // Missing context.
    [withContexts("client").sources, { context: "staff" }, FORBIDDEN],
    // Staff context without the capability.
    [
      withContexts("staff").sources,
      { context: "staff", capability: exactCapability },
      FORBIDDEN,
    ],
    // Malformed trusted-source output.
    [
      {
        ...stubSources().sources,
        contexts: { contextsOf: async () => "staff" },
      },
      { context: "staff" },
      UNAVAILABLE,
    ],
    [
      {
        ...stubSources().sources,
        capabilities: { isGranted: async () => "yes" },
      },
      { capability: exactCapability },
      UNAVAILABLE,
    ],
    [
      { ...stubSources().sources, session: { currentSubject: async () => 7 } },
      {},
      UNAVAILABLE,
    ],
    // Trusted-source exceptions.
    [
      {
        ...stubSources().sources,
        session: {
          currentSubject: async () => {
            throw new Error(`internal 7f3a ${TOKEN_LIKE}`);
          },
        },
      },
      {},
      UNAVAILABLE,
    ],
    [
      {
        ...stubSources().sources,
        contexts: {
          contextsOf: async () => {
            throw new Error(`internal 7f3a ${SUBJECT}`);
          },
        },
      },
      { context: "client" },
      UNAVAILABLE,
    ],
    [
      {
        ...stubSources().sources,
        capabilities: {
          isGranted: async () => {
            throw new Error(`internal 7f3a ${CAPABILITY} ${SCOPE}`);
          },
        },
      },
      { capability: exactCapability },
      UNAVAILABLE,
    ],
    // No sources at all.
    [null, {}, UNAVAILABLE],
    // Caller-shaped authorization assertions.
    [stubSources({ subject: null }).sources, { authorized: true }, UNAVAILABLE],
    [
      withContexts("client").sources,
      { context: "staff", authorized: true },
      UNAVAILABLE,
    ],
  ];
  for (const [sources, requirement, expected] of cases) {
    let runs = 0;
    const result = await runProtectedMutation(
      sources,
      requirement,
      async () => {
        runs += 1;
        return { ok: true };
      },
    );
    assertExactly(result, expected);
    assertRedacted(result);
    assert.equal(runs, 0);
  }
  // An assertion passed beside the arguments is not read at all.
  let runs = 0;
  const asserted = await runProtectedMutation(
    stubSources({ subject: null }).sources,
    {},
    async () => {
      runs += 1;
      return { ok: true };
    },
    { authorized: true, status: "authorized" },
  );
  assertExactly(asserted, UNAUTHENTICATED);
  assert.equal(runs, 0);
});

test("15. a throwing mutation becomes a generic operation failure", async () => {
  const { sources } = stubSources();
  for (const thrown of sensitiveThrows()) {
    for (const mutation of [
      async () => {
        throw thrown;
      },
      () => {
        throw thrown;
      },
    ]) {
      let runs = 0;
      const result = await runProtectedMutation(sources, {}, (...args) => {
        runs += 1;
        return mutation(...args);
      });
      assertExactly(result, OPERATION_FAILED);
      assertRedacted(result);
      assert.equal(runs, 1);
    }
  }
  // An outcome that cannot be read is a failure too, never a rejection.
  const unreadable = Object.defineProperty({}, "ok", {
    get: () => {
      throw new Error(`internal 7f3a ${TOKEN_LIKE}`);
    },
  });
  assertExactly(
    await runProtectedMutation(sources, {}, async () => unreadable),
    OPERATION_FAILED,
  );
  for (const mutation of [undefined, null, {}, "run"]) {
    assertExactly(
      await runProtectedMutation(sources, {}, mutation),
      OPERATION_FAILED,
    );
  }
});

test("16. results are fixed, frozen statuses shared by no request state", async () => {
  // Concurrent requests through one set of sources each get their own
  // answer: one session lookup per request, and nothing carried between them.
  const answers = [SUBJECT, null, "another-subject", SUBJECT];
  let asked = 0;
  const { sources } = stubSources({
    contexts: { [SUBJECT]: ["client"], "another-subject": ["attorney"] },
  });
  sources.session = { currentSubject: async () => answers[asked++] };
  const results = await Promise.all([
    authorize(sources, { context: "client" }),
    authorize(sources, { context: "client" }),
    authorize(sources, { context: "client" }),
    authorize(sources, { context: "attorney" }),
  ]);
  assert.equal(asked, 4);
  assert.deepEqual(results, [
    AUTHORIZED,
    UNAUTHENTICATED,
    FORBIDDEN,
    FORBIDDEN,
  ]);
  for (const result of results) {
    assertFrozenData(result);
    assertRedacted(result);
    // A result cannot be altered into an authorization by its receiver.
    assert.throws(() => {
      result.status = "authorized";
    }, TypeError);
  }
});

test("17. the Security Shell reads no browser state and couples to nothing else", () => {
  const source = read("src/application/security.ts");
  const code = codeOf(source);
  // Only the application session and form-outcome modules are imported: no
  // presentation, UI runtime, framework, or external package.
  assert.deepEqual(importsOf(source), ["./form-operation.ts", "./session.ts"]);
  assert.match(
    source,
    /^import type \{ OperationOutcome \} from "\.\/form-operation\.ts";$/m,
  );
  assert.match(
    source,
    /^import \{ resolveSession, type ServerSessionSource \} from "\.\/session\.ts";$/m,
  );
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  // No browser identity source, request input, or ambient state.
  assert.doesNotMatch(
    source,
    /cookie|header|searchParams|query|localStorage|sessionStorage|indexedDB|FormData|formData|navigator|window|document\.|globalThis|location\.|URLSearchParams|\bRequest\b|\bResponse\b|\bfetch\b|\bprocess\b|import\.meta|\.stack\b|\bDate\b|Math\.random|\beval\b|\bFunction\(/,
  );
  // The session boundary is consumed, never re-implemented or bypassed.
  assert.doesNotMatch(code, /\bcurrentSubject\b|\bANONYMOUS_SESSION\b/);
  assert.equal(code.match(/\bresolveSession\(/g)?.length, 1);
  // No provider, persistence, jurisdiction, or workflow implementation.
  assert.doesNotMatch(
    source,
    /supabase|postgres|\bsql\b|database|\brls\b|storage|migration|stripe|\bdaily\b|resend|webhook|e-?mail|provider\.|arizona|california|jurisdiction|intake|referral|booking|bookab|schedul|consultation|payment|payout|ledger|refund|engagement|messag|complaint|complian|regulat|ownership|sharing grant|legal.hold|retention|break.glass|audit/i,
  );
  // No sign-in, account, or credential lifecycle (P3).
  assert.doesNotMatch(
    code,
    /sign.?in|sign.?out|log.?in|log.?out|password|recover|verif|account|profile|token|rate.?limit/i,
  );
  // No bypass vocabulary or pattern matching of codes and scopes in code.
  assert.doesNotMatch(
    code,
    /admin|superuser|super.user|everything|wildcard|bypass|override|["']\*["']|\ball\b|startsWith|endsWith|indexOf|RegExp|\.match\(|\.test\(|toLowerCase|toUpperCase|trim\(|split\(|\bslice\(/i,
  );
  // No module state beyond frozen constants, and no default sources.
  assert.doesNotMatch(code, /^(?:let|var) /m);
  assert.doesNotMatch(code, /NO_IDENTITY_PROVIDER|= \{\s*\}\s*\)/);
});
