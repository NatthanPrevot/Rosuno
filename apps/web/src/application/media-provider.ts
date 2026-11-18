// The media provider boundary in the application (MVP-001 S9; MBS section 14;
// TA sections 16.2, 46, 53 and 66; PS sections 18 and 38; Packet section 2
// rule 12).
//
// Provider-neutral and injectable. Rosuno speaks of its own Media Room (one
// per Consultation) and of observations in its own vocabulary; a provider
// adapter translates them into provider calls and back. Replacing the
// provider touches only the adapter and its configuration (TA section 66).
// The provider never decides anything: the database owns the Consultation,
// the Media Room's state, provider session correlation, participation
// evidence and every disagreement (a Reconciliation Exception).
//
// This module holds:
// - the provider port (room creation, update, deletion and reading; meeting
//   tokens; presence and meeting reads), each answering one of a fixed set of
//   neutral results;
// - the observation vocabulary the database records (its
//   media_observation_valid vocabulary) and the mapping of provider reads to
//   one meetings_observed observation;
// - the recording port (the server-only privileged worker and webhook calls:
//   the job context, a provider call's result, a provider event);
// - the operational job handlers for the four media job types. Each reads
//   what to do from canonical state (media_job_context), makes at most a few
//   provider calls and records the observed result, resolving JOB_DONE only
//   when the database recorded it. A transient provider answer, an unknown
//   recording answer or missing configuration throws, so the S2 protocol
//   retries with backoff and escalates visibly when the attempts are used up
//   (a provider outage never changes canonical state: MBS section 14).
//
// Nothing here logs or returns a key, a meeting token, a participant's name
// or a provider payload.

import { JOB_DONE, type JobHandler, type JobRun } from "./job-worker.ts";
import { isTimestamp, isUuid, readExact } from "./professional-records.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MEDIA_JOB_TYPES = Object.freeze([
  "media.room_create",
  "media.room_update",
  "media.room_delete",
  "media.observe",
] as const);
export type MediaJobType = (typeof MEDIA_JOB_TYPES)[number];

export const MEDIA_ROOM_STATES = Object.freeze([
  "pending",
  "open",
  "closing",
  "closed",
] as const);
export type MediaRoomState = (typeof MEDIA_ROOM_STATES)[number];

// The participant roles a meeting token is issued for.
export const PARTICIPANT_ROLES = Object.freeze(["client", "attorney"] as const);
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

// The only name the provider ever learns for a participant: the role label.
export const PARTICIPANT_LABELS: Readonly<Record<ParticipantRole, string>> =
  Object.freeze({ client: "Client", attorney: "Attorney" });

// Rosuno's provider room names ("r" and the 32 hexadecimal digits of the
// Media Room id) and the room names an observation may carry.
export const ROSUNO_ROOM_NAME = /^r[0-9a-f]{32}$/;
const ROOM_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const REFERENCE = /^[A-Za-z0-9_-]{3,255}$/;
const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const INSTANT =
  /^20[2-9][0-9]-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$/;
// The database's own bounds on one observation.
export const MAX_OBSERVED_SESSIONS = 50;
export const MAX_OBSERVED_PARTICIPANTS = 50;

export function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME.test(value);
}

export function isRosunoRoomName(value: unknown): value is string {
  return typeof value === "string" && ROSUNO_ROOM_NAME.test(value);
}

export function isMediaReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE.test(value);
}

export function isProviderCode(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_CODE.test(value);
}

export function isObservedInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

// An instant in the form the database accepts (UTC, milliseconds), or null.
export function observedInstantOf(epochMs: number): string | null {
  if (!Number.isFinite(epochMs)) {
    return null;
  }
  const text = new Date(Math.round(epochMs)).toISOString();
  return isObservedInstant(text) ? text : null;
}

