// The client's and the attorney's Consultation workspaces: the waiting room,
// the media room and the attorney's start and end (MVP-001 S9; MBS section
// 14; IMP section 25; TA sections 16.2, 46 and 48; DM section 2.4; Packet
// section 2 rules 7 and 13).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every action: a
// client through the verified client of the request (the client intake
// sources), an attorney through the unchanged Security Shell over the trusted
// session and the trusted attorney principal source. The database decides
// everything again: the Consultation's own participants, aal2 for the
// attorney, the permitted window, the Media Room, the start's preconditions,
// the configured capture and every consequence. Reads are strict (an
// unexpected column or value makes the whole answer unavailable, never partly
// shown) and only the database's fixed outcomes are reported. Before an
// action the environment binding is checked (PS-A2 section 6; Packet rule 7),
// and an unrecorded or mismatched environment refuses. The browser never
// decides a time: the state, the window and whether joining, starting or
// ending is offered come from the server, which decides again on submission.
//
// After a start or an end, one bounded worker run follows, so the provider
// room's expiry update or its deletion (which ejects every participant: TA
// section 46) usually happens at once.
//
// Joining (TA section 46): the database authorizes media access for the
// participant (one Consultation, one role, one window) and answers the
// provider room name and the token's not-before and expiry; only then does
// the server ask the media provider for one meeting token with exactly those
// facts and the role label as the name, and answer the prebuilt room's
// address for the frame. The token is never stored, logged or audited; it
// travels only in this action's answer. A reconnect joins again: the same
// Consultation, the same Media Room. While the provider room is still being
// created, one bounded worker run is made and the database is asked once
// more.

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
} from "./attorney-access.ts";
import {
  CONSULTATION_STATES,
  type ConsultationState,
} from "./attorney-requests.ts";
import { verifiedClientOf, type ClientIntakeSources } from "./client-intake.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import { readFormFields } from "./form-operation.ts";
import {
  isRosunoRoomName,
  MEDIA_ROOM_STATES,
  type MediaProvider,
  type MediaRoomState,
  type ParticipantRole,
} from "./media-provider.ts";
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
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

export { CONSULTATION_STATES, type ConsultationState };

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

export const VIEW_COLUMNS = Object.freeze([
  "consultation_id",
  "state",
  "ready_due",
  "request_path",
  "modality",
  "duration_minutes",
  "booking_starts_at",
  "booking_ends_at",
  "opens_at",
  "closes_at",
  "started_at",
  "ended_at",
  "outcome_code",
  "media_state",
  "attorney_joined_at",
  "attorney_left_at",
  "client_joined_at",
  "client_left_at",
  "both_present",
  "either_left",
  "provider_sessions",
  "reconnections",
]);

export const LIST_COLUMNS = Object.freeze([
  "consultation_id",
  "state",
  "ready_due",
  "request_path",
  "modality",
  "duration_minutes",
  "booking_starts_at",
  "booking_ends_at",
  "opens_at",
  "closes_at",
  "started_at",
]);

// The database's own fixed outcomes.
export const ACCESS_OUTCOMES = Object.freeze([
  "granted",
  "waiting",
  "preparing",
  "not_open_yet",
  "ended",
  "configuration_unavailable",
  "not_found",
  "denied",
]);
export const START_OUTCOMES = Object.freeze([
  "started",
  "invalid",
  "denied",
  "not_found",
  "ended",
  "already_started",
  "not_ready",
  "configuration_unavailable",
  "not_open_yet",
  "window_passed",
  "attorney_in_consultation",
  "payment_not_ready",
  "not_eligible",
  "eligibility_unavailable",
  "conflict",
]);
export const END_OUTCOMES = Object.freeze([
  "completed",
  "invalid",
  "denied",
  "not_found",
  "not_started",
  "ended",
  "configuration_unavailable",
  "conflict",
]);

// The most Consultations the attorney's list holds (the database's own
// bound).
export const MAX_CONSULTATIONS = 200;

const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;

// One media access answer of the database.
export type MediaGrant = {
  readonly roomName: string;
  readonly role: ParticipantRole;
  readonly userId: string;
  readonly notBefore: string;
  readonly expiresAt: string;
};

