// Client voice memo of an Intake (MVP-001 S3; MBS section 8; MB sections 35
// and 55; TA section 57; PS sections 19.3 and 29).
//
// Provider-neutral and injectable. Every use case first establishes the
// verified client exactly as every client intake operation does (Security
// Shell, trusted session, fresh Auth read, active User, own Client Profile),
// then lets the database decide again for the request's own session.
//
// The duration limit is server configuration with no default: while it is
// unset or invalid every upload is refused with one fixed message (Packet
// section 3 gate; MB's 60 seconds is not a default). An upload is received
// on the server, its container recognized and its duration measured from the
// bytes (never from anything the browser reports), the limit and the byte
// ceiling enforced, and its digest computed, before anything is written.
// Only then does the database start a pending resource for the client's own
// draft Intake; the bytes are stored at that resource's own opaque path and
// the resource completed, or marked rejected when they could not be. Nothing
// about the Intake or its revisions changes, whatever the outcome.
//
// Playback is a signed URL for the one authorized resource, valid for a fixed
// short lifetime, issued only after the database authorized the caller.

import { measureRecording, type RecordingType } from "./audio-duration.ts";
import {
  verifiedClientIntakeOf,
  verifiedClientOf,
  type ClientIntakeSources,
} from "./client-intake.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  UNAVAILABLE,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import { isTimestamp, isUuid, readExact } from "./professional-records.ts";
import {
  BEGIN_VOICE_MEMO_OUTCOMES,
  bytesOf,
  digestOf,
  resourceOutcomeOf,
  SIGNED_URL_SECONDS,
  signedAccess,
  storeAndComplete,
  uploadFieldOf,
  type ContentDigest,
  type ProtectedStorage,
  type ResourceCalls,
} from "./protected-resources.ts";

export const VOICE_MEMO_RESOURCE_COLUMNS = "id, visibility_state, created_at";
export const VOICE_MEMO_COLUMNS = "resource_id, duration_seconds";

// The existing physical ceiling of a voice memo's duration
// (voice_memos_duration_seconds_check, PS section 19.3 as implemented in
// P1). A configured limit above it cannot be stored and is refused as
// invalid configuration; it is never a default.
export const VOICE_MEMO_PHYSICAL_MAX_SECONDS = 60;

export type VoiceMemoLimit =
  | { readonly kind: "configured"; readonly maxSeconds: number }
  | { readonly kind: "unavailable" };

// Request-scoped, unprivileged reads under the database's own row policies,
// keyed only by an Intake the use case verified as the client's own.
export type VoiceMemoReads = {
  // The Intake's available voice memo resource, if any (at most two rows).
  readonly availableMemoResourcesOf: (intakeId: string) => Promise<RowsResult>;
  // The Intake's voice memo records.
  readonly memosOf: (intakeId: string) => Promise<RowsResult>;
};

export type VoiceMemoSources = ClientIntakeSources & {
  readonly memoReads: () => Promise<VoiceMemoReads | null>;
  readonly resources: () => Promise<ResourceCalls | null>;
  readonly storage: () => Promise<ProtectedStorage | null>;
  readonly limit: () => VoiceMemoLimit;
  readonly digest: ContentDigest;
};

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

