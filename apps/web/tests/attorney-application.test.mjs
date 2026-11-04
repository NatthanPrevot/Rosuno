// Targeted P3-002 attorney application tests.
//
// The attorney application boundary, its server-only adapter, the shared
// provisioning boundary's narrow attorney-applicant port, the entry page,
// and its server action run against isolated synthetic session, Auth, and
// database stand-ins (one of which keeps the real unique User link of
// attorney_profiles), and then through the installed @supabase/ssr and
// supabase-js clients against a synthetic in-memory Auth and REST API,
// reached only through the fetch each client is given. The page and action
// sources are transpiled with the installed TypeScript compiler into a
// temporary directory outside the repository; only their trusted wiring
// imports and the Next.js runtime calls they make are replaced, by recording
// stand-ins. No real provider, account, credential, network, or database is
// contacted, nothing is written anywhere but that temporary directory, which
// is removed, and every value here is synthetic test data.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { types } from "node:util";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { resolveAttorneyWorkspaceAccess } from "../src/application/attorney-access.ts";
import {
  ATTORNEY_APPLICATION_INTENT,
  resolveAttorneyApplicationEntry,
  startAttorneyApplication,
} from "../src/application/attorney-application.ts";
import { authorize } from "../src/application/security.ts";
import {
  ATTORNEY_APPLICANT_PROVISIONING,
  ATTORNEY_APPLICATION_ACCOUNT,
  ATTORNEY_APPLICATION_RECORDS,
  createAttorneyApplicationAccountSource,
  createAttorneyApplicationRecordSource,
  createBoundedApplicantProvisioning,
} from "../src/infrastructure/identity/attorney-application-provisioning.ts";
import { createAttorneyPrincipalSource } from "../src/infrastructure/identity/attorney-principal-source.ts";
import { createClientPrincipalSource } from "../src/infrastructure/identity/client-principal-source.ts";
import {
  createAttorneyApplicantProvisioning,
  createConfirmationDispatch,
  createRegistrationProvisioning,
} from "../src/infrastructure/identity/registration-provisioning.ts";
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
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Synthetic, test-only values. None is a real account or credential.
const SUBJECT = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const USER_ID = "00000000-0000-4000-8000-0000000010b1";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000010b2";
const PROFILE_ID = "00000000-0000-4000-8000-0000000030b1";
const OTHER_PROFILE_ID = "00000000-0000-4000-8000-0000000030b2";
const CLIENT_PROFILE_ID = "00000000-0000-4000-8000-0000000020b1";
const CONFIRMED_AT = "2026-11-01T00:00:00Z";
const EMAIL = "applicant@synthetic.invalid";
const DETAIL = "internal 7f3a";

const SIGN_IN_REQUIRED = { status: "sign-in-required" };
const CAN_START = { status: "can-start" };
const ON_RECORD = { status: "on-record" };
const DENIED = { status: "denied" };
const UNAVAILABLE = { status: "unavailable" };
const CREATED = { status: "created" };
const UNCONFIRMED = { status: "unconfirmed" };

const ON_RECORD_STATES = Object.freeze([
  "applicant",
  "under_review",
  "approved",
]);
const REFUSED_STATES = Object.freeze(["suspended", "removed"]);

const UNREADABLE = Object.freeze({ kind: "unreadable" });
const rowsResult = (rows) => ({ kind: "rows", rows });

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

const USER_COLUMNS = ["id", "auth_user_id", "account_state"];
const PROFILE_COLUMNS = ["id", "user_id", "profile_state"];

function pick(row, columns) {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

// A synthetic in-memory database holding only test data. attorney_profiles
// keeps the real unique User link and the real User foreign key, and each
// new profile gets a fresh database-generated id.
function memoryDatabase({
  users = [activeUser()],
  attorneys = [],
  clients = [clientProfile()],
} = {}) {
  let sequence = 0x40b0;
  return {
    users: users.map((row) => ({ ...row })),
    attorney_profiles: attorneys.map((row) => ({ ...row })),
    client_profiles: clients.map((row) => ({ ...row })),
    nextId: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
    },
  };
}

function snapshot(db) {
  return JSON.stringify({
    users: db.users,
    attorney_profiles: db.attorney_profiles,
    client_profiles: db.client_profiles,
  });
}

// The privileged port over a memory database. Each call yields once before
// it acts, so concurrent starts interleave as separate requests would. The
// insert answers unreadable on a duplicate or a missing User, as the
// provisioning boundary does for any refused write. An override replaces one
// operation; it receives the argument and the real operation.
function memoryProvisioning(db, overrides = {}) {
  const calls = [];
  const real = {
    usersOf: async (accountId) =>
      rowsResult(
        db.users
          .filter((row) => row.auth_user_id === accountId)
          .slice(0, 2)
          .map((row) => pick(row, USER_COLUMNS)),
      ),
    attorneyProfilesOf: async (userId) =>
      rowsResult(
        db.attorney_profiles
          .filter((row) => row.user_id === userId)
          .slice(0, 2)
          .map((row) => pick(row, PROFILE_COLUMNS)),
      ),
    insertApplicantProfile: async (userId) => {
      if (
        db.attorney_profiles.some((row) => row.user_id === userId) ||
        !db.users.some((row) => row.id === userId)
      ) {
        return UNREADABLE;
      }
      const row = {
        id: db.nextId(),
        user_id: userId,
        profile_state: "applicant",
      };
      db.attorney_profiles.push(row);
      return rowsResult([pick(row, PROFILE_COLUMNS)]);
    },
  };
  const port = {};
  for (const name of Object.keys(real)) {
    port[name] = async (argument) => {
      calls.push([name, argument]);
      await tick();
      const override = overrides[name];
      return override === undefined
        ? real[name](argument)
        : override(argument, () => real[name](argument));
    };
  }
  return { calls, port };
}

const sessionOf = (subject) => ({ currentSubject: async () => subject });

function accountOf(user = { id: SUBJECT, emailConfirmedAt: CONFIRMED_AT }) {
  const log = [];
  return {
    log,
    source: {
      currentAccount: async (...args) => {
        log.push(args);
        return typeof user === "function"
          ? user()
          : Object.freeze({ kind: "user", ...user });
      },
    },
  };
}

function startForm(extra = []) {
  const form = new FormData();
  form.append(
    ATTORNEY_APPLICATION_INTENT.field,
    ATTORNEY_APPLICATION_INTENT.value,
  );
  for (const [name, value] of extra) {
    form.append(name, value);
  }
  return form;
}

// One request's start sources over a memory database, recording how often
// the privileged port is built.
function startWiring(db, { subject = SUBJECT, user, overrides } = {}) {
  const provisioning = memoryProvisioning(db, overrides);
  const account = accountOf(user);
  let built = 0;
  return {
    provisioning,
    account,
    built: () => built,
    sources: {
      session: sessionOf(subject),
      account: account.source,
      provisioning: async () => {
        built += 1;
        return provisioning.port;
      },
    },
  };
}

function entryWiring(db, { subject = SUBJECT, user, overrides } = {}) {
  const records = memoryProvisioning(db, overrides);
  const account = accountOf(user);
  let built = 0;
  return {
    records,
    account,
    built: () => built,
    sources: {
      session: sessionOf(subject),
      account: account.source,
      records: async () => {
        built += 1;
        const { usersOf, attorneyProfilesOf } = records.port;
        return { usersOf, attorneyProfilesOf };
      },
    },
  };
}

const EXPECTED_CREATION_CALLS = Object.freeze([
  ["usersOf", SUBJECT],
  ["attorneyProfilesOf", USER_ID],
  ["insertApplicantProfile", USER_ID],
  ["attorneyProfilesOf", USER_ID],
]);

// ---------------------------------------------------------------------------
// Applicant creation through the application boundary.
// ---------------------------------------------------------------------------

test("1. a confirmed, active User without an Attorney Profile starts exactly one applicant-state profile, proven by a fresh read", async () => {
  const db = memoryDatabase();
  const wiring = startWiring(db);
  const outcome = await startAttorneyApplication(wiring.sources, startForm());
  assertExactly(outcome, CREATED);
  assert.deepEqual(Object.keys(outcome), ["status"]);
  // The verified account's User, its profile, the one insert, and a fresh
  // read afterwards: nothing else is asked, and only server-derived keys.
  assert.deepEqual(wiring.provisioning.calls, EXPECTED_CREATION_CALLS);
  assert.deepEqual(wiring.account.log, [[]]);
  assert.equal(wiring.built(), 1);
  assert.equal(db.attorney_profiles.length, 1);
  const [created] = db.attorney_profiles;
  assert.deepEqual(Object.keys(created), ["id", "user_id", "profile_state"]);
  assert.equal(created.user_id, USER_ID);
  assert.equal(created.profile_state, "applicant");
  assert.notEqual(created.id, PROFILE_ID);
  // The User and Client profile are exactly as they were.
  assert.deepEqual(db.users, [activeUser()]);
  assert.deepEqual(db.client_profiles, [clientProfile()]);
  // The entry now reports the application on record.
  assertExactly(
    await resolveAttorneyApplicationEntry(entryWiring(db).sources),
    ON_RECORD,
  );
});

test("2. an existing Client profile neither grants nor prevents the start, and stays exactly as it was", async () => {
  for (const clients of [[clientProfile()], []]) {
    const db = memoryDatabase({ clients });
    const before = JSON.stringify(db.client_profiles);
    assertExactly(
      await resolveAttorneyApplicationEntry(entryWiring(db).sources),
      CAN_START,
    );
    const wiring = startWiring(db);
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      CREATED,
    );
    assert.equal(JSON.stringify(db.client_profiles), before);
    assert.ok(
      wiring.provisioning.calls.every(([name]) => !/client/i.test(name)),
    );
  }
  // Through the real principal sources, the Client context is unchanged and
  // the attorney context is now the applicant stage only.
  const db = memoryDatabase();
  const reader = readClientOver(db);
  const client = createClientPrincipalSource(async () => reader.client);
  const before = await client.contextsOf(SUBJECT);
  assert.deepEqual(before, ["client"]);
  await startAttorneyApplication(startWiring(db).sources, startForm());
  assert.deepEqual(await client.contextsOf(SUBJECT), ["client"]);
  const attorney = createAttorneyPrincipalSource(async () => reader.client);
  assert.deepEqual(await attorney.principalOf(SUBJECT), {
    contexts: ["attorney"],
    stage: "applicant",
  });
});

