// The participants' communication inside one Consultation: Messages and
// shared documents (MVP-001 S10; MBS section 15 deliverables 12A and 12B; IMP
// section 26; TA section 57; MB sections 51 to 54; MB-A1 section 1).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every action: a
// client through the verified client of the request (the client intake
// sources), an attorney through the unchanged Security Shell over the trusted
// session and the trusted attorney principal source. The database decides
// everything again: that the caller is the Consultation's own client or its
// attorney at aal2, the recipient (always the other participant, never
// chosen here), whether communication is still open (while the Consultation
// is not terminal, and after completion only inside the configured window,
// which is never assumed), the grant of each shared document, its access,
// Legal Holds and every audit event. Reads are strict (an unexpected column
// or value makes the whole answer unavailable, never partly shown) and only
// the database's fixed outcomes are reported. Before a change the
// environment binding is checked (PS-A2 section 6; Packet rule 7).
//
// Messages: the body loses its surrounding whitespace and must then hold 1 to
// 20 000 characters (the fixed technical ceiling of client free text, PS-A1);
// it is shown back only to the Consultation's participants and never logged.
//
// Documents (TA section 57): the file's bytes are received on the server
// first, within the S3 byte ceiling, its type recognized from the bytes
// themselves (PDF, PNG or JPEG; never a browser-reported type or name, and no
// file name is kept), its SHA-256 digest computed; the database then starts a
// pending resource at its own opaque path, the bytes are stored there through
// the server-only storage port and the upload is completed, which shares the
// document with the other participant through one grant. A failed store or
// an unknown completion marks the resource rejected, so nothing is ever
// disclosed that was not stored and confirmed. Opening a document asks the
// database to authorize the exact resource for the caller and only then signs
// its own path for the S3 lifetime (a download link). The uploader may revoke
// the grant; the database refuses every later access by the recipient.
//
// After a Message or a shared document, one bounded worker run follows, so
// the recipient's email Notification usually goes out at once (nothing
// depends on it).

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
} from "./attorney-access.ts";
import { verifiedClientOf, type ClientIntakeSources } from "./client-intake.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import { readFormFields } from "./form-operation.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import {
  ARTIFACT_TYPES,
  artifactTypeOf,
  bytesOf,
  digestOf,
  RESOURCE_BYTE_CEILING,
  resourceOutcomeOf,
  signedAccess,
  SIGNED_URL_SECONDS,
  storeAndComplete,
  uploadFieldOf,
  type ArtifactType,
  type ContentDigest,
  type ProtectedStorage,
  type ResourceAnswer,
  type ResourceCalls,
} from "./protected-resources.ts";
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

export const MESSAGE_MAX_CHARACTERS = 20_000;
// The database's own bounds of one thread and one document list.
export const MAX_MESSAGES = 500;
export const MAX_DOCUMENTS = 200;

export const PARTICIPANT_ROLES = Object.freeze(["client", "attorney"] as const);
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const MESSAGING_STATUSES = Object.freeze([
  "open",
  "closed",
  "window_unavailable",
] as const);
export type MessagingStatus = (typeof MESSAGING_STATUSES)[number];

export const MESSAGE_COLUMNS = Object.freeze([
  "message_id",
  "sender_role",
  "mine",
  "body",
  "sent_at",
  "older_not_shown",
]);
export const MESSAGING_COLUMNS = Object.freeze(["status", "closes_at"]);
export const DOCUMENT_COLUMNS = Object.freeze([
  "resource_id",
  "mime_type",
  "byte_size",
  "created_at",
  "uploaded_by",
  "mine",
  "sharing",
  "accessible",
  "older_not_shown",
]);

// The database's own fixed outcomes.
export const SEND_OUTCOMES = Object.freeze([
  "sent",
  "invalid",
  "not_found",
  "denied",
  "closed",
  "window_unavailable",
] as const);
export const BEGIN_DOCUMENT_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "not_found",
  "denied",
  "closed",
  "window_unavailable",
] as const);
export const REVOKE_OUTCOMES = Object.freeze([
  "revoked",
  "already_revoked",
  "not_found",
  "denied",
] as const);

export type DocumentStart = {
  readonly consultationId: string;
  readonly mimeType: ArtifactType;
  readonly byteSize: number;
  readonly contentDigest: string;
};

