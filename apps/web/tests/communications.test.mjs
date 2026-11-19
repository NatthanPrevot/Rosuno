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
  replaceAttorneyDocument,
  replaceClientDocument,
  resolveAttorneyCommunication,
  resolveAttorneyDocumentHistory,
  resolveClientCommunication,
  resolveClientDocumentHistory,
  VERSION_COLUMNS,
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
const DOCUMENT = "66666666-6666-4666-8666-666666666666";
const documentRow = (overrides = {}) => ({
  resource_id: RESOURCE,
  document_id: DOCUMENT,
  lineage_id: DOCUMENT,
  version_label: "v1",
  mime_type: "application/pdf",
  byte_size: 2048,
  created_at: SENT,
  uploaded_by: "client",
  mine: true,
  sharing: "active",
  accessible: true,
  earlier_versions_shared: false,
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
    versions: rows([]),
    beginReplacement: answer("created", RESOURCE),
    finalizeReplacement: answer("available"),
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
    versions: async (consultation, document) => {
      calls.push(["versions", consultation, document]);
      return state.versions;
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
    beginReplacement: async (start) => {
      calls.push(["beginReplacement", start]);
      return state.beginReplacement;
    },
    finalizeReplacement: async (consultation, resource, document) => {
      calls.push(["finalizeReplacement", consultation, resource, document]);
      return state.finalizeReplacement;
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
    documentId: DOCUMENT,
    lineageId: DOCUMENT,
    versionLabel: "v1",
    mimeType: "application/pdf",
    byteSize: 2048,
    createdAt: SENT,
    uploadedBy: "client",
    mine: true,
    sharing: "active",
    accessible: true,
    earlierShared: false,
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
    { documents: rows([documentRow({ version_label: "2" })]) },
    { documents: rows([documentRow({ version_label: "v0" })]) },
    { documents: rows([documentRow({ document_id: "not-an-id" })]) },
    // A v1 has no earlier version that could still be shared.
    { documents: rows([documentRow({ earlier_versions_shared: true })]) },
    { documents: rows([documentRow({ earlier_versions_shared: null })]) },
    // A v1 is its own lineage; a later version never is.
    { documents: rows([documentRow({ lineage_id: RESOURCE })]) },
    { documents: rows([documentRow({ version_label: "v2" })]) },
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
  // PS-A5: sharing is per version, and the wording says so.
  assert.equal(labels.OLDER_VERSIONS_NOTE, "Older versions are not shown.");
  assert.equal(labels.REVOKE_LABEL, "Stop sharing this version");
  assert.equal(
    labels.DOCUMENTS_NOTE,
    "A document you add here is shared only with the other participant of this consultation. Sharing is per version: each version you add is shared on its own, and stopping sharing of one version leaves the other versions as they are.",
  );
  assert.equal(
    labels.REPLACE_FIELD_HINT,
    "The new version will be shared with the other participant. The earlier version stays as it is, available to whoever could open it. A PDF, PNG, or JPEG of at most 1 MB.",
  );
  assert.deepEqual(
    [
      labels.currentSharingLabel("active", true, false),
      labels.currentSharingLabel("revoked", true, false),
      labels.currentSharingLabel("revoked", true, true),
      labels.currentSharingLabel("active", true, true),
      labels.currentSharingLabel("revoked", false, true),
      labels.currentSharingLabel("active", false, false),
    ],
    [
      "Shared",
      "Sharing stopped",
      "Sharing stopped. An earlier version is still shared with the other participant.",
      "Shared. An earlier version is still shared with the other participant.",
      "No longer shared with you. An earlier version is still shared with you.",
      "Shared",
    ],
  );
  assert.equal(
    labels.COMMUNICATION_OUTCOME_MESSAGES.sharing_revoked.body,
    "The other participant can no longer open this version. Other versions of the document are not affected.",
  );
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
      "document_id",
      "lineage_id",
      "version_label",
      "mime_type",
      "byte_size",
      "created_at",
      "uploaded_by",
      "mine",
      "sharing",
      "accessible",
      "earlier_versions_shared",
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

const replaceForm = (bytes, fields = {}) => {
  const data = new FormData();
  data.append("consultation", fields.consultation ?? CONSULTATION);
  data.append("document", fields.document ?? DOCUMENT);
  data.append(fields.field ?? "replacement", new Blob([bytes]), "anything.pdf");
  return data;
};

test("S10-C9. replacing a document (PS-A5): the new version's file is checked on the server first (one file, not empty, within the ceiling, a PDF, PNG or JPEG recognized from its bytes), then the database starts the replacement of the named Document from the server-measured type, size and digest, the bytes are stored at the new resource's own path and the replacement is completed, and one worker run follows; a lost race is already superseded, a closed window closed, an earlier version not current; anything but completion marks the upload rejected; the label is never sent", async () => {
  const w = world();
  assert.deepEqual(await replaceClientDocument(w.client, replaceForm(PDF)), {
    status: "outcome",
    outcome: "document_replaced",
  });
  assert.deepEqual(w.calls, [
    [
      "beginReplacement",
      {
        consultationId: CONSULTATION,
        documentId: DOCUMENT,
        mimeType: "application/pdf",
        byteSize: PDF.length,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
    ["store", RESOURCE, PDF.length, "application/pdf"],
    ["finalizeReplacement", CONSULTATION, RESOURCE, DOCUMENT],
    ["drain"],
  ]);
  const attorney = world();
  assert.deepEqual(
    await replaceAttorneyDocument(attorney.attorney, replaceForm(PDF)),
    { status: "outcome", outcome: "document_replaced" },
  );
  for (const [finalize, expected] of [
    [
      answer("already_superseded"),
      { status: "outcome", outcome: "already_superseded" },
    ],
    [answer("not_editable"), { status: "outcome", outcome: "closed" }],
    [answer("not_stored"), { status: "outcome", outcome: "upload_failed" }],
    [answer("denied"), { status: "denied" }],
    [UNREADABLE, { status: "unconfirmed" }],
  ]) {
    const x = world({ finalizeReplacement: finalize });
    assert.deepEqual(
      await replaceClientDocument(x.client, replaceForm(PDF)),
      expected,
    );
    assert.deepEqual(
      x.calls.map(([name]) => name),
      ["beginReplacement", "store", "finalizeReplacement", "abandon"],
    );
  }
  for (const [begin, expected] of [
    [answer("not_current"), { status: "outcome", outcome: "not_current" }],
    [answer("closed"), { status: "outcome", outcome: "closed" }],
    [
      answer("window_unavailable"),
      { status: "outcome", outcome: "window_unavailable" },
    ],
    [answer("not_found"), { status: "outcome", outcome: "not_found" }],
    [answer("invalid"), { status: "invalid", field: "replacement" }],
    [answer("denied"), { status: "denied" }],
    [answer("already_superseded"), { status: "unconfirmed" }],
    [UNREADABLE, { status: "unconfirmed" }],
  ]) {
    const x = world({ beginReplacement: begin });
    assert.deepEqual(
      await replaceClientDocument(x.client, replaceForm(PDF)),
      expected,
    );
    assert.deepEqual(
      x.calls.map(([name]) => name),
      ["beginReplacement"],
    );
  }
  const failedStore = world({ stored: false });
  assert.deepEqual(
    await replaceClientDocument(failedStore.client, replaceForm(PDF)),
    { status: "outcome", outcome: "upload_failed" },
  );
  assert.deepEqual(
    failedStore.calls.map(([name]) => name),
    ["beginReplacement", "store", "abandon"],
  );
  for (const [form, expected] of [
    [
      replaceForm(PDF, { document: "not-an-id" }),
      { status: "outcome", outcome: "not_found" },
    ],
    [
      replaceForm(PDF, { consultation: "x" }),
      { status: "outcome", outcome: "not_found" },
    ],
    [replaceForm(TEXT), { status: "invalid", field: "replacement" }],
    [
      replaceForm(new Uint8Array()),
      { status: "invalid", field: "replacement" },
    ],
    [
      replaceForm(PDF, { field: "document_file" }),
      { status: "invalid", field: "replacement" },
    ],
  ]) {
    const x = world();
    assert.deepEqual(await replaceClientDocument(x.client, form), expected);
    assert.deepEqual(x.calls, []);
  }
  const code = codeOf(read("src/application/consultation-communication.ts"));
  assert.doesNotMatch(code, /version_label\s*:|versionLabel\s*:\s*["'`]/);
});

const versionRow = (overrides = {}) => ({
  document_id: DOCUMENT,
  resource_id: RESOURCE,
  version_label: "v2",
  mime_type: "application/pdf",
  byte_size: 3072,
  created_at: SENT,
  uploaded_by: "client",
  mine: false,
  is_current: true,
  sharing: "active",
  accessible: true,
  older_versions_not_shown: false,
  ...overrides,
});
const EARLIER = "77777777-7777-4777-8777-777777777777";
const EARLIER_RESOURCE = "88888888-8888-4888-8888-888888888888";

test("S10-C10. a document's version history (PS-A5) is read strictly for the caller, one document at a time: each version's label, type, size, time, uploader role, whether it is current, its grant state and whether the caller may open it; no row is not found; any unexpected column or value, two current versions or an answer without the asked document is unavailable; a malformed id calls nothing; both consultation pages show the history only on request (?history=), open buttons only where the database said so, and the replacement form only to the uploader while communication is open", async () => {
  assert.deepEqual([...VERSION_COLUMNS], Object.keys(versionRow()));
  const history = rows([
    versionRow({
      document_id: EARLIER,
      resource_id: EARLIER_RESOURCE,
      version_label: "v1",
      is_current: false,
      sharing: "revoked",
      accessible: false,
    }),
    versionRow(),
  ]);
  const w = world({ versions: history });
  const view = await resolveClientDocumentHistory(
    w.client,
    CONSULTATION,
    DOCUMENT,
  );
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.versions.map((v) => [
      v.versionLabel,
      v.current,
      v.sharing,
      v.accessible,
      v.mine,
    ]),
    [
      ["v1", false, "revoked", false, false],
      ["v2", true, "active", true, false],
    ],
  );
  assert.deepEqual(w.calls, [["versions", CONSULTATION, DOCUMENT]]);
  const attorney = world({ versions: history });
  assert.equal(
    (
      await resolveAttorneyDocumentHistory(
        attorney.attorney,
        CONSULTATION,
        DOCUMENT,
      )
    ).status,
    "ready",
  );
  assert.deepEqual(
    await resolveClientDocumentHistory(
      world({ versions: rows([]) }).client,
      CONSULTATION,
      DOCUMENT,
    ),
    { status: "not-found" },
  );
  const malformed = world({ versions: history });
  assert.deepEqual(
    await resolveClientDocumentHistory(
      malformed.client,
      CONSULTATION,
      "not-an-id",
    ),
    { status: "not-found" },
  );
  assert.deepEqual(malformed.calls, []);
  // The newest versions only: the flag on every row, and the asked (older)
  // version may then be absent; the view says so instead of failing.
  const bounded = await resolveClientDocumentHistory(
    world({
      versions: rows([
        versionRow({
          document_id: EARLIER,
          resource_id: EARLIER_RESOURCE,
          version_label: "v501",
          is_current: false,
          older_versions_not_shown: true,
        }),
        versionRow({ version_label: "v502", older_versions_not_shown: true }),
      ]),
    }).client,
    CONSULTATION,
    "99999999-9999-4999-8999-999999999990",
  );
  assert.equal(bounded.status, "ready");
  assert.equal(bounded.olderNotShown, true);
  assert.equal(view.olderNotShown, false);
  for (const versions of [
    UNREADABLE,
    rows([versionRow({ older_versions_not_shown: null })]),
    rows([
      versionRow({
        document_id: EARLIER,
        resource_id: EARLIER_RESOURCE,
        version_label: "v1",
        is_current: false,
        older_versions_not_shown: true,
      }),
      versionRow(),
    ]),
    rows([{ ...versionRow(), extra: 1 }]),
    rows([versionRow({ version_label: "2" })]),
    rows([versionRow({ sharing: "pending" })]),
    rows([versionRow({ mine: true, accessible: false })]),
    rows([versionRow({ is_current: "yes" })]),
    rows([versionRow({ document_id: EARLIER, resource_id: EARLIER_RESOURCE })]),
    rows([
      versionRow(),
      versionRow({ document_id: EARLIER, resource_id: EARLIER_RESOURCE }),
    ]),
  ]) {
    assert.deepEqual(
      await resolveClientDocumentHistory(
        world({ versions }).client,
        CONSULTATION,
        DOCUMENT,
      ),
      { status: "unavailable" },
      JSON.stringify(versions).slice(0, 80),
    );
  }
  for (const page of [
    "app/client/consultations/[consultation]/page.tsx",
    "app/attorney/consultations/[consultation]/page.tsx",
  ]) {
    const code = codeOf(read(page));
    assert.match(
      code,
      /const historyId = typeof history === "string" \? history : null;/,
      page,
    );
    assert.match(
      code,
      /historyId === null\s*\? null\s*: await resolve(?:Client|Attorney)DocumentHistory\(/,
      page,
    );
    assert.match(
      code,
      /\{open && document\.mine \? \(\s*<DocumentReplace/,
      page,
    );
    assert.match(code, /openable=\{version\.accessible\}/, page);
    assert.match(
      code,
      /revocable=\{version\.mine && version\.sharing === "active"\}/,
      page,
    );
    assert.match(code, /\?history=\$\{document\.documentId\}/, page);
    assert.match(code, /document\.versionLabel === "v1" \? null/, page);
    // Rows keep their identity (and a replacement's message) across versions.
    assert.match(code, /<tr key=\{document\.lineageId\}>/, page);
    assert.match(
      code,
      /\{history\.olderNotShown \? \(\s*<Text tone="muted">\{OLDER_VERSIONS_NOTE\}<\/Text>\s*\) : null\}/,
      page,
    );
    assert.match(
      code,
      /currentSharingLabel\(\s*document\.sharing,\s*document\.mine,\s*document\.earlierShared,\s*\)/,
      page,
    );
  }
  for (const forms of [
    "app/client/consultations/[consultation]/forms.tsx",
    "app/attorney/consultations/[consultation]/forms.tsx",
  ]) {
    const code = codeOf(read(forms));
    assert.match(code, /export function DocumentReplace\(/, forms);
    assert.match(code, /name="replacement"/, forms);
    assert.match(
      code,
      /<input type="hidden" name="document" value=\{documentId\} \/>/,
      forms,
    );
    assert.doesNotMatch(code, /version_label|versionLabel/, forms);
  }
  for (const label of [
    labels.REPLACE_LABEL,
    labels.HISTORY_HEADING,
    labels.HISTORY_UNAVAILABLE,
    labels.VERSION_COLUMN,
  ]) {
    assert.ok(typeof label === "string" && label.length > 0);
  }
  assert.equal(labels.versionSharingLabel(null, true), "Not shared");
  assert.equal(
    labels.versionSharingLabel("revoked", false),
    "No longer shared with you",
  );
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
