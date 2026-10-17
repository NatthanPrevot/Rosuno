// Targeted P2-006 Client principal source tests.
//
// The source runs through the unchanged Security Shell against isolated
// synthetic Auth, session, and database stand-ins, and then through the
// installed @supabase/ssr and supabase-js clients against a synthetic
// in-memory Auth and REST API, reached only through the fetch each client is
// given. No real provider, account, credential, network, or database is
// contacted, and every value here is synthetic test data.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createServerClient } from "@supabase/ssr";

import { authorize } from "../src/application/security.ts";
import {
  CLIENT_PRINCIPAL_SOURCE,
  createClientPrincipalSource,
} from "../src/infrastructure/identity/client-principal-source.ts";
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

// Synthetic, test-only values. None is a real account or credential.
const SUBJECT = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const USER_ID = "00000000-0000-4000-8000-0000000010c1";
const PROFILE_ID = "00000000-0000-4000-8000-0000000020c1";
const CONFIRMED_AT = "2026-10-17T00:00:00Z";
const DETAIL = "internal 7f3a";

const AUTHORIZED = { status: "authorized" };
const FORBIDDEN = { status: "forbidden" };
const UNAVAILABLE = { status: "unavailable" };
const UNAUTHENTICATED = { status: "unauthenticated" };

const activeUser = (overrides = {}) => ({
  id: USER_ID,
  auth_user_id: SUBJECT,
  account_state: "active",
  ...overrides,
});
const clientProfile = (overrides = {}) => ({
  id: PROFILE_ID,
  user_id: USER_ID,
  ...overrides,
});

// A request-scoped read client stand-in. Each query resolves on limit(),
// as the installed builder does when awaited. Every call is recorded.
function readClient({
  user = { id: SUBJECT, email_confirmed_at: CONFIRMED_AT },
  auth = null,
  users = { data: [activeUser()], error: null },
  profiles = { data: [clientProfile()], error: null },
} = {}) {
  const calls = [];
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
        const result = table === "users" ? users : profiles;
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    };
    return builder;
  };
  return {
    calls,
    client: {
      auth: {
        getUser: async (...args) => {
          calls.push(["getUser", ...args]);
          if (auth instanceof Error) {
            throw auth;
          }
          return auth ?? { data: { user }, error: null };
        },
      },
      from: query,
    },
  };
}

function sourceOver(stand) {
  let built = 0;
  return {
    built: () => built,
    source: createClientPrincipalSource(async () => {
      built += 1;
      return stand.client;
    }),
  };
}

function sourcesFor(contexts, subject = SUBJECT) {
  return {
    session: { currentSubject: async () => subject },
    contexts,
    capabilities: { isGranted: async () => false },
  };
}

test("1. an active User with exactly one Client profile and a fresh, confirmed, same-subject Auth read holds the Client context", async () => {
  const stand = readClient();
  const { source } = sourceOver(stand);
  const contexts = await source.contextsOf(SUBJECT);
  assert.deepEqual(contexts, ["client"]);
  assert.ok(Object.isFrozen(contexts));
  // A fresh Auth user read, then the exact-key User and profile reads.
  assert.deepEqual(stand.calls, [
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
      "client_profiles",
      [
        ["select", "id, user_id"],
        ["eq", "user_id", USER_ID],
        ["limit", 2],
      ],
    ],
  ]);
  // Through the unchanged Security Shell.
  stand.calls.length = 0;
  assert.deepEqual(
    await authorize(sourcesFor(source), { context: "client" }),
    AUTHORIZED,
  );
  assert.equal(stand.calls.length, 3);
});

test("2. an anonymous request is refused before the source is asked", async () => {
  const stand = readClient();
  const { source, built } = sourceOver(stand);
  for (const subject of [null]) {
    assert.deepEqual(
      await authorize(sourcesFor(source, subject), { context: "client" }),
      UNAUTHENTICATED,
    );
  }
  assert.equal(built(), 0);
  assert.deepEqual(stand.calls, []);
});