test("3. anonymous, unconfirmed, inactive, missing, and malformed identities never start an application or build the privileged port", async () => {
  // Anonymous: sign-in is required before any account or record read.
  const anonymous = startWiring(memoryDatabase(), { subject: null });
  assertExactly(
    await startAttorneyApplication(anonymous.sources, startForm()),
    SIGN_IN_REQUIRED,
  );
  assert.deepEqual(anonymous.account.log, []);
  assert.equal(anonymous.built(), 0);
  // Definite refusals of the account itself, before the privileged port.
  const accounts = {
    "email not confirmed": { id: SUBJECT, emailConfirmedAt: null },
    "empty confirmation time": { id: SUBJECT, emailConfirmedAt: "" },
    "confirmation time missing": { id: SUBJECT },
    "confirmation time not text": { id: SUBJECT, emailConfirmedAt: 1 },
    "Auth read names another account": {
      id: OTHER,
      emailConfirmedAt: CONFIRMED_AT,
    },
  };
  for (const [name, user] of Object.entries(accounts)) {
    const db = memoryDatabase();
    const wiring = startWiring(db, { user });
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      DENIED,
      name,
    );
    assert.equal(wiring.built(), 0, name);
    assert.equal(db.attorney_profiles.length, 0, name);
  }
  // Unreadable or malformed identity is unavailable, with nothing built.
  const malformed = {
    "unreadable Auth read": () => ({ kind: "unreadable" }),
    "Auth read throws": () => {
      throw new Error(DETAIL);
    },
    "Auth read with an extra field": () => ({
      kind: "user",
      id: SUBJECT,
      emailConfirmedAt: CONFIRMED_AT,
      role: "attorney",
    }),
    "Auth read not a record": () => [SUBJECT],
    "Auth read missing": () => undefined,
  };
  for (const [name, user] of Object.entries(malformed)) {
    const db = memoryDatabase();
    const wiring = startWiring(db, { user });
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      UNAVAILABLE,
      name,
    );
    assert.equal(wiring.built(), 0, name);
  }
  // A subject that is not a canonical account id is malformed too.
  for (const subject of ["", "SUBJECT", SUBJECT.toUpperCase(), ` ${SUBJECT}`]) {
    const wiring = startWiring(memoryDatabase(), {
      subject,
      user: { id: subject, emailConfirmedAt: CONFIRMED_AT },
    });
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      UNAVAILABLE,
      JSON.stringify(subject),
    );
    assert.equal(wiring.built(), 0);
  }
  // A failing or malformed session is unavailable.
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
    const wiring = startWiring(memoryDatabase());
    assertExactly(
      await startAttorneyApplication(
        { ...wiring.sources, session },
        startForm(),
      ),
      UNAVAILABLE,
    );
    assert.equal(wiring.built(), 0);
  }
  // No Rosuno User, or one that is not active, is refused: nothing is
  // provisioned, activated, or created for it.
  const users = {
    "no Rosuno User": [],
    "pending_verification User": [
      activeUser({ account_state: "pending_verification" }),
    ],
    "suspended User": [activeUser({ account_state: "suspended" })],
    "closed User": [activeUser({ account_state: "closed" })],
  };
  for (const [name, rows] of Object.entries(users)) {
    const db = memoryDatabase({ users: rows });
    const before = snapshot(db);
    const wiring = startWiring(db);
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      DENIED,
      name,
    );
    assert.equal(snapshot(db), before, name);
    assert.ok(
      wiring.provisioning.calls.every(
        ([call]) => call !== "insertApplicantProfile",
      ),
      name,
    );
    assertExactly(
      await resolveAttorneyApplicationEntry(entryWiring(db).sources),
      DENIED,
      name,
    );
  }
});

test("4. existing applicant, under-review, and approved profiles are on record, and suspended or removed ones are refused: none is duplicated, reset, promoted, or revived", async () => {
  for (const state of [...ON_RECORD_STATES, ...REFUSED_STATES]) {
    const db = memoryDatabase({
      attorneys: [attorneyProfile({ profile_state: state })],
    });
    const before = snapshot(db);
    const expected = ON_RECORD_STATES.includes(state) ? ON_RECORD : DENIED;
    const wiring = startWiring(db);
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      expected,
      state,
    );
    // Reading stops at the existing profile; no write is attempted.
    assert.deepEqual(
      wiring.provisioning.calls,
      EXPECTED_CREATION_CALLS.slice(0, 2),
      state,
    );
    assert.equal(snapshot(db), before, state);
    assertExactly(
      await resolveAttorneyApplicationEntry(entryWiring(db).sources),
      expected,
      state,
    );
  }
  // Unknown or inconsistent states fail closed, with no write.
  const cases = {};
  for (const state of [
    "active",
    "APPLICANT",
    "Applicant",
    " applicant",
    "verified",
    "eligible",
    "",
    null,
    1,
    true,
  ]) {
    cases[`profile state ${JSON.stringify(state)}`] = {
      attorneys: [attorneyProfile({ profile_state: state })],
    };
  }
  for (const state of ["ACTIVE", "", null, "deleted"]) {
    cases[`User state ${JSON.stringify(state)}`] = {
      users: [activeUser({ account_state: state })],
    };
  }
  Object.assign(cases, {
    "two Users": {
      users: [activeUser(), activeUser({ id: OTHER_USER_ID })],
    },
    "User linked to another account": {
      users: [activeUser({ auth_user_id: OTHER })],
    },
    "User with a malformed id": { users: [activeUser({ id: "user-1" })] },
    "User with an extra column": { users: [activeUser({ role: "attorney" })] },
  });
  for (const [name, options] of Object.entries(cases)) {
    const db = memoryDatabase(options);
    // The memory database keys reads by the stored link, so a row linked to
    // another account is offered by an override instead.
    const overrides =
      name === "User linked to another account"
        ? {
            usersOf: async () =>
              rowsResult([activeUser({ auth_user_id: OTHER })]),
          }
        : name === "User with an extra column"
          ? { usersOf: async () => rowsResult([activeUser({ role: "x" })]) }
          : undefined;
    const before = snapshot(db);
    const wiring = startWiring(db, { overrides });
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      UNAVAILABLE,
      name,
    );
    assert.equal(snapshot(db), before, name);
    assert.ok(
      wiring.provisioning.calls.every(
        ([call]) => call !== "insertApplicantProfile",
      ),
      name,
    );
    assertExactly(
      await resolveAttorneyApplicationEntry(
        entryWiring(db, { overrides }).sources,
      ),
      UNAVAILABLE,
      name,
    );
  }
});

test("5. cross-account and IDOR attempts: reads are keyed only by the verified subject and the User row it names, and another User's profile never counts", async () => {
  // The session names one account and the Auth read another: refused before
  // any record is read.
  const crossed = startWiring(memoryDatabase(), {
    user: { id: OTHER, emailConfirmedAt: CONFIRMED_AT },
  });
  assertExactly(
    await startAttorneyApplication(crossed.sources, startForm()),
    DENIED,
  );
  assert.deepEqual(crossed.provisioning.calls, []);
  // Another confirmed account reads with its own subject only, and finds no
  // User of its own, even though this database holds SUBJECT's User.
  const db = memoryDatabase();
  const other = startWiring(db, {
    subject: OTHER,
    user: { id: OTHER, emailConfirmedAt: CONFIRMED_AT },
  });
  assertExactly(
    await startAttorneyApplication(other.sources, startForm()),
    DENIED,
  );
  assert.deepEqual(other.provisioning.calls, [["usersOf", OTHER]]);
  assert.equal(db.attorney_profiles.length, 0);
  // A profile of another User returned for this User fails closed.
  for (const profiles of [
    [attorneyProfile({ id: OTHER_PROFILE_ID, user_id: OTHER_USER_ID })],
    [
      attorneyProfile(),
      attorneyProfile({ id: OTHER_PROFILE_ID, user_id: OTHER_USER_ID }),
    ],
  ]) {
    const target = memoryDatabase();
    const wiring = startWiring(target, {
      overrides: { attorneyProfilesOf: async () => rowsResult(profiles) },
    });
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      UNAVAILABLE,
    );
    assert.equal(target.attorney_profiles.length, 0);
    assert.deepEqual(wiring.provisioning.calls.at(-1), [
      "attorneyProfilesOf",
      USER_ID,
    ]);
  }
  // Another User's existing profile does not stop, lend its state to, or get
  // touched by this User's start.
  const shared = memoryDatabase({
    users: [
      activeUser(),
      activeUser({ id: OTHER_USER_ID, auth_user_id: OTHER }),
    ],
    attorneys: [
      attorneyProfile({
        id: OTHER_PROFILE_ID,
        user_id: OTHER_USER_ID,
        profile_state: "approved",
      }),
    ],
  });
  assertExactly(
    await startAttorneyApplication(startWiring(shared).sources, startForm()),
    CREATED,
  );
  assert.deepEqual(
    shared.attorney_profiles.map((row) => [row.user_id, row.profile_state]),
    [
      [OTHER_USER_ID, "approved"],
      [USER_ID, "applicant"],
    ],
  );
});

test("6. spoofed identity, User, profile, role, and state fields are never read: only the one explicit intent field matters", async () => {
  const spoofed = [
    ["user_id", OTHER_USER_ID],
    ["auth_user_id", OTHER],
    ["subject", OTHER],
    ["attorney_id", OTHER_PROFILE_ID],
    ["id", OTHER_PROFILE_ID],
    ["profile_state", "approved"],
    ["state", "approved"],
    ["role", "attorney"],
    ["contexts", "attorney"],
    ["verified", "true"],
    ["eligible", "true"],
    ["account_state", "active"],
    ["email_confirmed_at", CONFIRMED_AT],
    ["redirect", "https://elsewhere.invalid/"],
  ];
  const db = memoryDatabase();
  const wiring = startWiring(db);
  assertExactly(
    await startAttorneyApplication(wiring.sources, startForm(spoofed)),
    CREATED,
  );
  assert.deepEqual(wiring.provisioning.calls, EXPECTED_CREATION_CALLS);
  assert.deepEqual(
    db.attorney_profiles.map((row) => [row.user_id, row.profile_state]),
    [[USER_ID, "applicant"]],
  );
  // Without exactly one exact intent field, nothing is read or built.
  const missing = new FormData();
  for (const [name, value] of spoofed) {
    missing.append(name, value);
  }
  const repeated = startForm();
  repeated.append(
    ATTORNEY_APPLICATION_INTENT.field,
    ATTORNEY_APPLICATION_INTENT.value,
  );
  const wrong = new FormData();
  wrong.append(ATTORNEY_APPLICATION_INTENT.field, "approve");
  const padded = new FormData();
  padded.append(
    ATTORNEY_APPLICATION_INTENT.field,
    ` ${ATTORNEY_APPLICATION_INTENT.value}`,
  );
  const file = new FormData();
  file.append(
    ATTORNEY_APPLICATION_INTENT.field,
    new Blob([ATTORNEY_APPLICATION_INTENT.value]),
  );
  for (const [name, payload] of Object.entries({
    "no intent": missing,
    "repeated intent": repeated,
    "other intent": wrong,
    "padded intent": padded,
    "file intent": file,
    "empty form": new FormData(),
    "plain object": { intent: ATTORNEY_APPLICATION_INTENT.value },
    "search params": new URLSearchParams({
      intent: ATTORNEY_APPLICATION_INTENT.value,
    }),
    null: null,
    undefined,
  })) {
    const target = memoryDatabase();
    const refused = startWiring(target);
    assertExactly(
      await startAttorneyApplication(refused.sources, payload),
      UNAVAILABLE,
      name,
    );
    assert.deepEqual(refused.account.log, [], name);
    assert.equal(refused.built(), 0, name);
    assert.equal(target.attorney_profiles.length, 0, name);
  }
  assert.deepEqual(ATTORNEY_APPLICATION_INTENT, {
    field: "intent",
    value: "start-attorney-application",
  });
  assert.ok(Object.isFrozen(ATTORNEY_APPLICATION_INTENT));
});

