// MVP-001 S11 PS-A6 application tests (L1 and L3, no database): break-glass
// access, data requests, the complaint statement and the configured
// complaint codes (PS-A6 sections 2 to 5).
//
// Every port is a synthetic in-memory double; every identifier, reason,
// description and statement is test data. The database decides every rule
// again (proved by apps/web/tests/mvp-001-s11-ps-a6-db-proof.mjs); these
// tests prove what the application adds: early refusals, the step-up gate
// and capability checks before anything is sent, strict reads, the fixed
// outcome tables, literal calls in one adapter, and neutral fixed wording.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  ACCESS_COLUMNS,
  approveBreakGlass,
  breakGlassPathFor,
  GRANT_ACTION_OUTCOMES,
  GRANT_STATES,
  MINE_COLUMNS,
  QUEUE_COLUMNS,
  requestBreakGlass,
  resolveBreakGlassAccess,
  resolveBreakGlassWorkspace,
  revokeBreakGlass,
} from "../src/application/break-glass.ts";
import {
  assignDataRequest,
  CLIENT_ACTION_OUTCOMES,
  decideDataRequest,
  OUTCOME_CODES,
  OWN_REQUEST_COLUMNS,
  QUEUE_COLUMNS as DR_QUEUE_COLUMNS,
  REQUEST_COLUMNS,
  REQUEST_STATES,
  REQUEST_TYPES,
  resolveClientDataRequests,
  resolveDataRequest,
  resolveDataRequestQueue,
  STAFF_ACTION_OUTCOMES,
  submitDataRequest,
  withdrawDataRequest,
} from "../src/application/data-requests.ts";
import {
  createBreakGlassReads,
  createBreakGlassWrites,
  createDataRequestReads,
  createDataRequestWrites,
  requestAnswerOf,
} from "../src/infrastructure/privacy/privacy-adapter.ts";
import * as labels from "../src/presentation/privacy-labels.ts";
import {
  addStaff,
  configurationSources,
  createWorld,
  grant,
} from "./configuration-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

// The result columns of one function, as its migration declares them.
const BREAK_GLASS_MIGRATION = "20261127190000_mvp_001_s11_break_glass.sql";
const DATA_REQUEST_MIGRATION = "20261127200000_mvp_001_s11_data_requests.sql";
function resultColumnsOf(migration, name) {
  const source = readFileSync(
    new URL(`../../../supabase/migrations/${migration}`, import.meta.url),
    "utf8",
  );
  const start = source.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0, name);
  const open = source.indexOf("returns table (\n", start);
  const close = source.indexOf("\n)\n", open);
  return source
    .slice(open + "returns table (\n".length, close)
    .split(",\n")
    .map((line) => line.trim().split(/\s+/)[0]);
}

const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const CONSULTATION = "99999999-9999-4999-8999-999999999999";
const GRANT = "88888888-8888-4888-8888-888888888888";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const JURISDICTION = "77777777-7777-4777-8777-777777777777";
const DOCUMENT = "44444444-4444-4444-8444-444444444444";
const RESOURCE = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "66666666-6666-4666-8666-666666666666";
const T = "2026-11-20T10:00:00+00:00";
const LATER = "2026-11-20T11:00:00+00:00";

const rows = (list) => ({ kind: "rows", rows: list });
// One astral character: one code point, two UTF-16 units.
const ASTRAL = "\u{1F600}";
const answer = (outcome) => ({ kind: "answer", outcome });
const DEV = rows([{ environment_class: "development", project_ref: null }]);

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.append(key, value);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Break-glass
// ---------------------------------------------------------------------------

const ownGrant = (overrides = {}) => ({
  break_glass_grant_id: GRANT,
  resource_type: "consultation",
  resource_id: CONSULTATION,
  reason: "Synthetic reason",
  state: "requested",
  requested_at: T,
  approved_at: null,
  expires_at: null,
  revoked_at: null,
  ...overrides,
});
const queuedGrant = (overrides = {}) => ({
  ...ownGrant(),
  jurisdiction_id: JURISDICTION,
  requested_by_me: false,
  ...overrides,
});
const accessRow = (overrides = {}) => ({
  break_glass_grant_id: GRANT,
  expires_at: LATER,
  consultation_id: CONSULTATION,
  consultation_state: "ready",
  request_path: "instant",
  modality: "synthetic_video",
  duration_minutes: 30,
  scheduled_start_at: null,
  scheduled_end_at: null,
  started_at: null,
  ended_at: null,
  outcome_code: null,
  messages: [
    {
      message_id: MESSAGE,
      sender_role: "client",
      body: "Synthetic message",
      sent_at: T,
    },
  ],
  older_messages_not_shown: false,
  documents: [
    {
      document_id: DOCUMENT,
      resource_id: RESOURCE,
      version_label: null,
      mime_type: "application/pdf",
      byte_size: 2048,
      created_at: T,
      uploaded_by: "attorney",
      sharing: "active",
    },
  ],
  older_documents_not_shown: false,
  ...overrides,
});