test("3. a session alone, another account, an unconfirmed email, or a missing, pending, or inactive pair holds no Client context", async () => {
  const cases = {
    "Auth read names another account": {
      user: { id: OTHER, email_confirmed_at: CONFIRMED_AT },
    },
    "email not confirmed": { user: { id: SUBJECT, email_confirmed_at: null } },
    "empty confirmation time": {
      user: { id: SUBJECT, email_confirmed_at: "" },
    },
    "confirmation time missing": { user: { id: SUBJECT } },
    "confirmation time not text": {
      user: { id: SUBJECT, email_confirmed_at: 1 },
    },
    "no User (session alone)": { users: { data: [], error: null } },
    "pending User": {
      users: {
        data: [activeUser({ account_state: "pending_verification" })],
        error: null,
      },
    },
    "suspended User": {
      users: {
        data: [activeUser({ account_state: "suspended" })],
        error: null,
      },
    },
    "closed User": {
      users: { data: [activeUser({ account_state: "closed" })], error: null },
    },
    "unknown state": {
      users: { data: [activeUser({ account_state: "ACTIVE" })], error: null },
    },
    "active User without a profile": { profiles: { data: [], error: null } },
  };
  for (const [name, options] of Object.entries(cases)) {
    const stand = readClient(options);
    const { source } = sourceOver(stand);
    assert.deepEqual(await source.contextsOf(SUBJECT), [], name);
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "client" }),
      FORBIDDEN,
      name,
    );
  }
});

test("4. anything unreadable or inconsistent throws, and the Security Shell reports it as unavailable", async () => {
  const cases = {
    "Auth error": { auth: { data: { user: null }, error: new Error(DETAIL) } },
    "Auth read throws": { auth: new Error(DETAIL) },
    "no Auth user": { auth: { data: { user: null }, error: null } },
    "malformed Auth answer": { auth: { data: null, error: null } },
    "User query error": { users: { data: null, error: { message: DETAIL } } },
    "User query throws": { users: new Error(DETAIL) },
    "User rows not a list": { users: { data: activeUser(), error: null } },
    "two Users": {
      users: { data: [activeUser(), activeUser({ id: OTHER })], error: null },
    },
    "User linked to another account": {
      users: { data: [activeUser({ auth_user_id: OTHER })], error: null },
    },
    "User without an id": {
      users: { data: [activeUser({ id: undefined })], error: null },
    },
    "malformed User row": { users: { data: ["active"], error: null } },
    "profile query error": {
      profiles: { data: null, error: { message: DETAIL } },
    },
    "two profiles": {
      profiles: {
        data: [clientProfile(), clientProfile({ id: OTHER })],
        error: null,
      },
    },
    "profile of another User": {
      profiles: { data: [clientProfile({ user_id: OTHER })], error: null },
    },
    "profile without an id": {
      profiles: { data: [clientProfile({ id: null })], error: null },
    },
  };
  for (const [name, options] of Object.entries(cases)) {
    const stand = readClient(options);
    const { source } = sourceOver(stand);
    await assert.rejects(
      source.contextsOf(SUBJECT),
      (error) => {
        // The thrown value is fixed and carries no provider detail.
        assert.equal(
          error.message,
          "The Client principal could not be resolved.",
        );
        assert.equal(String(error).includes("7f3a"), false);
        return true;
      },
      name,
    );
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "client" }),
      UNAVAILABLE,
      name,
    );
  }
  // An unconfigured or failing read client is unavailable too.
  for (const clientSource of [
    async () => null,
    async () => {
      throw new Error(DETAIL);
    },
  ]) {
    const source = createClientPrincipalSource(clientSource);
    assert.deepEqual(
      await authorize(sourcesFor(source), { context: "client" }),
      UNAVAILABLE,
    );
  }
});

test("5. the source reports only the Client context: never attorney or staff, and never a capability", async () => {
  const stand = readClient();
  const { source } = sourceOver(stand);
  for (const context of ["attorney", "staff"]) {
    assert.deepEqual(
      await authorize(sourcesFor(source), { context }),
      FORBIDDEN,
    );
  }
  assert.deepEqual(
    await authorize(sourcesFor(source), {
      context: "client",
      capability: { capability: "synthetic.capability", scope: "synthetic" },
    }),
    FORBIDDEN,
  );
  const code = codeOf(
    read("src/infrastructure/identity/client-principal-source.ts"),
  );
  assert.deepEqual(
    [...code.matchAll(/Object\.freeze\((\[[^\]]*\])\)/g)].map(
      (match) => match[1],
    ),
    ["[]", '["client"]'],
  );
  assert.doesNotMatch(
    code,
    /"attorney"|"staff"|attorney_profiles|staff_profiles|isGranted|capabilit/i,
  );
});

