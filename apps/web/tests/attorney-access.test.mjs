// Targeted P3-001 attorney access tests.
//
// The trusted Attorney principal source, the attorney workspace adapter, and
// the protected /attorney route run through the unchanged Security Shell
// against isolated synthetic Auth, session, and database stand-ins, and then
// through the installed @supabase/ssr and supabase-js clients against a
// synthetic in-memory Auth and REST API, reached only through the fetch each
// client is given. The route's own source is transpiled with the installed
// TypeScript compiler into a temporary directory outside the repository and
// rendered with the installed React server renderer; only its two trusted
// wiring imports and next/server's connection() are replaced, by recording
// stand-ins that delegate to the real trusted sources where a test says so.
// No real provider, account, credential, network, or database is contacted,
// nothing is written anywhere but that temporary directory, which is removed,
// and every value here is synthetic test data.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { types } from "node:util";

import { createServerClient } from "@supabase/ssr";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { resolveAttorneyWorkspaceAccess } from "../src/application/attorney-access.ts";
import { authorize } from "../src/application/security.ts";
import {
  ATTORNEY_PRINCIPAL_SOURCE,
  createAttorneyPrincipalSource,
} from "../src/infrastructure/identity/attorney-principal-source.ts";
import { createClientPrincipalSource } from "../src/infrastructure/identity/client-principal-source.ts";
import { createSupabaseServerSessionSource } from "../src/infrastructure/identity/server-session-source.ts";

const appRoot = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
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

// A value as plain data: its prototype and every own property, of it and of
// each object it holds, so nothing hidden can travel with a result.
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

function assertExactly(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assert.deepEqual(ownData(actual), ownData(expected), message);
  assertFrozenData(actual);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

// Synthetic, test-only values. None is a real account or credential.
const SUBJECT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const USER_ID = "00000000-0000-4000-8000-0000000010a1";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000010a2";
const PROFILE_ID = "00000000-0000-4000-8000-0000000030a1";
const OTHER_PROFILE_ID = "00000000-0000-4000-8000-0000000030a2";
const CLIENT_PROFILE_ID = "00000000-0000-4000-8000-0000000020a1";
const CONFIRMED_AT = "2026-10-31T00:00:00Z";
const EMAIL = "attorney@synthetic.invalid";
const DETAIL = "internal 7f3a";
const FIXED_MESSAGE = "The Attorney principal could not be resolved.";

const ADMITTED = Object.freeze(["applicant", "under_review", "approved"]);

const AUTHORIZED = { status: "authorized" };
const FORBIDDEN = { status: "forbidden" };
const UNAVAILABLE = { status: "unavailable" };
const UNAUTHENTICATED = { status: "unauthenticated" };

const NO_ATTORNEY = { contexts: [], stage: null };
const GRANTED = (stage) => ({ status: "granted", stage });
const SIGN_IN_REQUIRED = { status: "sign-in-required" };
const DENIED = { status: "denied" };
const WORKSPACE_UNAVAILABLE = { status: "unavailable" };

const rows = (data) => ({ data, error: null });
const activeUser = (overrides = {}) => ({
  id: USER_ID,
  auth_user_id: SUBJECT,
  account_state: "active",
  ...overrides,
});
const attorneyProfile = (overrides = {}) => ({
  id: PROFILE_ID,
  user_id: USER_ID,
  profile_state: "applicant",
  ...overrides,
});
const clientProfile = (overrides = {}) => ({
  id: CLIENT_PROFILE_ID,
  user_id: USER_ID,
  ...overrides,
});
const withState = (profile_state) => ({
  attorneys: rows([attorneyProfile({ profile_state })]),
});

// A request-scoped read client stand-in. Each query resolves on limit(), as
// the installed builder does when awaited, and offers no write method at all.
// An answer may be a result, an Error to throw, or a function producing the
// answer. Every call is recorded.
function readClient({
  user = { id: SUBJECT, email: EMAIL, email_confirmed_at: CONFIRMED_AT },
  auth = null,
  users = rows([activeUser()]),
  attorneys = rows([attorneyProfile()]),
  clients = rows([clientProfile()]),
} = {}) {
  const calls = [];
  const answers = {
    users,
    attorney_profiles: attorneys,
    client_profiles: clients,
  };
  const answer = async (value) => {
    if (typeof value === "function") {
      return value();
    }
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  const query = (table) => {
    const steps = [];
    const builder = {
      select: (columns) => {
        steps.push(["select", columns]);
        return builder;
      },
      eq: (column, value) => {
        steps.push(["eq", column, value]);
        return builder;
      },
      limit: async (count) => {
        steps.push(["limit", count]);
        calls.push([table, steps]);
        return answer(answers[table]);
      },
    };
    return builder;
  };
  return {
    calls,
    answers,
    client: {
      auth: {
        getUser: async (...args) => {
          calls.push(["getUser", ...args]);
          return answer(auth ?? { data: { user }, error: null });
        },
      },
      from: query,
    },
  };
}

function sourceOver(stand, deadline) {
  let built = 0;
  return {
    built: () => built,
    source: createAttorneyPrincipalSource(async () => {
      built += 1;
      return stand.client;
    }, deadline),
  };
}

function sourcesFor(contexts, subject = SUBJECT) {
  return {
    session: { currentSubject: async () => subject },
    contexts,
    capabilities: { isGranted: async () => false },
  };
}

function workspaceFor(attorney, subject = SUBJECT) {
  return {
    session: { currentSubject: async () => subject },
    attorney,
  };
}

const EXPECTED_READS = Object.freeze([
  ["getUser"],
  [
    "users",
    [
      ["select", "id, auth_user_id, account_state"],
      ["eq", "auth_user_id", SUBJECT],
      ["limit", 2],
    ],
  ],
  [
    "attorney_profiles",
    [
      ["select", "id, user_id, profile_state"],
      ["eq", "user_id", USER_ID],
      ["limit", 2],
    ],
  ],
]);

async function assertFixedRejection(promise, name) {
  await assert.rejects(
    promise,
    (error) => {
      // The thrown value is fixed and carries no provider detail.
      assert.ok(error instanceof Error, name);
      assert.equal(error.message, FIXED_MESSAGE, name);
      assert.equal(String(error).includes("7f3a"), false, name);
      assert.equal(error.cause, undefined, name);
      return true;
    },
    name,
  );
}

// ---------------------------------------------------------------------------
// The trusted Attorney principal source and the Security Shell.
// ---------------------------------------------------------------------------

test("1. a confirmed, same-subject Auth read, one active User, and exactly one linked Attorney Profile in each admitted state hold the limited attorney context", async () => {
  for (const stage of ADMITTED) {
    const stand = readClient(withState(stage));
    const { source, built } = sourceOver(stand);
    const principal = await source.principalOf(SUBJECT);
    assertExactly(principal, { contexts: ["attorney"], stage }, stage);
    // Only the context and the admitted stage: no verification, eligibility,
    // bookability, identifier, or record travels with it.
    assert.deepEqual(Object.keys(principal), ["contexts", "stage"], stage);
    // A fresh Auth user read, then the exact-key User and profile reads.
    assert.deepEqual(stand.calls, EXPECTED_READS, stage);
    stand.calls.length = 0;
    const contexts = await source.contextsOf(SUBJECT);
    assertExactly(contexts, ["attorney"], stage);
    assert.deepEqual(stand.calls, EXPECTED_READS, stage);
    // Through the unchanged Security Shell, and through the adapter.
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "attorney" }),
      AUTHORIZED,
      stage,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
      GRANTED(stage),
      stage,
    );
    assert.equal(built(), 4, stage);
  }
});