// The provider room name of a Media Room id.
export function roomNameOf(mediaRoomId: string): string {
  if (!isUuid(mediaRoomId)) {
    throw new Error("not a media room identifier");
  }
  return `r${mediaRoomId.replaceAll("-", "")}`;
}

export type ObservedParticipant = {
  readonly participant_reference: string;
  readonly user_id: string | null;
  readonly joined_at: string;
  readonly left_at: string | null;
};

export type ObservedSession = {
  readonly session_reference: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly participants: readonly ObservedParticipant[];
};

// One media observation, exactly the members the database accepts.
export type MediaObservation =
  | { readonly kind: "ignored" }
  | {
      // The expiry the provider room now carries (the database compares it
      // with the window end the room must carry).
      readonly kind: "room_created" | "room_updated";
      readonly room_name: string;
      readonly expires_at: string;
    }
  | {
      readonly kind: "room_deleted" | "room_missing";
      readonly room_name: string;
    }
  | {
      readonly kind: "meetings_observed";
      readonly room_name: string;
      readonly sessions: readonly ObservedSession[];
    }
  | {
      readonly kind: "meeting_started";
      readonly room_name: string;
      readonly session_reference: string;
      readonly started_at: string;
    }
  | {
      readonly kind: "meeting_ended";
      readonly room_name: string;
      readonly session_reference: string;
      readonly started_at: string;
      readonly ended_at: string;
    }
  | {
      readonly kind: "participant_joined";
      readonly room_name: string;
      readonly participant_reference: string;
      readonly user_id: string | null;
      readonly joined_at: string;
    }
  | {
      readonly kind: "participant_left";
      readonly room_name: string;
      readonly participant_reference: string;
      readonly user_id: string | null;
      readonly joined_at: string;
      readonly left_at: string;
    };

const exactly = (value: unknown, keys: readonly string[]) =>
  readExact(value, keys);
const nullableInstant = (value: unknown) =>
  value === null || isObservedInstant(value);
const userReference = (value: unknown) => value === null || isUuid(value);

function isObservedParticipant(value: unknown): boolean {
  const fields = exactly(value, [
    "participant_reference",
    "user_id",
    "joined_at",
    "left_at",
  ]);
  return (
    fields !== null &&
    isMediaReference(fields.get("participant_reference")) &&
    userReference(fields.get("user_id")) &&
    isObservedInstant(fields.get("joined_at")) &&
    nullableInstant(fields.get("left_at"))
  );
}

function isObservedSession(value: unknown): boolean {
  const fields = exactly(value, [
    "session_reference",
    "started_at",
    "ended_at",
    "participants",
  ]);
  const participants = fields?.get("participants");
  return (
    fields !== null &&
    isMediaReference(fields.get("session_reference")) &&
    isObservedInstant(fields.get("started_at")) &&
    nullableInstant(fields.get("ended_at")) &&
    Array.isArray(participants) &&
    participants.length <= MAX_OBSERVED_PARTICIPANTS &&
    participants.every(isObservedParticipant)
  );
}

const KIND_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ignored: ["kind"],
  room_created: ["kind", "room_name", "expires_at"],
  room_updated: ["kind", "room_name", "expires_at"],
  room_deleted: ["kind", "room_name"],
  room_missing: ["kind", "room_name"],
  meetings_observed: ["kind", "room_name", "sessions"],
  meeting_started: ["kind", "room_name", "session_reference", "started_at"],
  meeting_ended: [
    "kind",
    "room_name",
    "session_reference",
    "started_at",
    "ended_at",
  ],
  participant_joined: [
    "kind",
    "room_name",
    "participant_reference",
    "user_id",
    "joined_at",
  ],
  participant_left: [
    "kind",
    "room_name",
    "participant_reference",
    "user_id",
    "joined_at",
    "left_at",
  ],
});