export type AccessAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly grant: MediaGrant | null;
      readonly opensAt: string | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type CommandAnswer =
  | { readonly kind: "answer"; readonly outcome: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

// Request-scoped, unprivileged reads through the database's own functions.
export type ConsultationReads = {
  // client_consultation(p_consultation_id)
  readonly client: (consultationId: string) => Promise<RowsResult>;
  // attorney_consultation(p_consultation_id)
  readonly attorney: (consultationId: string) => Promise<RowsResult>;
  // attorney_consultations()
  readonly attorneyList: () => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

// Request-scoped write port: each call is one database function run for the
// request's own authenticated session. None takes an actor, User or profile.
export type ConsultationWrites = {
  readonly access: (consultationId: string) => Promise<AccessAnswer>;
  readonly start: (consultationId: string) => Promise<CommandAnswer>;
  readonly end: (consultationId: string) => Promise<CommandAnswer>;
};

// The server-only media side of joining: the provider's meeting tokens and
// the prebuilt room's address on the configured domain. Null when media is
// not configured.
export type MediaJoin = {
  readonly provider: Pick<MediaProvider, "createMeetingToken">;
  readonly frameUrl: (roomName: string, token: string) => string;
};

type SharedSources = {
  readonly reads: () => Promise<ConsultationReads | null>;
  readonly writes: () => Promise<ConsultationWrites | null>;
  // The server-side environment setting compared with the database's own
  // record before an action (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
  readonly media: () => Promise<MediaJoin | null>;
  // One bounded worker run (the provider room's creation job).
  readonly drain: () => Promise<void>;
  readonly clock: () => number;
};

export type ClientConsultationSources = SharedSources & {
  readonly clientIntake: ClientIntakeSources;
};

export type AttorneyConsultationSources = SharedSources & {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type ConsultationEntry = {
  readonly id: string;
  readonly state: ConsultationState;
  // The database's own flag: a scheduled Consultation whose window has
  // opened (the next command records ready).
  readonly readyDue: boolean;
  readonly path: "instant" | "scheduled";
  readonly modality: string;
  readonly durationMinutes: number | null;
  readonly bookingStart: string | null;
  readonly bookingEnd: string | null;
  // The permitted window, null without the timing configuration.
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly startedAt: string | null;
};

export type ConsultationDetail = ConsultationEntry & {
  readonly endedAt: string | null;
  readonly outcomeCode: string | null;
  readonly mediaState: MediaRoomState | null;
  readonly attorneyJoinedAt: string | null;
  readonly attorneyLeftAt: string | null;
  readonly clientJoinedAt: string | null;
  readonly clientLeftAt: string | null;
  readonly bothPresent: boolean;
  readonly eitherLeft: boolean;
  readonly providerSessions: number;
  readonly reconnections: number;
};

// What a participant sees: ready as soon as the server reports the window
// open, even before the transition is recorded.
export type DisplayState = ConsultationState;

const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 10000;

function entryOf(
  fields: ReadonlyMap<string, unknown>,
): ConsultationEntry | null {
  const id = fields.get("consultation_id");
  const state = fields.get("state");
  const readyDue = fields.get("ready_due");
  const path = fields.get("request_path");
  const modality = fields.get("modality");
  const duration = fields.get("duration_minutes");
  const bookingStart = fields.get("booking_starts_at");
  const bookingEnd = fields.get("booking_ends_at");
  const opensAt = fields.get("opens_at");
  const closesAt = fields.get("closes_at");
  const startedAt = fields.get("started_at");
  if (
    !isUuid(id) ||
    !isOneOf(CONSULTATION_STATES, state) ||
    typeof readyDue !== "boolean" ||
    (readyDue && state !== "scheduled") ||
    (path !== "instant" && path !== "scheduled") ||
    typeof modality !== "string" ||
    !MODALITY.test(modality) ||
    !(
      duration === null ||
      (Number.isSafeInteger(duration) &&
        (duration as number) >= 1 &&
        (duration as number) <= 1440)
    ) ||
    !nullableTime(bookingStart) ||
    !nullableTime(bookingEnd) ||
    (bookingStart === null) !== (bookingEnd === null) ||
    (bookingStart !== null && path !== "scheduled") ||
    !nullableTime(opensAt) ||
    !nullableTime(closesAt) ||
    (opensAt === null) !== (closesAt === null) ||
    !nullableTime(startedAt)
  ) {
    return null;
  }
  return {
    id,
    state,
    readyDue,
    path,
    modality,
    durationMinutes: duration as number | null,
    bookingStart,
    bookingEnd,
    opensAt,
    closesAt,
    startedAt,
  };
}

function readEntry(row: unknown): ConsultationEntry | null {
  const fields = readExact(row, LIST_COLUMNS);
  const entry = fields === null ? null : entryOf(fields);
  return entry === null ? null : Object.freeze(entry);
}

function readDetail(row: unknown): ConsultationDetail | null {
  const fields = readExact(row, VIEW_COLUMNS);
  if (fields === null) {
    return null;
  }
  const entry = entryOf(fields);
  const endedAt = fields.get("ended_at");
  const outcomeCode = fields.get("outcome_code");
  const mediaState = fields.get("media_state");
  const times = [
    "attorney_joined_at",
    "attorney_left_at",
    "client_joined_at",
    "client_left_at",
  ].map((key) => fields.get(key));
  const bothPresent = fields.get("both_present");
  const eitherLeft = fields.get("either_left");
  const sessions = fields.get("provider_sessions");
  const reconnections = fields.get("reconnections");
  if (
    entry === null ||
    !nullableTime(endedAt) ||
    !(
      outcomeCode === null ||
      (typeof outcomeCode === "string" && CODE.test(outcomeCode))
    ) ||
    !(mediaState === null || isOneOf(MEDIA_ROOM_STATES, mediaState)) ||
    !times.every(nullableTime) ||
    typeof bothPresent !== "boolean" ||
    typeof eitherLeft !== "boolean" ||
    !isCount(sessions) ||
    !isCount(reconnections) ||
    (entry.startedAt === null && entry.state === "live") ||
    (outcomeCode !== null &&
      !["completed", "cancelled", "no_show", "technical_failure"].includes(
        entry.state,
      ))
  ) {
    return null;
  }
  const [attorneyJoinedAt, attorneyLeftAt, clientJoinedAt, clientLeftAt] =
    times as (string | null)[];
  return Object.freeze({
    ...entry,
    endedAt,
    outcomeCode,
    mediaState: mediaState as MediaRoomState | null,
    attorneyJoinedAt,
    attorneyLeftAt,
    clientJoinedAt,
    clientLeftAt,
    bothPresent,
    eitherLeft,
    providerSessions: sessions,
    reconnections,
  });
}

export function displayStateOf(entry: ConsultationEntry): DisplayState {
  return entry.readyDue ? "ready" : entry.state;
}

// Whether the server reports the window open now (the database decides again
// when joining or starting).
export function windowOpen(entry: ConsultationEntry, now: number): boolean {
  return (
    entry.opensAt !== null &&
    entry.closesAt !== null &&
    Date.parse(entry.opensAt) <= now &&
    now < Date.parse(entry.closesAt)
  );
}

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);
const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

export type ConsultationView =
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly consultation: ConsultationDetail;
      readonly displayState: DisplayState;
      // The room can be joined only once the attorney has started (live);
      // while the Consultation is ready inside its window both participants
      // are in the waiting room (the database grants nothing before the start).
      readonly joinable: boolean;
      readonly waiting: boolean;
      readonly windowPassed: boolean;
      readonly startable: boolean;
      readonly endable: boolean;
    };

export type ConsultationListView =
  | {
      readonly status: "ready";
      readonly entries: readonly ConsultationEntry[];
    }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

type Admission =
  "granted" | typeof SIGN_IN_REQUIRED | typeof DENIED | typeof UNAVAILABLE;

async function admittedClient(
  sources: Pick<ClientConsultationSources, "clientIntake">,
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
  sources: Pick<AttorneyConsultationSources, "session" | "attorney">,
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

async function detailView(
  reads: ConsultationReads | null,
  read: (reads: ConsultationReads) => Promise<RowsResult>,
  consultationId: string,
  role: ParticipantRole,
  now: number,
): Promise<ConsultationView> {
  if (reads === null) {
    return UNAVAILABLE;
  }
  const rows = rowsOf(await attempt(() => read(reads)));
  if (rows === null || rows.length > 1) {
    return UNAVAILABLE;
  }
  if (rows.length === 0) {
    return NOT_FOUND;
  }
  const consultation = readDetail(rows[0]);
  if (consultation === null || consultation.id !== consultationId) {
    return UNAVAILABLE;
  }
  const displayState = displayStateOf(consultation);
  const open = windowOpen(consultation, now);
  const roomUsable =
    consultation.mediaState !== "closing" &&
    consultation.mediaState !== "closed";
  return Object.freeze({
    status: "ready",
    consultation,
    displayState,
    joinable: displayState === "live" && open && roomUsable,
    waiting: displayState === "ready" && open,
    windowPassed:
      consultation.closesAt !== null &&
      now >= Date.parse(consultation.closesAt),
    startable: role === "attorney" && displayState === "ready" && open,
    endable: role === "attorney" && consultation.state === "live",
  });
}

// One of the client's own Consultations. Another client's, an unknown and a
// malformed id answer alike: not found. It never throws.
export async function resolveClientConsultation(
  sources: Pick<ClientConsultationSources, "clientIntake" | "reads" | "clock">,
  consultationId: unknown,
): Promise<ConsultationView> {
  try {
    if (!isUuid(consultationId)) {
      return NOT_FOUND;
    }
    const access = await admittedClient(sources);
    if (access !== "granted") {
      return access;
    }
    return await detailView(
      await portFrom(sources.reads),
      (reads) => reads.client(consultationId),
      consultationId,
      "client",
      sources.clock(),
    );
  } catch {
    return UNAVAILABLE;
  }
}

// One of the attorney's own Consultations. It never throws.
export async function resolveAttorneyConsultation(
  sources: Pick<
    AttorneyConsultationSources,
    "session" | "attorney" | "reads" | "clock"
  >,
  consultationId: unknown,
): Promise<ConsultationView> {
  try {
    if (!isUuid(consultationId)) {
      return NOT_FOUND;
    }
    const access = await admittedAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    return await detailView(
      await portFrom(sources.reads),
      (reads) => reads.attorney(consultationId),
      consultationId,
      "attorney",
      sources.clock(),
    );
  } catch {
    return UNAVAILABLE;
  }
}

// The attorney's scheduled, ready and live Consultations. It never throws.
export async function resolveAttorneyConsultations(
  sources: Pick<AttorneyConsultationSources, "session" | "attorney" | "reads">,
): Promise<ConsultationListView> {
  try {
    const access = await admittedAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.attorneyList()));
    if (rows === null || rows.length > MAX_CONSULTATIONS) {
      return UNAVAILABLE;
    }
    const entries = readRows(rows, readEntry);
    if (
      entries === null ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      entries.some(
        (entry) => !["scheduled", "ready", "live"].includes(entry.state),
      )
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", entries });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Actions (server actions)
// ---------------------------------------------------------------------------

export const JOIN_OUTCOMES = Object.freeze([
  "waiting",
  "preparing",
  "not_open_yet",
  "ended",
  "configuration_unavailable",
  "media_unavailable",
  "not_found",
] as const);
export type JoinOutcome = (typeof JOIN_OUTCOMES)[number];

export type JoinActionState =
  | { readonly status: "idle" }
  | {
      readonly status: "granted";
      // The prebuilt room's address with the participant's meeting token.
      readonly frameUrl: string;
      readonly expiresAt: string;
    }
  | { readonly status: "outcome"; readonly outcome: JoinOutcome }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_JOIN_STATE: JoinActionState = Object.freeze({
  status: "idle",
});

export const COMMAND_OUTCOMES = Object.freeze([
  "consultation_started",
  "consultation_completed",
  "not_found",
  "ended",
  "already_started",
  "not_ready",
  "not_started",
  "configuration_unavailable",
  "not_open_yet",
  "window_passed",
  "attorney_in_consultation",
  "payment_not_ready",
  "not_eligible",
  "eligibility_unavailable",
  "conflict",
] as const);
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

export type CommandActionState =
  | { readonly status: "idle" }
  | { readonly status: "outcome"; readonly outcome: CommandOutcome }
  | { readonly status: "invalid" }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_COMMAND_STATE: CommandActionState = Object.freeze({
  status: "idle",
});

const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);
const INVALID = Object.freeze({ status: "invalid" } as const);

const joinOutcome = (outcome: JoinOutcome): JoinActionState =>
  Object.freeze({ status: "outcome", outcome });
const commandOutcome = (outcome: CommandOutcome): CommandActionState =>
  Object.freeze({ status: "outcome", outcome });

// The one Consultation an action concerns, from the submitted form: exactly
// one identifier, or null.
export function consultationOfForm(formData: FormData): string | null {
  const value = readFormFields(formData).get("consultation");
  return isUuid(value) && formData.getAll("consultation").length === 1
    ? value
    : null;
}

async function boundEnvironment(sources: SharedSources): Promise<{
  readonly reads: ConsultationReads;
  readonly writes: ConsultationWrites;
} | null> {
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

const epochSeconds = (timestamp: string) =>
  Math.floor(Date.parse(timestamp) / 1000);

async function join(
  sources: SharedSources,
  admit: () => Promise<Admission>,
  role: ParticipantRole,
  formData: FormData,
): Promise<JoinActionState> {
  try {
    const consultationId = consultationOfForm(formData);
    if (consultationId === null) {
      return joinOutcome("not_found");
    }
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const media = await portFrom(sources.media);
    if (media === null) {
      return joinOutcome("media_unavailable");
    }
    const ports = await boundEnvironment(sources);
    if (ports === null) {
      return UNAVAILABLE;
    }
    let answer = (await attempt(() => ports.writes.access(consultationId))) as
      AccessAnswer | undefined;
    if (answer?.kind === "answer" && answer.outcome === "preparing") {
      try {
        await sources.drain();
      } catch {
        // The creation job stays pending until the next worker run.
      }
      answer = (await attempt(() => ports.writes.access(consultationId))) as
        AccessAnswer | undefined;
    }
    if (answer?.kind === "rejected") {
      return UNAVAILABLE;
    }
    if (answer?.kind !== "answer") {
      return UNCONFIRMED;
    }
    switch (answer.outcome) {
      case "granted": {
        const grant = answer.grant;
        if (
          grant === null ||
          grant.role !== role ||
          !isRosunoRoomName(grant.roomName)
        ) {
          return UNCONFIRMED;
        }
        const token = await media.provider.createMeetingToken({
          roomName: grant.roomName,
          userId: grant.userId,
          role,
          notBefore: epochSeconds(grant.notBefore),
          expiresAt: epochSeconds(grant.expiresAt),
        });
        if (token.kind !== "ok") {
          return joinOutcome("media_unavailable");
        }
        return Object.freeze({
          status: "granted",
          frameUrl: media.frameUrl(grant.roomName, token.value),
          expiresAt: grant.expiresAt,
        });
      }
      case "waiting":
      case "preparing":
      case "not_open_yet":
      case "ended":
      case "configuration_unavailable":
      case "not_found":
        return joinOutcome(answer.outcome);
      case "denied":
        return DENIED;
      default:
        return UNCONFIRMED;
    }
  } catch {
    return UNAVAILABLE;
  }
}

export async function joinClientConsultation(
  sources: ClientConsultationSources,
  formData: FormData,
): Promise<JoinActionState> {
  return join(sources, () => admittedClient(sources), "client", formData);
}

export async function joinAttorneyConsultation(
  sources: AttorneyConsultationSources,
  formData: FormData,
): Promise<JoinActionState> {
  return join(sources, () => admittedAttorney(sources), "attorney", formData);
}

const START_TABLE: Readonly<Record<string, CommandActionState>> = Object.freeze(
  {
    started: commandOutcome("consultation_started"),
    invalid: INVALID,
    not_found: commandOutcome("not_found"),
    ended: commandOutcome("ended"),
    already_started: commandOutcome("already_started"),
    not_ready: commandOutcome("not_ready"),
    configuration_unavailable: commandOutcome("configuration_unavailable"),
    not_open_yet: commandOutcome("not_open_yet"),
    window_passed: commandOutcome("window_passed"),
    attorney_in_consultation: commandOutcome("attorney_in_consultation"),
    payment_not_ready: commandOutcome("payment_not_ready"),
    not_eligible: commandOutcome("not_eligible"),
    eligibility_unavailable: commandOutcome("eligibility_unavailable"),
    conflict: commandOutcome("conflict"),
  },
);

const END_TABLE: Readonly<Record<string, CommandActionState>> = Object.freeze({
  completed: commandOutcome("consultation_completed"),
  invalid: INVALID,
  not_found: commandOutcome("not_found"),
  not_started: commandOutcome("not_started"),
  ended: commandOutcome("ended"),
  configuration_unavailable: commandOutcome("configuration_unavailable"),
  conflict: commandOutcome("conflict"),
});

// Maps one answer through the command's own table. "denied" is always a
// refusal; a database rejection inside the call committed nothing; anything
// unknown is unconfirmed.
function settle(
  answer: unknown,
  table: Readonly<Record<string, CommandActionState>>,
): CommandActionState {
  const fields = readExact(answer, ["kind", "outcome"]);
  if (fields?.get("kind") === "answer") {
    const outcome = fields.get("outcome");
    if (outcome === "denied") {
      return DENIED;
    }
    if (typeof outcome === "string" && Object.hasOwn(table, outcome)) {
      return table[outcome];
    }
    return UNCONFIRMED;
  }
  return readExact(answer, ["kind"])?.get("kind") === "rejected"
    ? UNAVAILABLE
    : UNCONFIRMED;
}

async function command(
  sources: AttorneyConsultationSources,
  formData: FormData,
  call: (
    writes: ConsultationWrites,
    consultationId: string,
  ) => Promise<CommandAnswer>,
  table: Readonly<Record<string, CommandActionState>>,
): Promise<CommandActionState> {
  try {
    const consultationId = consultationOfForm(formData);
    if (consultationId === null) {
      return commandOutcome("not_found");
    }
    const access = await admittedAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    const ports = await boundEnvironment(sources);
    if (ports === null) {
      return UNAVAILABLE;
    }
    const state = settle(
      await attempt(() => call(ports.writes, consultationId)),
      table,
    );
    if (
      state.status === "outcome" &&
      (state.outcome === "consultation_started" ||
        state.outcome === "consultation_completed")
    ) {
      // The room's expiry update (after a start) or its deletion, which ejects
      // every participant (after an end), usually follows at once; nothing
      // depends on it (the worker route drains the backlog later).
      try {
        await sources.drain();
      } catch {
        // The job stays pending until the next worker run.
      }
    }
    return state;
  } catch {
    return UNAVAILABLE;
  }
}

export async function startConsultation(
  sources: AttorneyConsultationSources,
  formData: FormData,
): Promise<CommandActionState> {
  return command(
    sources,
    formData,
    (writes, id) => writes.start(id),
    START_TABLE,
  );
}

export async function endConsultation(
  sources: AttorneyConsultationSources,
  formData: FormData,
): Promise<CommandActionState> {
  return command(sources, formData, (writes, id) => writes.end(id), END_TABLE);
}

export function clientConsultationPathFor(consultationId: string): string {
  if (!isUuid(consultationId)) {
    throw new Error("not a consultation identifier");
  }
  return `/client/consultations/${consultationId}`;
}

export function attorneyConsultationPathFor(consultationId: string): string {
  if (!isUuid(consultationId)) {
    throw new Error("not a consultation identifier");
  }
  return `/attorney/consultations/${consultationId}`;
}