test("2. an anonymous request is refused before the source is asked", async () => {
  const stand = readClient(withState("approved"));
  const { source, built } = sourceOver(stand);
  assert.deepEqual(
    await authorize(sourcesFor(source, null), { context: "attorney" }),
    UNAUTHENTICATED,
  );
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(source, null)),
    SIGN_IN_REQUIRED,
  );
  assert.equal(built(), 0);
  assert.deepEqual(stand.calls, []);
  // A blank subject names nobody: it is unavailable, and nothing is read.
  await assertFixedRejection(source.principalOf(""), "blank subject");
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(source, "")),
    WORKSPACE_UNAVAILABLE,
  );
  assert.equal(built(), 0);
  assert.deepEqual(stand.calls, []);
});

test("3. another account, an unconfirmed email, a missing or non-active User, no Attorney Profile, or a suspended or removed one holds no attorney context", async () => {
  const cases = {
    "Auth read names another account (wrong identity)": {
      user: { id: OTHER, email_confirmed_at: CONFIRMED_AT },
      reads: 1,
    },
    "email not confirmed": {
      user: { id: SUBJECT, email_confirmed_at: null },
      reads: 1,
    },
    "empty confirmation time": {
      user: { id: SUBJECT, email_confirmed_at: "" },
      reads: 1,
    },
    "confirmation time missing": { user: { id: SUBJECT }, reads: 1 },
    "confirmation time not text": {
      user: { id: SUBJECT, email_confirmed_at: 1 },
      reads: 1,
    },
    "no User (session alone)": { users: rows([]), reads: 2 },
    "pending_verification User": {
      users: rows([activeUser({ account_state: "pending_verification" })]),
      reads: 2,
    },
    "suspended User": {
      users: rows([activeUser({ account_state: "suspended" })]),
      reads: 2,
    },
    "closed User": {
      users: rows([activeUser({ account_state: "closed" })]),
      reads: 2,
    },
    "client-only User without an Attorney Profile": {
      attorneys: rows([]),
      reads: 3,
    },
    "staff-only User without an Attorney Profile": {
      attorneys: rows([]),
      clients: rows([]),
      reads: 3,
    },
    "suspended Attorney Profile with an active User": {
      ...withState("suspended"),
      reads: 3,
    },
    "removed Attorney Profile with an active User": {
      ...withState("removed"),
      reads: 3,
    },
  };
  for (const [name, { reads, ...options }] of Object.entries(cases)) {
    const stand = readClient(options);
    const before = JSON.stringify(stand.answers);
    const { source } = sourceOver(stand);
    assertExactly(await source.principalOf(SUBJECT), NO_ATTORNEY, name);
    // Reading stops at the definite absence, and only reads were made.
    assert.deepEqual(stand.calls, EXPECTED_READS.slice(0, reads), name);
    assertExactly(await source.contextsOf(SUBJECT), [], name);
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "attorney" }),
      FORBIDDEN,
      name,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
      DENIED,
      name,
    );
    // Denial changes no User or profile.
    assert.equal(JSON.stringify(stand.answers), before, name);
  }
});

test("4. anything unreadable, malformed, multiple, inconsistent, or of an unknown state fails closed with a fixed error, and the Security Shell reports it as unavailable", async () => {
  const cases = {
    "Auth error": { auth: { data: { user: null }, error: new Error(DETAIL) } },
    "Auth read throws": { auth: new Error(DETAIL) },
    "no Auth user": { auth: { data: { user: null }, error: null } },
    "malformed Auth answer": { auth: { data: null, error: null } },
    "Auth user not a record": { auth: { data: { user: [SUBJECT] } } },
    "User query error": { users: { data: null, error: { message: DETAIL } } },
    "User query throws": { users: new Error(DETAIL) },
    "User rows not a list": { users: rows(activeUser()) },
    "two Users": {
      users: rows([activeUser(), activeUser({ id: OTHER_USER_ID })]),
    },
    "User linked to another account": {
      users: rows([activeUser({ auth_user_id: OTHER })]),
    },
    "User without an id": { users: rows([activeUser({ id: undefined })]) },
    "User with an empty id": { users: rows([activeUser({ id: "" })]) },
    "malformed User row": { users: rows(["active"]) },
    "unknown User state": {
      users: rows([activeUser({ account_state: "ACTIVE" })]),
    },
    "null User state": { users: rows([activeUser({ account_state: null })]) },
    "nonstring User state": {
      users: rows([activeUser({ account_state: 1 })]),
    },
    "Attorney Profile query error": {
      attorneys: { data: null, error: { message: DETAIL } },
    },
    "Attorney Profile query throws": { attorneys: new Error(DETAIL) },
    "Attorney Profile rows not a list": {
      attorneys: rows(attorneyProfile({ profile_state: "approved" })),
    },
    "two Attorney Profiles": {
      attorneys: rows([
        attorneyProfile({ profile_state: "approved" }),
        attorneyProfile({ id: OTHER_PROFILE_ID, profile_state: "approved" }),
      ]),
    },
    "another User's Attorney Profile (cross-attorney)": {
      attorneys: rows([
        attorneyProfile({
          id: OTHER_PROFILE_ID,
          user_id: OTHER_USER_ID,
          profile_state: "approved",
        }),
      ]),
    },
    "Attorney Profile without an id": {
      attorneys: rows([attorneyProfile({ id: null })]),
    },
    "malformed Attorney Profile row": { attorneys: rows(["approved"]) },
    "Attorney Profile state missing": {
      attorneys: rows([{ id: PROFILE_ID, user_id: USER_ID }]),
    },
  };
  // No Attorney Profile state named active exists; neither do these.
  for (const state of [
    "active",
    "APPROVED",
    "Approved",
    " approved",
    "approved ",
    "verified",
    "eligible",
    "bookable",
    "",
    null,
    0,
    1,
    true,
    ["approved"],
    { state: "approved" },
  ]) {
    cases[`profile state ${JSON.stringify(state)}`] = withState(state);
  }
  for (const [name, options] of Object.entries(cases)) {
    const stand = readClient(options);
    const { source } = sourceOver(stand);
    await assertFixedRejection(source.principalOf(SUBJECT), name);
    await assertFixedRejection(source.contextsOf(SUBJECT), name);
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "attorney" }),
      UNAVAILABLE,
      name,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
      WORKSPACE_UNAVAILABLE,
      name,
    );
    // Only reads were made, whatever failed.
    for (const call of stand.calls) {
      assert.ok(
        ["getUser", "users", "attorney_profiles"].includes(call[0]),
        name,
      );
    }
  }
  // An unconfigured, failing, or malformed read client is unavailable too.
  for (const clientSource of [
    async () => null,
    async () => {
      throw new Error(DETAIL);
    },
    () => {
      throw new Error(DETAIL);
    },
    async () => ({}),
    async () => ({ auth: {} }),
  ]) {
    const source = createAttorneyPrincipalSource(clientSource);
    await assertFixedRejection(source.principalOf(SUBJECT), "client source");
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "attorney" }),
      UNAVAILABLE,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
      WORKSPACE_UNAVAILABLE,
    );
  }
});

