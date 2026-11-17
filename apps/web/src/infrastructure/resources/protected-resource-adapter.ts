// Server-only protected resource adapter (MVP-001 S3; IMP section 13; PS
// sections 19 and 29).
//
// Builds the protected resource ports for one request:
// - the database's own resource functions (voice memo and verification
//   artifact start, completion, abandonment, and access authorization), each
//   one literal call through the request-scoped, unprivileged server client,
//   so the database decides the actor from the request's own authenticated
//   session; each answer is read strictly against that function's outcomes;
// - the voice memo reads, through that same client under the row policies;
// - the voice memo duration limit, read from server-only configuration with
//   no default (unset or malformed: unavailable);
// - the SHA-256 content digest;
// - the shared, server-only privileged storage port, which this module never
//   sees the credential or client of, with every call bounded in time.
// Every call is bounded in time; a call that fails, throws, or is too slow is
// reported as unreadable or failed, and writes one log line naming the call
// and how it failed, with the error code and HTTP status reported, and
// nothing the call carried or answered: no bytes, digest, path, or URL.

import { createHash } from "node:crypto";

import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import {
  ABANDON_OUTCOMES,
  ACCESS_OUTCOMES,
  BEGIN_ARTIFACT_OUTCOMES,
  BEGIN_VOICE_MEMO_OUTCOMES,
  FINALIZE_OUTCOMES,
  type ContentDigest,
  type ProtectedStorage,
  type ResourceAnswer,
  type ResourceCalls,
} from "../../application/protected-resources.ts";
import {
  VOICE_MEMO_COLUMNS,
  VOICE_MEMO_RESOURCE_COLUMNS,
  type VoiceMemoLimit,
  type VoiceMemoReads,
  type VoiceMemoSources,
} from "../../application/voice-memo.ts";
import {
  CLIENT_INTAKE_SOURCES,
  rowAnswerOf,
  textAnswerOf,
} from "../client/client-intake-adapter.ts";
import { readProviderConfiguration } from "../environment/provider-configuration.ts";
import { createProtectedStoragePort } from "../identity/registration-provisioning.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";

const CALL_FAILED = "protected_resource.call_failed";
const UNREADABLE: ResourceAnswer = Object.freeze({ kind: "unreadable" });
const EXPIRED = Symbol("expired");

// Storing up to the byte ceiling may take longer than an ordinary call.
const STORAGE_DEADLINE_MS = 20_000;

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// The error code and HTTP status a call's answer reported, and nothing else.
function failureOf(result: unknown): LogFields {
  const status = ownField(result, "status");
  return {
    ...errorFieldsOf(ownField(result, "error")),
    ...(typeof status === "number" ? { status } : {}),
  };
}

type Observation<T> = {
  readonly answer: T;
  readonly failure: LogFields | null;
};

// Runs one call within the deadline and answers what it answered, or the
// fallback when it threw or ran out of time; a failure writes one log line
// and never changes the outcome.
async function observed<T>(
  operation: string,
  deadlineMs: number,
  fallback: T,
  call: () => Promise<Observation<T>>,
): Promise<T> {
  const settled = await withinDeadline<Observation<T> | typeof EXPIRED>(
    async () => {
      try {
        return await call();
      } catch (error) {
        return {
          answer: fallback,
          failure: { outcome: "threw", ...errorFieldsOf(error) },
        };
      }
    },
    EXPIRED,
    deadlineMs,
  );
  if (settled === EXPIRED) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      outcome: "deadline",
    });
    return fallback;
  }
  if (settled.failure !== null) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...settled.failure,
    });
  }
  return settled.answer;
}

function observedCall(
  operation: string,
  deadlineMs: number,
  call: () => PromiseLike<unknown>,
  read: (result: unknown) => ResourceAnswer,
): Promise<ResourceAnswer> {
  return observed(operation, deadlineMs, UNREADABLE, async () => {
    const result = await call();
    const answer = read(result);
    return {
      answer,
      failure:
        answer.kind === "answer"
          ? null
          : { outcome: answer.kind, ...failureOf(result) },
    };
  });
}

function observedRead(
  operation: string,
  deadlineMs: number,
  query: () => PromiseLike<{ readonly data: unknown; readonly error: unknown }>,
): Promise<RowsResult> {
  return observed(operation, deadlineMs, UNREADABLE_ROWS, async () => {
    const result = await query();
    const rows = rowsResultOf(result);
    return {
      answer: rows,
      failure:
        rows.kind === "rows"
          ? null
          : {
              outcome: result.error === null ? "malformed" : "error",
              ...failureOf(result),
            },
    };
  });
}