// Whether an observation has exactly the shape the database accepts (the
// database checks it again).
export function isMediaObservation(value: unknown): value is MediaObservation {
  const descriptor =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.getOwnPropertyDescriptor(value, "kind")
      : undefined;
  const kind =
    descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  if (typeof kind !== "string" || !Object.hasOwn(KIND_KEYS, kind)) {
    return false;
  }
  const fields = exactly(value, KIND_KEYS[kind]);
  if (fields === null) {
    return false;
  }
  if (kind === "ignored") {
    return true;
  }
  if (!isRoomName(fields.get("room_name"))) {
    return false;
  }
  switch (kind) {
    case "meetings_observed": {
      const sessions = fields.get("sessions");
      return (
        Array.isArray(sessions) &&
        sessions.length <= MAX_OBSERVED_SESSIONS &&
        sessions.every(isObservedSession)
      );
    }
    case "meeting_started":
      return (
        isMediaReference(fields.get("session_reference")) &&
        isObservedInstant(fields.get("started_at"))
      );
    case "meeting_ended":
      return (
        isMediaReference(fields.get("session_reference")) &&
        isObservedInstant(fields.get("started_at")) &&
        isObservedInstant(fields.get("ended_at"))
      );
    case "participant_joined":
      return (
        isMediaReference(fields.get("participant_reference")) &&
        userReference(fields.get("user_id")) &&
        isObservedInstant(fields.get("joined_at"))
      );
    case "participant_left":
      return (
        isMediaReference(fields.get("participant_reference")) &&
        userReference(fields.get("user_id")) &&
        isObservedInstant(fields.get("joined_at")) &&
        isObservedInstant(fields.get("left_at"))
      );
    case "room_created":
    case "room_updated":
      return isObservedInstant(fields.get("expires_at"));
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// The provider port (TA section 16.2)
// ---------------------------------------------------------------------------

// A provider call's neutral result:
// - ok: the provider answered with a value of the expected shape;
// - not_found: the room (or other object) does not exist;
// - rejected: the request itself was refused (authentication, validation);
// - transient: no definitive answer (network, timeout, rate limit, server
//   error); retry later.
export type MediaResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "rejected" }
  | { readonly kind: "transient" };

// A provider room as Rosuno reads it back (no URL, no account facts).
export type RoomView = {
  readonly name: string;
  readonly privateRoom: boolean;
  readonly expiresAt: number | null;
  readonly ejectAtExpiry: boolean;
  readonly maxParticipants: number | null;
  readonly recordingDisabled: boolean;
  readonly chatDisabled: boolean;
  readonly knockingDisabled: boolean;
  readonly prejoin: boolean;
};

export type MeetingTokenInput = {
  readonly roomName: string;
  readonly userId: string;
  readonly role: ParticipantRole;
  // Epoch seconds.
  readonly notBefore: number;
  readonly expiresAt: number;
};

export type PresenceView = {
  readonly participantReference: string;
  readonly userId: string | null;
  readonly joinedAt: number;
};

export type MeetingParticipantView = {
  readonly participantReference: string;
  readonly userId: string | null;
  readonly joinedAt: number;
  readonly durationSeconds: number | null;
};

export type MeetingView = {
  readonly sessionReference: string;
  readonly startedAt: number;
  readonly durationSeconds: number | null;
  readonly ongoing: boolean;
  readonly participants: readonly MeetingParticipantView[];
};

export type MediaProvider = {
  // The provider code Rosuno records (lower-snake).
  readonly providerCode: string;
  readonly createRoom: (
    roomName: string,
    expiresAt: number,
  ) => Promise<MediaResult<RoomView>>;
  readonly getRoom: (roomName: string) => Promise<MediaResult<RoomView>>;
  readonly updateRoom: (
    roomName: string,
    expiresAt: number,
  ) => Promise<MediaResult<RoomView>>;
  // ok when deleted; not_found when it does not exist (also gone).
  readonly deleteRoom: (roomName: string) => Promise<MediaResult<null>>;
  // The token is returned to the caller only, never logged or stored.
  readonly createMeetingToken: (
    input: MeetingTokenInput,
  ) => Promise<MediaResult<string>>;
  readonly presence: (
    roomName: string,
  ) => Promise<MediaResult<readonly PresenceView[]>>;
  readonly meetings: (
    roomName: string,
  ) => Promise<MediaResult<readonly MeetingView[]>>;
};

// The one meetings_observed observation of a room from the provider's
// presence and meeting reads: each provider session with its start and (when
// it is no longer ongoing and its duration is known) its end; each participant
// with its join and, when it is no longer present and its duration is known,
// its departure. A present participant the meeting read does not list yet is
// added to the ongoing session. Instants are UTC with milliseconds; anything
// beyond the database's bounds is left out.
export function observationOf(
  roomName: string,
  presence: readonly PresenceView[],
  meetings: readonly MeetingView[],
): MediaObservation | null {
  if (!isRoomName(roomName)) {
    return null;
  }
  const present = new Set(presence.map((p) => p.participantReference));
  const sessions: ObservedSession[] = [];
  const ongoing = meetings.filter((m) => m.ongoing);
  for (const meeting of meetings.slice(0, MAX_OBSERVED_SESSIONS)) {
    const startedAt = observedInstantOf(meeting.startedAt * 1000);
    if (startedAt === null || !isMediaReference(meeting.sessionReference)) {
      continue;
    }
    const endedAt =
      !meeting.ongoing && meeting.durationSeconds !== null
        ? observedInstantOf(
            (meeting.startedAt + meeting.durationSeconds) * 1000,
          )
        : null;
    const participants: ObservedParticipant[] = [];
    const listed = new Set<string>();
    for (const participant of meeting.participants) {
      const joinedAt = observedInstantOf(participant.joinedAt * 1000);
      if (
        joinedAt === null ||
        !isMediaReference(participant.participantReference)
      ) {
        continue;
      }
      listed.add(participant.participantReference);
      const stillPresent =
        meeting.ongoing && present.has(participant.participantReference);
      const leftAt =
        !stillPresent && participant.durationSeconds !== null
          ? observedInstantOf(
              (participant.joinedAt + participant.durationSeconds) * 1000,
            )
          : null;
      participants.push({
        participant_reference: participant.participantReference,
        user_id: isUuid(participant.userId) ? participant.userId : null,
        joined_at: joinedAt,
        left_at: leftAt,
      });
    }
    if (meeting.ongoing && ongoing.length === 1) {
      for (const p of presence) {
        const joinedAt = observedInstantOf(p.joinedAt * 1000);
        if (
          joinedAt !== null &&
          isMediaReference(p.participantReference) &&
          !listed.has(p.participantReference)
        ) {
          participants.push({
            participant_reference: p.participantReference,
            user_id: isUuid(p.userId) ? p.userId : null,
            joined_at: joinedAt,
            left_at: null,
          });
        }
      }
    }
    sessions.push({
      session_reference: meeting.sessionReference,
      started_at: startedAt,
      ended_at: endedAt,
      participants: participants.slice(0, MAX_OBSERVED_PARTICIPANTS),
    });
  }
  const observation: MediaObservation = {
    kind: "meetings_observed",
    room_name: roomName,
    sessions,
  };
  return isMediaObservation(observation) ? observation : null;
}

// ---------------------------------------------------------------------------
// The recording port (server-only; the privileged worker and webhook calls)
// ---------------------------------------------------------------------------

export const MEDIA_RECORD_OUTCOMES = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "contradiction",
  "outdated",
  "invalid",
  "not_running",
] as const);
export type MediaRecordOutcome = (typeof MEDIA_RECORD_OUTCOMES)[number];

