// MVP-001 S10 application tests: the participants' Consultation
// communication (Messages and shared documents) and the notification center
// (MBS section 15 deliverables 12A to 12C; IMP section 26; TA sections 47 and
// 57; MB sections 51 to 54 and 98).
//
// The use cases run over synthetic, in-memory ports (no database, provider,
// storage or network): the strict read models (thread, messaging status,
// documents, notification center), the refusals (sign-in, denied,
// unavailable, not found alike for a malformed id), the Message validation
// before anything is sent, the document pipeline (bytes checked on the
// server, the type recognized from the bytes, the digest, the database's
// start, the store at the resource's own path, the completion, and the
// rejection of anything not stored and confirmed), revocation, the download
// link only after the database's authorization, acknowledgement, the
// environment binding before a change, one bounded worker run after a Message
// or a shared document, the labels for every outcome, and the source
// contracts of the new routes and modules (server pages that opt out of
// prerendering, the attorney pages and actions behind the step-up gate, no
// infrastructure in client modules, and the provider-neutral boundary: no
// email provider is named outside its adapter).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  COMMUNICATION_OUTCOMES,
  DOCUMENT_COLUMNS,
  MESSAGE_COLUMNS,
  messageBodyOf,
  openAttorneyDocument,
  openClientDocument,
  resolveAttorneyCommunication,
  resolveClientCommunication,
  revokeClientDocument,
  sendAttorneyMessage,
  sendClientMessage,
  uploadClientDocument,
} from "../src/application/consultation-communication.ts";
import {
  acknowledgeAttorneyNotification,
  acknowledgeClientNotification,
  resolveAttorneyNotifications,
  resolveClientNotifications,
} from "../src/application/notification-center.ts";
import { NOTIFICATION_TYPES } from "../src/application/notifications.ts";
import * as labels from "../src/presentation/communication-labels.ts";

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
const importsOf = (source) =>
  [...source.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);

const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const CONSULTATION = "99999999-9999-4999-8999-999999999999";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const RESOURCE = "44444444-4444-4444-8444-444444444444";
const NOTIFICATION = "55555555-5555-4555-8555-555555555555";
const SENT = "2026-11-20T10:05:00+00:00";

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const TEXT = new TextEncoder().encode("plain text, not a document");

const messageRow = (overrides = {}) => ({
  message_id: MESSAGE,
  sender_role: "client",
  mine: true,
  body: "A synthetic message.",
  sent_at: SENT,
  older_not_shown: false,
  ...overrides,
});
const documentRow = (overrides = {}) => ({
  resource_id: RESOURCE,
  mime_type: "application/pdf",
  byte_size: 2048,
  created_at: SENT,
  uploaded_by: "client",
  mine: true,
  sharing: "active",
  accessible: true,
  older_not_shown: false,
  ...overrides,
});
const centerRow = (overrides = {}) => ({
  notification_id: NOTIFICATION,
  notification_type: "message_received",
  state: "delivered",
  critical: false,
  ack_required: false,
  created_at: SENT,
  link_path: `/client/consultations/${CONSULTATION}`,
  email_state: "pending",
  ...overrides,
});