export function createResourceCalls(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ResourceCalls | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client: RequestClient | null = await withinDeadline(
      clientSource,
      null,
      deadlineMs,
    );
    if (client === null) {
      return null;
    }
    return Object.freeze({
      beginVoiceMemo: (start) =>
        observedCall(
          "resource_begin_voice_memo",
          deadlineMs,
          () =>
            client.rpc("resource_begin_voice_memo", {
              p_intake_id: start.intakeId,
              p_mime_type: start.mimeType,
              p_byte_size: start.byteSize,
              p_content_digest: start.contentDigest,
              p_duration_seconds: start.durationSeconds,
            }),
          (result) =>
            rowAnswerOf(result, BEGIN_VOICE_MEMO_OUTCOMES, "resource_id"),
        ),
      beginVerificationArtifact: (start) =>
        observedCall(
          "resource_begin_verification_artifact",
          deadlineMs,
          () =>
            client.rpc("resource_begin_verification_artifact", {
              p_subject_kind: start.subjectKind,
              p_subject_id: start.subjectId,
              p_mime_type: start.mimeType,
              p_byte_size: start.byteSize,
              p_content_digest: start.contentDigest,
            }),
          (result) =>
            rowAnswerOf(result, BEGIN_ARTIFACT_OUTCOMES, "resource_id"),
        ),
      finalizeUpload: (resourceId) =>
        observedCall(
          "resource_finalize_upload",
          deadlineMs,
          () =>
            client.rpc("resource_finalize_upload", {
              p_resource_id: resourceId,
            }),
          (result) => textAnswerOf(result, FINALIZE_OUTCOMES),
        ),
      abandonUpload: (resourceId) =>
        observedCall(
          "resource_abandon_upload",
          deadlineMs,
          () =>
            client.rpc("resource_abandon_upload", {
              p_resource_id: resourceId,
            }),
          (result) => textAnswerOf(result, ABANDON_OUTCOMES),
        ),
      authorizeAccess: (resourceId, kind) =>
        observedCall(
          "resource_authorize_access",
          deadlineMs,
          () =>
            client.rpc("resource_authorize_access", {
              p_resource_id: resourceId,
              p_resource_kind: kind,
            }),
          (result) => rowAnswerOf(result, ACCESS_OUTCOMES, "object_path"),
        ),
    } satisfies ResourceCalls);
  };
}

export function createVoiceMemoReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<VoiceMemoReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return Object.freeze({
      availableMemoResourcesOf: (intakeId: string) =>
        observedRead("availableMemoResourcesOf", deadlineMs, () =>
          client
            .from("resources")
            .select(VOICE_MEMO_RESOURCE_COLUMNS)
            .eq("intake_id", intakeId)
            .eq("resource_kind", "voice_memo")
            .eq("visibility_state", "available")
            .limit(2),
        ),
      memosOf: (intakeId: string) =>
        observedRead("memosOf", deadlineMs, () =>
          client
            .from("voice_memos")
            .select(VOICE_MEMO_COLUMNS)
            .eq("intake_id", intakeId)
            .limit(20),
        ),
    } satisfies VoiceMemoReads);
  };
}

// The configured voice memo limit in whole seconds: a server-only setting,
// never defaulted. Unset, malformed, or a placeholder is unavailable; the
// application also refuses a limit above the physical ceiling.
export const VOICE_MEMO_LIMIT_SETTING = Object.freeze({
  name: "ROSUNO_VOICE_MEMO_MAX_SECONDS",
  pattern: /^[1-9][0-9]{0,3}$/,
});

export function readVoiceMemoLimit(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): VoiceMemoLimit {
  const configuration = readProviderConfiguration(
    [VOICE_MEMO_LIMIT_SETTING],
    environment,
  );
  return configuration.kind === "configured"
    ? Object.freeze({
        kind: "configured",
        maxSeconds: Number(configuration.values[VOICE_MEMO_LIMIT_SETTING.name]),
      })
    : Object.freeze({ kind: "unavailable" });
}

export const sha256ContentDigest: ContentDigest = async (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The shared privileged storage port with each call bounded in time. A
// failed, refused, or slow call answers false or null and writes one log
// line naming only the operation and how it failed.
export function createStorageSource(
  source: () => Promise<ProtectedStorage | null> = createProtectedStoragePort,
  deadlineMs: number = STORAGE_DEADLINE_MS,
): () => Promise<ProtectedStorage | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const port = await withinDeadline(source, null, deadlineMs);
    if (port === null || typeof port !== "object") {
      await logRequestEvent("warn", CALL_FAILED, {
        operation: "storage",
        outcome: "unavailable",
      });
      return null;
    }
    return Object.freeze({
      store: async (resourceId, bytes, type) => {
        const stored = await withinDeadline(
          async () => (await port.store(resourceId, bytes, type)) === true,
          false,
          deadlineMs,
        );
        if (!stored) {
          await logRequestEvent("warn", CALL_FAILED, {
            operation: "storageStore",
            outcome: "failed",
          });
        }
        return stored;
      },
      signedUrl: async (resourceId, disposition) => {
        const url = await withinDeadline(
          () => port.signedUrl(resourceId, disposition),
          null,
          deadlineMs,
        );
        if (typeof url !== "string") {
          await logRequestEvent("warn", CALL_FAILED, {
            operation: "storageSign",
            outcome: "failed",
          });
          return null;
        }
        return url;
      },
    } satisfies ProtectedStorage);
  };
}

export const PROTECTED_RESOURCE_CALLS = createResourceCalls();
export const PROTECTED_STORAGE = createStorageSource();

// The production voice memo sources: the client intake sources, the voice
// memo reads, the resource functions, the storage port, the configured
// limit, and the digest.
export const VOICE_MEMO_SOURCES: VoiceMemoSources = Object.freeze({
  ...CLIENT_INTAKE_SOURCES,
  memoReads: createVoiceMemoReads(),
  resources: PROTECTED_RESOURCE_CALLS,
  storage: PROTECTED_STORAGE,
  limit: () => readVoiceMemoLimit(),
  digest: sha256ContentDigest,
});