export const MEDIA_EVENT_OUTCOMES = Object.freeze([
  "recorded",
  "duplicate",
  "invalid",
] as const);
export const MEDIA_PROCESSING_STATES = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "contradiction",
  "unmatched",
  "ignored",
] as const);

// One authenticated provider event as Rosuno records it.
export type MediaEvent = {
  readonly providerCode: string;
  readonly eventReference: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadDigest: string;
  readonly observation: MediaObservation;
};

export type MediaEventAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: (typeof MEDIA_EVENT_OUTCOMES)[number];
      readonly processing: (typeof MEDIA_PROCESSING_STATES)[number] | null;
    }
  | { readonly kind: "unknown" };

export type MediaRecorder = {
  // media_job_context(p_job_id): its rows, or null when unreadable.
  readonly jobContext: (jobId: string) => Promise<readonly unknown[] | null>;
  // media_record_operation(p_job_id, p_provider_code, p_observation).
  readonly recordOperation: (
    jobId: string,
    providerCode: string,
    observation: MediaObservation,
  ) => Promise<MediaRecordOutcome | "unknown">;
  // media_record_provider_event(...).
  readonly recordEvent: (event: MediaEvent) => Promise<MediaEventAnswer>;
};

const oneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export function mediaRecordOutcomeOf(
  data: unknown,
): MediaRecordOutcome | "unknown" {
  return oneOf(MEDIA_RECORD_OUTCOMES, data) ? data : "unknown";
}

