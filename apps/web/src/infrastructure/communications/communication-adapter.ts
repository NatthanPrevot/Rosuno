// Server-only communication adapter (MVP-001 S10).
//
// Builds the ports of the participants' Consultation communication (Messages
// and shared documents) and of the notification center for one request.
// Every database call goes through the request-scoped, unprivileged server
// client (the publishable key and the request's own cookie session): the
// thread and document reads, the messaging status, the PS-A2 environment
// accessor, sending a Message, starting a document upload, revoking a grant,
// the notification center and an acknowledgement, so the database decides
// the actor, the aal2 session, the Consultation's own participant and the
// recipient from the request's own authenticated session. Each function is
// called by its literal name, exactly once in this module. No privileged
// credential or client is used or seen here, and nothing reads a table
// directly. Every call is bounded in time; anything that fails, throws, or is
// too slow is reported as unreadable, a malformed identifier is refused before
// anything is sent, and each answer is read strictly against its own fixed
// outcomes. Each such failure writes one log line naming the call and how it
// failed (the error code and HTTP status only, MVP-001 D-8), and nothing the
// call carried or answered: never a Message body, a document's bytes, digest,
// path or URL.
//
// The production sources join these ports to the trusted server session, the
// client intake sources (the verified client), the attorney principal source,
// the server-side environment setting, the S3 resource functions and storage
// port, the SHA-256 digest and one bounded worker run.

import {
  BEGIN_DOCUMENT_OUTCOMES,
  REVOKE_OUTCOMES,
  SEND_OUTCOMES,
  type AttorneyCommunicationSources,
  type ClientCommunicationSources,
  type CommunicationReads,
  type CommunicationWrites,
} from "../../application/consultation-communication.ts";
import {
  ACKNOWLEDGE_OUTCOMES,
  type AcknowledgeAnswer,
  type AttorneyCenterSources,
  type CenterReads,
  type CenterWrites,
  type ClientCenterSources,
} from "../../application/notification-center.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import type { ResourceAnswer } from "../../application/protected-resources.ts";
import {
  CLIENT_INTAKE_SOURCES,
  rowAnswerOf,
  textAnswerOf,
} from "../client/client-intake-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import {
  AFTER_COMMIT_BOUNDS,
  drainOperationalJobs,
} from "../jobs/job-worker-adapter.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";
import {
  PROTECTED_RESOURCE_CALLS,
  PROTECTED_STORAGE,
  sha256ContentDigest,
} from "../resources/protected-resource-adapter.ts";

const CALL_FAILED = "communication.call_failed";
const EXPIRED = Symbol("expired");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

const UNREADABLE_ANSWER: ResourceAnswer = Object.freeze({ kind: "unreadable" });
const REJECTED_ANSWER: ResourceAnswer = Object.freeze({ kind: "rejected" });

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

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

// Runs one call within the deadline; a call that threw, failed, or ran out
// of time answers the fallback and writes one log line.
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

type QueryAnswer = { readonly data: unknown; readonly error: unknown };

