// Protected resources (MVP-001 S3; IMP section 13; PS sections 19 and 29;
// TA sections 21, 22 and 57).
//
// Provider-neutral building blocks shared by the voice memo and the
// verification artifact use cases. Each request hands in its own ports:
// - a request-scoped port of the database's own resource functions, called
//   through the request's own authenticated session, so the database decides
//   the actor, the relationship, the grant, the visibility, retention and
//   Legal Hold state, and audits every change and every authorization;
// - the server-only storage port, which stores bytes only at the opaque path
//   it derives from a resource id itself and signs only that path, for a
//   fixed short lifetime.
// Bytes are always received and checked on the server first: a byte ceiling,
// a content-type allowlist recognized from the bytes themselves (never from a
// browser-reported type or name), and a SHA-256 digest. A signed URL is asked
// for only after the database authorized the exact resource; storage
// existence or path knowledge is never authorization.

import { RECORDING_TYPES, type RecordingType } from "./audio-duration.ts";
import { isOneOf, isUuid } from "./professional-records.ts";

export const PROTECTED_BUCKET = "rosuno-private-resources";

// The largest object stored (a fixed technical bound of the upload path,
// below the server action body limit).
export const RESOURCE_BYTE_CEILING = 1_000_000;

// The lifetime of every signed URL: the minimum practical duration for
// starting playback or a download (PS section 29; IMP section 13).
export const SIGNED_URL_SECONDS = 60;

// MVP-001 S10: and consultation documents.
export const RESOURCE_KINDS = Object.freeze([
  "voice_memo",
  "verification_artifact",
  "document",
] as const);

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const ARTIFACT_TYPES = Object.freeze([
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const);

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export type StoredType = RecordingType | ArtifactType;

export const STORED_TYPES: readonly StoredType[] = Object.freeze([
  ...RECORDING_TYPES,
  ...ARTIFACT_TYPES,
]);

export function isStoredType(value: unknown): value is StoredType {
  return isOneOf(STORED_TYPES, value);
}

// The one object path of a resource, or null for anything but a canonical
// resource id. Nothing about a person, matter, or file name is in it.
export function objectPathOf(resourceId: unknown): string | null {
  return isUuid(resourceId) ? `resources/${resourceId}/original` : null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.length >= prefix.length &&
    prefix.every((byte, index) => bytes[index] === byte)
  );
}

// The type of a verification artifact, recognized from its leading bytes
// only: a PDF document, a PNG image (signature and header chunk), or a JPEG
// image. Anything else is null.
export function artifactTypeOf(bytes: Uint8Array): ArtifactType | null {
  if (!(bytes instanceof Uint8Array)) {
    return null;
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  if (
    startsWith(
      bytes,
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13],
    ) &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff]) && bytes.length >= 4) {
    return "image/jpeg";
  }
  return null;
}

// One file field of a submitted form: none chosen (no entry, or the empty
// entry a browser sends for a file input left empty), exactly one file, or
// anything else.
export type UploadField =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly file: Blob }
  | { readonly kind: "invalid" };

export function uploadFieldOf(formData: FormData, name: string): UploadField {
  const values = formData.getAll(name);
  if (values.length === 0) {
    return { kind: "none" };
  }
  const [file] = values;
  if (values.length > 1 || !(file instanceof Blob)) {
    return { kind: "invalid" };
  }
  if (file.size === 0 && file.name === "") {
    return { kind: "none" };
  }
  return { kind: "file", file };
}

// The bytes of an uploaded file within the ceiling: "empty", "too-large", or
// the bytes. The size is checked before anything is read.
export async function bytesOf(
  file: Blob,
): Promise<Uint8Array | "empty" | "too-large"> {
  if (file.size === 0) {
    return "empty";
  }
  if (file.size > RESOURCE_BYTE_CEILING) {
    return "too-large";
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) {
    return "empty";
  }
  return bytes.length > RESOURCE_BYTE_CEILING ? "too-large" : bytes;
}

// One resource function's answer as the adapter reports it: the function's
// own outcome (with the resource id or object path it returns, if any);
// "rejected" when the database raised an error inside the call, so nothing
// committed; or "unreadable" when the outcome is unknown.
export type ResourceAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly value: string | number | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export const BEGIN_VOICE_MEMO_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "not_found",
  "not_editable",
  "already_exists",
  "rate_limited",
] as const);
export const BEGIN_ARTIFACT_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "locked",
] as const);
export const FINALIZE_OUTCOMES = Object.freeze([
  "available",
  "not_found",
  "not_pending",
  "not_editable",
  "already_exists",
  "denied",
  "not_stored",
] as const);
export const ABANDON_OUTCOMES = Object.freeze([
  "rejected",
  "not_found",
  "not_pending",
] as const);
export const ACCESS_OUTCOMES = Object.freeze([
  "authorized",
  "not_available",
  "held",
  "refused",
] as const);

export type VoiceMemoStart = {
  readonly intakeId: string;
  readonly mimeType: RecordingType;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly durationSeconds: number;
};

export type ArtifactStart = {
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly mimeType: ArtifactType;
  readonly byteSize: number;
  readonly contentDigest: string;
};