function breakGlassWorld(options = {}) {
  const calls = [];
  const state = {
    mine: rows([]),
    queue: rows([]),
    access: rows([]),
    request: answer("requested"),
    approve: answer("approved"),
    revoke: answer("ended"),
    environment: DEV,
    ...options,
  };
  const world = createWorld();
  const staff = addStaff(world, 7);
  const sources = {
    staff: configurationSources(world, staff.authId),
    reads: async () => ({
      mine: async () => {
        calls.push(["mine"]);
        return state.mine;
      },
      queue: async (s, offset) => {
        calls.push(["queue", s, offset]);
        return state.queue;
      },
      access: async (id) => {
        calls.push(["access", id]);
        return state.access;
      },
      environmentIdentity: async () => state.environment,
    }),
    writes: async () => ({
      request: async (c, reason) => {
        calls.push(["request", c, reason]);
        return state.request;
      },
      approve: async (g, seconds) => {
        calls.push(["approve", g, seconds]);
        return state.approve;
      },
      revoke: async (g) => {
        calls.push(["revoke", g]);
        return state.revoke;
      },
    }),
    environment: () => ({
      configuredClass: "development",
      expectedProjectRef: null,
    }),
  };
  return {
    sources,
    calls,
    world,
    staff,
    grantStaff: (capability, overrides) =>
      grant(world, staff.userId, capability, overrides),
  };
}

test("PSA6-1 (PS-A6 section 2) the break-glass page needs an active Staff Profile only: it reads the caller's own grants strictly and, for holders of approve_break_glass in any scope, one page of the grants in one derived state; a staff member without the grant sees no queue; a deactivated or unknown staff member is refused; one malformed or contradictory row makes the page unavailable", async () => {
  const w = breakGlassWorld({
    mine: rows([ownGrant(), ownGrant({ state: "active", approved_at: T, expires_at: LATER })]),
  });
  const view = await resolveBreakGlassWorkspace(w.sources, "active", "1");
  assert.equal(view.status, "ready");
  assert.equal(view.mine.length, 2);
  assert.equal(view.queue, null);
  assert.deepEqual(w.calls, [["mine"]]);
  w.grantStaff("approve_break_glass", { jurisdiction_id: JURISDICTION });
  w.calls.length = 0;
  const held = await resolveBreakGlassWorkspace(
    { ...w.sources, reads: async () => ({ ...(await w.sources.reads()), queue: async (s, o) => { w.calls.push(["queue", s, o]); return rows([queuedGrant({ state: "active", approved_at: T, expires_at: LATER })]); } }) },
    "active",
    "2",
  );
  assert.equal(held.status, "ready");
  assert.equal(held.queue.grantState, "active");
  assert.equal(held.queue.grants.length, 1);
  assert.deepEqual(w.calls, [["mine"], ["queue", "active", 25]]);
  // A state outside the vocabulary reads the requested list.
  assert.equal(
    (await resolveBreakGlassWorkspace(w.sources, "approved", undefined)).queue
      .grantState,
    "requested",
  );
  for (const bad of [
    ownGrant({ state: "active" }),
    ownGrant({ state: "revoked" }),
    ownGrant({ reason: "  " }),
    ownGrant({ resource_type: "intake" }),
    { ...ownGrant(), extra: true },
  ]) {
    const broken = breakGlassWorld({ mine: rows([bad]) });
    assert.equal(
      (await resolveBreakGlassWorkspace(broken.sources, "requested")).status,
      "unavailable",
    );
  }
  const deactivated = breakGlassWorld();
  deactivated.world.staff_profiles[0].staff_state = "deactivated";
  assert.equal(
    (await resolveBreakGlassWorkspace(deactivated.sources, "requested")).status,
    "denied",
  );
  assert.deepEqual(deactivated.calls, []);
  // The database bounds the reason in code points (char_length): 1,500
  // astral characters (3,000 UTF-16 units) are a reason; 2,001 are not.
  const astral = breakGlassWorld({ mine: rows([ownGrant({ reason: ASTRAL.repeat(1500) })]) });
  assert.equal((await resolveBreakGlassWorkspace(astral.sources, "requested")).status, "ready");
  const overlong = breakGlassWorld({ mine: rows([ownGrant({ reason: ASTRAL.repeat(2001) })]) });
  assert.equal((await resolveBreakGlassWorkspace(overlong.sources, "requested")).status, "unavailable");
});

