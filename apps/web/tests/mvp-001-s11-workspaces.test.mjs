// MVP-001 S11 pass 2B L1/L3 tests: the remaining client and attorney
// workspace surfaces (MBS sections 18.2, 18.3 and 18.6): the client's home,
// payment history, message inbox, profile and settings and privacy and data
// pages; the attorney's dashboard, past consultations, week view, message
// inbox, documents and compliance pages; the participant workspace adapter's
// literal calls; the strict readers and summaries of the new application
// module; the workspace navigation; and the labels.
//
// Every source is a synthetic fake; nothing here reaches a network or a
// database. The database decides everything again (proven by the SURF checks
// of the S11 operations DB proof); these tests prove that the application
// only refuses early, reads strictly, summarizes what it read and links only
// fixed first-party pages.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  ACCOUNT_OVERVIEW_COLUMNS,
  alertSummaryOf,
  ATTORNEY_DOCUMENT_COLUMNS,
  availabilitySummaryOf,
  CLIENT_PAYMENT_COLUMNS,
  clientHomeOf,
  COMPLIANCE_RECORD_COLUMNS,
  complianceAlertsOf,
  consultationSummaryOf,
  DATA_CATEGORIES,
  requestSummaryOf,
  resolveAttorneyCompliance,
  resolveAttorneyComplianceRecords,
  resolveAttorneyDashboard,
  resolveAttorneyDocuments,
  resolveAttorneyHistory,
  resolveAttorneyThreads,
  resolveClientAccount,
  resolveClientPayments,
  resolveClientThreads,
  resolveScheduleWeek,
  THREAD_COLUMNS,
  weekStartOf,
} from "../src/application/participant-workspaces.ts";
import { JOB_DONE } from "../src/application/job-worker.ts";
import {
  resolveAttorneyNotifications,
  resolveClientNotifications,
} from "../src/application/notification-center.ts";
import {
  createNotificationJobHandlers,
  EMAIL_TEMPLATES,
  emailMessageOf,
  NOTIFICATION_TYPES,
} from "../src/application/notifications.ts";
import {
  createAttorneyWorkspaceReads,
  createClientWorkspaceReads,
} from "../src/infrastructure/workspaces/workspace-adapter.ts";
import { NOTIFICATION_LABELS } from "../src/presentation/communication-labels.ts";
import * as labels from "../src/presentation/workspace-labels.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const T = "2026-11-20T10:00:00+00:00";
const LATER = "2026-11-20T10:30:00+00:00";
const NOW = Date.parse("2026-11-20T12:00:00Z");
const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = { kind: "unreadable" };

// The new pages of this pass and the one use case call each makes.
const CLIENT_PAGES = Object.freeze({
  "app/client/payments/page.tsx":
    "resolveClientPayments(CLIENT_WORKSPACE_SOURCES, page)",
  "app/client/messages/page.tsx":
    "resolveClientThreads(CLIENT_WORKSPACE_SOURCES)",
  "app/client/settings/page.tsx":
    "resolveClientAccount(CLIENT_WORKSPACE_SOURCES)",
  "app/client/privacy/page.tsx":
    "resolveClientAccount(CLIENT_WORKSPACE_SOURCES)",
});
const ATTORNEY_PAGES = Object.freeze({
  "app/attorney/dashboard/page.tsx":
    "resolveAttorneyDashboard(DASHBOARD_SOURCES)",
  "app/attorney/consultations/history/page.tsx":
    "resolveAttorneyHistory(ATTORNEY_WORKSPACE_SOURCES)",
  "app/attorney/schedule/week/page.tsx":
    "resolveScheduleWeek(ATTORNEY_SCHEDULE_SOURCES, week)",
  "app/attorney/messages/page.tsx":
    "resolveAttorneyThreads(ATTORNEY_WORKSPACE_SOURCES)",
  "app/attorney/documents/page.tsx":
    "resolveAttorneyDocuments(ATTORNEY_WORKSPACE_SOURCES)",
  "app/attorney/compliance/page.tsx":
    "resolveAttorneyCompliance({ professional: ATTORNEY_PROFESSIONAL_SOURCES, workspace: ATTORNEY_WORKSPACE_SOURCES, })",
});
const pathOf = (file) =>
  `/${file.replace(/^app\//, "").replace(/\/page\.tsx$/, "")}`;

// The client and attorney principals of the fakes.
function principals(state) {
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
        rows(
          a === SUBJECT && state.client
            ? [{ id: USER, auth_user_id: SUBJECT, account_state: "active" }]
            : [],
        ),
      clientProfilesOf: async (u) =>
        rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
    }),
    writes: async () => ({}),
  };
  const attorney = {
    session: { currentSubject: async () => state.subject },
    attorney: {
      contextsOf: async () => (state.stage === null ? [] : ["attorney"]),
      principalOf: async () =>
        state.stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage: state.stage },
    },
  };
  return { clientIntake, attorney };
}

function workspaceWorld(answers = {}, options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    client: true,
    stage: "approved",
    ...options,
  };
  const { clientIntake, attorney } = principals(state);
  const reads = {
    payments: async (offset) => {
      calls.push(["payments", offset]);
      return answers.payments ?? rows([]);
    },
    overview: async () => {
      calls.push(["overview"]);
      return answers.overview ?? rows([]);
    },
    threads: async (role) => {
      calls.push(["threads", role]);
      return answers.threads ?? rows([]);
    },
    history: async () => {
      calls.push(["history"]);
      return answers.history ?? rows([]);
    },
    documents: async () => {
      calls.push(["documents"]);
      return answers.documents ?? rows([]);
    },
    compliance: async () => {
      calls.push(["compliance"]);
      return answers.compliance ?? rows([]);
    },
  };
  return {
    calls,
    state,
    client: { clientIntake, reads: async () => reads },
    attorney: { ...attorney, reads: async () => reads },
  };
}

const paymentRow = (overrides = {}) => ({
  payment_transaction_id: ID(1),
  consultation_request_id: ID(2),
  payment_state: "captured",
  total_client_amount_minor: 5175,
  currency_code: "XTS",
  amount_authorized_minor: 5175,
  amount_captured_minor: 5175,
  amount_refunded_minor: 0,
  created_at: T,
  ...overrides,
});