test("7. repeated and concurrent starts keep exactly one profile: one request is told it created it, every other one that it is on record", async () => {
  // Repeated, one after another.
  const db = memoryDatabase();
  const outcomes = [];
  for (let index = 0; index < 4; index += 1) {
    outcomes.push(
      await startAttorneyApplication(startWiring(db).sources, startForm()),
    );
  }
  assert.deepEqual(outcomes, [CREATED, ON_RECORD, ON_RECORD, ON_RECORD]);
  assert.equal(db.attorney_profiles.length, 1);
  // Concurrent: every request reads no profile before any insert lands; the
  // unique User link refuses all but one insert, and each loser's fresh read
  // shows the winner's profile, which it never claims.
  for (const count of [2, 5, 12]) {
    const target = memoryDatabase();
    const wirings = Array.from({ length: count }, () => startWiring(target));
    const results = await Promise.all(
      wirings.map((wiring) =>
        startAttorneyApplication(wiring.sources, startForm()),
      ),
    );
    assert.equal(target.attorney_profiles.length, 1, String(count));
    assert.equal(
      results.filter((result) => result.status === "created").length,
      1,
      String(count),
    );
    assert.equal(
      results.filter((result) => result.status === "on-record").length,
      count - 1,
      String(count),
    );
    // Every request attempted its one insert, after reading no profile.
    for (const wiring of wirings) {
      assert.deepEqual(wiring.provisioning.calls, EXPECTED_CREATION_CALLS);
    }
    assert.equal(target.attorney_profiles[0].profile_state, "applicant");
    assert.equal(target.attorney_profiles[0].user_id, USER_ID);
  }
});

test("8. failed inserts and uncertain persistence never become success: only a fresh read of exactly the inserted row is creation", async () => {
  const cases = {
    "insert refused, nothing on record": {
      overrides: { insertApplicantProfile: async () => UNREADABLE },
      expected: UNCONFIRMED,
      profiles: 0,
    },
    "insert throws, nothing on record": {
      overrides: {
        insertApplicantProfile: async () => {
          throw new Error(DETAIL);
        },
      },
      expected: UNCONFIRMED,
      profiles: 0,
    },
    "insert lands but its answer is lost": {
      overrides: {
        insertApplicantProfile: async (_userId, real) => {
          await real();
          throw new Error(DETAIL);
        },
      },
      expected: ON_RECORD,
      profiles: 1,
    },
    "insert lands but answers unreadable": {
      overrides: {
        insertApplicantProfile: async (_userId, real) => {
          await real();
          return UNREADABLE;
        },
      },
      expected: ON_RECORD,
      profiles: 1,
    },
    "insert lands but answers no row": {
      overrides: {
        insertApplicantProfile: async (_userId, real) => {
          await real();
          return rowsResult([]);
        },
      },
      expected: ON_RECORD,
      profiles: 1,
    },
    "insert answers another state": {
      overrides: {
        insertApplicantProfile: async (_userId, real) => {
          const answer = await real();
          return rowsResult([{ ...answer.rows[0], profile_state: "approved" }]);
        },
      },
      expected: ON_RECORD,
      profiles: 1,
    },
    "insert answers another User": {
      overrides: {
        insertApplicantProfile: async (_userId, real) => {
          const answer = await real();
          return rowsResult([{ ...answer.rows[0], user_id: OTHER_USER_ID }]);
        },
      },
      expected: ON_RECORD,
      profiles: 1,
    },
    "insert answers two rows": {
      overrides: {
        insertApplicantProfile: async (_userId, real) => {
          const answer = await real();
          return rowsResult([answer.rows[0], answer.rows[0]]);
        },
      },
      expected: ON_RECORD,
      profiles: 1,
    },
    "fresh read fails after the insert": {
      reread: async () => UNREADABLE,
      expected: UNCONFIRMED,
      profiles: 1,
    },
    "fresh read throws after the insert": {
      reread: async () => {
        throw new Error(DETAIL);
      },
      expected: UNCONFIRMED,
      profiles: 1,
    },
    "fresh read shows nothing after a reported insert": {
      reread: async () => rowsResult([]),
      expected: UNCONFIRMED,
      profiles: 1,
    },
    "fresh read shows another profile id": {
      reread: async () =>
        rowsResult([attorneyProfile({ id: OTHER_PROFILE_ID })]),
      expected: UNCONFIRMED,
      profiles: 1,
    },
    "fresh read shows two profiles": {
      reread: async (real) => {
        const answer = await real();
        return rowsResult([
          answer.rows[0],
          attorneyProfile({ id: OTHER_PROFILE_ID }),
        ]);
      },
      expected: UNCONFIRMED,
      profiles: 1,
    },
    "fresh read shows the row in an unknown state": {
      reread: async (real) => {
        const answer = await real();
        return rowsResult([{ ...answer.rows[0], profile_state: "verified" }]);
      },
      expected: UNCONFIRMED,
      profiles: 1,
    },
    "fresh read shows the row linked to another User": {
      reread: async (real) => {
        const answer = await real();
        return rowsResult([{ ...answer.rows[0], user_id: OTHER_USER_ID }]);
      },
      expected: UNCONFIRMED,
      profiles: 1,
    },
  };
  for (const [
    name,
    { overrides = {}, reread, expected, profiles },
  ] of Object.entries(cases)) {
    const db = memoryDatabase();
    let reads = 0;
    const merged =
      reread === undefined
        ? overrides
        : {
            ...overrides,
            attorneyProfilesOf: async (_userId, real) => {
              reads += 1;
              return reads === 1 ? real() : reread(real);
            },
          };
    const wiring = startWiring(db, { overrides: merged });
    const outcome = await startAttorneyApplication(wiring.sources, startForm());
    assertExactly(outcome, expected, name);
    assert.notDeepEqual(outcome, CREATED, name);
    assert.equal(db.attorney_profiles.length, profiles, name);
    // Exactly one insert was attempted, then exactly one fresh read.
    assert.deepEqual(
      wiring.provisioning.calls.map(([call]) => call),
      [
        "usersOf",
        "attorneyProfilesOf",
        "insertApplicantProfile",
        "attorneyProfilesOf",
      ],
      name,
    );
    // Whatever happened, no profile other than an applicant one exists.
    for (const row of db.attorney_profiles) {
      assert.equal(row.profile_state, "applicant", name);
    }
  }
  // A retry after an unconfirmed start never creates a second profile.
  const db = memoryDatabase();
  const lost = startWiring(db, {
    overrides: {
      insertApplicantProfile: async (_userId, real) => {
        await real();
        throw new Error(DETAIL);
      },
      attorneyProfilesOf: async (_userId, real) => {
        const answer = await real();
        return answer.rows.length === 0 ? answer : UNREADABLE;
      },
    },
  });
  assertExactly(
    await startAttorneyApplication(lost.sources, startForm()),
    UNCONFIRMED,
  );
  assertExactly(
    await startAttorneyApplication(startWiring(db).sources, startForm()),
    ON_RECORD,
  );
  assert.equal(db.attorney_profiles.length, 1);
});

test("9. an unbound, failing, or malformed privileged port refuses before any write, and pre-write read failures are unavailable", async () => {
  for (const provisioning of [
    async () => null,
    async () => undefined,
    async () => "port",
    async () => {
      throw new Error(DETAIL);
    },
    () => {
      throw new Error(DETAIL);
    },
  ]) {
    const db = memoryDatabase();
    const wiring = startWiring(db);
    assertExactly(
      await startAttorneyApplication(
        { ...wiring.sources, provisioning },
        startForm(),
      ),
      UNAVAILABLE,
    );
    assert.equal(db.attorney_profiles.length, 0);
  }
  const failures = {
    "User read fails": { usersOf: async () => UNREADABLE },
    "User read throws": {
      usersOf: async () => {
        throw new Error(DETAIL);
      },
    },
    "User read malformed": { usersOf: async () => ({ kind: "rows" }) },
    "User read with an extra field": {
      usersOf: async () => ({ kind: "rows", rows: [], extra: true }),
    },
    "profile read fails": { attorneyProfilesOf: async () => UNREADABLE },
    "profile read throws": {
      attorneyProfilesOf: async () => {
        throw new Error(DETAIL);
      },
    },
    "profile read not a list": {
      attorneyProfilesOf: async () => ({ kind: "rows", rows: "none" }),
    },
  };
  for (const [name, overrides] of Object.entries(failures)) {
    const db = memoryDatabase();
    const wiring = startWiring(db, { overrides });
    assertExactly(
      await startAttorneyApplication(wiring.sources, startForm()),
      UNAVAILABLE,
      name,
    );
    assert.equal(db.attorney_profiles.length, 0, name);
    assert.ok(
      wiring.provisioning.calls.every(
        ([call]) => call !== "insertApplicantProfile",
      ),
      name,
    );
    assertExactly(
      await resolveAttorneyApplicationEntry(
        entryWiring(db, { overrides }).sources,
      ),
      UNAVAILABLE,
      name,
    );
  }
  // The entry is unavailable without its record port, and never throws.
  for (const records of [
    async () => null,
    async () => {
      throw new Error(DETAIL);
    },
  ]) {
    const wiring = entryWiring(memoryDatabase());
    assertExactly(
      await resolveAttorneyApplicationEntry({ ...wiring.sources, records }),
      UNAVAILABLE,
    );
  }
  for (const sources of [undefined, null, {}]) {
    assertExactly(await resolveAttorneyApplicationEntry(sources), UNAVAILABLE);
    assertExactly(
      await startAttorneyApplication(sources, startForm()),
      UNAVAILABLE,
    );
  }
});

test("10. the entry only reads, and reports each standing as one fixed state", async () => {
  const cases = [
    [{ subject: null }, {}, SIGN_IN_REQUIRED],
    [{}, {}, CAN_START],
    [{}, { attorneys: [attorneyProfile()] }, ON_RECORD],
    [
      {},
      { attorneys: [attorneyProfile({ profile_state: "under_review" })] },
      ON_RECORD,
    ],
    [
      {},
      { attorneys: [attorneyProfile({ profile_state: "approved" })] },
      ON_RECORD,
    ],
    [
      {},
      { attorneys: [attorneyProfile({ profile_state: "suspended" })] },
      DENIED,
    ],
    [
      {},
      { attorneys: [attorneyProfile({ profile_state: "removed" })] },
      DENIED,
    ],
    [{ user: { id: SUBJECT, emailConfirmedAt: null } }, {}, DENIED],
    [{}, { users: [] }, DENIED],
    [{ user: () => ({ kind: "unreadable" }) }, {}, UNAVAILABLE],
  ];
  for (const [options, data, expected] of cases) {
    const db = memoryDatabase(data);
    const before = snapshot(db);
    const wiring = entryWiring(db, options);
    const entry = await resolveAttorneyApplicationEntry(wiring.sources);
    assertExactly(entry, expected, JSON.stringify([options, data]));
    assert.deepEqual(Object.keys(entry), ["status"]);
    // Only reads: nothing is written, whatever the standing.
    assert.equal(snapshot(db), before);
    assert.ok(
      wiring.records.calls.every(([call]) => call !== "insertApplicantProfile"),
    );
    if (expected === SIGN_IN_REQUIRED) {
      assert.deepEqual(wiring.account.log, []);
      assert.equal(wiring.built(), 0);
    }
  }
});

// ---------------------------------------------------------------------------
// P3-001 preservation.
// ---------------------------------------------------------------------------