test("PSA6-2 (PS-A6 section 2 rule 7) the read-only view reads one row strictly through the audited access path: the record, the Messages and the documents' metadata; no row is the fixed not-active answer; a malformed id reads nothing; a malformed or mismatched row is unavailable", async () => {
  const w = breakGlassWorld({ access: rows([accessRow()]) });
  const view = await resolveBreakGlassAccess(w.sources, GRANT);
  assert.equal(view.status, "ready");
  assert.equal(view.consultation.messages[0].body, "Synthetic message");
  assert.equal(view.consultation.documents[0].uploadedBy, "attorney");
  assert.deepEqual(w.calls, [["access", GRANT]]);
  const none = breakGlassWorld();
  assert.deepEqual(await resolveBreakGlassAccess(none.sources, GRANT), {
    status: "not-active",
  });
  const malformed = breakGlassWorld({ access: rows([accessRow()]) });
  assert.deepEqual(await resolveBreakGlassAccess(malformed.sources, "x"), {
    status: "not-active",
  });
  assert.deepEqual(malformed.calls, []);
  for (const bad of [
    accessRow({ break_glass_grant_id: CONSULTATION }),
    accessRow({ messages: [{ message_id: MESSAGE, sender_role: "staff", body: "x", sent_at: T }] }),
    accessRow({ documents: [{ ...accessRow().documents[0], sharing: "public" }] }),
    accessRow({ messages: "[]" }),
    { ...accessRow(), extra: 1 },
  ]) {
    const broken = breakGlassWorld({ access: rows([bad]) });
    assert.equal(
      (await resolveBreakGlassAccess(broken.sources, GRANT)).status,
      "unavailable",
    );
  }
  // A Message body is bounded in code points: 10,001 astral characters
  // (20,002 UTF-16 units) render; 20,001 do not.
  const message = (body) => accessRow({ messages: [{ message_id: MESSAGE, sender_role: "client", body, sent_at: T }] });
  const astral = breakGlassWorld({ access: rows([message(ASTRAL.repeat(10001))]) });
  const astralView = await resolveBreakGlassAccess(astral.sources, GRANT);
  assert.equal(astralView.status, "ready");
  assert.equal([...astralView.consultation.messages[0].body].length, 10001);
  const overlong = breakGlassWorld({ access: rows([message(ASTRAL.repeat(20001))]) });
  assert.equal((await resolveBreakGlassAccess(overlong.sources, GRANT)).status, "unavailable");
  assert.equal(breakGlassPathFor(GRANT), `/staff/break-glass/${GRANT}`);
  assert.throws(() => breakGlassPathFor("x"));
});

test("PSA6-3 (PS-A6 section 2 rules 3, 5 and 8) requesting needs an active Staff Profile and sends the Consultation and the trimmed reason (1 to 2,000 characters, no control characters); approving and revoking need approve_break_glass in some scope; the duration is whole minutes from 1 to 1,440 sent as seconds, with no default; the environment is bound first; each database outcome maps to one fixed state", async () => {
  const w = breakGlassWorld();
  assert.deepEqual(
    await requestBreakGlass(w.sources, form({ consultation: CONSULTATION.toUpperCase(), reason: "  Synthetic reason  " })),
    { status: "outcome", outcome: "access_requested" },
  );
  assert.deepEqual(w.calls, [["request", CONSULTATION, "Synthetic reason"]]);
  for (const fields of [
    { consultation: "x", reason: "Synthetic" },
    { consultation: CONSULTATION, reason: "   " },
    { consultation: CONSULTATION, reason: "x".repeat(2001) },
    { consultation: CONSULTATION, reason: "a\u0001b" },
    { consultation: CONSULTATION },
  ]) {
    const refused = breakGlassWorld();
    assert.equal((await requestBreakGlass(refused.sources, form(fields))).status, "invalid");
    assert.deepEqual(refused.calls, []);
  }
  assert.deepEqual(
    await requestBreakGlass(breakGlassWorld({ request: answer("existing") }).sources, form({ consultation: CONSULTATION, reason: "R" })),
    { status: "outcome", outcome: "already_requested" },
  );
  // Approval and revocation need the capability.
  const approver = breakGlassWorld();
  assert.equal((await approveBreakGlass(approver.sources, form({ grant: GRANT, minutes: "5" }))).status, "denied");
  assert.deepEqual(approver.calls, []);
  approver.grantStaff("approve_break_glass", { jurisdiction_id: JURISDICTION });
  assert.deepEqual(await approveBreakGlass(approver.sources, form({ grant: GRANT, minutes: "1440" })), {
    status: "outcome",
    outcome: "access_approved",
  });
  assert.deepEqual(approver.calls, [["approve", GRANT, 86400]]);
  for (const minutes of ["0", "1441", "1.5", "", "-1", "60s"]) {
    const refused = breakGlassWorld();
    refused.grantStaff("approve_break_glass");
    assert.equal((await approveBreakGlass(refused.sources, form({ grant: GRANT, minutes }))).status, "invalid", minutes);
    assert.deepEqual(refused.calls, []);
  }
  const table = {
    own_request: "own_request",
    already_active: "already_active",
    already_expired: "already_expired",
    already_revoked: "already_revoked",
    not_found: "not_found",
  };
  for (const [db, outcome] of Object.entries(table)) {
    const x = breakGlassWorld({ approve: answer(db) });
    x.grantStaff("approve_break_glass");
    assert.deepEqual(await approveBreakGlass(x.sources, form({ grant: GRANT, minutes: "1" })), { status: "outcome", outcome });
  }
  for (const [db, outcome] of Object.entries({ refused: "request_refused", ended: "access_ended", already_expired: "already_expired", already_revoked: "already_revoked", not_found: "not_found" })) {
    const x = breakGlassWorld({ revoke: answer(db) });
    x.grantStaff("approve_break_glass");
    assert.deepEqual(await revokeBreakGlass(x.sources, form({ grant: GRANT })), { status: "outcome", outcome });
  }
  // A mismatched environment sends nothing.
  const mismatch = breakGlassWorld({ environment: rows([{ environment_class: "production", project_ref: "syntheticprojectrefaa" }]) });
  assert.equal((await requestBreakGlass(mismatch.sources, form({ consultation: CONSULTATION, reason: "R" }))).status, "unavailable");
  assert.deepEqual(mismatch.calls, []);
  // An outcome outside the table is never guessed.
  assert.equal((await requestBreakGlass(breakGlassWorld({ request: answer("granted") }).sources, form({ consultation: CONSULTATION, reason: "R" }))).status, "unconfirmed");
});