test("5. a provider that times out or never answers is unavailable within the deadline, and a late answer is ignored", async () => {
  const timeout = () =>
    Promise.reject(new DOMException(DETAIL, "TimeoutError"));
  const aborted = () => Promise.reject(new DOMException(DETAIL, "AbortError"));
  const cases = {
    "Auth read never answers": { auth: never },
    "User read never answers": { users: never },
    "Attorney Profile read never answers": { attorneys: never },
    "Auth read times out": { auth: timeout },
    "User read times out": { users: timeout },
    "Attorney Profile read times out": { attorneys: timeout },
    "Attorney Profile read is aborted": { attorneys: aborted },
  };
  for (const [name, options] of Object.entries(cases)) {
    const stand = readClient({ ...withState("approved"), ...options });
    const { source } = sourceOver(stand, 25);
    const started = performance.now();
    await assertFixedRejection(source.principalOf(SUBJECT), name);
    assert.ok(performance.now() - started < 2000, name);
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
      WORKSPACE_UNAVAILABLE,
      name,
    );
  }
  // A read client that never arrives is unavailable as well.
  const stalled = createAttorneyPrincipalSource(never, 25);
  await assertFixedRejection(stalled.principalOf(SUBJECT), "stalled client");
  // An admitted answer that arrives after the deadline grants nothing.
  const late = readClient({
    ...withState("approved"),
    auth: async () => {
      await delay(60);
      return {
        data: { user: { id: SUBJECT, email_confirmed_at: CONFIRMED_AT } },
        error: null,
      };
    },
  });
  const { source } = sourceOver(late, 20);
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
    WORKSPACE_UNAVAILABLE,
  );
  await delay(80);
  // The default deadline is a positive whole number of milliseconds, and no
  // other deadline is accepted.
  for (const deadline of [0, -1, 1.5, Number.NaN, Infinity, "25", null]) {
    assert.throws(
      () => createAttorneyPrincipalSource(async () => null, deadline),
      TypeError,
      String(deadline),
    );
  }
  assert.match(
    codeOf(read("src/infrastructure/identity/attorney-principal-source.ts")),
    /^const RESOLUTION_DEADLINE_MS = \d+;$/m,
  );
});

test("6. the attorney context stands beside an independently authorized Client context: neither excludes nor revokes the other", async () => {
  const combined = (stand) => {
    const client = createClientPrincipalSource(async () => stand.client);
    const attorney = createAttorneyPrincipalSource(async () => stand.client);
    return {
      attorney,
      contexts: {
        contextsOf: async (subject) => [
          ...(await client.contextsOf(subject)),
          ...(await attorney.contextsOf(subject)),
        ],
      },
    };
  };
  const expectations = [
    ["approved", rows([clientProfile()]), AUTHORIZED, AUTHORIZED],
    ["applicant", rows([clientProfile()]), AUTHORIZED, AUTHORIZED],
    ["under_review", rows([]), FORBIDDEN, AUTHORIZED],
    ["suspended", rows([clientProfile()]), AUTHORIZED, FORBIDDEN],
    ["removed", rows([clientProfile()]), AUTHORIZED, FORBIDDEN],
  ];
  for (const [state, clients, client, attorney] of expectations) {
    const stand = readClient({ ...withState(state), clients });
    const before = JSON.stringify(stand.answers);
    const sources = combined(stand);
    assert.deepEqual(
      await authorize(sourcesFor(sources.contexts), { context: "client" }),
      client,
      state,
    );
    assert.deepEqual(
      await authorize(sourcesFor(sources.contexts), { context: "attorney" }),
      attorney,
      state,
    );
    assert.deepEqual(
      await authorize(sourcesFor(sources.contexts), { context: "staff" }),
      FORBIDDEN,
      state,
    );
    // Denying the workspace leaves the Client context exactly as it was.
    const workspace = await resolveAttorneyWorkspaceAccess(
      workspaceFor(sources.attorney),
    );
    assertExactly(
      workspace,
      attorney === AUTHORIZED ? GRANTED(state) : DENIED,
      state,
    );
    assert.deepEqual(
      await authorize(sourcesFor(sources.contexts), { context: "client" }),
      client,
      state,
    );
    assert.equal(JSON.stringify(stand.answers), before, state);
  }
  // On its own the attorney source never reads a Client profile and reports
  // only the attorney context: never client or staff, and no capability.
  for (const stage of ADMITTED) {
    const stand = readClient(withState(stage));
    const { source } = sourceOver(stand);
    for (const context of ["client", "staff"]) {
      assert.deepEqual(
        await authorize(sourcesFor(source), { context }),
        FORBIDDEN,
        `${stage} ${context}`,
      );
    }
    assert.deepEqual(
      await authorize(sourcesFor(source), {
        context: "attorney",
        capability: { capability: "synthetic.capability", scope: "synthetic" },
      }),
      FORBIDDEN,
      stage,
    );
    assert.ok(
      stand.calls.every((call) => call[0] !== "client_profiles"),
      stage,
    );
  }
});

test("7. Auth metadata, email text, User fields, and browser-shaped claims never establish the attorney context", async () => {
  for (const user of [
    {
      id: OTHER,
      email: EMAIL,
      email_confirmed_at: CONFIRMED_AT,
      user_metadata: {
        role: "attorney",
        auth_user_id: SUBJECT,
        profile_state: "approved",
      },
    },
    {
      id: OTHER,
      email_confirmed_at: CONFIRMED_AT,
      app_metadata: { contexts: ["attorney"], role: "attorney" },
      sub: SUBJECT,
    },
  ]) {
    const stand = readClient({ user, ...withState("approved") });
    const { source } = sourceOver(stand);
    assertExactly(await source.principalOf(SUBJECT), NO_ATTORNEY);
    // No database read follows an Auth read for another account.
    assert.deepEqual(stand.calls, [["getUser"]]);
  }
  // Metadata on the confirmed account itself, or a role-like field on its
  // User row, is not an Attorney Profile.
  const claimed = readClient({
    user: {
      id: SUBJECT,
      email: EMAIL,
      email_confirmed_at: CONFIRMED_AT,
      app_metadata: { role: "attorney", profile_state: "approved" },
      user_metadata: { attorney: true },
    },
    users: rows([activeUser({ role: "attorney", attorney: true })]),
    attorneys: rows([]),
  });
  assertExactly(
    await sourceOver(claimed).source.principalOf(SUBJECT),
    NO_ATTORNEY,
  );
  // The subject comes from the trusted session boundary; a session that
  // reports another subject than the Auth read is not the attorney.
  const stand = readClient(withState("approved"));
  const { source } = sourceOver(stand);
  assert.deepEqual(
    await authorize(sourcesFor(source, OTHER), { context: "attorney" }),
    FORBIDDEN,
  );
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(source, OTHER)),
    DENIED,
  );
  // The Auth read is the request's own session: no identifier is passed in.
  assert.ok(
    stand.calls.every((call) => call[0] !== "getUser" || call.length === 1),
  );
});

test("8. reads are keyed only by the trusted subject and the User row it names, so cross-user and cross-attorney identifiers fail closed", async () => {
  // Another confirmed account whose session and Auth read agree reads with
  // its own subject; a User row for someone else fails closed.
  const stand = readClient({
    user: { id: OTHER, email_confirmed_at: CONFIRMED_AT },
    users: rows([activeUser()]),
    ...withState("approved"),
  });
  const { source } = sourceOver(stand);
  assert.deepEqual(
    await authorize(sourcesFor(source, OTHER), { context: "attorney" }),
    UNAVAILABLE,
  );
  assert.deepEqual(stand.calls[1], [
    "users",
    [
      ["select", "id, auth_user_id, account_state"],
      ["eq", "auth_user_id", OTHER],
      ["limit", 2],
    ],
  ]);
  // A reviewer-visible Attorney Profile of another User, returned beside or
  // instead of the subject's own, never lends its state.
  for (const attorneys of [
    rows([
      attorneyProfile({
        id: OTHER_PROFILE_ID,
        user_id: OTHER_USER_ID,
        profile_state: "approved",
      }),
    ]),
    rows([
      attorneyProfile({ profile_state: "suspended" }),
      attorneyProfile({
        id: OTHER_PROFILE_ID,
        user_id: OTHER_USER_ID,
        profile_state: "approved",
      }),
    ]),
  ]) {
    const crossed = readClient({ attorneys });
    const { source: crossedSource } = sourceOver(crossed);
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(crossedSource)),
      WORKSPACE_UNAVAILABLE,
    );
    assert.deepEqual(crossed.calls[2][1][1], ["eq", "user_id", USER_ID]);
  }
});