// Request-scoped, unprivileged reads through the database's own functions.
export type CommunicationReads = {
  // consultation_messages(p_consultation_id)
  readonly messages: (consultationId: string) => Promise<RowsResult>;
  // consultation_messaging(p_consultation_id)
  readonly messaging: (consultationId: string) => Promise<RowsResult>;
  // consultation_documents(p_consultation_id)
  readonly documents: (consultationId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

// Request-scoped write port: each call is one database function run for the
// request's own authenticated session. None takes an actor, recipient, path
// or bucket; the database derives them itself.
export type CommunicationWrites = {
  // message_send(p_consultation_id, p_body): outcome and message id.
  readonly send: (
    consultationId: string,
    body: string,
  ) => Promise<ResourceAnswer>;
  // document_begin_upload(...): outcome and resource id.
  readonly beginDocument: (start: DocumentStart) => Promise<ResourceAnswer>;
  // document_revoke_sharing(p_resource_id): outcome.
  readonly revoke: (resourceId: string) => Promise<ResourceAnswer>;
};

type SharedSources = {
  readonly reads: () => Promise<CommunicationReads | null>;
  readonly writes: () => Promise<CommunicationWrites | null>;
  // The S3 resource functions (completion, abandonment and access).
  readonly resources: () => Promise<ResourceCalls | null>;
  readonly storage: () => Promise<ProtectedStorage | null>;
  readonly digest: ContentDigest;
  // The server-side environment setting compared with the database's own
  // record before a change (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
  // One bounded worker run (the recipient's email Notification).
  readonly drain: () => Promise<void>;
};

export type ClientCommunicationSources = SharedSources & {
  readonly clientIntake: ClientIntakeSources;
};

export type AttorneyCommunicationSources = SharedSources & {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type ThreadMessage = {
  readonly id: string;
  readonly senderRole: ParticipantRole;
  readonly mine: boolean;
  readonly body: string;
  readonly sentAt: string;
  // Whether older Messages exist that the answer does not show.
  readonly olderNotShown: boolean;
};

export type SharedDocument = {
  readonly resourceId: string;
  readonly mimeType: ArtifactType;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly uploadedBy: ParticipantRole;
  readonly mine: boolean;
  readonly sharing: "active" | "revoked";
  readonly accessible: boolean;
  // Whether older documents exist that the answer does not show.
  readonly olderNotShown: boolean;
};

export type CommunicationView =
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly messaging: MessagingStatus;
      // The window's end once it is known (after completion).
      readonly closesAt: string | null;
      readonly messages: readonly ThreadMessage[];
      readonly documents: readonly SharedDocument[];
      // Older Messages or documents exist that are not shown (the database
      // answers the newest 500 Messages and 200 documents).
      readonly olderMessagesNotShown: boolean;
      readonly olderDocumentsNotShown: boolean;
    };

function readMessage(row: unknown): ThreadMessage | null {
  const fields = readExact(row, MESSAGE_COLUMNS);
  if (fields === null) {
    return null;
  }
  const id = fields.get("message_id");
  const role = fields.get("sender_role");
  const mine = fields.get("mine");
  const body = fields.get("body");
  const sentAt = fields.get("sent_at");
  const olderNotShown = fields.get("older_not_shown");
  if (
    !isUuid(id) ||
    !isOneOf(PARTICIPANT_ROLES, role) ||
    typeof mine !== "boolean" ||
    typeof body !== "string" ||
    body.length < 1 ||
    body.length > MESSAGE_MAX_CHARACTERS * 2 ||
    !isTimestamp(sentAt) ||
    typeof olderNotShown !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    id,
    senderRole: role,
    mine,
    body,
    sentAt,
    olderNotShown,
  });
}

function readDocument(row: unknown): SharedDocument | null {
  const fields = readExact(row, DOCUMENT_COLUMNS);
  if (fields === null) {
    return null;
  }
  const id = fields.get("resource_id");
  const mime = fields.get("mime_type");
  const size = fields.get("byte_size");
  const createdAt = fields.get("created_at");
  const uploadedBy = fields.get("uploaded_by");
  const mine = fields.get("mine");
  const sharing = fields.get("sharing");
  const accessible = fields.get("accessible");
  const olderNotShown = fields.get("older_not_shown");
  if (
    !isUuid(id) ||
    !isOneOf(ARTIFACT_TYPES, mime) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > RESOURCE_BYTE_CEILING ||
    !isTimestamp(createdAt) ||
    !isOneOf(PARTICIPANT_ROLES, uploadedBy) ||
    typeof mine !== "boolean" ||
    (sharing !== "active" && sharing !== "revoked") ||
    typeof accessible !== "boolean" ||
    (mine && !accessible) ||
    typeof olderNotShown !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    resourceId: id,
    mimeType: mime,
    byteSize: size as number,
    createdAt,
    uploadedBy,
    mine,
    sharing,
    accessible,
    olderNotShown,
  });
}

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);
const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