// ---------------------------------------------------------------------------
// Data requests
// ---------------------------------------------------------------------------

const ownRequest = (overrides = {}) => ({
  data_request_id: REQUEST,
  request_type: "access",
  state: "submitted",
  details: null,
  outcome_code: null,
  submitted_at: T,
  decided_at: null,
  updated_at: T,
  ...overrides,
});
const staffRequest = (overrides = {}) => ({
  ...ownRequest(),
  assigned: false,
  assigned_to_me: false,
  requester_user_id: USER,
  requester_account_state: "active",
  legal_hold_applies: false,
  ...overrides,
});

function dataWorld(options = {}) {
  const calls = [];
  const state = {
    mine: rows([]),
    queue: rows([]),
    request: rows([]),
    submit: answer("submitted"),
    withdraw: answer("withdrawn"),
    assign: answer("applied"),
    decide: answer("applied"),
    subject: SUBJECT,
    ...options,
  };
  const clientIntake = {
    session: { currentSubject: async () => state.subject },
    contexts: { contextsOf: async () => ["client"] },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: state.subject,
        emailConfirmedAt: "2026-11-01T00:00:00Z",
      }),
    },
    reads: async () => ({
      usersOf: async (a) =>
        rows(a === SUBJECT ? [{ id: USER, auth_user_id: SUBJECT, account_state: "active" }] : []),
      clientProfilesOf: async (u) =>
        rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
    }),
    writes: async () => ({}),
  };
  const world = createWorld();
  const staff = addStaff(world, 8);
  const shared = {
    reads: async () => ({
      mine: async () => {
        calls.push(["mine"]);
        return state.mine;
      },
      queue: async (s, offset) => {
        calls.push(["queue", s, offset]);
        return state.queue;
      },
      request: async (id) => {
        calls.push(["request", id]);
        return state.request;
      },
      environmentIdentity: async () => DEV,
    }),
    writes: async () => ({
      submit: async (type, details) => {
        calls.push(["submit", type, details]);
        return state.submit;
      },
      withdraw: async (id) => {
        calls.push(["withdraw", id]);
        return state.withdraw;
      },
      assign: async (id) => {
        calls.push(["assign", id]);
        return state.assign;
      },
      decide: async (id, outcome) => {
        calls.push(["decide", id, outcome]);
        return state.decide;
      },
    }),
    environment: () => ({ configuredClass: "development", expectedProjectRef: null }),
  };
  return {
    client: { ...shared, clientIntake },
    staff: { ...shared, staff: configurationSources(world, staff.authId) },
    grantStaff: (capability, overrides) => grant(world, staff.userId, capability, overrides),
    calls,
  };
}

test("PSA6-4 (PS-A6 section 3 rules 1, 2, 6 and 8) the verified client submits one of the five types with optional details (trimmed; empty is none; at most 20,000 characters, no control characters), withdraws one of their own requests and reads their own list strictly; outcomes are fixed; a signed-out caller sends nothing", async () => {
  const w = dataWorld();
  assert.deepEqual(await submitDataRequest(w.client, form({ type: "correction", details: "  Synthetic details  " })), {
    status: "outcome",
    outcome: "request_submitted",
  });
  await submitDataRequest(w.client, form({ type: "access", details: "   " }));
  await submitDataRequest(w.client, form({ type: "export" }));
  assert.deepEqual(w.calls, [
    ["submit", "correction", "Synthetic details"],
    ["submit", "access", null],
    ["submit", "export", null],
  ]);
  for (const fields of [{ type: "erasure" }, {}, { type: "access", details: "x".repeat(20001) }, { type: "access", details: "a\u0001b" }]) {
    const refused = dataWorld();
    assert.equal((await submitDataRequest(refused.client, form(fields))).status, "invalid");
    assert.deepEqual(refused.calls, []);
  }
  assert.deepEqual(await submitDataRequest(dataWorld({ submit: answer("already_open") }).client, form({ type: "access" })), {
    status: "outcome",
    outcome: "already_open",
  });
  for (const [db, outcome] of Object.entries({ withdrawn: "request_withdrawn", already_decided: "already_decided", already_withdrawn: "already_withdrawn", not_found: "not_found" })) {
    assert.deepEqual(await withdrawDataRequest(dataWorld({ withdraw: answer(db) }).client, form({ request: REQUEST })), { status: "outcome", outcome });
  }
  const signedOut = dataWorld({ subject: null });
  assert.equal((await submitDataRequest(signedOut.client, form({ type: "access" }))).status, "sign-in-required");
  assert.deepEqual(signedOut.calls, []);
  const list = dataWorld({ mine: rows([ownRequest(), ownRequest({ data_request_id: GRANT, state: "decided", outcome_code: "denied", decided_at: LATER, details: "Synthetic" })]) });
  const view = await resolveClientDataRequests(list.client);
  assert.equal(view.status, "ready");
  assert.equal(view.requests[1].outcome, "denied");
  for (const bad of [ownRequest({ state: "decided" }), ownRequest({ outcome_code: "allowed" }), ownRequest({ details: " " }), ownRequest({ request_type: "erasure" }), { ...ownRequest(), requester_user_id: USER }]) {
    assert.equal((await resolveClientDataRequests(dataWorld({ mine: rows([bad]) }).client)).status, "unavailable");
  }
  // Details are bounded in code points: 15,000 astral characters (30,000
  // UTF-16 units) render; 20,001 do not.
  assert.equal((await resolveClientDataRequests(dataWorld({ mine: rows([ownRequest({ details: ASTRAL.repeat(15000) })]) }).client)).status, "ready");
  assert.equal((await resolveClientDataRequests(dataWorld({ mine: rows([ownRequest({ details: ASTRAL.repeat(20001) })]) }).client)).status, "unavailable");
});