function limitOf(sources: VoiceMemoSources): number | null {
  try {
    const limit = sources.limit();
    return limit.kind === "configured" &&
      Number.isSafeInteger(limit.maxSeconds) &&
      limit.maxSeconds >= 1 &&
      limit.maxSeconds <= VOICE_MEMO_PHYSICAL_MAX_SECONDS
      ? limit.maxSeconds
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export type VoiceMemoRecording =
  | { readonly kind: "open"; readonly maxSeconds: number }
  | { readonly kind: "not-configured" }
  | { readonly kind: "not-editable" }
  | { readonly kind: "recorded" };

export type VoiceMemoView =
  | Refusal
  | typeof NOT_FOUND
  | {
      readonly status: "ready";
      readonly intakeId: string;
      readonly memo: {
        readonly resourceId: string;
        readonly durationSeconds: number | null;
      } | null;
      readonly recording: VoiceMemoRecording;
    };

function readMemoResource(row: unknown): string | null {
  const fields = readExact(row, VOICE_MEMO_RESOURCE_COLUMNS.split(", "));
  const id = fields?.get("id");
  return isUuid(id) &&
    fields?.get("visibility_state") === "available" &&
    isTimestamp(fields?.get("created_at"))
    ? id
    : null;
}

export async function resolveVoiceMemo(
  sources: VoiceMemoSources,
  intakeId: unknown,
): Promise<VoiceMemoView> {
  try {
    const verified = await verifiedClientIntakeOf(sources, intakeId);
    if (!("client" in verified)) {
      return verified;
    }
    const reads = await portFrom(sources.memoReads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const resourceRows = rowsOf(
      await attempt(() => reads.availableMemoResourcesOf(verified.intakeId)),
    );
    const memoRows = rowsOf(
      await attempt(() => reads.memosOf(verified.intakeId)),
    );
    if (resourceRows === null || memoRows === null || resourceRows.length > 1) {
      return UNAVAILABLE;
    }
    let memo: { resourceId: string; durationSeconds: number | null } | null =
      null;
    if (resourceRows.length === 1) {
      const resourceId = readMemoResource(resourceRows[0]);
      if (resourceId === null) {
        return UNAVAILABLE;
      }
      const record = memoRows
        .map((row) => readExact(row, VOICE_MEMO_COLUMNS.split(", ")))
        .find((fields) => fields?.get("resource_id") === resourceId);
      const duration = record?.get("duration_seconds");
      memo = {
        resourceId,
        durationSeconds:
          Number.isSafeInteger(duration) && (duration as number) >= 0
            ? (duration as number)
            : null,
      };
    }
    const maxSeconds = limitOf(sources);
    const recording: VoiceMemoRecording =
      verified.state !== "draft"
        ? { kind: "not-editable" }
        : memo !== null
          ? { kind: "recorded" }
          : maxSeconds === null
            ? { kind: "not-configured" }
            : { kind: "open", maxSeconds };
    return Object.freeze({
      status: "ready",
      intakeId: verified.intakeId,
      memo: memo === null ? null : Object.freeze(memo),
      recording: Object.freeze(recording),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type VoiceMemoActionState =
  | { readonly status: "idle" }
  | { readonly status: "saved" }
  | { readonly status: "not-configured" }
  | { readonly status: "too-long"; readonly maxSeconds: number }
  | { readonly status: "too-large" }
  | { readonly status: "empty" }
  | { readonly status: "unsupported-format" }
  | { readonly status: "not-editable" }
  | { readonly status: "already-recorded" }
  | { readonly status: "rate-limited" }
  | { readonly status: "not-found" }
  | { readonly status: "outcome-unknown" }
  | Refusal;

export const INITIAL_VOICE_MEMO_STATE: VoiceMemoActionState = Object.freeze({
  status: "idle",
});

const fixed = <S extends VoiceMemoActionState["status"]>(status: S) =>
  Object.freeze({ status }) as { readonly status: S };

const STATES = Object.freeze({
  saved: fixed("saved"),
  notConfigured: fixed("not-configured"),
  tooLarge: fixed("too-large"),
  empty: fixed("empty"),
  unsupported: fixed("unsupported-format"),
  notEditable: fixed("not-editable"),
  alreadyRecorded: fixed("already-recorded"),
  rateLimited: fixed("rate-limited"),
  notFound: fixed("not-found"),
  outcomeUnknown: fixed("outcome-unknown"),
});

function singleValue(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  return values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : null;
}

// The whole seconds stored for a measured duration: rounded up, at least one.
export function storedSecondsOf(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / 1000));
}

export async function uploadVoiceMemo(
  sources: VoiceMemoSources,
  formData: unknown,
): Promise<VoiceMemoActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const intakeId = singleValue(formData, "intake");
    if (!isUuid(intakeId)) {
      return STATES.notFound;
    }
    const field = uploadFieldOf(formData, "recording");
    if (field.kind === "invalid") {
      return STATES.unsupported;
    }
    const verified = await verifiedClientIntakeOf(sources, intakeId);
    if (!("client" in verified)) {
      return verified.status === "not-found" ? STATES.notFound : verified;
    }
    if (verified.state !== "draft") {
      return STATES.notEditable;
    }
    const maxSeconds = limitOf(sources);
    if (maxSeconds === null) {
      return STATES.notConfigured;
    }
    if (field.kind === "none") {
      return STATES.empty;
    }
    const bytes = await bytesOf(field.file);
    if (bytes === "empty") {
      return STATES.empty;
    }
    if (bytes === "too-large") {
      return STATES.tooLarge;
    }
    const measure = measureRecording(bytes);
    if (measure.kind !== "measured") {
      return STATES.unsupported;
    }
    if (measure.durationMs <= 0) {
      return STATES.empty;
    }
    if (measure.durationMs > maxSeconds * 1000) {
      return Object.freeze({ status: "too-long", maxSeconds });
    }
    const digest = await digestOf(sources.digest, bytes);
    const calls = await portFrom(sources.resources);
    if (digest === null || calls === null) {
      return UNAVAILABLE;
    }
    const type: RecordingType = measure.type;
    const started = resourceOutcomeOf(
      await attempt(() =>
        calls.beginVoiceMemo(
          Object.freeze({
            intakeId: verified.intakeId,
            mimeType: type,
            byteSize: bytes.length,
            contentDigest: digest,
            durationSeconds: storedSecondsOf(measure.durationMs),
          }),
        ),
      ),
      BEGIN_VOICE_MEMO_OUTCOMES,
    );
    if (started === "rejected") {
      return UNAVAILABLE;
    }
    if (started === "unknown") {
      return STATES.outcomeUnknown;
    }
    switch (started.outcome) {
      case "created":
        break;
      case "not_found":
        return STATES.notFound;
      case "not_editable":
        return STATES.notEditable;
      case "already_exists":
        return STATES.alreadyRecorded;
      case "rate_limited":
        return STATES.rateLimited;
      default:
        return UNAVAILABLE;
    }
    if (!isUuid(started.value)) {
      return STATES.outcomeUnknown;
    }
    const storage = await portFrom(sources.storage);
    const completion = await storeAndComplete(
      calls,
      storage,
      started.value,
      bytes,
      type,
    );
    switch (completion) {
      case "available":
        return STATES.saved;
      case "not_editable":
        return STATES.notEditable;
      case "already_exists":
        return STATES.alreadyRecorded;
      case "unknown":
        return STATES.outcomeUnknown;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type VoiceMemoPlaybackState =
  | { readonly status: "idle" }
  | {
      readonly status: "ready";
      readonly url: string;
      readonly expiresInSeconds: number;
    }
  | { readonly status: "not-available" }
  | { readonly status: "held" }
  | { readonly status: "not-found" }
  | Refusal;

export const INITIAL_PLAYBACK_STATE: VoiceMemoPlaybackState = Object.freeze({
  status: "idle",
});

export async function voiceMemoPlayback(
  sources: VoiceMemoSources,
  formData: unknown,
): Promise<VoiceMemoPlaybackState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const resourceId = singleValue(formData, "resource");
    if (!isUuid(resourceId)) {
      return NOT_FOUND;
    }
    const client = await verifiedClientOf(sources);
    if (!("clientId" in client)) {
      return client;
    }
    const calls = await portFrom(sources.resources);
    if (calls === null) {
      return UNAVAILABLE;
    }
    const access = await signedAccess(
      calls,
      sources.storage,
      resourceId,
      "voice_memo",
      "inline",
    );
    switch (access.kind) {
      case "url":
        return Object.freeze({
          status: "ready",
          url: access.url,
          expiresInSeconds: SIGNED_URL_SECONDS,
        });
      case "not-available":
        return Object.freeze({ status: "not-available" });
      case "held":
        return Object.freeze({ status: "held" });
      case "refused":
        return NOT_FOUND;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}