const overviewRow = (overrides = {}) => ({
  display_name: null,
  account_state: "active",
  created_at: T,
  intakes: 2,
  requests: 1,
  consultations: 1,
  documents: 3,
  messages: 4,
  payments: 1,
  complaints: 0,
  ...overrides,
});

const threadRow = (overrides = {}) => ({
  consultation_id: ID(10),
  consultation_state: "scheduled",
  messaging_status: "open",
  message_count: 2,
  last_message_at: T,
  last_message_mine: false,
  ...overrides,
});

const historyRow = (overrides = {}) => ({
  consultation_id: ID(20),
  state: "cancelled",
  ready_due: false,
  request_path: "scheduled",
  modality: "synthetic_video",
  duration_minutes: 30,
  booking_starts_at: T,
  booking_ends_at: LATER,
  opens_at: T,
  closes_at: LATER,
  started_at: null,
  ended_at: LATER,
  outcome_code: "client_cancelled",
  ...overrides,
});

const documentRow = (overrides = {}) => ({
  consultation_id: ID(30),
  document_id: ID(31),
  version_label: "v1",
  mime_type: "application/pdf",
  byte_size: 2048,
  created_at: T,
  uploaded_by: "client",
  mine: false,
  sharing: "active",
  accessible: true,
  ...overrides,
});