type Admission =
  "granted" | typeof SIGN_IN_REQUIRED | typeof DENIED | typeof UNAVAILABLE;

async function admittedClient(
  sources: Pick<ClientCommunicationSources, "clientIntake">,
): Promise<Admission> {
  const client = await verifiedClientOf(sources.clientIntake);
  if ("clientId" in client) {
    return "granted";
  }
  return client.status === "sign-in-required"
    ? SIGN_IN_REQUIRED
    : client.status === "denied"
      ? DENIED
      : UNAVAILABLE;
}

async function admittedAttorney(
  sources: Pick<AttorneyCommunicationSources, "session" | "attorney">,
): Promise<Admission> {
  const access = await resolveAttorneyWorkspaceAccess({
    session: sources.session,
    attorney: sources.attorney,
  });
  if (access.status === "sign-in-required") {
    return SIGN_IN_REQUIRED;
  }
  if (access.status === "denied") {
    return DENIED;
  }
  return access.status === "granted" ? "granted" : UNAVAILABLE;
}

async function communicationView(
  reads: CommunicationReads | null,
  consultationId: string,
): Promise<CommunicationView> {
  if (reads === null) {
    return UNAVAILABLE;
  }
  const status = rowsOf(await attempt(() => reads.messaging(consultationId)));
  if (status === null || status.length > 1) {
    return UNAVAILABLE;
  }
  if (status.length === 0) {
    return NOT_FOUND;
  }
  const statusFields = readExact(status[0], MESSAGING_COLUMNS);
  const messaging = statusFields?.get("status");
  const closesAt = statusFields?.get("closes_at");
  if (
    !isOneOf(MESSAGING_STATUSES, messaging) ||
    !(closesAt === null || isTimestamp(closesAt))
  ) {
    return UNAVAILABLE;
  }
  const messageRows = rowsOf(
    await attempt(() => reads.messages(consultationId)),
  );
  const documentRows = rowsOf(
    await attempt(() => reads.documents(consultationId)),
  );
  if (
    messageRows === null ||
    documentRows === null ||
    messageRows.length > MAX_MESSAGES ||
    documentRows.length > MAX_DOCUMENTS
  ) {
    return UNAVAILABLE;
  }
  const messages = readRows(messageRows, readMessage);
  const documents = readRows(documentRows, readDocument);
  // Every row carries the same flag; anything else is not the database's
  // answer.
  const sameFlag = (rows: readonly { readonly olderNotShown: boolean }[]) =>
    rows.every((row) => row.olderNotShown === rows[0]?.olderNotShown);
  if (
    messages === null ||
    documents === null ||
    new Set(messages.map((m) => m.id)).size !== messages.length ||
    new Set(documents.map((d) => d.resourceId)).size !== documents.length ||
    !sameFlag(messages) ||
    !sameFlag(documents)
  ) {
    return UNAVAILABLE;
  }
  return Object.freeze({
    status: "ready",
    messaging,
    closesAt: closesAt as string | null,
    messages,
    documents,
    olderMessagesNotShown: messages[0]?.olderNotShown === true,
    olderDocumentsNotShown: documents[0]?.olderNotShown === true,
  });
}