// media_record_provider_event's one row read strictly.
export function mediaEventAnswerOf(rows: unknown): MediaEventAnswer {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return Object.freeze({ kind: "unknown" });
  }
  const fields = readExact(rows[0], ["outcome", "processing_state"]);
  const outcome = fields?.get("outcome");
  const processing = fields?.get("processing_state");
  if (
    fields === null ||
    !oneOf(MEDIA_EVENT_OUTCOMES, outcome) ||
    !(processing === null || oneOf(MEDIA_PROCESSING_STATES, processing)) ||
    (outcome === "invalid") !== (processing === null)
  ) {
    return Object.freeze({ kind: "unknown" });
  }
  return Object.freeze({
    kind: "answer",
    outcome,
    processing: processing as (typeof MEDIA_PROCESSING_STATES)[number] | null,
  });
}

export type MediaJobContext = {
  readonly outcome: "act" | "nothing_to_do" | "wait" | "not_running";
  readonly operation: string | null;
  readonly mediaRoomId: string | null;
  readonly roomName: string | null;
  readonly roomState: MediaRoomState | null;
  // Epoch seconds of the provider room's expiry (create and update only).
  readonly expiresAt: number | null;
};

const CONTEXT_COLUMNS = Object.freeze([
  "outcome",
  "operation",
  "media_room_id",
  "room_name",
  "room_state",
  "expires_at",
]);
const CONTEXT_OUTCOMES = Object.freeze([
  "act",
  "nothing_to_do",
  "wait",
  "not_running",
] as const);
const OPERATIONS = Object.freeze([
  "room_create",
  "room_update",
  "room_delete",
  "observe",
] as const);

// media_job_context's one row read strictly, or null.
export function mediaJobContextOf(
  rows: readonly unknown[] | null,
): MediaJobContext | null {
  if (rows === null || rows.length !== 1) {
    return null;
  }
  const fields = readExact(rows[0], CONTEXT_COLUMNS);
  if (fields === null) {
    return null;
  }
  const outcome = fields.get("outcome");
  const operation = fields.get("operation");
  const roomId = fields.get("media_room_id");
  const roomName = fields.get("room_name");
  const roomState = fields.get("room_state");
  const expires = fields.get("expires_at");
  if (
    !oneOf(CONTEXT_OUTCOMES, outcome) ||
    !(operation === null || oneOf(OPERATIONS, operation)) ||
    !(roomId === null || isUuid(roomId)) ||
    !(roomName === null || isRosunoRoomName(roomName)) ||
    !(roomState === null || oneOf(MEDIA_ROOM_STATES, roomState)) ||
    !(expires === null || isTimestamp(expires))
  ) {
    return null;
  }
  if (
    outcome === "act" &&
    (operation === null ||
      roomId === null ||
      roomName === null ||
      roomName !== roomNameOf(roomId) ||
      ((operation === "room_create" || operation === "room_update") &&
        expires === null))
  ) {
    return null;
  }
  return Object.freeze({
    outcome,
    operation: operation as string | null,
    mediaRoomId: roomId as string | null,
    roomName: roomName as string | null,
    roomState: roomState as MediaRoomState | null,
    expiresAt:
      expires === null
        ? null
        : Math.floor(Date.parse(expires as string) / 1000),
  });
}