// A request-scoped read client over a memory database, the shape the P3-001
// and P2-006 principal sources read through: a fresh Auth user and own-row
// reads that resolve on limit(). It offers no write method at all.
function readClientOver(
  db,
  {
    user = { id: SUBJECT, email: EMAIL, email_confirmed_at: CONFIRMED_AT },
  } = {},
) {
  const calls = [];
  const columnsOf = (text) => text.split(",").map((column) => column.trim());
  const query = (table) => {
    const steps = [];
    const filters = [];
    let columns = null;
    const builder = {
      select: (text) => {
        steps.push(["select", text]);
        columns = columnsOf(text);
        return builder;
      },
      eq: (column, value) => {
        steps.push(["eq", column, value]);
        filters.push([column, value]);
        return builder;
      },
      limit: async (count) => {
        steps.push(["limit", count]);
        calls.push([table, steps]);
        await tick();
        const data = db[table]
          .filter((row) =>
            filters.every(([column, value]) => row[column] === value),
          )
          .slice(0, count)
          .map((row) => pick(row, columns));
        return { data, error: null };
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
          return { data: { user }, error: null };
        },
      },
      from: query,
    },
  };
}

test("11. a started application enters the unchanged P3-001 workspace as an applicant through its own independent checks, and grants nothing more", async () => {
  const db = memoryDatabase();
  const reader = readClientOver(db);
  const attorney = createAttorneyPrincipalSource(async () => reader.client);
  const workspace = { session: sessionOf(SUBJECT), attorney };
  assertExactly(await resolveAttorneyWorkspaceAccess(workspace), {
    status: "denied",
  });
  assertExactly(
    await startAttorneyApplication(startWiring(db).sources, startForm()),
    CREATED,
  );
  assertExactly(await resolveAttorneyWorkspaceAccess(workspace), {
    status: "granted",
    stage: "applicant",
  });
  // The attorney context is the only one it adds, with no capability, and
  // no Client or staff context is created.
  const sources = {
    session: sessionOf(SUBJECT),
    contexts: attorney,
    capabilities: { isGranted: async () => false },
  };
  assert.deepEqual(await authorize(sources, { context: "attorney" }), {
    status: "authorized",
  });
  for (const context of ["client", "staff"]) {
    assert.deepEqual(await authorize(sources, { context }), {
      status: "forbidden",
    });
  }
  assert.deepEqual(
    await authorize(sources, {
      context: "attorney",
      capability: { capability: "manage_attorney_verification", scope: "x" },
    }),
    { status: "forbidden" },
  );
  // The workspace still refuses a suspended or removed profile, and starting
  // again revives neither.
  for (const state of REFUSED_STATES) {
    db.attorney_profiles[0].profile_state = state;
    assertExactly(await resolveAttorneyWorkspaceAccess(workspace), {
      status: "denied",
    });
    assertExactly(
      await startAttorneyApplication(startWiring(db).sources, startForm()),
      DENIED,
    );
    assert.equal(db.attorney_profiles[0].profile_state, state);
    assert.equal(db.attorney_profiles.length, 1);
  }
  // Anonymous requests and inactive Users start nothing and gain no
  // attorney context.
  for (const [subject, users] of [
    [null, [activeUser()]],
    [SUBJECT, [activeUser({ account_state: "suspended" })]],
  ]) {
    const target = memoryDatabase({ users });
    await startAttorneyApplication(
      startWiring(target, { subject }).sources,
      startForm(),
    );
    assert.equal(target.attorney_profiles.length, 0);
  }
});

// ---------------------------------------------------------------------------
// The shared provisioning boundary's attorney-applicant port.
// ---------------------------------------------------------------------------

const PROJECT_REF = "syntheticprojectrefa";
const OTHER_REF = "syntheticprojectrefb";
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

// A legacy-format project key: three base64url segments whose payload names
// a project and role. Built at run time; it signs nothing.
function legacyKey(claims) {
  const segment = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "HS256", typ: "JWT" }),
    segment(claims),
    "c3ludGhldGlj",
  ].join(".");
}

function recordingFactory() {
  const made = [];
  return {
    made,
    create: (...args) => {
      made.push(args);
      return { auth: {}, from: () => ({}) };
    },
  };
}