const recordRow = (overrides = {}) => ({
  record_kind: "license",
  record_id: ID(40),
  jurisdiction_id: ID(41),
  status_code: null,
  starts_on: "2026-01-01",
  ends_on: "2027-01-01",
  evidence_lapses_on: "2026-12-22",
  recorded_at: T,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Routes (MBS section 18.6) and navigation
// ---------------------------------------------------------------------------

test("S11C-1 (MBS section 18.6) the new pages are server pages rendered per request and unindexed that read only through their own use case and production sources: the four client pages hand the request's trusted client sources to a use case that re-verifies the client and refuse a signed-out caller and a wrong principal; the six attorney pages ask the step-up gate first and refuse likewise; none reads a header, cookie, setting, table or database function, renders a form, or offers an action; the payment history reads only the page value and the week view only the week value", () => {
  const all = { ...CLIENT_PAGES, ...ATTORNEY_PAGES };
  for (const [file, call] of Object.entries(all)) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.ok(code.replace(/\s+/g, " ").includes(call), `${file}: ${call}`);
    assert.doesNotMatch(
      code,
      /headers\(|cookies\(|process\.env|dangerouslySetInnerHTML|\.rpc\(|\.from\(|<form|action=|useActionState|createClient|service_role|registration-provisioning/,
      file,
    );
    assert.match(code, /"sign-in-required"/, file);
    assert.match(code, /href="\/sign-in"/, file);
    assert.match(code, /"denied"/, file);
    for (const specifier of importsOf(source)) {
      assert.match(
        specifier,
        /^(?:next|next\/server|react|(?:\.\.\/)+src\/(?:application|presentation)\/[a-z-]+\.tsx?|(?:\.\.\/)+src\/infrastructure\/[a-z-]+\/[a-z-]+\.ts|(?:\.\.\/)+account\/gate\.ts)$/,
        `${file}: ${specifier}`,
      );
    }
    if (file.startsWith("app/attorney/")) {
      assert.ok(
        code.includes(
          '  await connection();\n  await requireSteppedUp("attorney");\n',
        ),
        file,
      );
    } else {
      assert.doesNotMatch(code, /requireSteppedUp/, file);
    }
    const queries = code.match(/\bsearchParams\b/g)?.length ?? 0;
    if (file === "app/client/payments/page.tsx") {
      assert.equal(queries, 3, file);
      assert.ok(code.includes("const { page } = await searchParams;"), file);
    } else if (file === "app/attorney/schedule/week/page.tsx") {
      assert.equal(queries, 3, file);
      assert.ok(code.includes("const { week } = await searchParams;"), file);
    } else {
      assert.equal(queries, 0, file);
    }
    assert.doesNotMatch(code, /\bparams\b/, file);
  }
  // The pages of this pass add no server action and no client module.
  for (const file of Object.keys(all)) {
    const directory = file.slice(0, file.lastIndexOf("/") + 1);
    for (const sibling of filesIn(directory).filter(
      (f) => !f.slice(directory.length).includes("/"),
    )) {
      if (Object.hasOwn(all, sibling)) {
        continue;
      }
      // The existing schedule and consultations modules beside the new
      // subdirectories are earlier work.
      assert.ok(
        [
          "app/attorney/consultations/actions.ts",
          "app/attorney/consultations/page.tsx",
          "app/attorney/schedule/actions.ts",
          "app/attorney/schedule/forms.tsx",
          "app/attorney/schedule/heartbeat.tsx",
          "app/attorney/schedule/page.tsx",
          "app/client/payments/[payment]/page.tsx",
        ].includes(sibling),
        sibling,
      );
    }
  }
  // The participant workspace adapter is reached only by these pages.
  for (const file of [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
    /\.tsx?$/.test(f),
  )) {
    if (/workspace-adapter\.ts/.test(read(file))) {
      assert.ok(
        Object.hasOwn(all, file) &&
          file !== "app/attorney/schedule/week/page.tsx",
        file,
      );
    }
  }
});

test("S11C-2 one consistent navigation per workspace: fixed first-party links, each to a page that exists (or a public page), shown by every new page with its own path marked; the client home links every client area of the set from its own page-local links (its Help and Privacy links are pinned there); the attorney home links the dashboard; the staff home's grouped links stay the staff navigation", () => {
  const exists = (href) =>
    existsSync(new URL(`app${href === "/" ? "" : href}/page.tsx`, appRoot));
  for (const [list, prefix] of [
    [labels.CLIENT_NAVIGATION, "/client"],
    [labels.ATTORNEY_NAVIGATION, "/attorney"],
  ]) {
    const hrefs = list.map((link) => link.href);
    assert.equal(new Set(hrefs).size, hrefs.length);
    for (const link of list) {
      assert.match(link.href, /^\/[a-z-/]*$/, link.href);
      assert.ok(exists(link.href), link.href);
      assert.ok(
        link.href.startsWith(prefix) ||
          ["/help", "/find-an-attorney", "/account/security"].includes(
            link.href,
          ),
        link.href,
      );
      assert.ok(link.label.length > 0 && link.label.length <= 40);
    }
  }
  for (const file of Object.keys(CLIENT_PAGES)) {
    const code = codeOf(read(file));
    assert.ok(
      code.includes(`<ClientNavigation current="${pathOf(file)}" />`),
      file,
    );
    assert.ok(
      labels.CLIENT_NAVIGATION.some((link) => link.href === pathOf(file)),
      file,
    );
  }
  for (const file of Object.keys(ATTORNEY_PAGES)) {
    const code = codeOf(read(file));
    assert.ok(
      code.includes(`<AttorneyNavigation current="${pathOf(file)}" />`),
      file,
    );
    assert.ok(
      labels.ATTORNEY_NAVIGATION.some((link) => link.href === pathOf(file)),
      file,
    );
  }
  const home = codeOf(read("app/client/page.tsx"));
  const homeLinks = new Set(
    [...home.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
  );
  for (const link of labels.CLIENT_NAVIGATION) {
    if (link.href !== "/client") {
      assert.ok(homeLinks.has(link.href), link.href);
    }
  }
  assert.match(
    codeOf(read("app/attorney/page.tsx")),
    /href="\/attorney\/dashboard"/,
  );
  // The component marks the current page and links nothing else.
  const navigation = codeOf(read("src/presentation/workspace-navigation.tsx"));
  assert.deepEqual(
    importsOf(read("src/presentation/workspace-navigation.tsx")),
    ["./design-system.tsx", "./workspace-labels.ts"],
  );
  assert.match(navigation, /aria-current="page"/);
  assert.match(navigation, /<nav aria-label=\{label\}>/);
});

test("S11C-3 the participant workspace adapter calls each of its six reads by its literal name with exactly its named arguments through the request's own client; a malformed offset or role is refused before anything is sent; a failed, thrown or malformed answer is unreadable", async () => {
  const log = [];
  let reply = { data: [], error: null };
  const client = {
    rpc: async (name, args) => {
      log.push([name, args]);
      if (reply === "throw") {
        throw new Error("synthetic failure");
      }
      return reply;
    },
  };
  const clientReads = await createClientWorkspaceReads(async () => client)();
  const attorneyReads = await createAttorneyWorkspaceReads(
    async () => client,
  )();
  await clientReads.payments(25);
  await clientReads.overview();
  await clientReads.threads("client");
  await attorneyReads.threads("attorney");
  await attorneyReads.history();
  await attorneyReads.documents();
  await attorneyReads.compliance();
  assert.deepEqual(log, [
    ["client_payments", { p_offset: 25 }],
    ["client_account_overview", undefined],
    ["consultation_threads", { p_role: "client" }],
    ["consultation_threads", { p_role: "attorney" }],
    ["attorney_consultation_history", undefined],
    ["attorney_documents", undefined],
    ["attorney_compliance_records", undefined],
  ]);
  log.length = 0;
  for (const offset of [-25, 7, 100025, 1.5, "0", null]) {
    assert.deepEqual(await clientReads.payments(offset), UNREADABLE);
  }
  for (const role of ["staff", "Client", "", null]) {
    assert.deepEqual(await clientReads.threads(role), UNREADABLE);
  }
  assert.deepEqual(log, []);
  assert.deepEqual(Object.keys(clientReads).sort(), [
    "overview",
    "payments",
    "threads",
  ]);
  assert.deepEqual(Object.keys(attorneyReads).sort(), [
    "compliance",
    "documents",
    "history",
    "threads",
  ]);
  reply = { data: null, error: { code: "42501", message: "denied" } };
  assert.deepEqual(await clientReads.overview(), UNREADABLE);
  reply = { data: { not: "rows" }, error: null };
  assert.deepEqual(await attorneyReads.history(), UNREADABLE);
  reply = "throw";
  assert.deepEqual(await attorneyReads.documents(), UNREADABLE);
  const adapter = codeOf(
    read("src/infrastructure/workspaces/workspace-adapter.ts"),
  );
  assert.doesNotMatch(
    adapter,
    /\.from\(|createClient\b|service_role|ADMIN_KEY|registration-provisioning|process\.env|\binsert|\bupdate|\bdelete/i,
  );
});

// ---------------------------------------------------------------------------
// Client surfaces
// ---------------------------------------------------------------------------

test("S11C-4 (MBS section 18.2 payments) the payment history needs the verified client and reads one page of 25 strictly: every column exactly, a known state, whole amounts, a refund never above the captured amount; one malformed or repeated row makes the page unavailable; 26 rows say an older page follows; the page value pages by 25 and anything else is the first page", async () => {
  assert.deepEqual(Object.keys(paymentRow()), [...CLIENT_PAYMENT_COLUMNS]);
  const list = Array.from({ length: 26 }, (_, n) =>
    paymentRow({ payment_transaction_id: ID(100 + n) }),
  );
  const w = workspaceWorld({ payments: rows(list) });
  const view = await resolveClientPayments(w.client, "2");
  assert.equal(view.status, "ready");
  assert.equal(view.payments.length, 25);
  assert.deepEqual(view.pager, { page: 2, hasNext: true });
  assert.deepEqual(w.calls, [["payments", 25]]);
  for (const page of [["2"], "0", "x", undefined, "-1"]) {
    const v = workspaceWorld({ payments: rows([paymentRow()]) });
    await resolveClientPayments(v.client, page);
    assert.deepEqual(v.calls, [["payments", 0]], String(page));
  }
  const refunded = await resolveClientPayments(
    workspaceWorld({
      payments: rows([
        paymentRow({
          payment_state: "partially_refunded",
          amount_refunded_minor: 1000,
        }),
      ]),
    }).client,
    undefined,
  );
  assert.equal(refunded.payments[0].refundedMinor, 1000);
  for (const bad of [
    [paymentRow({ extra: 1 })],
    [paymentRow({ payment_state: "settled" })],
    [paymentRow({ amount_refunded_minor: 6000 })],
    [paymentRow({ amount_captured_minor: null, amount_refunded_minor: 1 })],
    [paymentRow({ currency_code: "xts" })],
    [paymentRow({ total_client_amount_minor: -1 })],
    [paymentRow(), paymentRow()],
  ]) {
    const v = await resolveClientPayments(
      workspaceWorld({ payments: rows(bad) }).client,
      undefined,
    );
    assert.equal(v.status, "unavailable", JSON.stringify(bad));
  }
  const signedOut = workspaceWorld({}, { subject: null });
  assert.equal(
    (await resolveClientPayments(signedOut.client, undefined)).status,
    "sign-in-required",
  );
  assert.deepEqual(signedOut.calls, []);
  const notClient = workspaceWorld({}, { client: false });
  assert.notEqual(
    (await resolveClientPayments(notClient.client, undefined)).status,
    "ready",
  );
  assert.deepEqual(notClient.calls, []);
  assert.equal(
    (
      await resolveClientPayments(
        workspaceWorld({ payments: UNREADABLE }).client,
        undefined,
      )
    ).status,
    "unavailable",
  );
});

test("S11C-5 (MBS section 18.2 settings, privacy and data) the account overview needs the verified client and exactly one row: the display name, a known account state, the creation instant and a whole count for each of the seven categories in order; none, two or a malformed row is unavailable", async () => {
  assert.deepEqual(Object.keys(overviewRow()), [...ACCOUNT_OVERVIEW_COLUMNS]);
  assert.deepEqual(DATA_CATEGORIES, [
    "intakes",
    "requests",
    "consultations",
    "documents",
    "messages",
    "payments",
    "complaints",
  ]);
  const w = workspaceWorld({ overview: rows([overviewRow()]) });
  const view = await resolveClientAccount(w.client);
  assert.equal(view.status, "ready");
  assert.deepEqual(view.account.counts, {
    intakes: 2,
    requests: 1,
    consultations: 1,
    documents: 3,
    messages: 4,
    payments: 1,
    complaints: 0,
  });
  assert.equal(view.account.displayName, null);
  assert.equal(view.account.accountState, "active");
  for (const bad of [
    [],
    [overviewRow(), overviewRow()],
    [overviewRow({ messages: -1 })],
    [overviewRow({ documents: 1.5 })],
    [overviewRow({ account_state: "unknown" })],
    [overviewRow({ extra: 0 })],
  ]) {
    const v = await resolveClientAccount(
      workspaceWorld({ overview: rows(bad) }).client,
    );
    assert.equal(v.status, "unavailable", JSON.stringify(bad));
  }
  const signedOut = workspaceWorld({}, { subject: null });
  assert.equal(
    (await resolveClientAccount(signedOut.client)).status,
    "sign-in-required",
  );
  assert.deepEqual(signedOut.calls, []);
});

test("S11C-6 (MBS sections 18.2 and 18.3 messages) the inboxes read the caller's own threads for their own role only (client: client; attorney: attorney behind the Security Shell): every column exactly, a known Consultation state and messaging status, a count with its latest instant and sender together (none for an empty thread); a malformed, inconsistent or repeated row makes the inbox unavailable", async () => {
  assert.deepEqual(Object.keys(threadRow()), [...THREAD_COLUMNS]);
  const w = workspaceWorld({
    threads: rows([
      threadRow(),
      threadRow({
        consultation_id: ID(11),
        consultation_state: "completed",
        messaging_status: "closed",
        message_count: 0,
        last_message_at: null,
        last_message_mine: null,
      }),
    ]),
  });
  const client = await resolveClientThreads(w.client);
  assert.equal(client.status, "ready");
  assert.equal(client.threads.length, 2);
  const attorney = await resolveAttorneyThreads(w.attorney);
  assert.equal(attorney.status, "ready");
  assert.deepEqual(w.calls, [
    ["threads", "client"],
    ["threads", "attorney"],
  ]);
  for (const bad of [
    [threadRow({ message_count: 0 })],
    [threadRow({ last_message_at: null })],
    [threadRow({ last_message_mine: null })],
    [threadRow({ messaging_status: "unknown" })],
    [threadRow({ consultation_state: "archived" })],
    [threadRow({ body: "x" })],
    [threadRow(), threadRow()],
  ]) {
    const v = await resolveClientThreads(
      workspaceWorld({ threads: rows(bad) }).client,
    );
    assert.equal(v.status, "unavailable", JSON.stringify(bad));
  }
  const noAttorney = workspaceWorld({}, { stage: null });
  assert.equal(
    (await resolveAttorneyThreads(noAttorney.attorney)).status,
    "denied",
  );
  assert.deepEqual(noAttorney.calls, []);
});

test("S11C-7 the client's home shows the Consultations in progress or ready now and the next upcoming one, from the client's own list as it was read; an unread list shows nothing", () => {
  const entry = (id, state, readyDue = false) => ({
    id,
    state,
    readyDue,
    path: "scheduled",
    modality: "synthetic_video",
    durationMinutes: 30,
    bookingStart: T,
    bookingEnd: LATER,
    opensAt: T,
    closesAt: LATER,
    startedAt: state === "live" ? T : null,
    endedAt: null,
    outcomeCode: null,
  });
  const home = clientHomeOf({
    status: "ready",
    entries: [
      entry(ID(1), "live"),
      entry(ID(2), "scheduled", true),
      entry(ID(3), "scheduled"),
      entry(ID(4), "created"),
      { ...entry(ID(5), "cancelled"), endedAt: LATER },
    ],
  });
  assert.deepEqual(
    home.active.map((e) => e.id),
    [ID(1), ID(2)],
  );
  assert.equal(home.next.id, ID(3));
  assert.equal(home.upcoming, 2);
  assert.equal(clientHomeOf({ status: "unavailable" }), null);
  assert.deepEqual(clientHomeOf({ status: "ready", entries: [] }), {
    active: [],
    next: null,
    upcoming: 0,
  });
});

// ---------------------------------------------------------------------------
// Attorney surfaces
// ---------------------------------------------------------------------------

test("S11C-8 (MBS section 18.3 consultations) the past consultations read the attorney's own ended Consultations strictly with the client list's reader: a Consultation that has not ended, an outcome of another state or a repeated id makes the list unavailable; the Security Shell refuses first", async () => {
  const w = workspaceWorld({
    history: rows([
      historyRow(),
      historyRow({
        consultation_id: ID(21),
        state: "completed",
        started_at: T,
        outcome_code: "normal",
      }),
    ]),
  });
  const view = await resolveAttorneyHistory(w.attorney);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.entries.map((e) => [e.state, e.outcomeCode]),
    [
      ["cancelled", "client_cancelled"],
      ["completed", "normal"],
    ],
  );
  for (const bad of [
    [historyRow({ state: "scheduled", ended_at: null, outcome_code: null })],
    [historyRow({ outcome_code: "normal" })],
    [historyRow(), historyRow()],
    [historyRow({ extra: 1 })],
  ]) {
    const v = await resolveAttorneyHistory(
      workspaceWorld({ history: rows(bad) }).attorney,
    );
    assert.equal(v.status, "unavailable", JSON.stringify(bad));
  }
  const signedOut = workspaceWorld({}, { subject: null });
  assert.equal(
    (await resolveAttorneyHistory(signedOut.attorney)).status,
    "sign-in-required",
  );
  assert.deepEqual(signedOut.calls, []);
});

test("S11C-9 (MBS section 18.3 documents) the documents read strictly: every column exactly, a server version label, an accepted type and size, the attorney's own uploads always openable and the uploader matching mine; 201 rows say more exist and only 200 are shown; a malformed or repeated row makes the list unavailable", async () => {
  assert.deepEqual(Object.keys(documentRow()), [...ATTORNEY_DOCUMENT_COLUMNS]);
  const many = Array.from({ length: 201 }, (_, n) =>
    documentRow({ document_id: ID(500 + n) }),
  );
  const view = await resolveAttorneyDocuments(
    workspaceWorld({ documents: rows(many) }).attorney,
  );
  assert.equal(view.status, "ready");
  assert.equal(view.documents.length, 200);
  assert.equal(view.more, true);
  const one = await resolveAttorneyDocuments(
    workspaceWorld({
      documents: rows([
        documentRow({
          uploaded_by: "attorney",
          mine: true,
          sharing: "revoked",
        }),
      ]),
    }).attorney,
  );
  assert.equal(one.more, false);
  assert.equal(one.documents[0].mine, true);
  for (const bad of [
    [documentRow({ uploaded_by: "attorney" })],
    [documentRow({ mine: true })],
    [documentRow({ uploaded_by: "attorney", mine: true, accessible: false })],
    [documentRow({ version_label: "draft" })],
    [documentRow({ mime_type: "text/html" })],
    [documentRow({ byte_size: 0 })],
    [documentRow({ sharing: "public" })],
    [documentRow({ storage_object_path: "x" })],
    [documentRow(), documentRow()],
    Array.from({ length: 202 }, (_, n) =>
      documentRow({ document_id: ID(800 + n) }),
    ),
  ]) {
    const v = await resolveAttorneyDocuments(
      workspaceWorld({ documents: rows(bad) }).attorney,
    );
    assert.equal(v.status, "unavailable", JSON.stringify(bad).slice(0, 80));
  }
});

test("S11C-10 (MBS section 18.3 compliance) the attorney's own records read strictly (a licence always with its jurisdiction, a status code only on a discipline finding, an evidence date never on one, dates as dates); the alerts apply no lead time: records past their end date, evidence past its stated age, findings without a resolved date, and the soonest date still ahead", async () => {
  assert.deepEqual(Object.keys(recordRow()), [...COMPLIANCE_RECORD_COLUMNS]);
  const list = [
    recordRow(),
    recordRow({
      record_id: ID(42),
      record_kind: "insurance",
      ends_on: "2026-11-01",
      evidence_lapses_on: null,
    }),
    recordRow({
      record_id: ID(43),
      record_kind: "discipline",
      status_code: "synthetic_open",
      starts_on: "2026-05-01",
      ends_on: null,
      evidence_lapses_on: null,
    }),
    recordRow({
      record_id: ID(44),
      evidence_lapses_on: "2026-10-01",
      ends_on: null,
    }),
  ];
  const view = await resolveAttorneyComplianceRecords(
    workspaceWorld({ compliance: rows(list) }).attorney,
  );
  assert.equal(view.status, "ready");
  assert.deepEqual(complianceAlertsOf(view.records, "2026-11-20"), {
    lapsed: 1,
    evidenceAged: 1,
    openFindings: 1,
    nextDate: "2026-12-22",
  });
  assert.deepEqual(complianceAlertsOf([], "2026-11-20"), {
    lapsed: 0,
    evidenceAged: 0,
    openFindings: 0,
    nextDate: null,
  });
  // A date on the day itself is not yet past.
  assert.equal(
    complianceAlertsOf([view.records[0]], "2026-12-22").evidenceAged,
    0,
  );
  for (const bad of [
    [recordRow({ jurisdiction_id: null })],
    [recordRow({ status_code: "active" })],
    [
      recordRow({
        record_kind: "discipline",
        evidence_lapses_on: "2026-01-01",
      }),
    ],
    [recordRow({ record_kind: "discipline", status_code: "Free Text" })],
    [recordRow({ ends_on: "2027-01-01T00:00:00Z" })],
    [recordRow({ record_kind: "evidence" })],
    [recordRow({ license_number: "SYN" })],
    [recordRow(), recordRow()],
  ]) {
    const v = await resolveAttorneyComplianceRecords(
      workspaceWorld({ compliance: rows(bad) }).attorney,
    );
    assert.equal(v.status, "unavailable", JSON.stringify(bad));
  }
});

test("S11C-10b (MBS sections 18.3 and 18.6) the compliance page admits the attorney through the Security Shell before anything is read: an account without attorney workspace access (a client or a staff member) gets the fixed refusal, a signed-out caller is asked to sign in, and neither the professional setup nor the compliance records are read", async () => {
  for (const [options, status] of [
    [{ stage: null }, "denied"],
    [{ subject: null }, "sign-in-required"],
  ]) {
    const w = workspaceWorld({ compliance: rows([recordRow()]) }, options);
    const professionalCalls = [];
    const professional = new Proxy(
      {},
      {
        get: (_target, key) => {
          professionalCalls.push(String(key));
          return async () => null;
        },
      },
    );
    const view = await resolveAttorneyCompliance({
      professional,
      workspace: w.attorney,
    });
    assert.equal(view.status, status);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(professionalCalls, []);
  }
});

test("S11C-11 (MBS section 18.3 home) the dashboard admits the attorney once through the Security Shell before any section is read, then shows each section from its own existing use case; a section that fails or throws is unavailable alone; the summaries count only what was read (Requests past their deadline are not counted, notifications only when an acknowledgement is asked and missing, complaints only when not resolved) and apply no threshold", async () => {
  const calls = [];
  const source = (name, value) => async () => {
    calls.push(name);
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  const consultation = (
    id,
    state,
    readyDue = false,
    closesAt = "2026-11-21T10:00:00Z",
  ) => ({
    id,
    state,
    readyDue,
    path: "scheduled",
    modality: "synthetic_video",
    durationMinutes: 30,
    bookingStart: T,
    bookingEnd: LATER,
    opensAt: T,
    closesAt,
    startedAt: state === "live" ? T : null,
  });
  const queueEntry = (id, path, expiredDue = false) => ({
    id,
    path,
    expiredDue,
  });
  const { attorney } = principals({ subject: SUBJECT, stage: "approved" });
  const sources = {
    ...attorney,
    consultations: source("consultations", {
      status: "ready",
      entries: [
        consultation(ID(1), "live"),
        consultation(ID(2), "scheduled", false, "2026-11-20T11:00:00Z"),
        consultation(ID(3), "scheduled"),
      ],
    }),
    requests: source("requests", {
      status: "ready",
      entries: [
        queueEntry(ID(4), "instant"),
        queueEntry(ID(5), "scheduled"),
        queueEntry(ID(6), "scheduled", true),
      ],
    }),
    schedule: source("schedule", new Error("synthetic")),
    earnings: source("earnings", {
      status: "ready",
      lines: [],
      totals: [
        {
          currency: "XTS",
          attributedMinor: 900,
          reversedMinor: 100,
          netMinor: 800,
        },
      ],
    }),
    notifications: source("notifications", {
      status: "ready",
      entries: [
        { acknowledgementRequired: true, state: "delivered" },
        { acknowledgementRequired: true, state: "acknowledged" },
        { acknowledgementRequired: false, state: "delivered" },
      ],
    }),
    complaints: source("complaints", {
      status: "ready",
      cases: [{ state: "opened" }, { state: "resolved" }],
    }),
    compliance: source("compliance", { status: "unavailable" }),
    clock: () => NOW,
  };
  const view = await resolveAttorneyDashboard(sources);
  assert.equal(view.status, "ready");
  const d = view.dashboard;
  assert.deepEqual(
    d.consultations.value.active.map((e) => e.id),
    [ID(1)],
  );
  // ID(2)'s window closed before now: it is not the next one.
  assert.equal(d.consultations.value.next.id, ID(3));
  assert.deepEqual(d.requests.value, { instant: 1, scheduled: 1 });
  assert.deepEqual(d.availability, { status: "unavailable" });
  assert.deepEqual(d.earnings.value.totals, [
    { currency: "XTS", netMinor: 800 },
  ]);
  assert.deepEqual(d.alerts.value, {
    unacknowledged: 1,
    openComplaints: 1,
    compliance: null,
  });
  assert.deepEqual(calls.sort(), [
    "complaints",
    "compliance",
    "consultations",
    "earnings",
    "notifications",
    "requests",
    "schedule",
  ]);
  calls.length = 0;
  const refused = await resolveAttorneyDashboard({
    ...sources,
    ...principals({ subject: SUBJECT, stage: null }).attorney,
  });
  assert.equal(refused.status, "denied");
  assert.deepEqual(calls, []);
  // The pure summaries.
  assert.equal(requestSummaryOf({ status: "denied" }), null);
  assert.equal(consultationSummaryOf({ status: "unavailable" }, NOW), null);
  assert.equal(
    alertSummaryOf(
      { status: "unavailable" },
      { status: "ready", cases: [] },
      { status: "unavailable" },
      NOW,
    ),
    null,
  );
  const availability = availabilitySummaryOf(
    {
      status: "ready",
      stage: "approved",
      today: "2026-11-20",
      displayZone: "UTC",
      calendar: [
        {
          kind: "window",
          id: ID(7),
          startsAt: "2026-11-20T09:00:00Z",
          endsAt: "2026-11-20T10:00:00Z",
          timezone: "UTC",
          localDate: "2026-11-20",
          state: "available",
        },
        {
          kind: "window",
          id: ID(8),
          startsAt: "2026-11-21T09:00:00Z",
          endsAt: "2026-11-21T10:00:00Z",
          timezone: "UTC",
          localDate: "2026-11-21",
          state: "available",
        },
        {
          kind: "blackout",
          id: ID(9),
          startsAt: "2026-11-22T09:00:00Z",
          endsAt: "2026-11-22T10:00:00Z",
          timezone: null,
          localDate: null,
          state: "removable",
        },
      ],
      rules: [],
      blackouts: [],
      instant: {
        on: false,
        expiresAt: null,
        sessionActive: false,
        configured: true,
        otherSessionsOn: 0,
      },
    },
    NOW,
  );
  assert.equal(availability.windows, 2);
  assert.equal(availability.nextWindow.id, ID(8));
  assert.equal(availability.blackouts, 1);
  assert.equal(availability.instantOn, false);
  assert.equal(availability.days, 14);
});

test("S11C-12 (MBS section 18.3 schedule) the week view reads seven days of the attorney's own calendar through the existing read from the named first day (a whole UTC date within 28 days back and the read's span ahead; today otherwise), shows each entry on the first day of the week it overlaps, offers the neighbouring weeks inside the span, and is unavailable on any malformed row", async () => {
  assert.equal(weekStartOf(undefined, NOW), "2026-11-20");
  assert.equal(weekStartOf("2026-11-27", NOW), "2026-11-27");
  assert.equal(weekStartOf("2026-10-23", NOW), "2026-10-23");
  assert.equal(weekStartOf("2026-10-22", NOW), "2026-11-20");
  assert.equal(weekStartOf(["2026-11-27"], NOW), "2026-11-20");
  assert.equal(weekStartOf("2026-02-30", NOW), "2026-11-20");
  assert.equal(weekStartOf("2036-11-20", NOW), "2026-11-20");
  const calls = [];
  const entry = (id, kind, startsAt, endsAt, zone = null) => ({
    entry_kind: kind,
    entry_id: id,
    starts_at: startsAt,
    ends_at: endsAt,
    timezone_name: zone,
    local_date: zone === null ? null : startsAt.slice(0, 10),
    entry_state: kind === "window" ? "available" : "confirmed",
    reason_code: null,
  });
  const scheduleSources = (answer) => ({
    ...principals({ subject: SUBJECT, stage: "approved" }).attorney,
    reads: async () => ({
      calendar: async (from, days) => {
        calls.push([from, days]);
        return answer;
      },
    }),
    writes: async () => ({}),
    clock: () => NOW,
  });
  const view = await resolveScheduleWeek(
    scheduleSources(
      rows([
        entry(
          ID(1),
          "blackout",
          "2026-11-19T20:00:00Z",
          "2026-11-20T02:00:00Z",
        ),
        entry(
          ID(2),
          "window",
          "2026-11-21T09:00:00Z",
          "2026-11-21T10:00:00Z",
          "UTC",
        ),
        entry(ID(3), "booking", "2026-11-26T23:30:00Z", "2026-11-27T00:30:00Z"),
        entry(ID(4), "booking", "2026-11-27T09:00:00Z", "2026-11-27T10:00:00Z"),
        entry(ID(5), "hold", "2026-11-19T09:00:00Z", "2026-11-19T10:00:00Z"),
      ]),
    ),
    "2026-11-20",
  );
  assert.deepEqual(calls, [["2026-11-20", 7]]);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.days.map((day) => [day.date, day.entries.map((e) => e.id)]),
    [
      ["2026-11-20", [ID(1)]],
      ["2026-11-21", [ID(2)]],
      ["2026-11-22", []],
      ["2026-11-23", []],
      ["2026-11-24", []],
      ["2026-11-25", []],
      ["2026-11-26", [ID(3)]],
    ],
  );
  assert.equal(view.previous, "2026-11-13");
  assert.equal(view.next, "2026-11-27");
  const early = await resolveScheduleWeek(
    scheduleSources(rows([])),
    "2026-10-23",
  );
  assert.equal(early.previous, null);
  const bad = await resolveScheduleWeek(
    scheduleSources(rows([{ ...entry(ID(6), "booking", T, LATER), extra: 1 }])),
    undefined,
  );
  assert.equal(bad.status, "unavailable");
  const refused = await resolveScheduleWeek(
    {
      ...scheduleSources(rows([])),
      ...principals({ subject: null, stage: null }).attorney,
    },
    undefined,
  );
  assert.equal(refused.status, "sign-in-required");
});

// ---------------------------------------------------------------------------
// Labels (Packet rule 11)
// ---------------------------------------------------------------------------

test("S11C-13 (Packet rule 11) the workspace wording is fixed and neutral: every messaging status, data category, record kind and account state has a label; the privacy and data page repeats only the public privacy page's own sentence and says data requests cannot be made yet, with no request form; nothing states an entitlement, a settlement, a legal right, a threshold or a recommendation, or names a provider", () => {
  for (const status of ["open", "closed", "window_unavailable"]) {
    assert.ok(labels.MESSAGING_STATUS_LABELS[status].label.length > 0);
  }
  for (const category of DATA_CATEGORIES) {
    assert.ok(labels.DATA_CATEGORY_LABELS[category].length > 0);
  }
  for (const kind of ["license", "insurance", "discipline"]) {
    assert.ok(labels.RECORD_KIND_LABELS[kind].length > 0);
  }
  for (const state of [
    "pending_verification",
    "active",
    "suspended",
    "closed",
  ]) {
    assert.ok(labels.ACCOUNT_STATE_LABELS[state].label.length > 0);
  }
  const privacy = codeOf(read("app/privacy/page.tsx"));
  assert.ok(privacy.includes(labels.PRIVACY_NOT_AVAILABLE));
  assert.equal(
    labels.DATA_REQUESTS_NOT_AVAILABLE,
    "Requests about your data cannot be made here yet.",
  );
  const texts = Object.values(labels)
    .flatMap((value) =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : [],
    )
    .join(" ");
  assert.doesNotMatch(
    texts,
    /entitle|guarantee|escrow|\bsettled\b|\bearned\b|right to|GDPR|CCPA|recommend|best attorney|stripe|daily\.co|resend|supabase|within \d+ days|\d+ days before/i,
  );
  assert.equal(
    labels.lastMessageText(null, null, (t) => t),
    "No messages yet.",
  );
  assert.equal(
    labels.lastMessageText(T, true, () => "X"),
    "Last message X, from you.",
  );
  assert.equal(labels.refundText("captured", 0, "x"), null);
  assert.equal(
    labels.refundText("refund_pending", 0, "x"),
    "Refund in progress.",
  );
  assert.equal(
    labels.refundText("partially_refunded", 100, "XTS 1.00"),
    "Refunded so far: XTS 1.00.",
  );
  // The data page offers no form, field or action.
  const data = codeOf(read("app/client/privacy/page.tsx"));
  assert.doesNotMatch(
    data,
    /<form|TextField|SelectField|Button\b(?!Link)|action=/,
  );
});

// ---------------------------------------------------------------------------
// Correction D14: the S11 notification types end to end
// ---------------------------------------------------------------------------

const S11_TYPES = Object.freeze([
  "consultation_cancelled",
  "consultation_outcome_recorded",
  "review_available",
  "complaint_received",
]);

// The database's notification type vocabulary, from the latest migration
// that defines it: the notification_types() array and the type check's pairs.
function databaseVocabulary() {
  const directory = new URL("../../supabase/migrations/", appRoot);
  const files = readdirSync(directory)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const latest = files
    .filter((f) =>
      /^create (?:or replace )?function public\.notification_types\(\)/m.test(
        readFileSync(new URL(f, directory), "utf8"),
      ),
    )
    .at(-1);
  const text = readFileSync(new URL(latest, directory), "utf8");
  const body = text.slice(
    text.search(/function public\.notification_types\(\)/),
  );
  const array = body.slice(body.indexOf("array["), body.indexOf("]::text[]"));
  const types = [...array.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const checked = [
    ...text.matchAll(/notification_type = '([a-z_]+)' and source_event_type/g),
  ].map((m) => m[1]);
  return { latest, types, checked };
}

test("S11C-14 (correction D14) the application's notification types equal the database vocabulary of the latest migration that defines it (the notification_types() list and the type check), in order, so the two cannot drift; every type has a fixed email template and a notification center label", () => {
  const { latest, types, checked } = databaseVocabulary();
  assert.equal(latest, "20261127070000_mvp_001_s11_notification_events.sql");
  assert.deepEqual([...NOTIFICATION_TYPES], types);
  assert.deepEqual([...NOTIFICATION_TYPES], checked);
  assert.equal(NOTIFICATION_TYPES.length, 11);
  assert.deepEqual(Object.keys(EMAIL_TEMPLATES), [...NOTIFICATION_TYPES]);
  assert.deepEqual(Object.keys(NOTIFICATION_LABELS), [...NOTIFICATION_TYPES]);
  for (const type of S11_TYPES) {
    assert.ok(NOTIFICATION_TYPES.includes(type), type);
  }
});

test("S11C-15 (correction D14) the four S11 types' emails keep the S10 fixed minimal form: a fixed subject and line, no name, matter detail, outcome, amount or address, and one link only, to the recipient's notification center; their center labels are fixed and neutral", () => {
  const to = "synthetic.person@synthetic.invalid";
  const center = "http://127.0.0.1:3000/client/notifications";
  for (const type of S11_TYPES) {
    const template = EMAIL_TEMPLATES[type];
    assert.ok(template.subject.length > 0 && template.subject.length <= 80);
    const built = emailMessageOf(type, to, center);
    assert.equal(built.subject, template.subject);
    assert.ok(built.text.startsWith(`${template.line}\n`), type);
    assert.equal(built.html.match(/href=/g).length, 1, type);
    assert.ok(built.html.includes(`href="${center}"`), type);
    assert.equal(built.text.includes(to), false, type);
    assert.equal(built.html.includes(to), false, type);
    for (const text of [
      template.subject,
      template.line,
      NOTIFICATION_LABELS[type],
    ]) {
      assert.doesNotMatch(
        text,
        /no.show|technical|failure|manual|refund|charge|amount|fee|\$|attorney [A-Z]|client [A-Z]|entitle|guarantee|liab|legal/i,
        `${type}: ${text}`,
      );
    }
  }
});

test("S11C-16 (correction D14) the notification centers read the four S11 types with the database's own links (the recipient's Consultation page for the three Consultation events, the recipient's reported problems page for complaint_received; a complaints link on another type or a Consultation link on a complaint is unavailable), and the delivery job reads a context of each new type and sends its fixed email once to the notification center link", async () => {
  const consultation = ID(60);
  const centerRow = (type, link) => ({
    notification_id: ID(61 + S11_TYPES.indexOf(type)),
    notification_type: type,
    state: "delivered",
    critical: false,
    ack_required: false,
    created_at: T,
    link_path: link,
    email_state: "pending",
  });
  const clientRows = [
    centerRow("review_available", `/client/consultations/${consultation}`),
    centerRow(
      "consultation_cancelled",
      `/client/consultations/${consultation}`,
    ),
    centerRow(
      "consultation_outcome_recorded",
      `/client/consultations/${consultation}`,
    ),
    centerRow("complaint_received", "/client/complaints"),
  ];
  const state = { subject: SUBJECT, client: true, stage: "approved" };
  const { clientIntake, attorney } = principals(state);
  const centerSources = (list) => ({
    reads: async () => ({ center: async () => rows(list) }),
    writes: async () => ({}),
  });
  const client = await resolveClientNotifications({
    clientIntake,
    ...centerSources(clientRows),
  });
  assert.equal(client.status, "ready");
  assert.deepEqual(
    client.entries.map((e) => [e.type, e.linkPath]),
    clientRows.map((r) => [r.notification_type, r.link_path]),
  );
  const attorneyView = await resolveAttorneyNotifications({
    ...attorney,
    ...centerSources([
      centerRow(
        "consultation_cancelled",
        `/attorney/consultations/${consultation}`,
      ),
      centerRow("complaint_received", "/attorney/complaints"),
    ]),
  });
  assert.equal(attorneyView.status, "ready");
  for (const bad of [
    centerRow("review_available", "/client/complaints"),
    centerRow("complaint_received", `/client/consultations/${consultation}`),
    centerRow("complaint_received", "/client/complaints/x"),
    centerRow("complaint_received", "/staff/complaints"),
  ]) {
    const view = await resolveClientNotifications({
      clientIntake,
      ...centerSources([bad]),
    });
    assert.equal(view.status, "unavailable", JSON.stringify(bad));
  }
  // The delivery job, with the database's context of each new type.
  for (const type of S11_TYPES) {
    const sent = [];
    const attempts = [];
    const handler = createNotificationJobHandlers({
      providerCode: "synthetic_mail",
      provider: async () => ({
        providerCode: "synthetic_mail",
        send: async (message, key) => {
          sent.push([message, key]);
          return { kind: "accepted", reference: "synthetic-reference-1" };
        },
      }),
      recorder: async () => ({
        jobContext: async () => [
          {
            outcome: "act",
            notification_id: ID(70),
            notification_type: type,
            center_path:
              type === "consultation_cancelled"
                ? "/attorney/notifications"
                : "/client/notifications",
            recipient_address: "synthetic.person@synthetic.invalid",
          },
        ],
        recordAttempt: async (jobId, providerCode, attempt) => {
          attempts.push([jobId, providerCode, attempt.result]);
          return "sent";
        },
        recordEvent: async () => "invalid",
      }),
      origin: () => "http://127.0.0.1:3000",
    }).get("notification.deliver");
    const done = await handler({
      jobId: ID(71),
      jobType: "notification.deliver",
      subjectType: "notification",
      subjectId: ID(70),
      attempt: 1,
      maxAttempts: 8,
      idempotencyKey: `rosuno-job-${ID(71)}`,
      signal: new AbortController().signal,
    });
    assert.equal(done, JOB_DONE, type);
    assert.equal(sent.length, 1, type);
    assert.equal(sent[0][0].subject, EMAIL_TEMPLATES[type].subject, type);
    assert.equal(sent[0][1], `rosuno-notification-${ID(70)}`, type);
    assert.deepEqual(attempts, [[ID(71), "synthetic_mail", "accepted"]], type);
  }
});