test("9. each request reads afresh through its own client: nothing is cached, shared, or carried between requests", async () => {
  const stands = {
    approved: readClient(withState("approved")),
    suspended: readClient(withState("suspended")),
    applicant: readClient(withState("applicant")),
    failing: readClient({ attorneys: new Error(DETAIL) }),
  };
  let current = stands.approved;
  let built = 0;
  const source = createAttorneyPrincipalSource(async () => {
    built += 1;
    return current.client;
  });
  const expected = [
    ["approved", GRANTED("approved")],
    ["suspended", DENIED],
    ["approved", GRANTED("approved")],
    ["failing", WORKSPACE_UNAVAILABLE],
    ["applicant", GRANTED("applicant")],
    ["approved", GRANTED("approved")],
  ];
  for (const [name, access] of expected) {
    current = stands[name];
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(source)),
      access,
      name,
    );
  }
  assert.equal(built, expected.length);
  // Concurrent requests each see only their own read.
  const order = [
    stands.approved,
    stands.suspended,
    stands.failing,
    stands.applicant,
  ];
  let next = 0;
  const concurrent = createAttorneyPrincipalSource(async () => {
    const stand = order[next];
    next += 1;
    await delay(5 * (order.length - next));
    return stand.client;
  });
  assert.deepEqual(
    await Promise.all(
      order.map(() => resolveAttorneyWorkspaceAccess(workspaceFor(concurrent))),
    ),
    [GRANTED("approved"), DENIED, WORKSPACE_UNAVAILABLE, GRANTED("applicant")],
  );
  for (const candidate of [source, ATTORNEY_PRINCIPAL_SOURCE]) {
    assert.ok(Object.isFrozen(candidate));
    assert.deepEqual(Object.keys(candidate), ["contextsOf", "principalOf"]);
  }
});

// ---------------------------------------------------------------------------
// The attorney workspace adapter.
// ---------------------------------------------------------------------------

function principalStub(answer) {
  const log = [];
  return {
    log,
    source: {
      contextsOf: async () => {
        log.push("contextsOf");
        throw new Error(DETAIL);
      },
      principalOf: async (...args) => {
        log.push(["principalOf", ...args]);
        return typeof answer === "function" ? answer() : answer;
      },
    },
  };
}

test("10. the adapter reads the principal once per request and maps every outcome to a fixed, non-leaking workspace state", async () => {
  for (const stage of ADMITTED) {
    const stub = principalStub({ contexts: ["attorney"], stage });
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(stub.source)),
      GRANTED(stage),
      stage,
    );
    // Exactly one read, for the trusted subject; the stage shown is the one
    // from that same read.
    assert.deepEqual(stub.log, [["principalOf", SUBJECT]], stage);
  }
  const none = principalStub({ contexts: [], stage: null });
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(none.source)),
    DENIED,
  );
  assert.deepEqual(none.log, [["principalOf", SUBJECT]]);
  // Anything but the two consistent answers is unavailable.
  const accessor = { contexts: ["attorney"] };
  Object.defineProperty(accessor, "stage", {
    enumerable: true,
    get: () => "approved",
  });
  const malformed = {
    "attorney context without a stage": { contexts: ["attorney"], stage: null },
    "stage without the attorney context": { contexts: [], stage: "approved" },
    "a client context": { contexts: ["client"], stage: null },
    "an extra context": {
      contexts: ["attorney", "client"],
      stage: "approved",
    },
    "a repeated context": {
      contexts: ["attorney", "attorney"],
      stage: "approved",
    },
    "a refused stage": { contexts: ["attorney"], stage: "suspended" },
    "an unknown stage": { contexts: ["attorney"], stage: "APPROVED" },
    "contexts not a list": { contexts: "attorney", stage: "approved" },
    "an added verification field": {
      contexts: ["attorney"],
      stage: "approved",
      verified: true,
    },
    "a missing stage": { contexts: ["attorney"] },
    "an accessor stage": accessor,
    null: null,
    undefined: undefined,
    "a string": "attorney",
    "a list": ["attorney"],
  };
  for (const [name, answer] of Object.entries(malformed)) {
    const stub = principalStub(answer);
    assertExactly(
      await resolveAttorneyWorkspaceAccess(workspaceFor(stub.source)),
      WORKSPACE_UNAVAILABLE,
      name,
    );
    assert.deepEqual(stub.log, [["principalOf", SUBJECT]], name);
  }
  // A failing principal read, session, or wiring is unavailable; the adapter
  // never throws.
  const failing = principalStub(() => {
    throw new Error(DETAIL);
  });
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(failing.source)),
    WORKSPACE_UNAVAILABLE,
  );
  const granted = principalStub({ contexts: ["attorney"], stage: "approved" });
  for (const session of [
    {
      currentSubject: async () => {
        throw new Error(DETAIL);
      },
    },
    { currentSubject: async () => 7 },
    {},
    null,
  ]) {
    assertExactly(
      await resolveAttorneyWorkspaceAccess({
        session,
        attorney: granted.source,
      }),
      WORKSPACE_UNAVAILABLE,
    );
  }
  for (const sources of [
    undefined,
    null,
    {},
    { session: { currentSubject: async () => SUBJECT } },
    {
      session: { currentSubject: async () => SUBJECT },
      attorney: { contextsOf: async () => ["attorney"] },
    },
  ]) {
    assertExactly(
      await resolveAttorneyWorkspaceAccess(sources),
      WORKSPACE_UNAVAILABLE,
    );
  }
  assert.deepEqual(granted.log, []);
  // An anonymous request never reaches the principal source.
  const anonymous = principalStub({
    contexts: ["attorney"],
    stage: "approved",
  });
  assertExactly(
    await resolveAttorneyWorkspaceAccess(workspaceFor(anonymous.source, null)),
    SIGN_IN_REQUIRED,
  );
  assert.deepEqual(anonymous.log, []);
});

// ---------------------------------------------------------------------------
// Module contracts.
// ---------------------------------------------------------------------------

test("11. the source module is unprivileged, read-only, attorney-only, and loads the request-scoped client only when asked", () => {
  const file = "src/infrastructure/identity/attorney-principal-source.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "@supabase/supabase-js",
    "../../application/attorney-access.ts",
    "../../application/security.ts",
  ]);
  assert.match(
    code,
    /^import type \{ SupabaseClient \} from "@supabase\/supabase-js";$/m,
  );
  assert.match(
    code,
    /^import type \{ PrincipalContext \} from "\.\.\/\.\.\/application\/security\.ts";$/m,
  );
  assert.match(code, /await import\("\.\/supabase-server\.ts"\)/);
  assert.equal(code.match(/\bimport\s*\(/g).length, 1);
  assert.doesNotMatch(
    code,
    /registration-|client-principal-source|ROSUNO_SUPABASE|service_role|sb_secret_|createClient\b|createServerClient|process\.env|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\brpc\b|admin|\bconsole\b|cookies|headers|getSession|getClaims|user_metadata|app_metadata|\.email\b|\brole\b|searchParams|globalThis|localStorage/,
  );
  assert.deepEqual(
    [...code.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]),
    ["users", "attorney_profiles"],
  );
  assert.deepEqual(
    [...code.matchAll(/\.select\("([^"]+)"\)/g)].map((match) => match[1]),
    ["id, auth_user_id, account_state", "id, user_id, profile_state"],
  );
  assert.deepEqual(
    [...code.matchAll(/\.eq\(([^)]*)\)/g)].map((match) => match[1]),
    ['"auth_user_id", subject', '"user_id", user.id'],
  );
  assert.equal(code.match(/\.limit\(2\)/g).length, 2);
  assert.equal(code.match(/\.getUser\(\)/g).length, 1);
  assert.deepEqual(
    [...code.matchAll(/^export (?:const|function) (\w+)/gm)].map(
      (match) => match[1],
    ),
    ["createAttorneyPrincipalSource", "ATTORNEY_PRINCIPAL_SOURCE"],
  );
  // The only context it can report is the attorney context, and the only
  // User state it admits is active.
  assert.doesNotMatch(
    code,
    /"client"|"staff"|client_profiles|staff_profiles|isGranted|capabilit/i,
  );
  assert.equal(code.match(/"attorney"/g).length, 1);
  assert.equal(code.match(/"active"/g).length, 1);
  assert.match(code, /user\.account_state !== "active"/);
  assert.match(
    code,
    /const REFUSED_PROFILE_STATES = Object\.freeze\(\["suspended", "removed"\] as const\);/,
  );
  assert.match(
    code,
    /const INACTIVE_ACCOUNT_STATES = Object\.freeze\(\[\n {2}"pending_verification",\n {2}"suspended",\n {2}"closed",\n\] as const\);/,
  );
  // The unchanged Security Shell is consumed as it is.
  assert.match(
    read("src/application/security.ts"),
    /export async function authorize\(/,
  );
});