test("6. the Client-only source preserves multiplicity: an independent resolver's contexts stand beside it", async () => {
  const stand = readClient();
  const { source } = sourceOver(stand);
  // A later, separately authorized resolver for another context.
  const independent = { contextsOf: async () => Object.freeze(["attorney"]) };
  const combined = {
    contextsOf: async (subject) => [
      ...(await source.contextsOf(subject)),
      ...(await independent.contextsOf(subject)),
    ],
  };
  for (const context of ["client", "attorney"]) {
    assert.deepEqual(
      await authorize(sourcesFor(combined), { context }),
      AUTHORIZED,
    );
  }
  assert.deepEqual(
    await authorize(sourcesFor(combined), { context: "staff" }),
    FORBIDDEN,
  );
  // Without the Client pair, the other context is untouched.
  const pending = readClient({
    users: {
      data: [activeUser({ account_state: "pending_verification" })],
      error: null,
    },
  });
  const withoutClient = {
    contextsOf: async (subject) => [
      ...(await sourceOver(pending).source.contextsOf(subject)),
      ...(await independent.contextsOf(subject)),
    ],
  };
  assert.deepEqual(
    await authorize(sourcesFor(withoutClient), { context: "attorney" }),
    AUTHORIZED,
  );
  assert.deepEqual(
    await authorize(sourcesFor(withoutClient), { context: "client" }),
    FORBIDDEN,
  );
});

test("7. metadata, email text, and browser-shaped claims never establish the Client context", async () => {
  for (const user of [
    {
      id: OTHER,
      email: "applicant@synthetic.invalid",
      email_confirmed_at: CONFIRMED_AT,
      user_metadata: { role: "client", auth_user_id: SUBJECT },
    },
    {
      id: OTHER,
      email_confirmed_at: CONFIRMED_AT,
      app_metadata: { contexts: ["client"] },
      sub: SUBJECT,
    },
  ]) {
    const stand = readClient({ user });
    const { source } = sourceOver(stand);
    assert.deepEqual(await source.contextsOf(SUBJECT), []);
    // No database read follows an Auth read for another account.
    assert.deepEqual(stand.calls, [["getUser"]]);
  }
  // The subject comes from the trusted session boundary; a session that
  // reports another subject than the Auth read is not the Client.
  const stand = readClient();
  const { source } = sourceOver(stand);
  assert.deepEqual(
    await authorize(sourcesFor(source, OTHER), { context: "client" }),
    FORBIDDEN,
  );
  // The Auth read is the request's own session: no identifier is passed in.
  assert.ok(
    stand.calls.every((call) => call[0] !== "getUser" || call.length === 1),
  );
});

test("8. each request reads afresh through its own client, and nothing is cached or shared", async () => {
  const active = readClient();
  const pending = readClient({
    users: {
      data: [activeUser({ account_state: "pending_verification" })],
      error: null,
    },
  });
  let current = active;
  let built = 0;
  const source = createClientPrincipalSource(async () => {
    built += 1;
    return current.client;
  });
  assert.deepEqual(await source.contextsOf(SUBJECT), ["client"]);
  current = pending;
  assert.deepEqual(await source.contextsOf(SUBJECT), []);
  current = active;
  assert.deepEqual(await source.contextsOf(SUBJECT), ["client"]);
  assert.equal(built, 3);
  assert.ok(Object.isFrozen(source));
  assert.deepEqual(Object.keys(source), ["contextsOf"]);
  assert.ok(Object.isFrozen(CLIENT_PRINCIPAL_SOURCE));
  assert.deepEqual(Object.keys(CLIENT_PRINCIPAL_SOURCE), ["contextsOf"]);
});