// The client's communication in one of their Consultations. Another
// client's, an unknown and a malformed id answer alike: not found. It never
// throws.
export async function resolveClientCommunication(
  sources: Pick<ClientCommunicationSources, "clientIntake" | "reads">,
  consultationId: unknown,
): Promise<CommunicationView> {
  try {
    if (!isUuid(consultationId)) {
      return NOT_FOUND;
    }
    const access = await admittedClient(sources);
    if (access !== "granted") {
      return access;
    }
    return await communicationView(
      await portFrom(sources.reads),
      consultationId,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// The attorney's communication in one of their Consultations. It never
// throws.
export async function resolveAttorneyCommunication(
  sources: Pick<AttorneyCommunicationSources, "session" | "attorney" | "reads">,
  consultationId: unknown,
): Promise<CommunicationView> {
  try {
    if (!isUuid(consultationId)) {
      return NOT_FOUND;
    }
    const access = await admittedAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    return await communicationView(
      await portFrom(sources.reads),
      consultationId,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Actions (server actions)
// ---------------------------------------------------------------------------

export const COMMUNICATION_OUTCOMES = Object.freeze([
  "message_sent",
  "document_shared",
  "sharing_revoked",
  "already_revoked",
  "closed",
  "window_unavailable",
  "not_found",
  "not_available",
  "held",
  "upload_failed",
] as const);
export type CommunicationOutcome = (typeof COMMUNICATION_OUTCOMES)[number];

export type CommunicationActionState =
  | { readonly status: "idle" }
  | { readonly status: "outcome"; readonly outcome: CommunicationOutcome }
  | {
      readonly status: "invalid";
      readonly field: "body" | "document";
    }
  | {
      readonly status: "download";
      readonly url: string;
      readonly expiresInSeconds: number;
    }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_COMMUNICATION_STATE: CommunicationActionState =
  Object.freeze({ status: "idle" });

const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);
const outcome = (value: CommunicationOutcome): CommunicationActionState =>
  Object.freeze({ status: "outcome", outcome: value });
const invalid = (field: "body" | "document"): CommunicationActionState =>
  Object.freeze({ status: "invalid", field });

// The one identifier a form names under a field: exactly one value, or null.
function identifierOf(formData: FormData, name: string): string | null {
  const value = readFormFields(formData).get(name);
  return isUuid(value) && formData.getAll(name).length === 1 ? value : null;
}

// The Message text of the form: without surrounding whitespace, 1 to 20 000
// characters, exactly one value; otherwise null.
export function messageBodyOf(formData: FormData): string | null {
  const values = formData.getAll("body");
  if (values.length !== 1 || typeof values[0] !== "string") {
    return null;
  }
  const body = values[0].replace(/^\s+|\s+$/g, "");
  return body.length >= 1 && body.length <= MESSAGE_MAX_CHARACTERS
    ? body
    : null;
}

type Ports = {
  readonly reads: CommunicationReads;
  readonly writes: CommunicationWrites;
};

async function boundEnvironment(sources: SharedSources): Promise<Ports | null> {
  const reads = await portFrom(sources.reads);
  const writes = await portFrom(sources.writes);
  if (reads === null || writes === null) {
    return null;
  }
  const binding = bindEnvironment(
    rowsOf(await attempt(() => reads.environmentIdentity())),
    sources.environment(),
  );
  return binding === "unrecorded" || binding === "mismatch"
    ? null
    : { reads, writes };
}

async function drainAfter(sources: SharedSources): Promise<void> {
  try {
    await sources.drain();
  } catch {
    // The delivery job stays pending until the next worker run.
  }
}

type Admit = () => Promise<Admission>;

async function send(
  sources: SharedSources,
  admit: Admit,
  formData: FormData,
): Promise<CommunicationActionState> {
  try {
    const consultationId = identifierOf(formData, "consultation");
    if (consultationId === null) {
      return outcome("not_found");
    }
    const body = messageBodyOf(formData);
    if (body === null) {
      return invalid("body");
    }
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const ports = await boundEnvironment(sources);
    if (ports === null) {
      return UNAVAILABLE;
    }
    const answer = resourceOutcomeOf(
      await attempt(() => ports.writes.send(consultationId, body)),
      SEND_OUTCOMES,
    );
    if (answer === "rejected") {
      return UNAVAILABLE;
    }
    if (answer === "unknown") {
      return UNCONFIRMED;
    }
    switch (answer.outcome) {
      case "sent":
        await drainAfter(sources);
        return outcome("message_sent");
      case "invalid":
        return invalid("body");
      case "closed":
      case "window_unavailable":
      case "not_found":
        return outcome(answer.outcome);
      case "denied":
        return DENIED;
      default:
        return UNCONFIRMED;
    }
  } catch {
    return UNAVAILABLE;
  }
}

async function upload(
  sources: SharedSources,
  admit: Admit,
  formData: FormData,
): Promise<CommunicationActionState> {
  try {
    const consultationId = identifierOf(formData, "consultation");
    if (consultationId === null) {
      return outcome("not_found");
    }
    const field = uploadFieldOf(formData, "document");
    if (field.kind !== "file") {
      return invalid("document");
    }
    const bytes = await bytesOf(field.file);
    if (bytes === "empty" || bytes === "too-large") {
      return invalid("document");
    }
    const type = artifactTypeOf(bytes);
    if (type === null) {
      return invalid("document");
    }
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const contentDigest = await digestOf(sources.digest, bytes);
    if (contentDigest === null) {
      return UNAVAILABLE;
    }
    const ports = await boundEnvironment(sources);
    const calls = await portFrom(sources.resources);
    if (ports === null || calls === null) {
      return UNAVAILABLE;
    }
    const begun = resourceOutcomeOf(
      await attempt(() =>
        ports.writes.beginDocument({
          consultationId,
          mimeType: type,
          byteSize: bytes.length,
          contentDigest,
        }),
      ),
      BEGIN_DOCUMENT_OUTCOMES,
    );
    if (begun === "rejected") {
      return UNAVAILABLE;
    }
    if (begun === "unknown") {
      return UNCONFIRMED;
    }
    switch (begun.outcome) {
      case "created":
        break;
      case "invalid":
        return invalid("document");
      case "closed":
      case "window_unavailable":
      case "not_found":
        return outcome(begun.outcome);
      case "denied":
        return DENIED;
      default:
        return UNCONFIRMED;
    }
    if (!isUuid(begun.value)) {
      return UNCONFIRMED;
    }
    const storage = await portFrom(sources.storage);
    const completion = await storeAndComplete(
      calls,
      storage,
      begun.value,
      bytes,
      type,
    );
    if (completion === "available") {
      await drainAfter(sources);
      return outcome("document_shared");
    }
    if (completion === "not_editable") {
      return outcome("closed");
    }
    if (completion === "denied") {
      return DENIED;
    }
    return completion === "unknown" ? UNCONFIRMED : outcome("upload_failed");
  } catch {
    return UNAVAILABLE;
  }
}

async function revoke(
  sources: SharedSources,
  admit: Admit,
  formData: FormData,
): Promise<CommunicationActionState> {
  try {
    const resourceId = identifierOf(formData, "resource");
    if (resourceId === null) {
      return outcome("not_found");
    }
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const ports = await boundEnvironment(sources);
    if (ports === null) {
      return UNAVAILABLE;
    }
    const answer = resourceOutcomeOf(
      await attempt(() => ports.writes.revoke(resourceId)),
      REVOKE_OUTCOMES,
    );
    if (answer === "rejected") {
      return UNAVAILABLE;
    }
    if (answer === "unknown") {
      return UNCONFIRMED;
    }
    switch (answer.outcome) {
      case "revoked":
        return outcome("sharing_revoked");
      case "already_revoked":
      case "not_found":
        return outcome(answer.outcome);
      case "denied":
        return DENIED;
      default:
        return UNCONFIRMED;
    }
  } catch {
    return UNAVAILABLE;
  }
}

async function open(
  sources: SharedSources,
  admit: Admit,
  formData: FormData,
): Promise<CommunicationActionState> {
  try {
    const resourceId = identifierOf(formData, "resource");
    if (resourceId === null) {
      return outcome("not_found");
    }
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const calls = await portFrom(sources.resources);
    if (calls === null) {
      return UNAVAILABLE;
    }
    const signed = await signedAccess(
      calls,
      sources.storage,
      resourceId,
      "document",
      "attachment",
    );
    switch (signed.kind) {
      case "url":
        return Object.freeze({
          status: "download",
          url: signed.url,
          expiresInSeconds: SIGNED_URL_SECONDS,
        });
      case "not-available":
        return outcome("not_available");
      case "held":
        return outcome("held");
      case "refused":
        return outcome("not_found");
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

export const sendClientMessage = (
  sources: ClientCommunicationSources,
  formData: FormData,
) => send(sources, () => admittedClient(sources), formData);
export const sendAttorneyMessage = (
  sources: AttorneyCommunicationSources,
  formData: FormData,
) => send(sources, () => admittedAttorney(sources), formData);
export const uploadClientDocument = (
  sources: ClientCommunicationSources,
  formData: FormData,
) => upload(sources, () => admittedClient(sources), formData);
export const uploadAttorneyDocument = (
  sources: AttorneyCommunicationSources,
  formData: FormData,
) => upload(sources, () => admittedAttorney(sources), formData);
export const revokeClientDocument = (
  sources: ClientCommunicationSources,
  formData: FormData,
) => revoke(sources, () => admittedClient(sources), formData);
export const revokeAttorneyDocument = (
  sources: AttorneyCommunicationSources,
  formData: FormData,
) => revoke(sources, () => admittedAttorney(sources), formData);
export const openClientDocument = (
  sources: ClientCommunicationSources,
  formData: FormData,
) => open(sources, () => admittedClient(sources), formData);
export const openAttorneyDocument = (
  sources: AttorneyCommunicationSources,
  formData: FormData,
) => open(sources, () => admittedAttorney(sources), formData);