// ---------------------------------------------------------------------------
// The job handlers (the S2 protocol runs them; MBS section 21)
// ---------------------------------------------------------------------------

export type MediaJobWiring = {
  readonly provider: () => Promise<MediaProvider | null>;
  readonly recorder: () => Promise<MediaRecorder | null>;
};

// Thrown so the S2 protocol retries the job with backoff (and escalates it
// once its attempts are used up). It carries no payload, key or provider
// message.
export class MediaJobRetry extends Error {
  constructor() {
    super("media job attempt did not finish");
    this.name = "MediaJobRetry";
  }
}

const retry = (): never => {
  throw new MediaJobRetry();
};

// The recorded outcomes that mean the database holds the result (or no longer
// needs it).
const SETTLED: readonly string[] = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "contradiction",
  "not_running",
]);

async function recorded(
  recorder: MediaRecorder,
  provider: MediaProvider,
  job: JobRun,
  observation: MediaObservation,
): Promise<typeof JOB_DONE> {
  if (!isMediaObservation(observation)) {
    return retry();
  }
  const outcome = await recorder.recordOperation(
    job.jobId,
    provider.providerCode,
    observation,
  );
  return SETTLED.includes(outcome) ? JOB_DONE : retry();
}

type ActContext = MediaJobContext & {
  readonly operation: string;
  readonly mediaRoomId: string;
  readonly roomName: string;
};

type Step = (
  context: ActContext,
  provider: MediaProvider,
  recorder: MediaRecorder,
  job: JobRun,
) => Promise<typeof JOB_DONE>;

// The expiry a provider room reports (epoch seconds) as an observed instant;
// when the provider reports none, the expiry the job asked for.
function reportedExpiry(room: RoomView, requested: number): string | null {
  const seconds =
    typeof room.expiresAt === "number" ? room.expiresAt : requested;
  return observedInstantOf(seconds * 1000);
}

const createStep: Step = async (context, provider, recorder, job) => {
  if (context.expiresAt === null) {
    return retry();
  }
  // The adapter sets this expiry on a room that already existed (a retried
  // creation whose first result was lost) before it answers.
  const created = await provider.createRoom(
    context.roomName,
    context.expiresAt,
  );
  if (created.kind !== "ok" || created.value.name !== context.roomName) {
    return retry();
  }
  const expiresAt = reportedExpiry(created.value, context.expiresAt);
  if (expiresAt === null) {
    return retry();
  }
  return recorded(recorder, provider, job, {
    kind: "room_created",
    room_name: context.roomName,
    expires_at: expiresAt,
  });
};

const updateStep: Step = async (context, provider, recorder, job) => {
  if (context.expiresAt === null) {
    return retry();
  }
  const updated = await provider.updateRoom(
    context.roomName,
    context.expiresAt,
  );
  if (updated.kind === "not_found") {
    return recorded(recorder, provider, job, {
      kind: "room_missing",
      room_name: context.roomName,
    });
  }
  if (updated.kind !== "ok") {
    return retry();
  }
  const expiresAt = reportedExpiry(updated.value, context.expiresAt);
  if (expiresAt === null) {
    return retry();
  }
  // An outdated answer (the window moved again meanwhile) is not settled: the
  // job runs again and reads the window end afresh.
  return recorded(recorder, provider, job, {
    kind: "room_updated",
    room_name: context.roomName,
    expires_at: expiresAt,
  });
};