// Request-scoped port: each call is one resource function run for the
// request's own authenticated session. None takes an actor, owner, path, or
// bucket; the database derives them itself.
export type ResourceCalls = {
  readonly beginVoiceMemo: (start: VoiceMemoStart) => Promise<ResourceAnswer>;
  readonly beginVerificationArtifact: (
    start: ArtifactStart,
  ) => Promise<ResourceAnswer>;
  readonly finalizeUpload: (resourceId: string) => Promise<ResourceAnswer>;
  readonly abandonUpload: (resourceId: string) => Promise<ResourceAnswer>;
  readonly authorizeAccess: (
    resourceId: string,
    kind: ResourceKind,
  ) => Promise<ResourceAnswer>;
};

// Server-only storage port. It derives the object path from the resource id
// itself, in the one private bucket, and offers nothing else: no listing,
// reading, moving, replacing, or removal.
export type ProtectedStorage = {
  // Stores new bytes at the resource's path (never replacing an object);
  // true only when the storage service confirmed it.
  readonly store: (
    resourceId: string,
    bytes: Uint8Array,
    type: StoredType,
  ) => Promise<boolean>;
  // A URL for the resource's path valid for SIGNED_URL_SECONDS, served inline
  // or as an attachment, or null.
  readonly signedUrl: (
    resourceId: string,
    disposition: "inline" | "attachment",
  ) => Promise<string | null>;
};

// The SHA-256 digest of the bytes as "sha256:<64 hex>", or null.
export type ContentDigest = (bytes: Uint8Array) => Promise<string | null>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export async function digestOf(
  digest: ContentDigest,
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    const value = await digest(bytes);
    return typeof value === "string" && DIGEST.test(value) ? value : null;
  } catch {
    return null;
  }
}

function ownField(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// One answer, read strictly against the function's outcomes.
export function resourceOutcomeOf<T extends string>(
  answer: unknown,
  outcomes: readonly T[],
): { readonly outcome: T; readonly value: unknown } | "rejected" | "unknown" {
  try {
    if (answer === null || typeof answer !== "object") {
      return "unknown";
    }
    const kind = ownField(answer, "kind");
    if (kind === "rejected") {
      return "rejected";
    }
    if (kind !== "answer") {
      return "unknown";
    }
    const outcome = ownField(answer, "outcome");
    return isOneOf(outcomes, outcome)
      ? { outcome, value: ownField(answer, "value") }
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function attempted<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

// Marks a pending resource rejected after its bytes could not be stored or
// confirmed. Best effort: whatever it answers, the resource never becomes
// available without completion.
async function abandon(calls: ResourceCalls, resourceId: string) {
  await attempted(() => calls.abandonUpload(resourceId));
}

export type Completion =
  | "available"
  | "not_editable"
  | "already_exists"
  | "denied"
  | "failed"
  | "unknown";

// Stores the bytes at the started resource's own path and completes it. A
// failed store, a refusal, and an unknown completion each mark the resource
// rejected (a completed resource is left as it is), so nothing is ever
// disclosed that was not stored and confirmed.
export async function storeAndComplete(
  calls: ResourceCalls,
  storage: ProtectedStorage | null,
  resourceId: string,
  bytes: Uint8Array,
  type: StoredType,
): Promise<Completion> {
  if (storage === null || objectPathOf(resourceId) === null) {
    await abandon(calls, resourceId);
    return "failed";
  }
  const stored = await attempted(() => storage.store(resourceId, bytes, type));
  if (stored !== true) {
    await abandon(calls, resourceId);
    return "failed";
  }
  const answer = resourceOutcomeOf(
    await attempted(() => calls.finalizeUpload(resourceId)),
    FINALIZE_OUTCOMES,
  );
  if (answer !== "rejected" && answer !== "unknown") {
    if (answer.outcome === "available") {
      return "available";
    }
    await abandon(calls, resourceId);
    return answer.outcome === "not_editable" ||
      answer.outcome === "already_exists" ||
      answer.outcome === "denied"
      ? answer.outcome
      : "failed";
  }
  await abandon(calls, resourceId);
  return answer === "rejected" ? "failed" : "unknown";
}

export type Access =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "refused" }
  | { readonly kind: "not-available" }
  | { readonly kind: "held" }
  | { readonly kind: "unavailable" };

// Asks the database to authorize the exact resource for the caller, and only
// then signs that resource's own path. The path the database answers must be
// the path derived from the id; anything else is refused.
export async function signedAccess(
  calls: ResourceCalls,
  storage: () => Promise<ProtectedStorage | null>,
  resourceId: string,
  kind: ResourceKind,
  disposition: "inline" | "attachment",
): Promise<Access> {
  const path = objectPathOf(resourceId);
  if (path === null) {
    return { kind: "refused" };
  }
  const answer = resourceOutcomeOf(
    await attempted(() => calls.authorizeAccess(resourceId, kind)),
    ACCESS_OUTCOMES,
  );
  if (answer === "rejected" || answer === "unknown") {
    return { kind: "unavailable" };
  }
  switch (answer.outcome) {
    case "authorized": {
      if (answer.value !== path) {
        return { kind: "unavailable" };
      }
      const port = await attempted(storage);
      if (port === undefined || port === null) {
        return { kind: "unavailable" };
      }
      const url = await attempted(() =>
        port.signedUrl(resourceId, disposition),
      );
      return typeof url === "string" && url !== ""
        ? { kind: "url", url }
        : { kind: "unavailable" };
    }
    case "not_available":
      return { kind: "not-available" };
    case "held":
      return { kind: "held" };
    default:
      return { kind: "refused" };
  }
}