test("12. the attorney-applicant port is built only for a verified project binding: anything missing, malformed, or mismatched builds no client", async () => {
  const invalid = {
    "missing project ref": { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined },
    "malformed project ref": {
      ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "Synthetic-Ref",
    },
    "cross-project ref": { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: OTHER_REF },
    "missing URL": { NEXT_PUBLIC_SUPABASE_URL: undefined },
    "HTTP URL": {
      NEXT_PUBLIC_SUPABASE_URL: `http://${PROJECT_REF}.supabase.co`,
    },
    "unexpected host": {
      NEXT_PUBLIC_SUPABASE_URL: `https://${PROJECT_REF}.elsewhere.invalid`,
    },
    path: { NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}/rest/v1` },
    port: { NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}:8443` },
    "missing publishable key": {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
    },
    "missing admin key": { ROSUNO_SUPABASE_ADMIN_KEY: undefined },
    "empty admin key": { ROSUNO_SUPABASE_ADMIN_KEY: "" },
    "admin key with whitespace": { ROSUNO_SUPABASE_ADMIN_KEY: `${ADMIN} ` },
    "publishable key as admin key": { ROSUNO_SUPABASE_ADMIN_KEY: PUBLISHABLE },
    "unsupported admin key shape": {
      ROSUNO_SUPABASE_ADMIN_KEY: "synthetic-admin-7f3a",
    },
    "legacy admin key for another project": {
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        ref: OTHER_REF,
        role: "service_role",
      }),
    },
    "legacy public key as admin key": {
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({ ref: PROJECT_REF, role: "anon" }),
    },
  };
  for (const [name, overrides] of Object.entries(invalid)) {
    const factory = recordingFactory();
    assert.equal(
      await createAttorneyApplicantProvisioning(
        boundEnvironment(overrides),
        factory.create,
      ),
      null,
      name,
    );
    assert.deepEqual(factory.made, [], name);
  }
  // With no configuration at all, the deployed default is unbound too, and
  // the adapter reports no port.
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "ROSUNO_SUPABASE_ADMIN_KEY",
    "ROSUNO_SUPABASE_EXPECTED_PROJECT_REF",
  ]) {
    assert.equal(process.env[name], undefined, name);
  }
  assert.equal(await createAttorneyApplicantProvisioning(), null);
  assert.equal(await ATTORNEY_APPLICANT_PROVISIONING(), null);
  // Valid bindings build exactly one cookie-free, session-free privileged
  // client, and the port exposes only its three narrow operations.
  for (const environment of [
    boundEnvironment(),
    boundEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}/` }),
    boundEnvironment({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyKey({
        ref: PROJECT_REF,
        role: "anon",
      }),
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        ref: PROJECT_REF,
        role: "service_role",
      }),
    }),
  ]) {
    const factory = recordingFactory();
    const port = await createAttorneyApplicantProvisioning(
      environment,
      factory.create,
    );
    assert.ok(Object.isFrozen(port));
    assert.deepEqual(Object.keys(port), [
      "usersOf",
      "attorneyProfilesOf",
      "insertApplicantProfile",
    ]);
    assert.deepEqual(factory.made, [
      [
        PROJECT_URL,
        environment.ROSUNO_SUPABASE_ADMIN_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        },
      ],
    ]);
    // No key material, project reference, or client is visible on it.
    const visible = JSON.stringify(ownData(port), (_key, item) =>
      typeof item === "function" ? "function" : item,
    );
    assert.equal(
      visible.includes(environment.ROSUNO_SUPABASE_ADMIN_KEY),
      false,
    );
    assert.equal(visible.includes(PROJECT_REF), false);
    for (const value of Object.values(port)) {
      assert.equal(typeof value, "function");
    }
  }
});

// A synthetic in-memory Auth and REST API, reached only through the fetch
// each client is given. attorney_profiles keeps the real unique User link
// (409 with code 23505) and database-generated ids. It records every request
// as sent.
function syntheticApi({
  confirmedAt = CONFIRMED_AT,
  users = [activeUser()],
  attorneys = [],
  failing = [],
} = {}) {
  const db = memoryDatabase({ users, attorneys });
  const jwt = sessionJwt(SUBJECT);
  const requests = [];
  const json = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? ""
        : await request.text();
    requests.push({
      method: request.method,
      url,
      headers: request.headers,
      body,
    });
    await tick();
    const route = `${request.method} ${url.pathname}`;
    if (failing.includes(route)) {
      return json(500, { message: DETAIL });
    }
    const bearer = request.headers.get("authorization");
    const privileged = bearer === `Bearer ${ADMIN}`;
    const own = bearer === `Bearer ${jwt}`;
    if (route === "GET /auth/v1/user") {
      return own
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
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    if (!["users", "attorney_profiles"].includes(table)) {
      return json(404, { message: "not found" });
    }
    if (request.method === "GET") {
      // Own-row policies for the request's session; the privileged key reads
      // past them, as service_role does.
      const columns = url.searchParams.get("select").split(",");
      const filters = [...url.searchParams]
        .filter(([key]) => !["select", "limit"].includes(key))
        .map(([key, value]) => [key, value.replace(/^eq\./, "")]);
      const visible = db[table].filter(
        (row) =>
          privileged ||
          (own &&
            (table === "users"
              ? row.auth_user_id === SUBJECT
              : db.users.some(
                  (user) =>
                    user.id === row.user_id && user.auth_user_id === SUBJECT,
                ))),
      );
      return json(
        200,
        visible
          .filter((row) =>
            filters.every(([key, value]) => String(row[key]) === value),
          )
          .slice(0, Number(url.searchParams.get("limit") ?? "1000"))
          .map((row) => pick(row, columns)),
      );
    }
    if (request.method === "POST" && table === "attorney_profiles") {
      // Only the privileged key may insert, as the grants say.
      if (!privileged) {
        return json(403, { code: "42501", message: "permission denied" });
      }
      const values = JSON.parse(body);
      if (db.attorney_profiles.some((row) => row.user_id === values.user_id)) {
        return json(409, { code: "23505", message: DETAIL });
      }
      if (!db.users.some((row) => row.id === values.user_id)) {
        return json(409, { code: "23503", message: DETAIL });
      }
      const row = { id: db.nextId(), ...values };
      db.attorney_profiles.push(row);
      const columns = url.searchParams.get("select").split(",");
      return json(201, [pick(row, columns)]);
    }
    return json(405, { message: "not allowed" });
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
  return { db, jwt, requests, fetch, cookie };
}

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

function factoryOver(api) {
  return (url, key, options) =>
    createClient(url, key, { ...options, global: { fetch: api.fetch } });
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

function sentOf(requests) {
  return requests.map(({ method, url, body }) => [
    method,
    url.pathname,
    Object.fromEntries(url.searchParams),
    body === "" ? null : JSON.parse(body),
  ]);
}

test("13. through the installed client, the port sends only exact-key reads and one applicant-state insert with the privileged key and no cookie", async () => {
  const api = syntheticApi();
  const port = await createAttorneyApplicantProvisioning(
    boundEnvironment(),
    factoryOver(api),
  );
  assert.deepEqual(await port.usersOf(SUBJECT), rowsResult([activeUser()]));
  assert.deepEqual(await port.attorneyProfilesOf(USER_ID), rowsResult([]));
  const inserted = await port.insertApplicantProfile(USER_ID);
  assert.equal(inserted.kind, "rows");
  assert.equal(inserted.rows.length, 1);
  assert.deepEqual(Object.keys(inserted.rows[0]), [
    "id",
    "user_id",
    "profile_state",
  ]);
  assert.equal(inserted.rows[0].user_id, USER_ID);
  assert.equal(inserted.rows[0].profile_state, "applicant");
  assert.deepEqual(sentOf(api.requests), [
    [
      "GET",
      "/rest/v1/users",
      {
        select: "id,auth_user_id,account_state",
        auth_user_id: `eq.${SUBJECT}`,
        limit: "2",
      },
      null,
    ],
    [
      "GET",
      "/rest/v1/attorney_profiles",
      {
        select: "id,user_id,profile_state",
        user_id: `eq.${USER_ID}`,
        limit: "2",
      },
      null,
    ],
    [
      "POST",
      "/rest/v1/attorney_profiles",
      { select: "id,user_id,profile_state" },
      { user_id: USER_ID, profile_state: "applicant" },
    ],
  ]);
  for (const { headers, url } of api.requests) {
    assert.equal(url.origin, PROJECT_URL);
    assert.equal(headers.get("authorization"), `Bearer ${ADMIN}`);
    assert.equal(headers.get("cookie"), null);
  }
  // A duplicate, a missing User, or any failure is unreadable, never rows.
  assert.deepEqual(await port.insertApplicantProfile(USER_ID), UNREADABLE);
  assert.deepEqual(
    await port.insertApplicantProfile(OTHER_USER_ID),
    UNREADABLE,
  );
  const failing = syntheticApi({
    failing: [
      "GET /rest/v1/users",
      "GET /rest/v1/attorney_profiles",
      "POST /rest/v1/attorney_profiles",
    ],
  });
  const failingPort = await createAttorneyApplicantProvisioning(
    boundEnvironment(),
    factoryOver(failing),
  );
  assert.deepEqual(await failingPort.usersOf(SUBJECT), UNREADABLE);
  assert.deepEqual(await failingPort.attorneyProfilesOf(USER_ID), UNREADABLE);
  assert.deepEqual(
    await failingPort.insertApplicantProfile(USER_ID),
    UNREADABLE,
  );
  assert.equal(failing.db.attorney_profiles.length, 0);
});

test("14. end to end through the installed clients: the trusted session, a fresh Auth read, and the shared port create one profile, and concurrent starts keep one", async () => {
  const api = syntheticApi();
  const sources = () => ({
    session: createSupabaseServerSessionSource(async () => requestClient(api)),
    account: createAttorneyApplicationAccountSource(async () =>
      requestClient(api),
    ),
    provisioning: createBoundedApplicantProvisioning(() =>
      createAttorneyApplicantProvisioning(boundEnvironment(), factoryOver(api)),
    ),
  });
  const entrySources = () => ({
    session: createSupabaseServerSessionSource(async () => requestClient(api)),
    account: createAttorneyApplicationAccountSource(async () =>
      requestClient(api),
    ),
    records: createAttorneyApplicationRecordSource(async () =>
      requestClient(api),
    ),
  });
  assertExactly(
    await resolveAttorneyApplicationEntry(entrySources()),
    CAN_START,
  );
  // The entry used only the request's own session and publishable key, and
  // only reads.
  for (const { method, headers } of api.requests) {
    assert.equal(method, "GET");
    assert.equal(headers.get("authorization"), `Bearer ${api.jwt}`);
    assert.equal(headers.get("apikey"), PUBLISHABLE);
  }
  api.requests.length = 0;
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      startAttorneyApplication(sources(), startForm()),
    ),
  );
  assert.equal(api.db.attorney_profiles.length, 1);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "created",
    "on-record",
    "on-record",
    "on-record",
    "on-record",
    "on-record",
  ]);
  // The Auth read used the request's own session; every database call used
  // the privileged key with no cookie; only the insert wrote.
  for (const { method, url, headers, body } of api.requests) {
    if (url.pathname === "/auth/v1/user") {
      assert.equal(headers.get("authorization"), `Bearer ${api.jwt}`);
      assert.equal(headers.get("apikey"), PUBLISHABLE);
      continue;
    }
    assert.equal(headers.get("authorization"), `Bearer ${ADMIN}`);
    assert.equal(headers.get("cookie"), null);
    if (method !== "GET") {
      assert.equal(
        `${method} ${url.pathname}`,
        "POST /rest/v1/attorney_profiles",
      );
      assert.deepEqual(JSON.parse(body), {
        user_id: USER_ID,
        profile_state: "applicant",
      });
    }
  }
  assertExactly(
    await resolveAttorneyApplicationEntry(entrySources()),
    ON_RECORD,
  );
  // The P3-001 workspace, through its own real wiring, admits the applicant.
  const workspace = {
    session: createSupabaseServerSessionSource(async () => requestClient(api)),
    attorney: createAttorneyPrincipalSource(async () => requestClient(api)),
  };
  assertExactly(await resolveAttorneyWorkspaceAccess(workspace), {
    status: "granted",
    stage: "applicant",
  });
  // Without a session cookie nothing is read past the session, and nothing
  // is created; an unconfirmed account is refused before the privileged
  // port.
  const anonymousApi = syntheticApi();
  assertExactly(
    await startAttorneyApplication(
      {
        session: createSupabaseServerSessionSource(async () =>
          requestClient(anonymousApi, { signedIn: false }),
        ),
        account: createAttorneyApplicationAccountSource(async () =>
          requestClient(anonymousApi, { signedIn: false }),
        ),
        provisioning: createBoundedApplicantProvisioning(() =>
          createAttorneyApplicantProvisioning(
            boundEnvironment(),
            factoryOver(anonymousApi),
          ),
        ),
      },
      startForm(),
    ),
    SIGN_IN_REQUIRED,
  );
  assert.ok(
    anonymousApi.requests.every(({ url }) => !url.pathname.startsWith("/rest")),
  );
  const unconfirmed = syntheticApi({ confirmedAt: null });
  assertExactly(
    await startAttorneyApplication(
      {
        session: createSupabaseServerSessionSource(async () =>
          requestClient(unconfirmed),
        ),
        account: createAttorneyApplicationAccountSource(async () =>
          requestClient(unconfirmed),
        ),
        provisioning: createBoundedApplicantProvisioning(() =>
          createAttorneyApplicantProvisioning(
            boundEnvironment(),
            factoryOver(unconfirmed),
          ),
        ),
      },
      startForm(),
    ),
    DENIED,
  );
  assert.ok(
    unconfirmed.requests.every(({ url }) => !url.pathname.startsWith("/rest")),
  );
  assert.equal(unconfirmed.db.attorney_profiles.length, 0);
});

// ---------------------------------------------------------------------------
// The server-only adapter.
// ---------------------------------------------------------------------------

test("15. the account port reads the request's own Auth user afresh, passes on only its id and confirmation, and is unreadable on any failure or delay", async () => {
  const stand = readClientOver(memoryDatabase(), {
    user: {
      id: SUBJECT,
      email: EMAIL,
      email_confirmed_at: CONFIRMED_AT,
      app_metadata: { role: "attorney" },
      user_metadata: { profile_state: "approved" },
    },
  });
  const source = createAttorneyApplicationAccountSource(
    async () => stand.client,
  );
  assertExactly(await source.currentAccount(), {
    kind: "user",
    id: SUBJECT,
    emailConfirmedAt: CONFIRMED_AT,
  });
  // No identifier is passed in: the read is the request's own session.
  assert.deepEqual(stand.calls, [["getUser"]]);
  const failures = [
    async () => null,
    async () => {
      throw new Error(DETAIL);
    },
    async () => ({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    }),
    async () => ({
      auth: { getUser: async () => ({ data: null, error: new Error(DETAIL) }) },
    }),
    async () => ({
      auth: {
        getUser: async () => {
          throw new Error(DETAIL);
        },
      },
    }),
    async () => ({ auth: { getUser: never } }),
    never,
  ];
  for (const clientSource of failures) {
    const started = performance.now();
    assertExactly(
      await createAttorneyApplicationAccountSource(
        clientSource,
        25,
      ).currentAccount(),
      { kind: "unreadable" },
    );
    assert.ok(performance.now() - started < 2000);
  }
  for (const deadline of [0, -1, 1.5, Number.NaN, Infinity, "25", null]) {
    assert.throws(
      () => createAttorneyApplicationAccountSource(async () => null, deadline),
      TypeError,
    );
    assert.throws(
      () => createAttorneyApplicationRecordSource(async () => null, deadline),
      TypeError,
    );
    assert.throws(
      () => createBoundedApplicantProvisioning(async () => null, deadline),
      TypeError,
    );
  }
  assert.ok(Object.isFrozen(ATTORNEY_APPLICATION_ACCOUNT));
  assert.deepEqual(Object.keys(ATTORNEY_APPLICATION_ACCOUNT), [
    "currentAccount",
  ]);
});

test("16. the entry's record port reads only through the request-scoped client, by exact keys, and is unreadable on any failure or delay", async () => {
  const db = memoryDatabase({ attorneys: [attorneyProfile()] });
  const stand = readClientOver(db);
  let built = 0;
  const records = await createAttorneyApplicationRecordSource(async () => {
    built += 1;
    return stand.client;
  })();
  assert.ok(Object.isFrozen(records));
  assert.deepEqual(Object.keys(records), ["usersOf", "attorneyProfilesOf"]);
  assert.deepEqual(await records.usersOf(SUBJECT), rowsResult([activeUser()]));
  assert.deepEqual(
    await records.attorneyProfilesOf(USER_ID),
    rowsResult([attorneyProfile()]),
  );
  assert.equal(built, 1);
  assert.deepEqual(stand.calls, [
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
  // No client, or one that never arrives, is no port.
  assert.equal(
    await createAttorneyApplicationRecordSource(async () => null)(),
    null,
  );
  assert.equal(await createAttorneyApplicationRecordSource(never, 25)(), null);
  assert.equal(
    await createAttorneyApplicationRecordSource(async () => {
      throw new Error(DETAIL);
    })(),
    null,
  );
  // Failing, malformed, thrown, or slow reads are unreadable.
  const failing = (answer) => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: answer,
      };
      return builder;
    },
  });
  for (const answer of [
    async () => ({ data: null, error: { message: DETAIL } }),
    async () => ({ data: { rows: [] }, error: null }),
    async () => {
      throw new Error(DETAIL);
    },
    never,
  ]) {
    const port = await createAttorneyApplicationRecordSource(
      async () => failing(answer),
      25,
    )();
    assert.deepEqual(await port.usersOf(SUBJECT), UNREADABLE);
    assert.deepEqual(await port.attorneyProfilesOf(USER_ID), UNREADABLE);
  }
  // The port is read-only: it offers no write of any kind.
  assert.equal("insertApplicantProfile" in records, false);
  // Without the public project configuration, the default request client is
  // never built, so the deployed default reports no port.
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, undefined);
  assert.equal(await ATTORNEY_APPLICATION_RECORDS(), null);
});

test("17. the bounded applicant port delegates every call to the shared boundary unchanged and turns failure or delay into unreadable", async () => {
  const db = memoryDatabase();
  const shared = memoryProvisioning(db);
  let built = 0;
  const port = await createBoundedApplicantProvisioning(async () => {
    built += 1;
    return shared.port;
  })();
  assert.ok(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port), [
    "usersOf",
    "attorneyProfilesOf",
    "insertApplicantProfile",
  ]);
  assert.deepEqual(await port.usersOf(SUBJECT), rowsResult([activeUser()]));
  const inserted = await port.insertApplicantProfile(USER_ID);
  assert.equal(inserted.rows[0].user_id, USER_ID);
  assert.deepEqual(shared.calls, [
    ["usersOf", SUBJECT],
    ["insertApplicantProfile", USER_ID],
  ]);
  assert.equal(built, 1);
  for (const source of [
    async () => null,
    async () => undefined,
    async () => "port",
    never,
    async () => {
      throw new Error(DETAIL);
    },
  ]) {
    assert.equal(await createBoundedApplicantProvisioning(source, 25)(), null);
  }
  const slow = memoryProvisioning(memoryDatabase(), {
    usersOf: never,
    attorneyProfilesOf: async () => {
      throw new Error(DETAIL);
    },
    insertApplicantProfile: async (_userId, real) => {
      await delay(60);
      return real();
    },
  });
  const bounded = await createBoundedApplicantProvisioning(
    async () => slow.port,
    25,
  )();
  const started = performance.now();
  assert.deepEqual(await bounded.usersOf(SUBJECT), UNREADABLE);
  assert.deepEqual(await bounded.attorneyProfilesOf(USER_ID), UNREADABLE);
  // A late insert answer is ignored: its outcome is unknown here, and only
  // the application's fresh read afterwards decides.
  assert.deepEqual(await bounded.insertApplicantProfile(USER_ID), UNREADABLE);
  assert.ok(performance.now() - started < 2000);
  await delay(80);
});

// ---------------------------------------------------------------------------
// Module contracts.
// ---------------------------------------------------------------------------

const PRIVILEGED_NAMES =
  /ROSUNO_SUPABASE|service_role|sb_secret_|createClient\b|process\.env|adminKey|binding/;

test("18. the application boundary is provider-neutral, holds no state, and decides no verification, eligibility, or other business question", () => {
  const source = read("src/application/attorney-application.ts");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), ["./session.ts"]);
  assert.doesNotMatch(
    code,
    /\bimport\s*\(|\brequire\s*\(|next|react|supabase|postgres|\bprocess\b|\bconsole\b|\bfetch\s*\(|cookie|header|localStorage|sessionStorage|globalThis|\bwindow\b|\bdocument\b|Math\.random|\bDate\b|setTimeout|\bjwt\b|access_?token/i,
  );
  assert.doesNotMatch(code, /^\s*(?:let|var) /m);
  // The one User account-state name is set aside, exactly once; nothing else
  // may speak of verification or any other business decision.
  assert.equal(code.split('"pending_verification"').length, 2);
  assert.doesNotMatch(
    code.replace('"pending_verification"', " "),
    /verif|eligib|bookab|consult|payment|licen[cs]e|capabilit|"client"|"staff"|client_profiles|\.from\(|\.update\(|\.upsert\(|\.delete\(/i,
  );
  assert.doesNotMatch(code, PRIVILEGED_NAMES);
  assert.deepEqual(
    [
      ...code.matchAll(
        /^export (?:async function|function|const|type) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    [
      "AttorneyApplicationAccountRead",
      "AttorneyApplicationAccountSource",
      "AttorneyApplicationRows",
      "AttorneyApplicationRecords",
      "AttorneyApplicantProvisioning",
      "AttorneyApplicationEntrySources",
      "AttorneyApplicationStartSources",
      "AttorneyApplicationEntry",
      "AttorneyApplicationOutcome",
      "ATTORNEY_APPLICATION_INTENT",
      "resolveAttorneyApplicationEntry",
      "startAttorneyApplication",
    ],
  );
  // The one write, called once, after the explicit start and the reads.
  assert.equal(code.match(/\.insertApplicantProfile\(/g).length, 1);
  assert.equal(code.match(/\.currentAccount\(/g).length, 1);
  assert.equal(code.match(/"applicant"/g).length, 2);
  assert.match(
    code,
    /const ON_RECORD_PROFILE_STATES = Object\.freeze\(\[\n {2}"applicant",\n {2}"under_review",\n {2}"approved",\n\] as const\);/,
  );
  assert.match(
    code,
    /const REFUSED_PROFILE_STATES = Object\.freeze\(\["suspended", "removed"\] as const\);/,
  );
  assert.match(
    code,
    /const INACTIVE_ACCOUNT_STATES = Object\.freeze\(\[\n {2}"pending_verification",\n {2}"suspended",\n {2}"closed",\n\] as const\);/,
  );
  assert.equal(code.match(/"active"/g).length, 1);
  // The privileged port is built only after the account is verified.
  const start = code.slice(
    code.indexOf("export async function startAttorneyApplication("),
  );
  assert.ok(
    start.indexOf("isExplicitStart(payload)") <
      start.indexOf("confirmedAccountOf("),
  );
  assert.ok(
    start.indexOf("confirmedAccountOf(") <
      start.indexOf("portFrom(sources.provisioning)"),
  );
  assert.ok(
    start.indexOf("standingOf(") < start.indexOf(".insertApplicantProfile("),
  );
  assert.ok(
    start.indexOf(".insertApplicantProfile(") <
      start.indexOf("outcomeAfterWrite("),
  );
});

test("19. the adapter holds no credential and builds no privileged client: it delegates to the shared boundary and reads only through the request client", () => {
  const file =
    "src/infrastructure/identity/attorney-application-provisioning.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "@supabase/supabase-js",
    "../../application/attorney-application.ts",
    "./registration-provisioning.ts",
  ]);
  assert.match(
    code,
    /^import type \{ SupabaseClient \} from "@supabase\/supabase-js";$/m,
  );
  assert.match(
    code,
    /^import \{ createAttorneyApplicantProvisioning \} from "\.\/registration-provisioning\.ts";$/m,
  );
  assert.match(code, /await import\("\.\/supabase-server\.ts"\)/);
  assert.equal(code.match(/\bimport\s*\(/g).length, 1);
  assert.doesNotMatch(code, PRIVILEGED_NAMES);
  assert.doesNotMatch(
    code,
    /createServerClient|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\brpc\b|\.admin\b|\bconsole\b|cookies|headers|getSession|getClaims|user_metadata|app_metadata|\.email\b|searchParams|globalThis|localStorage|client_profiles/,
  );
  assert.equal(code.match(/createAttorneyApplicantProvisioning\(/g).length, 1);
  assert.deepEqual(
    [...code.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]),
    ["users", "attorney_profiles"],
  );
  assert.deepEqual(
    [...code.matchAll(/\.eq\(([^)]*)\)/g)].map((match) => match[1]),
    ['"auth_user_id", accountId', '"user_id", userId'],
  );
  assert.equal(code.match(/\.getUser\(\)/g).length, 1);
  assert.deepEqual(
    [...code.matchAll(/^export (?:const|function) (\w+)/gm)].map(
      (match) => match[1],
    ),
    [
      "createAttorneyApplicationAccountSource",
      "createAttorneyApplicationRecordSource",
      "createBoundedApplicantProvisioning",
      "ATTORNEY_APPLICATION_ACCOUNT",
      "ATTORNEY_APPLICATION_RECORDS",
      "ATTORNEY_APPLICANT_PROVISIONING",
    ],
  );
  assert.equal(code.match(/\bexport\b/g).length, 6);
});

test("20. the shared boundary's attorney section is narrow: exact tables, columns, keys, and one applicant insert, with no generic executor", () => {
  const code = codeOf(
    read("src/infrastructure/identity/registration-provisioning.ts"),
  );
  const start = code.indexOf(
    "export async function createAttorneyApplicantProvisioning(",
  );
  const end = code.indexOf("type QuotaDigests");
  assert.ok(start > 0 && end > start);
  const section = code.slice(start, end);
  // It is built exactly like the existing ports: verified binding first, then
  // one cookie-free privileged client, never returned.
  assert.match(
    section,
    /const binding = readProjectBinding\(environment\);\n {2}if \(binding === null\) \{\n {4}return null;\n {2}\}\n {2}const admin = create\(binding\.url, binding\.adminKey, clientOptions\(\)\);\n {2}return Object\.freeze\(\{/,
  );
  assert.deepEqual(
    [...section.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]),
    ["users", "attorney_profiles", "attorney_profiles"],
  );
  assert.deepEqual(
    [...section.matchAll(/\.eq\(([^)]*)\)/g)].map((match) => match[1]),
    ['"auth_user_id", accountId', '"user_id", userId'],
  );
  assert.equal(section.match(/\.limit\(2\)/g).length, 2);
  assert.equal(section.match(/\.insert\(/g).length, 1);
  assert.match(
    section,
    /\.insert\(\{ user_id: userId, profile_state: "applicant" \}\)/,
  );
  assert.doesNotMatch(
    section,
    /\.update\(|\.upsert\(|\.delete\(|\brpc\b|auth\.admin|\bthrow\b|process\.env|return admin|admin[,;)]|\.\.\./,
  );
  assert.match(
    code,
    /^const ATTORNEY_PROFILE_COLUMNS = "id, user_id, profile_state";$/m,
  );
  // The pre-existing ports are untouched by the new section. The P3-003
  // professional ports sit in their own bounded section before it, are
  // checked exactly by the P3-003 tests, and are the only code set aside.
  const professionalStart = code.indexOf("const MAX_IDS = 500;");
  const professionalEnd = code.indexOf(
    'const ATTORNEY_PROFILE_COLUMNS = "id, user_id, profile_state";',
  );
  assert.ok(professionalStart > 0 && professionalEnd > professionalStart);
  const outside =
    code.slice(0, professionalStart) + code.slice(professionalEnd);
  assert.equal(outside.match(/profile_state/g).length, 2);
  assert.equal(outside.match(/attorney_profiles/g).length, 2);
});

test("21. privileged credentials and modules never reach presentation: the page, action, and application code name none, and no client module imports infrastructure", () => {
  for (const file of [
    "app/attorney/apply/page.tsx",
    "app/attorney/apply/actions.ts",
    "app/attorney/page.tsx",
    "src/application/attorney-application.ts",
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(code, PRIVILEGED_NAMES, file);
    assert.doesNotMatch(source, /["']use client["']/, file);
    assert.ok(
      importsOf(source).every(
        (specifier) => !specifier.endsWith("registration-provisioning.ts"),
      ),
      file,
    );
    assert.doesNotMatch(
      code,
      /NEXT_PUBLIC_ROSUNO|NEXT_PUBLIC_\w*(?:ADMIN|SECRET|SERVICE)/,
      file,
    );
  }
});

test("22. D-04 and client registration stay as they were: P3-002 adds no account creation, signup path, or registration mechanism", async () => {
  for (const file of [
    "app/attorney/apply/page.tsx",
    "app/attorney/apply/actions.ts",
    "src/application/attorney-application.ts",
    "src/infrastructure/identity/attorney-application-provisioning.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /\.signUp\(|createUser|createAccount|inviteUserByEmail|generateLink|signInWithOtp|registerClientAccount|insertPendingUser|activatePendingUser|insertClientProfile|registration-abuse-control|client-registration|\/sign-up|\/auth\/confirm|decideQuota|createRegistrationProvisioning|createConfirmationDispatch/,
      file,
    );
  }
  // The sign-up action is still default-deny with no trusted client address.
  const signUp = codeOf(read("app/sign-up/actions.ts"));
  assert.match(signUp, /trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,/);
  // The existing registration ports keep exactly their operations.
  const factory = recordingFactory();
  const provisioning = await createRegistrationProvisioning(
    boundEnvironment(),
    factory.create,
  );
  assert.deepEqual(Object.keys(provisioning), [
    "createAccount",
    "readAccount",
    "usersOf",
    "insertPendingUser",
    "clientProfilesOf",
    "insertClientProfile",
    "activatePendingUser",
  ]);
  const dispatch = await createConfirmationDispatch(
    boundEnvironment(),
    factory.create,
  );
  assert.deepEqual(Object.keys(dispatch), ["requestSignupConfirmation"]);
  assert.deepEqual(
    factory.made.map(([url, key]) => [url, key]),
    [
      [PROJECT_URL, ADMIN],
      [PROJECT_URL, PUBLISHABLE],
    ],
  );
});

test("23. the entry page is a server-rendered, parameter-free page with one explicit form, fixed destinations, and the trusted wiring only", () => {
  const source = read("app/attorney/apply/page.tsx");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "next",
    "next/server",
    "react",
    "../../../src/application/attorney-application.ts",
    "../../../src/infrastructure/identity/attorney-application-provisioning.ts",
    "../../../src/infrastructure/identity/server-session-source.ts",
    "../../../src/presentation/design-system.tsx",
    "./actions.ts",
  ]);
  assert.match(code, /^import type \{ Metadata \} from "next";$/m);
  assert.match(code, /^import type \{ ReactNode \} from "react";$/m);
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  assert.deepEqual(
    [
      ...code.matchAll(
        /^export (?:default )?(?:async )?(?:function|const) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    ["metadata", "AttorneyApplicationPage"],
  );
  assert.equal(code.match(/\bexport\b/g).length, 2);
  assert.match(
    code,
    /^export default async function AttorneyApplicationPage\(\) \{$/m,
  );
  const resolve =
    "await resolveAttorneyApplicationEntry({\n    session: SUPABASE_SERVER_SESSION_SOURCE,\n    account: ATTORNEY_APPLICATION_ACCOUNT,\n    records: ATTORNEY_APPLICATION_RECORDS,\n  });";
  assert.equal(code.split("await connection();").length, 2);
  assert.equal(code.split(resolve).length, 2);
  assert.ok(code.indexOf("await connection();") < code.indexOf(resolve));
  // Exactly one form, posting to the one server action, with only the fixed
  // intent field; the page reads no request input and never writes.
  assert.equal(code.match(/<form\b/g).length, 1);
  assert.match(code, /<form action=\{startApplication\}>/);
  assert.equal(code.match(/<input\b/g).length, 1);
  assert.match(
    code,
    /<input\n\s+type="hidden"\n\s+name=\{ATTORNEY_APPLICATION_INTENT\.field\}\n\s+value=\{ATTORNEY_APPLICATION_INTENT\.value\}\n\s+\/>/,
  );
  assert.doesNotMatch(
    code,
    /searchParams|\bparams\b|headers\(|cookies\(|redirect|notFound|next\/navigation|useActionState|useState|useEffect|dangerouslySetInnerHTML|process\.env|\bconsole\b|createSupabaseServerClient|\.from\(|getUser|getClaims|startAttorneyApplication|ATTORNEY_APPLICANT_PROVISIONING|localStorage|sessionStorage|window\.|document\.|\bfetch\s*\(/,
  );
  assert.deepEqual(
    [...new Set([...code.matchAll(/href="([^"]*)"/g)].map((m) => m[1]))],
    ["/", "/attorney", "/sign-in"],
  );
  assert.doesNotMatch(code, /href=\{/);
});

test("24. the server action is POST-only, hands the form over unread, and never reports an unproven start as success", () => {
  const source = read("app/attorney/apply/actions.ts");
  const code = codeOf(source);
  assert.match(source, /^"use server";\n/);
  assert.deepEqual(importsOf(source), [
    "next/cache",
    "next/navigation",
    "../../../src/application/attorney-application.ts",
    "../../../src/infrastructure/identity/attorney-application-provisioning.ts",
    "../../../src/infrastructure/identity/server-session-source.ts",
  ]);
  assert.deepEqual(
    [...code.matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (match) => match[1],
    ),
    ["startApplication"],
  );
  assert.equal(code.match(/\bexport\b/g).length, 1);
  assert.match(
    code,
    /export async function startApplication\(formData: FormData\): Promise<void> \{/,
  );
  // The form goes to the application boundary as it is: nothing in it is
  // read here, and only the fixed entry page is a destination.
  assert.doesNotMatch(
    code,
    /formData\.|headers|cookies|searchParams|process\.env|\bconsole\b|ATTORNEY_APPLICATION_RECORDS|createAttorneyApplicantProvisioning|registration-provisioning/,
  );
  assert.equal(code.match(/\bredirect\(/g).length, 1);
  assert.match(code, /redirect\("\/attorney\/apply"\);/);
});

// ---------------------------------------------------------------------------
// The page and action, rendered and run from their own sources.
// ---------------------------------------------------------------------------

const WIRING_STUB = `export const wiring = {
  session: null,
  account: null,
  records: null,
  provisioning: null,
  log: [],
};
export const SUPABASE_SERVER_SESSION_SOURCE = Object.freeze({
  currentSubject: async () => {
    wiring.log.push("session");
    return wiring.session.currentSubject();
  },
});
export const ATTORNEY_APPLICATION_ACCOUNT = Object.freeze({
  currentAccount: async () => {
    wiring.log.push("account");
    return wiring.account.currentAccount();
  },
});
export const ATTORNEY_APPLICATION_RECORDS = async () => {
  wiring.log.push("records");
  return wiring.records();
};
export const ATTORNEY_APPLICANT_PROVISIONING = async () => {
  wiring.log.push("provisioning");
  return wiring.provisioning();
};
`;

const NEXT_SERVER_STUB = `import { wiring } from "./wiring.mjs";
export async function connection() {
  wiring.log.push("connection");
}
`;

const NEXT_CACHE_STUB = `import { wiring } from "./wiring.mjs";
export function revalidatePath(path) {
  wiring.log.push(["revalidatePath", path]);
}
`;

const NEXT_NAVIGATION_STUB = `import { wiring } from "./wiring.mjs";
export class SyntheticRedirect extends Error {}
export function redirect(path) {
  wiring.log.push(["redirect", path]);
  throw new SyntheticRedirect(path);
}
`;

// The page's own action, replaced by a recording stand-in that carries a
// server reference's form descriptor, so the rendered form names it.
const ACTIONS_STUB = `import { wiring } from "./wiring.mjs";
export async function startApplication(formData) {
  wiring.log.push(["action", formData]);
}
startApplication.$$FORM_ACTION = () => ({
  name: "$ACTION_ID_synthetic",
  action: "/synthetic-start-application",
  method: "POST",
  encType: "multipart/form-data",
  data: null,
});
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
// have one, and every target must be used, so the module's imports stay
// exact.
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

async function buildHarness() {
  const directory = mkdtempSync(join(tmpdir(), "rosuno-p3-002-"));
  const target = (name) => pathToFileURL(join(directory, name)).href;
  const write = (name, text) => writeFileSync(join(directory, name), text);
  const jsxRuntime = import.meta.resolve("react/jsx-runtime");
  const application = new URL(
    "src/application/attorney-application.ts",
    appRoot,
  ).href;
  write("wiring.mjs", WIRING_STUB);
  write("next-server.mjs", NEXT_SERVER_STUB);
  write("next-cache.mjs", NEXT_CACHE_STUB);
  write("next-navigation.mjs", NEXT_NAVIGATION_STUB);
  write("actions-stub.mjs", ACTIONS_STUB);
  write(
    "design-system.mjs",
    relink(
      transpile(read("src/presentation/design-system.tsx"), "design.tsx"),
      { "react/jsx-runtime": jsxRuntime },
    ),
  );
  write(
    "page.mjs",
    relink(transpile(read("app/attorney/apply/page.tsx"), "page.tsx"), {
      "react/jsx-runtime": jsxRuntime,
      "next/server": target("next-server.mjs"),
      "../../../src/application/attorney-application.ts": application,
      "../../../src/infrastructure/identity/attorney-application-provisioning.ts":
        target("wiring.mjs"),
      "../../../src/infrastructure/identity/server-session-source.ts":
        target("wiring.mjs"),
      "../../../src/presentation/design-system.tsx":
        target("design-system.mjs"),
      "./actions.ts": target("actions-stub.mjs"),
    }),
  );
  write(
    "actions.mjs",
    relink(transpile(read("app/attorney/apply/actions.ts"), "actions.ts"), {
      "next/cache": target("next-cache.mjs"),
      "next/navigation": target("next-navigation.mjs"),
      "../../../src/application/attorney-application.ts": application,
      "../../../src/infrastructure/identity/attorney-application-provisioning.ts":
        target("wiring.mjs"),
      "../../../src/infrastructure/identity/server-session-source.ts":
        target("wiring.mjs"),
    }),
  );
  const { wiring } = await import(target("wiring.mjs"));
  const page = await import(target("page.mjs"));
  const actions = await import(target("actions.mjs"));
  const { SyntheticRedirect } = await import(target("next-navigation.mjs"));
  return { directory, wiring, page, actions, SyntheticRedirect };
}

const harness = await buildHarness();
after(() => rmSync(harness.directory, { recursive: true, force: true }));

function wire({
  subject = SUBJECT,
  user,
  db = memoryDatabase(),
  overrides,
  records,
  provisioning,
} = {}) {
  const account = accountOf(user);
  const reads = memoryProvisioning(db, overrides);
  const writes = memoryProvisioning(db, overrides);
  harness.wiring.session = sessionOf(subject);
  harness.wiring.account = account.source;
  harness.wiring.records =
    records ??
    (async () => {
      const { usersOf, attorneyProfilesOf } = reads.port;
      return { usersOf, attorneyProfilesOf };
    });
  harness.wiring.provisioning = provisioning ?? (async () => writes.port);
  harness.wiring.log.length = 0;
  return { db, reads, writes };
}

async function renderPage(options, props) {
  const state = wire(options);
  const element = await harness.page.default(props);
  return {
    ...state,
    html: renderToStaticMarkup(element),
    log: [...harness.wiring.log],
  };
}

function textOf(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hrefsOf(html) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
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
    "synthetic.invalid",
    "Bearer",
    "auth_user_id",
    "account_state",
    "profile_state",
    "under_review",
    "sb-",
    "sb_",
  ]) {
    assert.equal(html.includes(value), false, `${name}: ${value}`);
  }
}