function world(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    messaging: rows([{ status: "open", closes_at: null }]),
    messages: rows([messageRow()]),
    documents: rows([documentRow()]),
    environment: rows([
      { environment_class: "development", project_ref: null },
    ]),
    configuredClass: "development",
    send: answer("sent", MESSAGE),
    begin: answer("created", RESOURCE),
    revoke: answer("revoked"),
    finalize: answer("available"),
    authorize: answer("authorized", `resources/${RESOURCE}/original`),
    stored: true,
    center: rows([centerRow()]),
    acknowledge: { kind: "answer", outcome: "acknowledged" },
    ...options,
  };
  const reads = async () => ({
    messages: async (id) => {
      calls.push(["messages", id]);
      return state.messages;
    },
    messaging: async (id) => {
      calls.push(["messaging", id]);
      return state.messaging;
    },
    documents: async (id) => {
      calls.push(["documents", id]);
      return state.documents;
    },
    environmentIdentity: async () => state.environment,
  });
  const writes = async () => ({
    send: async (id, body) => {
      calls.push(["send", id, body]);
      return state.send;
    },
    beginDocument: async (start) => {
      calls.push(["begin", start]);
      return state.begin;
    },
    revoke: async (id) => {
      calls.push(["revoke", id]);
      return state.revoke;
    },
  });
  const resources = async () => ({
    beginVoiceMemo: async () => UNREADABLE,
    beginVerificationArtifact: async () => UNREADABLE,
    finalizeUpload: async (id) => {
      calls.push(["finalize", id]);
      return state.finalize;
    },
    abandonUpload: async (id) => {
      calls.push(["abandon", id]);
      return answer("rejected");
    },
    authorizeAccess: async (id, kind) => {
      calls.push(["authorize", id, kind]);
      return state.authorize;
    },
  });
  const storage = async () => ({
    store: async (id, bytes, type) => {
      calls.push(["store", id, bytes.length, type]);
      return state.stored;
    },
    signedUrl: async (id, disposition) => {
      calls.push(["sign", id, disposition]);
      return `https://storage.synthetic.invalid/${id}?sig=synthetic`;
    },
  });
  const shared = {
    reads,
    writes,
    resources,
    storage,
    digest: async (bytes) => `sha256:${"a".repeat(64)}`,
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
    drain: async () => {
      calls.push(["drain"]);
    },
  };
  const center = {
    reads: async () => ({
      center: async () => {
        calls.push(["center"]);
        return state.center;
      },
    }),
    writes: async () => ({
      acknowledge: async (id) => {
        calls.push(["acknowledge", id]);
        return state.acknowledge;
      },
    }),
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
        rows(
          a === SUBJECT
            ? [{ id: USER, auth_user_id: SUBJECT, account_state: "active" }]
            : [],
        ),
      clientProfilesOf: async (u) =>
        rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
    }),
    writes: async () => ({}),
  };
  const attorneyAccess = {
    session: { currentSubject: async () => state.subject },
    attorney: {
      contextsOf: async () => (state.stage === null ? [] : ["attorney"]),
      principalOf: async () =>
        state.stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage: state.stage },
    },
  };
  return {
    client: Object.freeze({ ...shared, clientIntake }),
    attorney: Object.freeze({ ...shared, ...attorneyAccess }),
    clientCenter: Object.freeze({ ...center, clientIntake }),
    attorneyCenter: Object.freeze({ ...center, ...attorneyAccess }),
    calls,
    state,
  };
}

const form = (fields) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.append(key, value);
  }
  return data;
};