function observedRead(
  operation: string,
  deadlineMs: number,
  query: () => PromiseLike<QueryAnswer>,
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

function observedWrite(
  operation: string,
  deadlineMs: number,
  call: () => PromiseLike<unknown>,
  read: (result: unknown) => ResourceAnswer,
): Promise<ResourceAnswer> {
  return observed(operation, deadlineMs, UNREADABLE_ANSWER, async () => {
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

async function requestClient(
  clientSource: RequestClientSource,
  deadlineMs: number,
): Promise<RequestClient | null> {
  return withinDeadline(clientSource, null, deadlineMs);
}

export function createCommunicationReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<CommunicationReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await requestClient(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        messages: (consultationId: string) =>
          isId(consultationId)
            ? observedRead("consultation_messages", deadlineMs, () =>
                client.rpc("consultation_messages", {
                  p_consultation_id: consultationId,
                }),
              )
            : Promise.resolve(UNREADABLE_ROWS),
        messaging: (consultationId: string) =>
          isId(consultationId)
            ? observedRead("consultation_messaging", deadlineMs, () =>
                client.rpc("consultation_messaging", {
                  p_consultation_id: consultationId,
                }),
              )
            : Promise.resolve(UNREADABLE_ROWS),
        documents: (consultationId: string) =>
          isId(consultationId)
            ? observedRead("consultation_documents", deadlineMs, () =>
                client.rpc("consultation_documents", {
                  p_consultation_id: consultationId,
                }),
              )
            : Promise.resolve(UNREADABLE_ROWS),
        environmentIdentity: () =>
          observedRead("deployment_environment_identity", deadlineMs, () =>
            client.rpc("deployment_environment_identity"),
          ),
      },
      deadlineMs,
    );
  };
}

export function createCommunicationWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<CommunicationWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await requestClient(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return Object.freeze({
      send: async (consultationId: string, body: string) =>
        isId(consultationId) && typeof body === "string"
          ? observedWrite(
              "message_send",
              deadlineMs,
              () =>
                client.rpc("message_send", {
                  p_consultation_id: consultationId,
                  p_body: body,
                }),
              (result) => rowAnswerOf(result, SEND_OUTCOMES, "message_id"),
            )
          : REJECTED_ANSWER,
      beginDocument: async (start) =>
        isId(start.consultationId)
          ? observedWrite(
              "document_begin_upload",
              deadlineMs,
              () =>
                client.rpc("document_begin_upload", {
                  p_consultation_id: start.consultationId,
                  p_mime_type: start.mimeType,
                  p_byte_size: start.byteSize,
                  p_content_digest: start.contentDigest,
                }),
              (result) =>
                rowAnswerOf(result, BEGIN_DOCUMENT_OUTCOMES, "resource_id"),
            )
          : REJECTED_ANSWER,
      revoke: async (resourceId: string) =>
        isId(resourceId)
          ? observedWrite(
              "document_revoke_sharing",
              deadlineMs,
              () =>
                client.rpc("document_revoke_sharing", {
                  p_resource_id: resourceId,
                }),
              (result) => textAnswerOf(result, REVOKE_OUTCOMES),
            )
          : REJECTED_ANSWER,
    } satisfies CommunicationWrites);
  };
}

export function createCenterReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<CenterReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await requestClient(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        center: () =>
          observedRead("notification_center", deadlineMs, () =>
            client.rpc("notification_center"),
          ),
      },
      deadlineMs,
    );
  };
}

export function createCenterWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<CenterWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await requestClient(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return Object.freeze({
      acknowledge: async (
        notificationId: string,
      ): Promise<AcknowledgeAnswer> => {
        if (!isId(notificationId)) {
          return REJECTED_ANSWER as AcknowledgeAnswer;
        }
        const answer = await observedWrite(
          "notification_acknowledge",
          deadlineMs,
          () =>
            client.rpc("notification_acknowledge", {
              p_notification_id: notificationId,
            }),
          (result) => textAnswerOf(result, ACKNOWLEDGE_OUTCOMES),
        );
        return answer.kind === "answer"
          ? Object.freeze({ kind: "answer", outcome: answer.outcome })
          : (answer as AcknowledgeAnswer);
      },
    } satisfies CenterWrites);
  };
}

const COMMUNICATION_SHARED = Object.freeze({
  reads: createCommunicationReads(),
  writes: createCommunicationWrites(),
  resources: PROTECTED_RESOURCE_CALLS,
  storage: PROTECTED_STORAGE,
  digest: sha256ContentDigest,
  environment: () => readEnvironmentConfiguration(),
  drain: async () => {
    await drainOperationalJobs(AFTER_COMMIT_BOUNDS);
  },
});

export const CLIENT_COMMUNICATION_SOURCES: ClientCommunicationSources =
  Object.freeze({
    ...COMMUNICATION_SHARED,
    clientIntake: CLIENT_INTAKE_SOURCES,
  });

export const ATTORNEY_COMMUNICATION_SOURCES: AttorneyCommunicationSources =
  Object.freeze({
    ...COMMUNICATION_SHARED,
    session: SUPABASE_SERVER_SESSION_SOURCE,
    attorney: ATTORNEY_PRINCIPAL_SOURCE,
  });

const CENTER_SHARED = Object.freeze({
  reads: createCenterReads(),
  writes: createCenterWrites(),
});

export const CLIENT_CENTER_SOURCES: ClientCenterSources = Object.freeze({
  ...CENTER_SHARED,
  clientIntake: CLIENT_INTAKE_SOURCES,
});

export const ATTORNEY_CENTER_SOURCES: AttorneyCenterSources = Object.freeze({
  ...CENTER_SHARED,
  session: SUPABASE_SERVER_SESSION_SOURCE,
  attorney: ATTORNEY_PRINCIPAL_SOURCE,
});