// The page advertises no marketplace, paid service, scheduling, or account
// creation, and claims no verification, approval, or eligibility.
function assertNoAdvertisedCapability(html, name) {
  const text = textOf(html);
  assert.doesNotMatch(
    text,
    /sign[ -]?up|create (?:an |your )?account|regist|onboard|complian|consultation|earning|payout|payment|\bfee|\bpaid\b|price|schedul|calendar|appointment|\bbook|licen[cs]e|insurance/i,
    name,
  );
  assert.doesNotMatch(
    text,
    /\byou are (?:now )?(?:verified|approved|eligible)|\bverified\b|\beligible\b|\bcertified\b|\bbookable\b/i,
    name,
  );
}

function assertFrame(html, title, name) {
  assert.match(
    html,
    /^<div class="rs-page" data-density="attorney"><section class="rs-surface" data-tone="light" data-emphasis="raised" aria-labelledby="attorney-application-title">/,
    name,
  );
  assert.equal(html.match(/<h1\b/g).length, 1, name);
  assert.ok(
    html.includes(
      `<h1 class="rs-heading" data-size="lg" id="attorney-application-title">${title}</h1>`,
    ),
    name,
  );
  assert.ok(textOf(html).startsWith(`Attorney application ${title}`), name);
  assertNoPrivateData(html, name);
  assertNoAdvertisedCapability(html, name);
}