const deleteStep: Step = async (context, provider, recorder, job) => {
  const deleted = await provider.deleteRoom(context.roomName);
  if (deleted.kind !== "ok" && deleted.kind !== "not_found") {
    return retry();
  }
  return recorded(recorder, provider, job, {
    kind: "room_deleted",
    room_name: context.roomName,
  });
};

const observeStep: Step = async (context, provider, recorder, job) => {
  const room = await provider.getRoom(context.roomName);
  if (room.kind === "not_found" && context.roomState === "open") {
    // The provider reports no room while Rosuno's is open: the database
    // decides whether this is a disagreement (it never corrects silently).
    const outcome = await recorder.recordOperation(
      job.jobId,
      provider.providerCode,
      { kind: "room_missing", room_name: context.roomName },
    );
    if (!SETTLED.includes(outcome)) {
      return retry();
    }
  } else if (room.kind !== "ok" && room.kind !== "not_found") {
    return retry();
  }
  const presence =
    room.kind === "ok"
      ? await provider.presence(context.roomName)
      : ({ kind: "ok", value: [] } as const);
  const meetings = await provider.meetings(context.roomName);
  if (presence.kind !== "ok" || meetings.kind !== "ok") {
    return retry();
  }
  const observation = observationOf(
    context.roomName,
    presence.value,
    meetings.value,
  );
  return observation === null
    ? retry()
    : recorded(recorder, provider, job, observation);
};

const STEPS: Readonly<Record<MediaJobType, Step>> = Object.freeze({
  "media.room_create": createStep,
  "media.room_update": updateStep,
  "media.room_delete": deleteStep,
  "media.observe": observeStep,
});

function handlerFor(type: MediaJobType, wiring: MediaJobWiring): JobHandler {
  return async (job: JobRun) => {
    const recorder = await wiring.recorder();
    if (recorder === null) {
      return retry();
    }
    const context = mediaJobContextOf(await recorder.jobContext(job.jobId));
    if (context === null || context.outcome === "wait") {
      return retry();
    }
    if (context.outcome !== "act") {
      // The Media Room no longer needs this operation (or the job is no
      // longer running): nothing is sent.
      return JOB_DONE;
    }
    if (context.operation !== type.slice("media.".length)) {
      return retry();
    }
    const provider = await wiring.provider();
    if (provider === null || !isProviderCode(provider.providerCode)) {
      return retry();
    }
    return STEPS[type](context as ActContext, provider, recorder, job);
  };
}

// The four media job handlers, keyed by job type.
export function createMediaJobHandlers(
  wiring: MediaJobWiring,
): ReadonlyMap<string, JobHandler> {
  return new Map<string, JobHandler>(
    MEDIA_JOB_TYPES.map((type) => [type, handlerFor(type, wiring)]),
  );
}

// ---------------------------------------------------------------------------
// Provider events (after the webhook adapter verified authenticity)
// ---------------------------------------------------------------------------

export type MediaEventHandling = "accepted" | "rejected" | "unavailable";

// Records one authenticated provider event: accepted when the database
// recorded it or already had it (a replay), rejected when it refused the
// event as malformed, unavailable when the answer is unknown (the provider
// delivers again; the receipt key keeps that idempotent).
export async function recordMediaEvent(
  recorder: MediaRecorder,
  event: MediaEvent,
): Promise<MediaEventHandling> {
  try {
    if (!isMediaObservation(event.observation)) {
      return "rejected";
    }
    const answer = await recorder.recordEvent(event);
    if (answer.kind !== "answer") {
      return "unavailable";
    }
    return answer.outcome === "invalid" ? "rejected" : "accepted";
  } catch {
    return "unavailable";
  }
}