test("12. the adapter is provider-neutral, holds no state, grants no capability, and decides no verification or eligibility", () => {
  const file = "src/application/attorney-access.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), ["./security.ts", "./session.ts"]);
  assert.match(
    code,
    /^import type \{ ServerSessionSource \} from "\.\/session\.ts";$/m,
  );
  assert.doesNotMatch(
    code,
    /\bimport\s*\(|\brequire\s*\(|next|react|supabase|postgres|\bprocess\b|\bconsole\b|\bfetch\s*\(|cookie|header|localStorage|sessionStorage|globalThis|\bwindow\b|\bdocument\b|Math\.random|\bDate\b|setTimeout/i,
  );
  assert.doesNotMatch(code, /^(?:let|var) /m);
  assert.doesNotMatch(
    code,
    /verif|eligib|bookab|consult|payment|licen[cs]e|\.from\(|insert|update|"client"|"staff"/i,
  );
  assert.deepEqual(
    [
      ...code.matchAll(
        /^export (?:async function|function|const|type) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    [
      "AttorneyWorkspaceStage",
      "AttorneyPrincipal",
      "AttorneyPrincipalSource",
      "AttorneyWorkspaceSources",
      "AttorneyWorkspaceAccess",
      "isAttorneyWorkspaceStage",
      "resolveAttorneyWorkspaceAccess",
    ],
  );
  // The three admitted stages, the attorney requirement alone, and a
  // capability port that grants nothing.
  assert.match(
    code,
    /const WORKSPACE_STAGES = Object\.freeze\(\[\n {2}"applicant",\n {2}"under_review",\n {2}"approved",\n\] as const\);/,
  );
  assert.match(
    code,
    /const ATTORNEY_REQUIREMENT: SecurityRequirement = Object\.freeze\(\{\n {2}context: "attorney",\n\}\);/,
  );
  assert.match(code, /isGranted: async \(\) => false,/);
  assert.equal(code.match(/\bauthorize\(/g).length, 1);
  assert.equal(code.match(/\.principalOf\(/g).length, 1);
  assert.doesNotMatch(code, /attorney\.contextsOf|\.isGranted\(/);
});

test("13. the route is a server-rendered, parameter-free page that reads access only through the trusted wiring", () => {
  const file = "app/attorney/page.tsx";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "next",
    "next/server",
    "react",
    "../../src/application/attorney-access.ts",
    "../../src/infrastructure/identity/attorney-principal-source.ts",
    "../../src/infrastructure/identity/server-session-source.ts",
    "../../src/presentation/design-system.tsx",
  ]);
  assert.match(code, /^import type \{ Metadata \} from "next";$/m);
  assert.match(code, /^import \{ connection \} from "next\/server";$/m);
  assert.match(code, /^import type \{ ReactNode \} from "react";$/m);
  // A server component: no client or server-action directive.
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  // It exports only its metadata and the parameter-free page.
  assert.deepEqual(
    [
      ...code.matchAll(
        /^export (?:default )?(?:async )?(?:function|const) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    ["metadata", "AttorneyWorkspacePage"],
  );
  assert.equal(code.match(/\bexport\b/g).length, 2);
  assert.match(
    code,
    /^export default async function AttorneyWorkspacePage\(\) \{$/m,
  );
  assert.match(code, /robots: \{ index: false, follow: false \},/);
  // Each request opts out of prerendering before access is read, through the
  // trusted session and attorney sources and nothing else.
  const resolve =
    "await resolveAttorneyWorkspaceAccess({\n    session: SUPABASE_SERVER_SESSION_SOURCE,\n    attorney: ATTORNEY_PRINCIPAL_SOURCE,\n  });";
  assert.equal(code.split("await connection();").length, 2);
  assert.equal(code.split(resolve).length, 2);
  assert.ok(code.indexOf("await connection();") < code.indexOf(resolve));
  assert.equal(code.match(/resolveAttorneyWorkspaceAccess\(/g).length, 1);
  assert.doesNotMatch(
    code,
    /searchParams|\bparams\b|headers\(|cookies\(|redirect|notFound|next\/navigation|useActionState|useState|useEffect|<form|\baction=|TextField|TextAreaField|SelectField|Choice|<Button\b|<Dialog|dangerouslySetInnerHTML|process\.env|\bconsole\b|createSupabaseServerClient|\.from\(|getUser|getClaims|\.insert\(|\.update\(|\.upsert\(|\.delete\(|localStorage|sessionStorage|window\.|document\.|\bfetch\s*\(/,
  );
  // Fixed destinations only: the home page, the existing sign-in, and the
  // P3-002 attorney application entry, linked once, from the refusal state.
  assert.deepEqual(
    [...new Set([...code.matchAll(/href="([^"]*)"/g)].map((m) => m[1]))],
    ["/", "/sign-in", "/attorney/apply"],
  );
  assert.equal(code.match(/href="\/attorney\/apply"/g).length, 1);
  assert.doesNotMatch(code, /href=\{/);
  // Design-system primitives and native table structure only.
  const lowercaseTags = new Set(
    [...code.matchAll(/<([a-z][a-z0-9]*)\b/g)].map((match) => match[1]),
  );
  assert.deepEqual([...lowercaseTags].sort(), [
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
  ]);
  for (const header of code.match(/<th\b[^>]*>/g)) {
    assert.match(header, /scope="(?:col|row)"/);
  }
  assert.match(
    code,
    /const STAGE_LABELS: Readonly<Record<AttorneyWorkspaceStage, string>> = \{\n {2}applicant: "Applicant",\n {2}under_review: "Under review",\n {2}approved: "Approved \(record stage only\)",\n\};/,
  );
});

// ---------------------------------------------------------------------------
// The route, rendered from its own source.
// ---------------------------------------------------------------------------

const WIRING_STUB = `export const wiring = { session: null, attorney: null, log: [] };
export const SUPABASE_SERVER_SESSION_SOURCE = Object.freeze({
  currentSubject: async () => {
    wiring.log.push("session");
    return wiring.session.currentSubject();
  },
});
export const ATTORNEY_PRINCIPAL_SOURCE = Object.freeze({
  contextsOf: async (subject) => {
    wiring.log.push("contexts");
    return wiring.attorney.contextsOf(subject);
  },
  principalOf: async (subject) => {
    wiring.log.push("principal");
    return wiring.attorney.principalOf(subject);
  },
});
`;

const NEXT_SERVER_STUB = `import { wiring } from "./wiring.mjs";
export async function connection() {
  wiring.log.push("connection");
}
`;

function transpile(source, fileName) {
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(output.diagnostics, [], fileName);
  return output.outputText;
}

// Points each import of a transpiled module at its target. Every import must
// have one, and every target must be used, so the route's imports stay exact.
function relink(code, targets) {
  const seen = new Set();
  const linked = code.replace(
    /(\bfrom\s+|\bimport\s+)"([^"]+)"/g,
    (_match, keyword, specifier) => {
      assert.ok(Object.hasOwn(targets, specifier), specifier);
      seen.add(specifier);
      return `${keyword}"${targets[specifier]}"`;
    },
  );
  assert.deepEqual([...seen].sort(), Object.keys(targets).sort());
  return linked;
}

async function buildPageHarness() {
  const directory = mkdtempSync(join(tmpdir(), "rosuno-p3-001-"));
  const target = (name) => pathToFileURL(join(directory, name)).href;
  const write = (name, text) => writeFileSync(join(directory, name), text);
  const jsxRuntime = import.meta.resolve("react/jsx-runtime");
  write("wiring.mjs", WIRING_STUB);
  write("next-server.mjs", NEXT_SERVER_STUB);
  write(
    "design-system.mjs",
    relink(
      transpile(read("src/presentation/design-system.tsx"), "design.tsx"),
      { "react/jsx-runtime": jsxRuntime },
    ),
  );
  write(
    "page.mjs",
    relink(transpile(read("app/attorney/page.tsx"), "page.tsx"), {
      "react/jsx-runtime": jsxRuntime,
      "next/server": target("next-server.mjs"),
      "../../src/application/attorney-access.ts": new URL(
        "src/application/attorney-access.ts",
        appRoot,
      ).href,
      "../../src/infrastructure/identity/attorney-principal-source.ts":
        target("wiring.mjs"),
      "../../src/infrastructure/identity/server-session-source.ts":
        target("wiring.mjs"),
      "../../src/presentation/design-system.tsx": target("design-system.mjs"),
    }),
  );
  const { wiring } = await import(target("wiring.mjs"));
  const page = await import(target("page.mjs"));
  return { directory, wiring, page };
}

const harness = await buildPageHarness();
after(() => rmSync(harness.directory, { recursive: true, force: true }));

async function renderPage(session, attorney, props) {
  harness.wiring.session = session;
  harness.wiring.attorney = attorney;
  harness.wiring.log.length = 0;
  const element = await harness.page.default(props);
  return {
    html: renderToStaticMarkup(element),
    log: [...harness.wiring.log],
  };
}

const sessionOf = (subject) => ({ currentSubject: async () => subject });

function textOf(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hrefsOf(html) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

const LABELS = {
  applicant: "Applicant",
  under_review: "Under review",
  approved: "Approved (record stage only)",
};

// The design-system status markup for one tone and one written meaning.
const STATUS_ICONS = {
  success: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M8.25 12.25l2.5 2.5 5-5.5",
  warning: "M12 4.5 2.75 20h18.5L12 4.5Z M12 10v4.5 M12 17.25v.01",
  neutral: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
};
function statusOf(tone, text) {
  return `<span class="rs-status" data-tone="${tone}" data-emphasis="subtle"><svg class="rs-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${STATUS_ICONS[tone]}"></path></svg><span>${text}</span></span>`;
}

// Nothing private, internal, or credential-like reaches the page.
function assertNoPrivateData(html, name) {
  for (const value of [
    SUBJECT,
    OTHER,
    USER_ID,
    OTHER_USER_ID,
    PROFILE_ID,
    OTHER_PROFILE_ID,
    CLIENT_PROFILE_ID,
    EMAIL,
    CONFIRMED_AT,
    "7f3a",
    "synthetic",
    "Bearer",
    "auth_user_id",
    "account_state",
    "profile_state",
    "under_review",
    "sb-",
  ]) {
    assert.equal(html.includes(value), false, `${name}: ${value}`);
  }
}

// The page advertises no account creation, application, onboarding,
// compliance verification, paid service, earnings, or scheduling, and claims
// no verification or eligibility.
function assertNoAdvertisedCapability(html, name) {
  const text = textOf(html);
  assert.doesNotMatch(
    text,
    /sign[ -]?up|create (?:an |your )?account|regist|\bapply\b|\bapplications?\b|onboard|submi|complian|consultation|earning|payout|payment|\bfee|\bpaid\b|price|schedul|calendar|appointment|\bbook|licen[cs]e|insurance/i,
    name,
  );
  assert.doesNotMatch(
    text,
    /\bverified\b|\beligible\b|\bcertified\b|\bbookable\b/i,
    name,
  );
  assert.doesNotMatch(html, /<form|<input|<textarea|<select|<button/, name);
}

// The one fixed link every refusal offers to the separate P3-002 attorney
// application entry, in exactly this form. It is the only application
// wording the workspace route admits, and only on its refusal page; every
// other state still advertises nothing.
const APPLICATION_ENTRY_LINK =
  '<a class="rs-button" data-variant="secondary" href="/attorney/apply">Attorney application</a>';
const REFUSAL_TITLE = "Attorney workspace not available";

function assertFrame(html, title, name) {
  if (title === REFUSAL_TITLE) {
    assert.equal(html.split(APPLICATION_ENTRY_LINK).length, 2, name);
    assertFrameOf(html.replace(APPLICATION_ENTRY_LINK, ""), title, name);
    return;
  }
  assert.equal(html.includes("/attorney/apply"), false, name);
  assertFrameOf(html, title, name);
}

function assertFrameOf(html, title, name) {
  assert.match(
    html,
    /^<div class="rs-page" data-density="attorney"><section class="rs-surface" data-tone="light" data-emphasis="raised" aria-labelledby="attorney-workspace-title">/,
    name,
  );
  assert.equal(html.match(/<h1\b/g).length, 1, name);
  assert.ok(
    html.includes(
      `<h1 class="rs-heading" data-size="lg" id="attorney-workspace-title">${title}</h1>`,
    ),
    name,
  );
  assert.ok(textOf(html).startsWith(`Attorney workspace ${title}`), name);
  assertNoPrivateData(html, name);
  assertNoAdvertisedCapability(html, name);
}

test("14. the route renders a restricted entry for each admitted stage that keeps account access, lifecycle, verification, and eligibility apart", async () => {
  for (const stage of ADMITTED) {
    const stand = readClient(withState(stage));
    const { source } = sourceOver(stand);
    const { html, log } = await renderPage(sessionOf(SUBJECT), source);
    assertFrame(html, "Restricted attorney workspace", stage);
    // connection() runs before anything is read, and the principal is read
    // exactly once.
    assert.deepEqual(log, ["connection", "session", "principal"], stage);
    assert.deepEqual(stand.calls, EXPECTED_READS, stage);
    const text = textOf(html);
    for (const row of [
      "Workspace access Restricted entry permitted",
      "User account Active",
      `Attorney profile lifecycle ${LABELS[stage]}`,
      "Professional verification Not established",
      "Current eligibility Not determined",
    ]) {
      assert.ok(text.includes(row), `${stage}: ${row}`);
    }
    assert.equal(
      html.match(/<tr>/g).length,
      6,
      `${stage}: one header row and five standing rows`,
    );
    // Only this request's stage is named.
    for (const other of ADMITTED.filter((entry) => entry !== stage)) {
      assert.equal(text.includes(LABELS[other]), false, `${stage}/${other}`);
    }
    // Verification and eligibility are never shown as settled, the lifecycle
    // stage, approved included, is shown in a neutral tone as a record stage,
    // and only workspace access and the active User account read as success.
    assert.ok(html.includes(statusOf("warning", "Not established")), stage);
    assert.ok(html.includes(statusOf("warning", "Not determined")), stage);
    assert.ok(html.includes(statusOf("neutral", LABELS[stage])), stage);
    assert.ok(html.includes(statusOf("success", "Active")), stage);
    assert.ok(
      html.includes(statusOf("success", "Restricted entry permitted")),
      stage,
    );
    assert.equal(html.match(/data-tone="success"/g).length, 2, stage);
    assert.ok(text.includes("Access is not verification"), stage);
    assert.deepEqual(hrefsOf(html), ["/"], stage);
  }
});

test("15. denied, unavailable, and anonymous requests each render one fixed, non-sensitive state, whatever the reason", async () => {
  const signIn = await renderPage(
    sessionOf(null),
    sourceOver(readClient()).source,
  );
  assertFrame(signIn.html, "Sign in to continue", "anonymous");
  assert.deepEqual(signIn.log, ["connection", "session"]);
  assert.deepEqual(hrefsOf(signIn.html), ["/sign-in", "/"]);
  const denials = {
    "suspended profile": withState("suspended"),
    "removed profile": withState("removed"),
    "no profile (client-only)": { attorneys: rows([]) },
    "pending User": {
      users: rows([activeUser({ account_state: "pending_verification" })]),
    },
    "closed User": { users: rows([activeUser({ account_state: "closed" })]) },
    "unconfirmed email": { user: { id: SUBJECT, email_confirmed_at: null } },
    "another account": {
      user: { id: OTHER, email_confirmed_at: CONFIRMED_AT },
    },
  };
  const deniedPages = new Set();
  for (const [name, options] of Object.entries(denials)) {
    const { html, log } = await renderPage(
      sessionOf(SUBJECT),
      sourceOver(readClient(options)).source,
    );
    assertFrame(html, "Attorney workspace not available", name);
    assert.deepEqual(log, ["connection", "session", "principal"], name);
    assert.ok(
      textOf(html).includes("Any other access the account has is unchanged."),
    );
    assert.deepEqual(hrefsOf(html), ["/attorney/apply", "/"], name);
    deniedPages.add(html);
  }
  // Every refusal reason renders the very same page, so none can be told
  // apart from outside.
  assert.equal(deniedPages.size, 1);
  const failures = {
    "Auth error": { auth: { data: { user: null }, error: new Error(DETAIL) } },
    "two Users": {
      users: rows([activeUser(), activeUser({ id: OTHER_USER_ID })]),
    },
    "cross-attorney profile": {
      attorneys: rows([
        attorneyProfile({ user_id: OTHER_USER_ID, profile_state: "approved" }),
      ]),
    },
    "unknown profile state": withState("active"),
    "null profile state": withState(null),
    "profile read throws": { attorneys: new Error(DETAIL) },
  };
  const unavailablePages = new Set();
  for (const [name, options] of Object.entries(failures)) {
    const { html } = await renderPage(
      sessionOf(SUBJECT),
      sourceOver(readClient(options)).source,
    );
    assertFrame(html, "Attorney workspace unavailable", name);
    assert.match(html, /role="alert"/, name);
    unavailablePages.add(html);
  }
  // A failing session or a timed-out read renders the same fixed page.
  for (const [session, attorney] of [
    [
      {
        currentSubject: async () => {
          throw new Error(DETAIL);
        },
      },
      sourceOver(readClient()).source,
    ],
    [sessionOf(SUBJECT), sourceOver(readClient({ auth: never }), 25).source],
  ]) {
    unavailablePages.add((await renderPage(session, attorney)).html);
  }
  assert.equal(unavailablePages.size, 1);
  // No denied or unavailable page holds any standing row or stage name.
  for (const html of [...deniedPages, ...unavailablePages, signIn.html]) {
    assert.doesNotMatch(
      textOf(html),
      /Applicant|Under review|Approved|User account|lifecycle|Not established|Not determined/,
    );
    assert.equal(html.includes("<table"), false);
  }
});

test("16. direct URL entry and repeated requests are decided afresh on the server, and request input never changes the outcome", async () => {
  // Route parameters and a query naming a destination, role, stage, or
  // subject are ignored: the page takes nothing from them.
  const hostile = {
    params: Promise.resolve({ role: "attorney" }),
    searchParams: Promise.resolve({
      next: "https://elsewhere.invalid/",
      redirect: "//elsewhere.invalid",
      role: "attorney",
      stage: "approved",
      subject: SUBJECT,
    }),
  };
  for (const options of [withState("suspended"), withState("approved")]) {
    const plain = await renderPage(
      sessionOf(SUBJECT),
      sourceOver(readClient(options)).source,
    );
    const entered = await renderPage(
      sessionOf(SUBJECT),
      sourceOver(readClient(options)).source,
      hostile,
    );
    assert.equal(entered.html, plain.html);
  }
  const anonymous = await renderPage(
    sessionOf(null),
    sourceOver(readClient()).source,
    hostile,
  );
  assert.deepEqual(hrefsOf(anonymous.html), ["/sign-in", "/"]);
  assert.equal(anonymous.html.includes("elsewhere"), false);
  // Repeated requests through one source follow the current state each time.
  const stands = {
    approved: readClient(withState("approved")),
    suspended: readClient(withState("suspended")),
    failing: readClient({ users: new Error(DETAIL) }),
  };
  let current = stands.approved;
  const source = createAttorneyPrincipalSource(async () => current.client);
  const titles = [];
  for (const name of [
    "approved",
    "suspended",
    "approved",
    "failing",
    "approved",
  ]) {
    current = stands[name];
    const { html, log } = await renderPage(sessionOf(SUBJECT), source);
    assert.deepEqual(log, ["connection", "session", "principal"], name);
    titles.push(html.match(/id="attorney-workspace-title">([^<]*)</)[1]);
  }
  assert.deepEqual(titles, [
    "Restricted attorney workspace",
    "Attorney workspace not available",
    "Restricted attorney workspace",
    "Attorney workspace unavailable",
    "Restricted attorney workspace",
  ]);
  // The route's metadata keeps it out of search indexes.
  assert.deepEqual(harness.page.metadata, {
    title: "Attorney workspace",
    robots: { index: false, follow: false },
  });
  assert.deepEqual(Object.keys(harness.page).sort(), ["default", "metadata"]);
});

// ---------------------------------------------------------------------------
// The installed clients over a synthetic Auth and REST API.
// ---------------------------------------------------------------------------

const PROJECT_REF = "syntheticprojectrefa";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const FAR_FUTURE = 4102444800;

// A session token for the subject: three base64url segments, built at run
// time. It signs nothing; the synthetic Auth API accepts only this value.
function sessionJwt(subject) {
  const segment = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "HS256", typ: "JWT" }),
    segment({
      sub: subject,
      aud: "authenticated",
      role: "authenticated",
      exp: FAR_FUTURE,
      iat: FAR_FUTURE - 3600,
      session_id: "synthetic-session",
    }),
    "c3ludGhldGlj",
  ].join(".");
}

function syntheticApi({
  confirmedAt = CONFIRMED_AT,
  users,
  attorneys,
  clients,
  failing = [],
} = {}) {
  const jwt = sessionJwt(SUBJECT);
  const requests = [];
  const authorized = (request) =>
    request.headers.get("authorization") === `Bearer ${jwt}`;
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, url, headers: request.headers });
    const json = (status, payload) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (failing.includes(url.pathname)) {
      return json(500, { message: DETAIL });
    }
    if (url.pathname === "/auth/v1/user") {
      return authorized(request)
        ? json(200, {
            id: SUBJECT,
            aud: "authenticated",
            role: "authenticated",
            email: EMAIL,
            email_confirmed_at: confirmedAt,
            created_at: CONFIRMED_AT,
            app_metadata: { role: "attorney" },
          })
        : json(401, { code: 401, msg: "invalid" });
    }
    // Own-row policies: only the request's own session reads its rows.
    const tables = {
      "/rest/v1/users": users ?? [activeUser()],
      "/rest/v1/attorney_profiles": attorneys ?? [attorneyProfile()],
      "/rest/v1/client_profiles": clients ?? [clientProfile()],
    };
    if (Object.hasOwn(tables, url.pathname)) {
      return json(200, authorized(request) ? tables[url.pathname] : []);
    }
    return json(404, { message: "not found" });
  };
  const rt = "r";
  const session = {
    access_token: jwt,
    refresh_token: rt,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: FAR_FUTURE,
    user: { id: SUBJECT, aud: "authenticated", role: "authenticated" },
  };
  const cookie = {
    name: `sb-${PROJECT_REF}-auth-token`,
    value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
  };
  return { jwt, requests, fetch, cookie };
}

function requestClient(api, { signedIn = true } = {}) {
  return createServerClient(PROJECT_URL, PUBLISHABLE, {
    cookies: {
      getAll: () => (signedIn ? [api.cookie] : []),
      setAll: () => {},
    },
    global: { fetch: api.fetch },
  });
}

// The real trusted session boundary and the real attorney source over one
// request client each.
function trustedWiring(api, options) {
  return {
    session: createSupabaseServerSessionSource(async () =>
      requestClient(api, options),
    ),
    attorney: createAttorneyPrincipalSource(async () =>
      requestClient(api, options),
    ),
  };
}

function assertReadOnlyAndUnprivileged(api) {
  assert.ok(api.requests.length > 0);
  for (const { method, url, headers } of api.requests) {
    // Reads only: nothing is created, changed, or removed.
    assert.equal(method, "GET", url.pathname);
    assert.equal(url.origin, PROJECT_URL);
    // Every read carries the request's own session and the publishable key,
    // and nothing privileged.
    assert.equal(headers.get("authorization"), `Bearer ${api.jwt}`);
    assert.equal(headers.get("apikey"), PUBLISHABLE);
  }
}

test("17. through the installed clients, the request's own session reads its own Auth user and rows, and each admitted stage holds the attorney context", async () => {
  for (const stage of ADMITTED) {
    const api = syntheticApi({
      attorneys: [attorneyProfile({ profile_state: stage })],
    });
    const source = createAttorneyPrincipalSource(async () =>
      requestClient(api),
    );
    assertExactly(
      await source.principalOf(SUBJECT),
      { contexts: ["attorney"], stage },
      stage,
    );
    assert.deepEqual(
      api.requests.map(({ url }) => [
        url.pathname,
        Object.fromEntries(url.searchParams),
      ]),
      [
        ["/auth/v1/user", {}],
        [
          "/rest/v1/users",
          {
            select: "id,auth_user_id,account_state",
            auth_user_id: `eq.${SUBJECT}`,
            limit: "2",
          },
        ],
        [
          "/rest/v1/attorney_profiles",
          {
            select: "id,user_id,profile_state",
            user_id: `eq.${USER_ID}`,
            limit: "2",
          },
        ],
      ],
      stage,
    );
    assertReadOnlyAndUnprivileged(api);
    // End to end: the existing trusted session boundary, the unchanged
    // Security Shell, this source, and the adapter.
    const wiring = trustedWiring(api);
    assert.deepEqual(
      await authorize(
        {
          session: wiring.session,
          contexts: wiring.attorney,
          capabilities: { isGranted: async () => false },
        },
        { context: "attorney" },
      ),
      AUTHORIZED,
      stage,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(wiring),
      GRANTED(stage),
      stage,
    );
    assertReadOnlyAndUnprivileged(api);
  }
});

test("18. through the installed clients, refusals hold no attorney context and provider failures fail closed", async () => {
  const refusals = [
    { confirmedAt: null },
    { users: [] },
    { users: [activeUser({ account_state: "pending_verification" })] },
    { users: [activeUser({ account_state: "suspended" })] },
    { users: [activeUser({ account_state: "closed" })] },
    { attorneys: [] },
    { attorneys: [attorneyProfile({ profile_state: "suspended" })] },
    { attorneys: [attorneyProfile({ profile_state: "removed" })] },
  ];
  for (const options of refusals) {
    const api = syntheticApi(options);
    const name = JSON.stringify(options);
    assertExactly(
      await createAttorneyPrincipalSource(async () =>
        requestClient(api),
      ).principalOf(SUBJECT),
      NO_ATTORNEY,
      name,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(trustedWiring(api)),
      DENIED,
      name,
    );
    assertReadOnlyAndUnprivileged(api);
  }
  const failures = [
    { failing: ["/rest/v1/users"] },
    { failing: ["/rest/v1/attorney_profiles"] },
    { users: [activeUser(), activeUser({ id: OTHER_USER_ID })] },
    {
      attorneys: [
        attorneyProfile({ user_id: OTHER_USER_ID, profile_state: "approved" }),
      ],
    },
    { attorneys: [attorneyProfile({ profile_state: "active" })] },
    { attorneys: [attorneyProfile({ profile_state: null })] },
  ];
  for (const options of failures) {
    const api = syntheticApi(options);
    const name = JSON.stringify(options);
    await assertFixedRejection(
      createAttorneyPrincipalSource(async () => requestClient(api)).principalOf(
        SUBJECT,
      ),
      name,
    );
    assertExactly(
      await resolveAttorneyWorkspaceAccess(trustedWiring(api)),
      WORKSPACE_UNAVAILABLE,
      name,
    );
    assertReadOnlyAndUnprivileged(api);
  }
  // Without a session cookie the request is anonymous, and no database read
  // is made at all.
  const api = syntheticApi();
  assertExactly(
    await resolveAttorneyWorkspaceAccess(
      trustedWiring(api, { signedIn: false }),
    ),
    SIGN_IN_REQUIRED,
  );
  assert.ok(api.requests.every(({ url }) => !url.pathname.startsWith("/rest")));
});

test("19. the route renders through the real trusted wiring over the installed clients without exposing any credential or record", async () => {
  for (const stage of ADMITTED) {
    const api = syntheticApi({
      attorneys: [attorneyProfile({ profile_state: stage })],
    });
    const wiring = trustedWiring(api);
    const { html, log } = await renderPage(wiring.session, wiring.attorney);
    assertFrame(html, "Restricted attorney workspace", stage);
    assert.deepEqual(log, ["connection", "session", "principal"], stage);
    assert.ok(
      textOf(html).includes(`Attorney profile lifecycle ${LABELS[stage]}`),
    );
    assert.equal(html.includes(api.jwt), false, stage);
    assert.equal(html.includes(PUBLISHABLE), false, stage);
    assertReadOnlyAndUnprivileged(api);
  }
  const states = [
    [
      { attorneys: [attorneyProfile({ profile_state: "suspended" })] },
      "Attorney workspace not available",
    ],
    [
      { attorneys: [attorneyProfile({ profile_state: "removed" })] },
      "Attorney workspace not available",
    ],
    [{ confirmedAt: null }, "Attorney workspace not available"],
    [
      { failing: ["/rest/v1/attorney_profiles"] },
      "Attorney workspace unavailable",
    ],
  ];
  for (const [options, title] of states) {
    const api = syntheticApi(options);
    const wiring = trustedWiring(api);
    const { html } = await renderPage(wiring.session, wiring.attorney);
    assertFrame(html, title, JSON.stringify(options));
    assert.equal(html.includes(api.jwt), false);
    assertReadOnlyAndUnprivileged(api);
  }
  const anonymousApi = syntheticApi();
  const anonymous = trustedWiring(anonymousApi, { signedIn: false });
  const { html } = await renderPage(anonymous.session, anonymous.attorney);
  assertFrame(html, "Sign in to continue", "anonymous");
  assert.deepEqual(hrefsOf(html), ["/sign-in", "/"]);
});