test("9. the source module is unprivileged, read-only, and loads the request-scoped client only when asked", () => {
  const file = "src/infrastructure/identity/client-principal-source.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "@supabase/supabase-js",
    "../../application/security.ts",
  ]);
  assert.match(
    code,
    /^import type \{ SupabaseClient \} from "@supabase\/supabase-js";$/m,
  );
  assert.match(code, /await import\("\.\/supabase-server\.ts"\)/);
  assert.equal(code.match(/\bimport\s*\(/g).length, 1);
  assert.doesNotMatch(
    code,
    /registration-provisioning|ROSUNO_SUPABASE|service_role|createClient\b|process\.env|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|admin|\bconsole\b|cookies|headers/,
  );
  assert.deepEqual(
    [...code.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]),
    ["users", "client_profiles"],
  );
  assert.equal(code.match(/\.getUser\(\)/g).length, 1);
  assert.deepEqual(
    [...code.matchAll(/^export (?:const|function) (\w+)/gm)].map(
      (match) => match[1],
    ),
    ["createClientPrincipalSource", "CLIENT_PRINCIPAL_SOURCE"],
  );
  // The unchanged Security Shell's source stays exactly as it was consumed.
  assert.match(
    read("src/application/security.ts"),
    /export async function authorize\(/,
  );
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

function syntheticApi({ confirmedAt = CONFIRMED_AT, users, profiles } = {}) {
  const jwt = sessionJwt(SUBJECT);
  const requests = [];
  const authorized = (request) =>
    request.headers.get("authorization") === `Bearer ${jwt}`;
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ url, headers: request.headers });
    const json = (status, payload) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/auth/v1/user") {
      return authorized(request)
        ? json(200, {
            id: SUBJECT,
            aud: "authenticated",
            role: "authenticated",
            email: "applicant@synthetic.invalid",
            email_confirmed_at: confirmedAt,
            created_at: CONFIRMED_AT,
          })
        : json(401, { code: 401, msg: "invalid" });
    }
    // Own-row policies: only the request's own session reads its rows.
    if (url.pathname === "/rest/v1/users") {
      return json(200, authorized(request) ? (users ?? [activeUser()]) : []);
    }
    if (url.pathname === "/rest/v1/client_profiles") {
      return json(
        200,
        authorized(request) ? (profiles ?? [clientProfile()]) : [],
      );
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

function requestClient(api) {
  return createServerClient(PROJECT_URL, PUBLISHABLE, {
    cookies: {
      getAll: () => [api.cookie],
      setAll: () => {},
    },
    global: { fetch: api.fetch },
  });
}

test("10. through the installed clients, the request's own session reads its own Auth user and rows, and the Security Shell authorizes the Client", async () => {
  const api = syntheticApi();
  const source = createClientPrincipalSource(async () => requestClient(api));
  assert.deepEqual(await source.contextsOf(SUBJECT), ["client"]);
  const sent = api.requests.map(({ url }) => [
    url.pathname,
    Object.fromEntries(url.searchParams),
  ]);
  assert.deepEqual(sent, [
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
      "/rest/v1/client_profiles",
      { select: "id,user_id", user_id: `eq.${USER_ID}`, limit: "2" },
    ],
  ]);
  // Every read carries the request's own session and the publishable key,
  // and nothing privileged.
  for (const { headers } of api.requests) {
    assert.equal(headers.get("authorization"), `Bearer ${api.jwt}`);
    assert.equal(headers.get("apikey"), PUBLISHABLE);
  }
  // End to end: the existing trusted session boundary over the same request
  // client, the unchanged Security Shell, and this source.
  const session = createSupabaseServerSessionSource(async () =>
    requestClient(api),
  );
  assert.deepEqual(
    await authorize(
      {
        session,
        contexts: source,
        capabilities: { isGranted: async () => false },
      },
      { context: "client" },
    ),
    AUTHORIZED,
  );
});

test("11. through the installed clients, an unconfirmed email or an incomplete pair holds no Client context", async () => {
  for (const options of [
    { confirmedAt: null },
    { users: [] },
    { users: [activeUser({ account_state: "pending_verification" })] },
    { profiles: [] },
  ]) {
    const api = syntheticApi(options);
    const source = createClientPrincipalSource(async () => requestClient(api));
    assert.deepEqual(
      await source.contextsOf(SUBJECT),
      [],
      JSON.stringify(options),
    );
    const session = createSupabaseServerSessionSource(async () =>
      requestClient(api),
    );
    assert.deepEqual(
      await authorize(
        {
          session,
          contexts: source,
          capabilities: { isGranted: async () => false },
        },
        { context: "client" },
      ),
      FORBIDDEN,
    );
  }
});