const MEANING = "An application is not verification";

test("25. a signed-in account that can start sees one accessible form posting only the fixed intent to the server action", async () => {
  const { html, log, db } = await renderPage();
  assertFrame(html, "Start an attorney application", "can-start");
  assert.deepEqual(log, ["connection", "session", "account", "records"]);
  assert.equal(html.match(/<form\b/g).length, 1);
  // The form posts to the page's own server action, whose reference field
  // the framework adds, and carries exactly one field of the page's own: the
  // fixed intent. No identity, User, profile, role, or state field exists.
  assert.ok(
    html.includes(
      '<form action="/synthetic-start-application" encType="multipart/form-data" method="POST"><input type="hidden" name="$ACTION_ID_synthetic"/><input type="hidden" name="intent" value="start-attorney-application"/>',
    ),
  );
  assert.deepEqual(
    [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]),
    [
      '<input type="hidden" name="$ACTION_ID_synthetic"/>',
      '<input type="hidden" name="intent" value="start-attorney-application"/>',
    ],
  );
  assert.equal(html.match(/<button\b/g).length, 1);
  assert.ok(
    html.includes(
      '<button class="rs-button" data-variant="primary" type="submit">Start attorney application</button>',
    ),
  );
  assert.ok(textOf(html).includes(MEANING));
  assert.deepEqual(hrefsOf(html), ["/"]);
  // Rendering the entry creates nothing.
  assert.equal(db.attorney_profiles.length, 0);
});