test("PSA6-5 (PS-A6 section 3 rules 3 to 5 and 8; global grant) the staff queue and one request need the global manage_data_requests grant (a scoped one is denied and reads nothing); the queue never carries the details; assignment and decision send exactly the request and one of the four outcome codes; legal_hold and the other database outcomes map to fixed states", async () => {
  const w = dataWorld({ queue: rows([{ data_request_id: REQUEST, request_type: "deletion", state: "submitted", outcome_code: null, submitted_at: T, decided_at: null, assigned_to_me: false }]), request: rows([staffRequest({ request_type: "deletion", details: "Synthetic" })]) });
  w.grantStaff("manage_data_requests", { jurisdiction_id: JURISDICTION });
  assert.equal((await resolveDataRequestQueue(w.staff, "submitted", "1")).status, "denied");
  assert.equal((await decideDataRequest(w.staff, form({ request: REQUEST, outcome: "denied" }))).status, "denied");
  assert.deepEqual(w.calls, []);
  w.grantStaff("manage_data_requests");
  const queue = await resolveDataRequestQueue(w.staff, "submitted", "1");
  assert.equal(queue.status, "ready");
  assert.equal(queue.requests.length, 1);
  assert.equal((await resolveDataRequestQueue(w.staff, "pending", "1")).requestState, "submitted");
  const one = await resolveDataRequest(w.staff, REQUEST);
  assert.equal(one.status, "ready");
  assert.equal(one.request.details, "Synthetic");
  assert.deepEqual(await resolveDataRequest(w.staff, "x"), { status: "not-found" });
  w.calls.length = 0;
  assert.deepEqual(await assignDataRequest(w.staff, form({ request: REQUEST })), { status: "outcome", outcome: "applied" });
  assert.deepEqual(await decideDataRequest(w.staff, form({ request: REQUEST, outcome: "restricted" })), { status: "outcome", outcome: "applied" });
  assert.deepEqual(w.calls, [["assign", REQUEST], ["decide", REQUEST, "restricted"]]);
  assert.equal((await decideDataRequest(w.staff, form({ request: REQUEST, outcome: "approved" }))).status, "invalid");
  for (const [db, outcome] of Object.entries({ legal_hold: "legal_hold", invalid_transition: "invalid_transition", not_found: "not_found" })) {
    const x = dataWorld({ decide: answer(db) });
    x.grantStaff("manage_data_requests");
    assert.deepEqual(await decideDataRequest(x.staff, form({ request: REQUEST, outcome: "allowed" })), { status: "outcome", outcome });
  }
  for (const bad of [staffRequest({ requester_account_state: "frozen" }), staffRequest({ assigned_to_me: true, assigned: false }), staffRequest({ legal_hold_applies: "no" })]) {
    const x = dataWorld({ request: rows([bad]) });
    x.grantStaff("manage_data_requests");
    assert.equal((await resolveDataRequest(x.staff, REQUEST)).status, "unavailable");
  }
  // Details are bounded in code points: 15,000 astral characters render.
  const astral = dataWorld({ request: rows([staffRequest({ details: ASTRAL.repeat(15000) })]) });
  astral.grantStaff("manage_data_requests");
  assert.equal((await resolveDataRequest(astral.staff, REQUEST)).status, "ready");
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

test("PSA6-6 the privacy adapter calls each of its thirteen functions by its literal name with exactly its named arguments through the request's own client; a malformed argument is refused before anything is sent; each command answer is read strictly (the request's identifier exactly with requested or existing)", async () => {
  const sent = [];
  const client = {
    rpc: async (name, args) => {
      sent.push([name, args ?? null]);
      if (name === "staff_request_break_glass") {
        return { data: [{ outcome: "existing", break_glass_grant_id: GRANT }], error: null, status: 200 };
      }
      if (name === "client_submit_data_request") {
        return { data: [{ outcome: "submitted", data_request_id: REQUEST }], error: null, status: 200 };
      }
      if (["staff_approve_break_glass", "staff_revoke_break_glass", "client_withdraw_data_request", "staff_assign_data_request", "staff_decide_data_request"].includes(name)) {
        return { data: name === "staff_approve_break_glass" ? "approved" : name === "staff_revoke_break_glass" ? "ended" : name === "client_withdraw_data_request" ? "withdrawn" : "applied", error: null, status: 200 };
      }
      return { data: [], error: null, status: 200 };
    },
  };
  const bgReads = await createBreakGlassReads(async () => client, 1000)();
  const bgWrites = await createBreakGlassWrites(async () => client, 1000)();
  const drReads = await createDataRequestReads(async () => client, 1000)();
  const drWrites = await createDataRequestWrites(async () => client, 1000)();
  await bgReads.mine();
  await bgReads.queue("active", 25);
  await bgReads.access(GRANT);
  assert.deepEqual(await bgWrites.request(CONSULTATION, "Synthetic"), answer("existing"));
  assert.deepEqual(await bgWrites.approve(GRANT, 60), answer("approved"));
  assert.deepEqual(await bgWrites.revoke(GRANT), answer("ended"));
  await drReads.mine();
  await drReads.queue("in_review", 0);
  await drReads.request(REQUEST);
  assert.deepEqual(await drWrites.submit("deletion", null), answer("submitted"));
  assert.deepEqual(await drWrites.withdraw(REQUEST), answer("withdrawn"));
  assert.deepEqual(await drWrites.assign(REQUEST), answer("applied"));
  assert.deepEqual(await drWrites.decide(REQUEST, "deferred"), answer("applied"));
  assert.deepEqual(sent, [
    ["staff_break_glass_grants_mine", null],
    ["staff_break_glass_queue", { p_state: "active", p_offset: 25 }],
    ["staff_break_glass_consultation", { p_break_glass_id: GRANT }],
    ["staff_request_break_glass", { p_consultation_id: CONSULTATION, p_reason: "Synthetic" }],
    ["staff_approve_break_glass", { p_break_glass_id: GRANT, p_duration_seconds: 60 }],
    ["staff_revoke_break_glass", { p_break_glass_id: GRANT }],
    ["client_data_requests", null],
    ["staff_data_request_queue", { p_state: "in_review", p_offset: 0 }],
    ["staff_data_request", { p_data_request_id: REQUEST }],
    ["client_submit_data_request", { p_request_type: "deletion", p_details: null }],
    ["client_withdraw_data_request", { p_data_request_id: REQUEST }],
    ["staff_assign_data_request", { p_data_request_id: REQUEST }],
    ["staff_decide_data_request", { p_data_request_id: REQUEST, p_outcome_code: "deferred" }],
  ]);
  sent.length = 0;
  for (const call of [
    () => bgReads.queue("approved", 0),
    () => bgReads.queue("active", 7),
    () => bgReads.access("x"),
    () => bgWrites.request("x", "Synthetic"),
    () => bgWrites.request(CONSULTATION, " "),
    () => bgWrites.approve(GRANT, 0),
    () => bgWrites.approve(GRANT, 86401),
    () => drWrites.submit("erasure", null),
    () => drWrites.submit("access", "x".repeat(20001)),
    () => drWrites.decide(REQUEST, "approved"),
  ]) {
    const result = await call();
    assert.ok(
      ["rejected", "unreadable"].includes(result.kind),
      JSON.stringify(result),
    );
  }
  assert.deepEqual(sent, []);
  const readAnswer = (data) =>
    requestAnswerOf({ data, error: null, status: 200 });
  assert.deepEqual(readAnswer([{ outcome: "requested", break_glass_grant_id: GRANT }]), answer("requested"));
  assert.deepEqual(readAnswer([{ outcome: "existing", break_glass_grant_id: GRANT }]), answer("existing"));
  assert.deepEqual(readAnswer([{ outcome: "denied", break_glass_grant_id: null }]), answer("denied"));
  for (const data of [
    [{ outcome: "requested", break_glass_grant_id: null }],
    [{ outcome: "existing", break_glass_grant_id: null }],
    [{ outcome: "denied", break_glass_grant_id: GRANT }],
    [{ outcome: "granted", break_glass_grant_id: GRANT }],
    [{ outcome: "requested", break_glass_grant_id: GRANT, extra: 1 }],
  ]) {
    assert.equal(readAnswer(data).kind, "unreadable", JSON.stringify(data));
  }
  // The thirteen calls are this module's only ones, each named once.
  const code = codeOf(read("src/infrastructure/privacy/privacy-adapter.ts"));
  assert.equal(code.match(/client\.rpc\(/g).length, 14);
  assert.doesNotMatch(code, /\.from\(|service_role|createClient|adminKey/);
});

// ---------------------------------------------------------------------------
// Labels, pages and actions
// ---------------------------------------------------------------------------

test("PSA6-7 (Packet rule 11) every state, type, outcome and action outcome has a fixed label or message; the wording states no legal right, entitlement, timeline or retention period and names no provider", () => {
  for (const s of GRANT_STATES) assert.ok(labels.GRANT_STATE_LABELS[s].label.length > 0, s);
  for (const o of GRANT_ACTION_OUTCOMES) assert.ok(labels.GRANT_MESSAGES[o].title.length > 0, o);
  for (const t of REQUEST_TYPES) {
    assert.ok(labels.REQUEST_TYPE_LABELS[t].length > 0, t);
    assert.ok(labels.STAFF_REQUEST_TYPE_LABELS[t].length > 0, t);
  }
  for (const s of REQUEST_STATES) assert.ok(labels.REQUEST_STATE_LABELS[s].label.length > 0, s);
  for (const o of OUTCOME_CODES) assert.ok(labels.OUTCOME_LABELS[o].length > 0, o);
  for (const o of CLIENT_ACTION_OUTCOMES) assert.ok(labels.CLIENT_REQUEST_MESSAGES[o].title.length > 0, o);
  for (const o of STAFF_ACTION_OUTCOMES) assert.ok(labels.STAFF_REQUEST_MESSAGES[o].title.length > 0, o);
  const text = JSON.stringify(Object.values(labels));
  assert.doesNotMatch(
    text,
    /entitle|right to|rights|GDPR|CCPA|law requires|legally|within \d+|days|retain|retention|guarantee|stripe|daily\.co|resend|supabase/i,
  );
  // The columns the reads expect are the database's: the same names, in the
  // order each function's migration declares them.
  const columns = {
    [BREAK_GLASS_MIGRATION]: {
      staff_break_glass_grants_mine: MINE_COLUMNS,
      staff_break_glass_queue: QUEUE_COLUMNS,
      staff_break_glass_consultation: ACCESS_COLUMNS,
    },
    [DATA_REQUEST_MIGRATION]: {
      client_data_requests: OWN_REQUEST_COLUMNS,
      staff_data_request_queue: DR_QUEUE_COLUMNS,
      staff_data_request: REQUEST_COLUMNS,
    },
  };
  for (const [migration, functions] of Object.entries(columns)) {
    for (const [name, expected] of Object.entries(functions)) {
      assert.deepEqual([...expected], resultColumnsOf(migration, name), name);
    }
  }
  assert.equal(MINE_COLUMNS.length, 9);
  assert.equal(QUEUE_COLUMNS.length, 11);
  assert.equal(ACCESS_COLUMNS.length, 16);
  assert.equal(OWN_REQUEST_COLUMNS.length, 8);
  assert.equal(DR_QUEUE_COLUMNS.length, 7);
  assert.equal(REQUEST_COLUMNS.length, 13);
});

test("PSA6-8 the new pages ask the step-up gate first (staff) or re-verify the client, read only through their own use case and the privacy adapter's production sources, read no header, cookie, setting or table, and read only their own query values; the break-glass view renders no form; each action module asks the gate first (staff) and hands the form to its use case", () => {
  const staffPages = {
    "app/staff/break-glass/page.tsx": "resolveBreakGlassWorkspace( BREAK_GLASS_SOURCES, state, page, )",
    "app/staff/break-glass/[grant]/page.tsx": "resolveBreakGlassAccess(BREAK_GLASS_SOURCES, grant)",
    "app/staff/data-requests/page.tsx": "resolveDataRequestQueue( STAFF_DATA_REQUEST_SOURCES, state, page, )",
    "app/staff/data-requests/[request]/page.tsx": "resolveDataRequest(STAFF_DATA_REQUEST_SOURCES, requestId)",
  };
  for (const [file, call] of Object.entries(staffPages)) {
    const code = codeOf(read(file));
    assert.ok(code.includes('  await connection();\n  await requireSteppedUp("staff");\n'), file);
    assert.ok(code.replace(/\s+/g, " ").includes(call), `${file}: ${call}`);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.doesNotMatch(code, /headers\(|cookies\(|process\.env|\.rpc\(|\.from\(|dangerouslySetInnerHTML/, file);
  }
  const view = codeOf(read("app/staff/break-glass/[grant]/page.tsx"));
  assert.doesNotMatch(view, /<form|Form\b|action=|useActionState|download|href=\{`\/staff\/consultations/);
  const privacy = codeOf(read("app/client/privacy/page.tsx"));
  assert.ok(privacy.includes("resolveClientDataRequests(CLIENT_DATA_REQUEST_SOURCES)"));
  assert.doesNotMatch(privacy, /requireSteppedUp|headers\(|cookies\(|searchParams/);
  for (const [file, calls] of Object.entries({
    "app/staff/break-glass/actions.ts": ["requestBreakGlass(BREAK_GLASS_SOURCES, formData)", "approveBreakGlass(BREAK_GLASS_SOURCES, formData)", "revokeBreakGlass(BREAK_GLASS_SOURCES, formData)"],
    "app/staff/data-requests/actions.ts": ["assignDataRequest(STAFF_DATA_REQUEST_SOURCES, formData)", "decideDataRequest(STAFF_DATA_REQUEST_SOURCES, formData)"],
    "app/client/privacy/actions.ts": ["submitDataRequest(CLIENT_DATA_REQUEST_SOURCES, formData)", "withdrawDataRequest(CLIENT_DATA_REQUEST_SOURCES, formData)"],
  })) {
    const source = read(file);
    const code = codeOf(source).replace(/\s+/g, " ");
    assert.match(source, /^"use server";\n/, file);
    for (const call of calls) assert.ok(code.includes(call), `${file}: ${call}`);
    assert.equal(file.startsWith("app/staff/"), code.includes('await stepUpRefusal("staff")'), file);
    assert.doesNotMatch(code, /_previous\.|process\.env|console|redirect\(/, file);
  }
  for (const file of ["app/staff/break-glass/forms.tsx", "app/staff/data-requests/forms.tsx", "app/client/privacy/forms.tsx"]) {
    const source = read(file);
    assert.match(source, /^"use client";\n/, file);
    assert.doesNotMatch(source, /infrastructure/, file);
  }
  assert.deepEqual(filesIn("app/staff/break-glass/"), [
    "app/staff/break-glass/[grant]/page.tsx",
    "app/staff/break-glass/actions.ts",
    "app/staff/break-glass/forms.tsx",
    "app/staff/break-glass/page.tsx",
  ]);
});

test("PSA6-9 (review corrections) the approval and revocation forms of the break-glass list keep their fixed message in one slot outside the list, and the page is refreshed after every outcome; the approval message names no time that is not on screen; a caller without an active Staff Profile gets the break-glass surface's own refusal; the client's list names the decision field as the recorded decision", () => {
  const actions = codeOf(read("app/staff/break-glass/actions.ts")).replace(/\s+/g, " ");
  assert.doesNotMatch(actions, /refresh/);
  assert.ok(actions.includes('if (state.status === "outcome") { revalidatePath("/staff/break-glass"); }'));
  for (const call of ["requestBreakGlass", "approveBreakGlass", "revokeBreakGlass"]) {
    assert.ok(actions.includes(`return gated(() => ${call}(BREAK_GLASS_SOURCES, formData)); }`), call);
  }
  const forms = codeOf(read("app/staff/break-glass/forms.tsx"));
  const bodyOf = (name) => {
    const start = forms.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, name);
    const next = forms.indexOf("\nexport function ", start + 1);
    return forms.slice(start, next < 0 ? undefined : next);
  };
  const decisions = bodyOf("GrantDecisions");
  assert.ok(decisions.includes("approveBreakGlassAction"));
  assert.ok(decisions.includes("revokeBreakGlassAction"));
  assert.ok(decisions.indexOf("<Outcome") < decisions.indexOf("{children}"));
  // Before hydration (or without scripts) no submission is noted, so the
  // slot shows whichever action has an outcome (an idle state shows nothing).
  const fallback = decisions.indexOf("last === null ? (");
  assert.ok(fallback > 0);
  assert.ok(decisions.indexOf("<Outcome state={approved} />", fallback) > fallback);
  assert.ok(decisions.indexOf("<Outcome state={revoked} />", fallback) > fallback);
  assert.ok(decisions.indexOf("<Outcome state={revoked} />") < decisions.indexOf("{children}"));
  for (const name of ["ApproveAccessForm", "RevokeAccessForm"]) {
    assert.doesNotMatch(bodyOf(name), /useActionState|<Outcome|Action\b/, name);
  }
  const page = codeOf(read("app/staff/break-glass/page.tsx"));
  const open = page.indexOf("<GrantDecisions>");
  const close = page.indexOf("</GrantDecisions>");
  assert.ok(open > 0 && close > open);
  assert.ok(page.indexOf("queue.grants.map(") > open && page.indexOf("queue.grants.map(") < close);
  for (const form of ["<ApproveAccessForm", "<RevokeAccessForm"]) {
    const at = [...page.matchAll(new RegExp(form, "g"))].map((m) => m.index);
    assert.ok(at.length > 0 && at.every((index) => index > open && index < close), form);
  }
  assert.doesNotMatch(labels.GRANT_MESSAGES.access_approved.body, /time shown|until/i);
  // A caller without an active Staff Profile: the surface's own refusal
  // (never the configuration pages' "a staff profile alone grants none").
  assert.match(labels.BREAK_GLASS_STAFF_REQUIRED, /active staff profile/);
  assert.doesNotMatch(labels.BREAK_GLASS_STAFF_REQUIRED, /alone|capabilit/i);
  for (const file of ["app/staff/break-glass/page.tsx", "app/staff/break-glass/[grant]/page.tsx"]) {
    const code = codeOf(read(file));
    const denied = code.indexOf('if (view.status === "denied") {');
    assert.ok(denied > 0, file);
    assert.ok(denied < code.indexOf("return refusalPage("), file);
    assert.ok(code.slice(denied, code.indexOf("return refusalPage(")).includes("{BREAK_GLASS_STAFF_REQUIRED}"), file);
  }
  // The client's list: the recorded decision, never a bare "Decision".
  assert.equal(labels.RECORDED_DECISION_LABEL, "Recorded decision");
  const privacy = codeOf(read("app/client/privacy/page.tsx"));
  assert.ok(privacy.includes("`${RECORDED_DECISION_LABEL}: ${OUTCOME_LABELS[request.outcome]}`"));
  assert.doesNotMatch(privacy, /Decision: /);
});