const fileForm = (bytes, consultation = CONSULTATION) => {
  const data = new FormData();
  data.append("consultation", consultation);
  data.append("document", new Blob([bytes]), "anything.pdf");
  return data;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("S10-C1. a participant's communication is read strictly: the messaging status and window end, the thread oldest first and the documents with their grant state; no status row is not found; any unexpected column or value makes the whole answer unavailable; a malformed id calls nothing; the attorney is admitted only through the Security Shell", async () => {
  const w = world({
    messaging: rows([{ status: "closed", closes_at: SENT }]),
    messages: rows([
      messageRow(),
      messageRow({
        message_id: "33333333-3333-4333-8333-333333333334",
        sender_role: "attorney",
        mine: false,
      }),
    ]),
  });
  const view = await resolveClientCommunication(w.client, CONSULTATION);
  assert.equal(view.status, "ready");
  assert.equal(view.messaging, "closed");
  assert.equal(view.closesAt, SENT);
  assert.deepEqual(
    view.messages.map((m) => [m.senderRole, m.mine]),
    [
      ["client", true],
      ["attorney", false],
    ],
  );
  assert.deepEqual(view.documents[0], {
    resourceId: RESOURCE,
    mimeType: "application/pdf",
    byteSize: 2048,
    createdAt: SENT,
    uploadedBy: "client",
    mine: true,
    sharing: "active",
    accessible: true,
    olderNotShown: false,
  });
  assert.equal(view.olderMessagesNotShown, false);
  assert.equal(view.olderDocumentsNotShown, false);
  assert.deepEqual(w.calls, [
    ["messaging", CONSULTATION],
    ["messages", CONSULTATION],
    ["documents", CONSULTATION],
  ]);
  assert.deepEqual(
    await resolveClientCommunication(
      world({ messaging: rows([]) }).client,
      CONSULTATION,
    ),
    { status: "not-found" },
  );
  const malformed = world();
  assert.deepEqual(
    await resolveClientCommunication(malformed.client, "not-an-id"),
    { status: "not-found" },
  );
  assert.deepEqual(malformed.calls, []);
  for (const overrides of [
    { messaging: rows([{ status: "maybe", closes_at: null }]) },
    { messaging: rows([{ status: "open", closes_at: null, extra: 1 }]) },
    { messages: rows([{ ...messageRow(), extra: 1 }]) },
    { messages: rows([messageRow({ sender_role: "staff" })]) },
    { messages: rows([messageRow({ body: "" })]) },
    { messages: rows([messageRow(), messageRow()]) },
    { documents: rows([documentRow({ mime_type: "audio/webm" })]) },
    { documents: rows([documentRow({ byte_size: 1000001 })]) },
    { documents: rows([documentRow({ sharing: "pending" })]) },
    { documents: rows([documentRow({ mine: true, accessible: false })]) },
    { messages: rows([messageRow({ older_not_shown: null })]) },
    { documents: rows([documentRow({ older_not_shown: "yes" })]) },
    {
      messages: rows([(({ older_not_shown, ...row }) => row)(messageRow())]),
    },
    { messages: UNREADABLE },
    { documents: UNREADABLE },
  ]) {
    assert.deepEqual(
      await resolveClientCommunication(world(overrides).client, CONSULTATION),
      { status: "unavailable" },
      JSON.stringify(Object.keys(overrides)),
    );
  }
  assert.equal(
    (await resolveAttorneyCommunication(world().attorney, CONSULTATION)).status,
    "ready",
  );
  const noPrincipal = world({ stage: null });
  const refused = await resolveAttorneyCommunication(
    noPrincipal.attorney,
    CONSULTATION,
  );
  assert.ok(["denied", "sign-in-required"].includes(refused.status));
  assert.deepEqual(noPrincipal.calls, []);
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

test("S10-C2. sending a Message: the body loses its surrounding whitespace and must hold 1 to 20 000 characters (else invalid, nothing sent); the environment is bound first; each of the database's outcomes maps to one fixed state; one bounded worker run follows a sent Message; no recipient is ever chosen here", async () => {
  assert.equal(
    messageBodyOf(form({ body: "  Hello there.\n" })),
    "Hello there.",
  );
  for (const bad of [
    form({}),
    form({ body: "" }),
    form({ body: " \n\t " }),
    form({ body: "x".repeat(20001) }),
  ]) {
    assert.equal(messageBodyOf(bad), null);
  }
  const twice = new FormData();
  twice.append("body", "a");
  twice.append("body", "b");
  assert.equal(messageBodyOf(twice), null);
  const w = world();
  const sent = await sendClientMessage(
    w.client,
    form({ consultation: CONSULTATION, body: "  A question.  " }),
  );
  assert.deepEqual(sent, { status: "outcome", outcome: "message_sent" });
  assert.deepEqual(w.calls, [["send", CONSULTATION, "A question."], ["drain"]]);
  const invalid = world();
  assert.deepEqual(
    await sendClientMessage(
      invalid.client,
      form({ consultation: CONSULTATION, body: "   " }),
    ),
    { status: "invalid", field: "body" },
  );
  assert.deepEqual(invalid.calls, []);
  assert.deepEqual(
    await sendClientMessage(world().client, form({ body: "x" })),
    { status: "outcome", outcome: "not_found" },
  );
  const table = [
    [answer("closed"), { status: "outcome", outcome: "closed" }],
    [
      answer("window_unavailable"),
      { status: "outcome", outcome: "window_unavailable" },
    ],
    [answer("not_found"), { status: "outcome", outcome: "not_found" }],
    [answer("invalid"), { status: "invalid", field: "body" }],
    [answer("denied"), { status: "denied" }],
    [{ kind: "rejected" }, { status: "unavailable" }],
    [UNREADABLE, { status: "unconfirmed" }],
    [answer("surprise"), { status: "unconfirmed" }],
  ];
  for (const [reply, expected] of table) {
    const x = world({ send: reply });
    assert.deepEqual(
      await sendAttorneyMessage(
        x.attorney,
        form({ consultation: CONSULTATION, body: "Answer." }),
      ),
      expected,
    );
    assert.equal(
      x.calls.some(([name]) => name === "drain"),
      false,
    );
  }
  const mismatch = world({ configuredClass: "staging" });
  assert.deepEqual(
    await sendClientMessage(
      mismatch.client,
      form({ consultation: CONSULTATION, body: "Hello." }),
    ),
    { status: "unavailable" },
  );
  assert.equal(
    mismatch.calls.some(([name]) => name === "send"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

test("S10-C3. sharing a document: the file is checked on the server first (one file, not empty, within the ceiling, a PDF, PNG or JPEG recognized from its bytes; else invalid and nothing is sent), then the database starts the upload from the server-measured type, size and digest, the bytes are stored at the resource's own path, the upload is completed (sharing it) and one worker run follows; a failed store or a refused completion marks the resource rejected and shares nothing", async () => {
  const w = world();
  assert.deepEqual(await uploadClientDocument(w.client, fileForm(PDF)), {
    status: "outcome",
    outcome: "document_shared",
  });
  assert.deepEqual(w.calls, [
    [
      "begin",
      {
        consultationId: CONSULTATION,
        mimeType: "application/pdf",
        byteSize: PDF.length,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
    ["store", RESOURCE, PDF.length, "application/pdf"],
    ["finalize", RESOURCE],
    ["drain"],
  ]);
  for (const data of [
    form({ consultation: CONSULTATION }),
    fileForm(new Uint8Array()),
    fileForm(TEXT),
    fileForm(new Uint8Array(1_000_001).fill(0x25)),
  ]) {
    const x = world();
    assert.deepEqual(await uploadClientDocument(x.client, data), {
      status: "invalid",
      field: "document",
    });
    assert.deepEqual(x.calls, []);
  }
  const failedStore = world({ stored: false });
  assert.deepEqual(
    await uploadClientDocument(failedStore.client, fileForm(PDF)),
    { status: "outcome", outcome: "upload_failed" },
  );
  assert.deepEqual(
    failedStore.calls.map(([name]) => name),
    ["begin", "store", "abandon"],
  );
  const closedLate = world({ finalize: answer("not_editable") });
  assert.deepEqual(
    await uploadClientDocument(closedLate.client, fileForm(PDF)),
    { status: "outcome", outcome: "closed" },
  );
  assert.deepEqual(
    closedLate.calls.map(([name]) => name),
    ["begin", "store", "finalize", "abandon"],
  );
  for (const [reply, expected] of [
    [answer("closed"), { status: "outcome", outcome: "closed" }],
    [
      answer("window_unavailable"),
      { status: "outcome", outcome: "window_unavailable" },
    ],
    // No upload count limit exists: an answer outside the database's fixed
    // outcomes is never reported as one.
    [answer("rate_limited"), { status: "unconfirmed" }],
    [answer("not_found"), { status: "outcome", outcome: "not_found" }],
    [answer("denied"), { status: "denied" }],
    [UNREADABLE, { status: "unconfirmed" }],
  ]) {
    const x = world({ begin: reply });
    assert.deepEqual(
      await uploadClientDocument(x.client, fileForm(PDF)),
      expected,
    );
    assert.equal(
      x.calls.some(([name]) => name === "store"),
      false,
    );
  }
});

test("S10-C4. revoking and opening: the uploader's revocation maps the database's outcomes; opening asks the database to authorize exactly this document for the caller and only then signs its own path as a download, valid for the S3 lifetime; a refusal is not found, a hold is held, a pending one not available, and anything unexpected unavailable", async () => {
  const w = world();
  assert.deepEqual(
    await revokeClientDocument(w.client, form({ resource: RESOURCE })),
    { status: "outcome", outcome: "sharing_revoked" },
  );
  assert.deepEqual(w.calls, [["revoke", RESOURCE]]);
  assert.deepEqual(
    await revokeClientDocument(
      world({ revoke: answer("already_revoked") }).client,
      form({ resource: RESOURCE }),
    ),
    { status: "outcome", outcome: "already_revoked" },
  );
  assert.deepEqual(
    await revokeClientDocument(world().client, form({ resource: "x" })),
    { status: "outcome", outcome: "not_found" },
  );
  const opened = world();
  const download = await openClientDocument(
    opened.client,
    form({ resource: RESOURCE }),
  );
  assert.equal(download.status, "download");
  assert.equal(download.expiresInSeconds, 60);
  assert.deepEqual(opened.calls, [
    ["authorize", RESOURCE, "document"],
    ["sign", RESOURCE, "attachment"],
  ]);
  for (const [reply, expected] of [
    [answer("refused"), { status: "outcome", outcome: "not_found" }],
    [answer("held"), { status: "outcome", outcome: "held" }],
    [answer("not_available"), { status: "outcome", outcome: "not_available" }],
    [
      answer("authorized", "resources/other/original"),
      { status: "unavailable" },
    ],
    [UNREADABLE, { status: "unavailable" }],
  ]) {
    const x = world({ authorize: reply });
    assert.deepEqual(
      await openAttorneyDocument(x.attorney, form({ resource: RESOURCE })),
      expected,
    );
    assert.equal(
      x.calls.some(([name]) => name === "sign"),
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// The notification center
// ---------------------------------------------------------------------------

test("S10-C5. the notification center reads the caller's own in-app Notifications strictly (type, state, flags, time, a link only to the caller's own Request or Consultation page, the email twin's state) and acknowledges one through the database; a malformed id is not found without a call; anything unexpected is unavailable", async () => {
  const w = world({
    center: rows([
      centerRow({ critical: true, ack_required: true }),
      centerRow({
        notification_id: "55555555-5555-4555-8555-555555555556",
        notification_type: "request_accepted",
        link_path: `/client/requests/${CONSULTATION}`,
        email_state: null,
        state: "acknowledged",
        ack_required: true,
      }),
    ]),
  });
  const view = await resolveClientNotifications(w.clientCenter);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.entries.map((e) => [
      e.type,
      e.state,
      e.critical,
      e.acknowledgementRequired,
      e.linkPath,
      e.emailState,
    ]),
    [
      [
        "message_received",
        "delivered",
        true,
        true,
        `/client/consultations/${CONSULTATION}`,
        "pending",
      ],
      [
        "request_accepted",
        "acknowledged",
        false,
        true,
        `/client/requests/${CONSULTATION}`,
        null,
      ],
    ],
  );
  for (const bad of [
    centerRow({ notification_type: "synthetic" }),
    centerRow({ state: "pending" }),
    centerRow({ state: "acknowledged", ack_required: false }),
    centerRow({ link_path: "https://elsewhere.invalid/" }),
    centerRow({ link_path: "/staff/finance" }),
    centerRow({ email_state: "bounced" }),
    { ...centerRow(), address: "x" },
  ]) {
    assert.deepEqual(
      await resolveClientNotifications(
        world({ center: rows([bad]) }).clientCenter,
      ),
      { status: "unavailable" },
    );
  }
  assert.equal(
    (await resolveAttorneyNotifications(world().attorneyCenter)).status,
    "ready",
  );
  const acknowledged = world();
  assert.deepEqual(
    await acknowledgeClientNotification(
      acknowledged.clientCenter,
      form({ notification: NOTIFICATION }),
    ),
    { status: "outcome", outcome: "acknowledged" },
  );
  assert.deepEqual(acknowledged.calls, [["acknowledge", NOTIFICATION]]);
  for (const [reply, expected] of [
    [
      { kind: "answer", outcome: "already_acknowledged" },
      { status: "outcome", outcome: "already_acknowledged" },
    ],
    [
      { kind: "answer", outcome: "not_required" },
      { status: "outcome", outcome: "not_required" },
    ],
    [{ kind: "rejected" }, { status: "unavailable" }],
    [{ kind: "unreadable" }, { status: "unconfirmed" }],
    [{ kind: "answer", outcome: "surprise" }, { status: "unconfirmed" }],
  ]) {
    assert.deepEqual(
      await acknowledgeAttorneyNotification(
        world({ acknowledge: reply }).attorneyCenter,
        form({ notification: NOTIFICATION }),
      ),
      expected,
    );
  }
  const malformed = world();
  assert.deepEqual(
    await acknowledgeClientNotification(
      malformed.clientCenter,
      form({ notification: "not-an-id" }),
    ),
    { status: "outcome", outcome: "not_found" },
  );
  assert.deepEqual(malformed.calls, []);
});

// ---------------------------------------------------------------------------
// Labels and source contracts
// ---------------------------------------------------------------------------

test("S10-C6. the labels: one fixed message for every communication outcome and every notification type and email state; no email provider, address or recommendation wording", () => {
  for (const outcome of COMMUNICATION_OUTCOMES) {
    const message = labels.COMMUNICATION_OUTCOME_MESSAGES[outcome];
    assert.ok(message.title && message.body, outcome);
  }
  for (const type of NOTIFICATION_TYPES) {
    assert.ok(labels.NOTIFICATION_LABELS[type], type);
  }
  // No upload count limit, so no such outcome or label.
  assert.equal(COMMUNICATION_OUTCOMES.includes("rate_limited"), false);
  assert.equal("rate_limited" in labels.COMMUNICATION_OUTCOME_MESSAGES, false);
  assert.equal(labels.OLDER_MESSAGES_NOTE, "Older messages are not shown.");
  assert.equal(labels.OLDER_DOCUMENTS_NOTE, "Older documents are not shown.");
  const source = codeOf(read("src/presentation/communication-labels.ts"));
  assert.doesNotMatch(
    source,
    /resend|svix|sendgrid|postmark|@[a-z0-9-]+\.[a-z]|best attorney|recommended|guarantee/i,
  );
  assert.equal(
    labels.messagingNote("open", null, (t) => t),
    null,
  );
  assert.equal(
    labels.messagingNote("closed", null, (t) => t),
    "This conversation is closed. You can still read it.",
  );
});

test("S10-C8. truncation is never silent: when the database answers that older Messages or documents exist beyond the newest it returns (the same flag on every row), the view says so and both consultation pages show the fixed note; mixed flags are not the database's answer", async () => {
  const older = world({
    messages: rows([
      messageRow({ older_not_shown: true }),
      messageRow({
        message_id: "33333333-3333-4333-8333-333333333334",
        older_not_shown: true,
      }),
    ]),
    documents: rows([documentRow({ older_not_shown: true })]),
  });
  const view = await resolveClientCommunication(older.client, CONSULTATION);
  assert.equal(view.status, "ready");
  assert.equal(view.olderMessagesNotShown, true);
  assert.equal(view.olderDocumentsNotShown, true);
  const attorneyView = await resolveAttorneyCommunication(
    older.attorney,
    CONSULTATION,
  );
  assert.equal(attorneyView.olderMessagesNotShown, true);
  const mixed = world({
    messages: rows([
      messageRow({ older_not_shown: true }),
      messageRow({
        message_id: "33333333-3333-4333-8333-333333333334",
        older_not_shown: false,
      }),
    ]),
  });
  assert.deepEqual(
    await resolveClientCommunication(mixed.client, CONSULTATION),
    { status: "unavailable" },
  );
  // The exact columns of consultation_messages and consultation_documents
  // (the S10 database proof pins the same lists on the database side).
  assert.deepEqual(
    [...MESSAGE_COLUMNS],
    ["message_id", "sender_role", "mine", "body", "sent_at", "older_not_shown"],
  );
  assert.deepEqual(
    [...DOCUMENT_COLUMNS],
    [
      "resource_id",
      "mime_type",
      "byte_size",
      "created_at",
      "uploaded_by",
      "mine",
      "sharing",
      "accessible",
      "older_not_shown",
    ],
  );
  const empty = world({ messages: rows([]), documents: rows([]) });
  const emptyView = await resolveClientCommunication(
    empty.client,
    CONSULTATION,
  );
  assert.equal(emptyView.olderMessagesNotShown, false);
  assert.equal(emptyView.olderDocumentsNotShown, false);
  for (const page of [
    "app/client/consultations/[consultation]/page.tsx",
    "app/attorney/consultations/[consultation]/page.tsx",
  ]) {
    const code = codeOf(read(page));
    assert.match(
      code,
      /\{view\.olderMessagesNotShown \? \(\s*<Text tone="muted">\{OLDER_MESSAGES_NOTE\}<\/Text>\s*\) : null\}/,
      page,
    );
    assert.match(
      code,
      /\{view\.olderDocumentsNotShown \? \(\s*<Text tone="muted">\{OLDER_DOCUMENTS_NOTE\}<\/Text>\s*\) : null\}/,
      page,
    );
  }
});

test("S10-C7. source contracts: the new pages are server pages that opt out of prerendering (the attorney center behind the step-up gate), every client form module reaches no infrastructure, the communication adapter is the only module calling the S10 participant functions and uses no privileged client, and the provider-neutral boundary holds: only the notifications infrastructure modules name the email provider or its webhook scheme", () => {
  for (const file of [
    "app/client/notifications/page.tsx",
    "app/attorney/notifications/page.tsx",
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.includes("  await connection();\n"), file);
    assert.doesNotMatch(
      code,
      /createClient\b|ADMIN_KEY|service_role|registration-provisioning|\.from\(|\.rpc\(|process\.env|dangerouslySetInnerHTML/,
      file,
    );
  }
  assert.ok(
    codeOf(read("app/attorney/notifications/page.tsx")).includes(
      '  await connection();\n  await requireSteppedUp("attorney");\n',
    ),
  );
  for (const file of [
    "app/client/notifications/forms.tsx",
    "app/attorney/notifications/forms.tsx",
    "app/client/consultations/[consultation]/forms.tsx",
    "app/attorney/consultations/[consultation]/forms.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /^"use client";\n/, file);
    assert.ok(
      importsOf(source).every((s) => !/infrastructure/.test(s)),
      file,
    );
  }
  const adapter = codeOf(
    read("src/infrastructure/communications/communication-adapter.ts"),
  );
  assert.doesNotMatch(
    adapter,
    /\badmin\b|createClient\b|adminKey|ADMIN_KEY|service_role|registration-provisioning|\.from\(/,
  );
  const sources = [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
    /\.tsx?$/.test(f),
  );
  const providerModules = [
    "src/infrastructure/notifications/notification-jobs.ts",
    "src/infrastructure/notifications/resend-provider.ts",
    "src/infrastructure/notifications/resend-webhook.ts",
  ];
  for (const file of sources) {
    const code = codeOf(read(file));
    // The webhook route names its own path and its adapter module only.
    if (file === "app/api/notifications/resend/route.ts") {
      assert.deepEqual(importsOf(read(file)), [
        "../../../../src/infrastructure/notifications/resend-webhook.ts",
      ]);
      continue;
    }
    if (!providerModules.includes(file)) {
      // (Supabase's own auth.resend confirmation call is not the email
      // provider.)
      assert.doesNotMatch(
        code,
        /api\.resend\.com|resend-provider|resend-webhook|RESEND_PROVIDER_CODE|svix|ROSUNO_EMAIL_FROM|ROSUNO_RESEND|"resend"/i,
        file,
      );
    }
  }
  assert.deepEqual(
    filesIn("src/infrastructure/notifications/"),
    providerModules,
  );
  // The provider-neutral application modules name no provider at all.
  for (const file of [
    "src/application/notifications.ts",
    "src/application/notification-center.ts",
    "src/application/consultation-communication.ts",
  ]) {
    assert.doesNotMatch(read(file), /resend|svix/i, file);
  }
  // The adapter reads its settings through the configuration reader only.
  const provider = codeOf(
    read("src/infrastructure/notifications/resend-provider.ts"),
  );
  assert.doesNotMatch(
    provider,
    /process\.env\.ROSUNO|\bconsole\b|logRequestEvent/,
  );
  assert.equal(provider.match(/"ROSUNO_RESEND_API_KEY"/g).length, 1);
  assert.equal(provider.match(/"ROSUNO_RESEND_WEBHOOK_SECRET"/g).length, 1);
  assert.equal(provider.match(/"ROSUNO_EMAIL_FROM"/g).length, 1);
  // No provider SDK.
  for (const file of sources) {
    for (const specifier of importsOf(read(file))) {
      assert.doesNotMatch(specifier, /^[^.].*(?:resend|svix)/i, file);
    }
  }
});