test("26. on-record, anonymous, denied, and unavailable requests each render one fixed state, with no form, whatever the reason", async () => {
  for (const state of ON_RECORD_STATES) {
    const { html, log } = await renderPage({
      db: memoryDatabase({
        attorneys: [attorneyProfile({ profile_state: state })],
      }),
    });
    assertFrame(html, "Attorney application on record", state);
    assert.deepEqual(log, ["connection", "session", "account", "records"]);
    assert.deepEqual(hrefsOf(html), ["/attorney", "/"], state);
    assert.match(html, /role="status"/);
    // The stage itself is shown only by the workspace.
    assert.doesNotMatch(textOf(html), /Under review|Approved|Applicant\b/);
    assert.equal(html.includes("<form"), false);
  }
  const anonymous = await renderPage({ subject: null });
  assertFrame(anonymous.html, "Attorney application", "anonymous");
  assert.deepEqual(anonymous.log, ["connection", "session"]);
  assert.deepEqual(hrefsOf(anonymous.html), ["/sign-in", "/"]);
  assert.ok(textOf(anonymous.html).includes(MEANING));
  assert.equal(anonymous.html.includes("<form"), false);
  const denials = {
    "suspended profile": {
      db: memoryDatabase({
        attorneys: [attorneyProfile({ profile_state: "suspended" })],
      }),
    },
    "removed profile": {
      db: memoryDatabase({
        attorneys: [attorneyProfile({ profile_state: "removed" })],
      }),
    },
    "pending User": {
      db: memoryDatabase({
        users: [activeUser({ account_state: "pending_verification" })],
      }),
    },
    "closed User": {
      db: memoryDatabase({ users: [activeUser({ account_state: "closed" })] }),
    },
    "no Rosuno User": { db: memoryDatabase({ users: [] }) },
    "unconfirmed email": { user: { id: SUBJECT, emailConfirmedAt: null } },
    "another account": { user: { id: OTHER, emailConfirmedAt: CONFIRMED_AT } },
  };
  const deniedPages = new Set();
  for (const [name, options] of Object.entries(denials)) {
    const { html } = await renderPage(options);
    assertFrame(html, "Attorney application not available", name);
    assert.deepEqual(hrefsOf(html), ["/"], name);
    assert.match(html, /role="status"/);
    deniedPages.add(html);
  }
  assert.equal(deniedPages.size, 1);
  const failures = {
    "unreadable Auth read": { user: () => ({ kind: "unreadable" }) },
    "two Users": {
      db: memoryDatabase({
        users: [activeUser(), activeUser({ id: OTHER_USER_ID })],
      }),
    },
    "unknown profile state": {
      db: memoryDatabase({
        attorneys: [attorneyProfile({ profile_state: "verified" })],
      }),
    },
    "record port unbound": { records: async () => null },
    "record read fails": {
      overrides: { attorneyProfilesOf: async () => UNREADABLE },
    },
  };
  const unavailablePages = new Set();
  for (const [name, options] of Object.entries(failures)) {
    const { html } = await renderPage(options);
    assertFrame(html, "Attorney application unavailable", name);
    assert.match(html, /role="alert"/, name);
    assert.deepEqual(hrefsOf(html), ["/"], name);
    unavailablePages.add(html);
  }
  assert.equal(unavailablePages.size, 1);
  for (const html of [...deniedPages, ...unavailablePages]) {
    assert.equal(html.includes("<form"), false);
    assert.equal(html.includes('/attorney"'), false);
  }
  // The route's metadata keeps it out of search indexes.
  assert.deepEqual(harness.page.metadata, {
    title: "Attorney application",
    robots: { index: false, follow: false },
  });
  assert.deepEqual(Object.keys(harness.page).sort(), ["default", "metadata"]);
});

test("27. route parameters and a query naming an identity, role, stage, or destination never change the page, and it never builds the privileged port", async () => {
  const hostile = {
    params: Promise.resolve({ role: "attorney" }),
    searchParams: Promise.resolve({
      next: "https://elsewhere.invalid/",
      redirect: "//elsewhere.invalid",
      role: "attorney",
      stage: "approved",
      profile_state: "approved",
      subject: OTHER,
      user_id: OTHER_USER_ID,
      intent: ATTORNEY_APPLICATION_INTENT.value,
    }),
  };
  for (const options of [
    {},
    { db: memoryDatabase({ attorneys: [attorneyProfile()] }) },
    { subject: null },
  ]) {
    const plain = await renderPage(options);
    const entered = await renderPage(options, hostile);
    assert.equal(entered.html, plain.html);
    assert.equal(entered.html.includes("elsewhere"), false);
    assert.ok(entered.log.every((entry) => entry !== "provisioning"));
    assert.equal(entered.writes.calls.length, 0);
    assert.equal(
      entered.db.attorney_profiles.length,
      options.db?.attorney_profiles.length ?? 0,
    );
  }
});

async function runAction(formData, options) {
  const state = wire(options);
  let thrown;
  try {
    await harness.actions.startApplication(formData);
  } catch (error) {
    thrown = error;
  }
  return { ...state, thrown, log: [...harness.wiring.log] };
}

const RETURN_TO_ENTRY = [
  ["revalidatePath", "/attorney"],
  ["revalidatePath", "/attorney/apply"],
  ["redirect", "/attorney/apply"],
];

test("28. the action returns every definite outcome to the fixed entry page, and only the explicit start through the trusted wiring writes", async () => {
  // Created: the one insert, then back to the entry, which reads afresh.
  const created = await runAction(startForm());
  assert.ok(created.thrown instanceof harness.SyntheticRedirect);
  assert.deepEqual(created.log, [
    "session",
    "account",
    "provisioning",
    ...RETURN_TO_ENTRY,
  ]);
  assert.equal(created.db.attorney_profiles.length, 1);
  assert.deepEqual(
    created.writes.calls.map(([call]) => call),
    [
      "usersOf",
      "attorneyProfilesOf",
      "insertApplicantProfile",
      "attorneyProfilesOf",
    ],
  );
  // Already on record, refused, or anonymous: no write, same destination.
  const definite = {
    "on record": {
      db: memoryDatabase({ attorneys: [attorneyProfile()] }),
      log: ["session", "account", "provisioning"],
    },
    "suspended profile": {
      db: memoryDatabase({
        attorneys: [attorneyProfile({ profile_state: "suspended" })],
      }),
      log: ["session", "account", "provisioning"],
    },
    unconfirmed: {
      user: { id: SUBJECT, emailConfirmedAt: null },
      log: ["session", "account"],
    },
    anonymous: { subject: null, log: ["session"] },
  };
  for (const [name, { log, ...options }] of Object.entries(definite)) {
    const before = snapshot(options.db ?? memoryDatabase());
    const run = await runAction(startForm(), options);
    assert.ok(run.thrown instanceof harness.SyntheticRedirect, name);
    assert.deepEqual(run.log, [...log, ...RETURN_TO_ENTRY], name);
    assert.ok(
      run.writes.calls.every(([call]) => call !== "insertApplicantProfile"),
      name,
    );
    if (options.db !== undefined) {
      assert.equal(snapshot(run.db), before, name);
    }
  }
  // Spoofed fields alongside the intent change nothing.
  const spoofed = await runAction(
    startForm([
      ["user_id", OTHER_USER_ID],
      ["profile_state", "approved"],
      ["role", "attorney"],
    ]),
  );
  assert.ok(spoofed.thrown instanceof harness.SyntheticRedirect);
  assert.deepEqual(
    spoofed.db.attorney_profiles.map((row) => [row.user_id, row.profile_state]),
    [[USER_ID, "applicant"]],
  );
});

test("29. an unavailable or unconfirmed start is never reported as success: the action throws one fixed error, revalidates nothing, and redirects nowhere", async () => {
  const failing = {
    "no explicit intent": { form: new FormData() },
    "unbound privileged port": {
      form: startForm(),
      provisioning: async () => null,
    },
    "unreadable Auth read": {
      form: startForm(),
      user: () => ({ kind: "unreadable" }),
    },
    "insert refused": {
      form: startForm(),
      overrides: { insertApplicantProfile: async () => UNREADABLE },
    },
    "fresh read fails after the insert": {
      form: startForm(),
      overrides: {
        attorneyProfilesOf: async (_userId, real) => {
          const answer = await real();
          return answer.rows.length === 0 ? answer : UNREADABLE;
        },
      },
    },
  };
  for (const [name, { form, ...options }] of Object.entries(failing)) {
    const run = await runAction(form, options);
    assert.ok(run.thrown instanceof Error, name);
    assert.equal(run.thrown instanceof harness.SyntheticRedirect, false, name);
    assert.equal(
      run.thrown.message,
      "The attorney application could not be completed.",
      name,
    );
    assert.equal(String(run.thrown).includes("7f3a"), false, name);
    assert.ok(
      run.log.every(
        (entry) =>
          !Array.isArray(entry) ||
          !["redirect", "revalidatePath"].includes(entry[0]),
      ),
      name,
    );
  }
  assert.deepEqual(Object.keys(harness.actions), ["startApplication"]);
});
