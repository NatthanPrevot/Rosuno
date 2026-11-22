// Server-only participant workspace adapter (MVP-001 S11 pass 2B).
//
// Builds the read ports of the client's payment history, account overview
// and Message threads and of the attorney's Message threads, ended
// Consultations, documents and compliance records for one request. Every
// database call goes through the request-scoped, unprivileged server client
// (the publishable key and the request's own cookie session), so the
// database decides the caller, the profile and (for the attorney reads) the
// aal2 session from the request's own authenticated session; no call sends an
// actor, User, profile or record id. Each function is called by its literal
// name, exactly once in this module. No privileged credential or client is
// used or seen here, nothing reads a table directly, and nothing is written.
// Every call is bounded in time; anything that fails, throws, or is too slow
// is reported as unreadable, and a malformed argument is refused before
// anything is sent. Each failure writes one log line naming the call and how
// it failed (the error code and HTTP status only), and nothing the call
// carried or answered.

import { ATTORNEY_PRINCIPAL_SOURCE } from "../identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { CLIENT_INTAKE_SOURCES } from "../client/client-intake-adapter.ts";
import {
  THREAD_ROLES,
  type AttorneyWorkspaceReads,
  type AttorneyWorkspaceSources,
  type ClientWorkspaceReads,
  type ClientWorkspaceSources,
  type ThreadRole,
} from "../../application/participant-workspaces.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
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

const CALL_FAILED = "workspaces.call_failed";
const EXPIRED = Symbol("expired");
// The client payment list offsets the database pages by (25 rows a page).
const MAX_OFFSET = 100000;

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

type QueryAnswer = { readonly data: unknown; readonly error: unknown };

// One read, bounded in time; a failure is logged with the call's name and
// how it failed only.
async function observedRead(
  operation: string,
  deadlineMs: number,
  query: () => PromiseLike<QueryAnswer>,
): Promise<RowsResult> {
  const settled = await withinDeadline<
    | { readonly rows: RowsResult; readonly failure: LogFields | null }
    | typeof EXPIRED
  >(
    async () => {
      try {
        const result = await query();
        const rows = rowsResultOf(result);
        return {
          rows,
          failure:
            rows.kind === "rows"
              ? null
              : {
                  outcome: result.error === null ? "malformed" : "error",
                  ...failureOf(result),
                },
        };
      } catch (error) {
        return {
          rows: UNREADABLE_ROWS,
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
    return UNREADABLE_ROWS;
  }
  if (settled.failure !== null) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...settled.failure,
    });
  }
  return settled.rows;
}

const isOffset = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_OFFSET &&
  (value as number) % 25 === 0;
const isRole = (value: unknown): value is ThreadRole =>
  THREAD_ROLES.some((role) => role === value);

const refusedRead = () => Promise.resolve(UNREADABLE_ROWS);

// Every call of this module, bound to one request client. Each database
// function is named exactly once, here.
function callsOf(client: RequestClient, deadlineMs: number) {
  return Object.freeze({
    payments: (offset: number) =>
      isOffset(offset)
        ? observedRead("client_payments", deadlineMs, () =>
            client.rpc("client_payments", { p_offset: offset }),
          )
        : refusedRead(),
    overview: () =>
      observedRead("client_account_overview", deadlineMs, () =>
        client.rpc("client_account_overview"),
      ),
    threads: (role: ThreadRole) =>
      isRole(role)
        ? observedRead("consultation_threads", deadlineMs, () =>
            client.rpc("consultation_threads", { p_role: role }),
          )
        : refusedRead(),
    history: () =>
      observedRead("attorney_consultation_history", deadlineMs, () =>
        client.rpc("attorney_consultation_history"),
      ),
    documents: () =>
      observedRead("attorney_documents", deadlineMs, () =>
        client.rpc("attorney_documents"),
      ),
    compliance: () =>
      observedRead("attorney_compliance_records", deadlineMs, () =>
        client.rpc("attorney_compliance_records"),
      ),
  });
}

type Calls = ReturnType<typeof callsOf>;

function portSource<Port extends object>(
  pick: (calls: Calls) => Port,
  clientSource: RequestClientSource,
  deadlineMs: number,
): () => Promise<Port | null> {
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
    return boundedPort(
      pick(callsOf(client, deadlineMs)) as never,
      deadlineMs,
    ) as Port;
  };
}

export function createClientWorkspaceReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientWorkspaceReads | null> {
  return portSource(
    (calls): ClientWorkspaceReads => ({
      payments: calls.payments,
      overview: calls.overview,
      threads: calls.threads,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createAttorneyWorkspaceReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyWorkspaceReads | null> {
  return portSource(
    (calls): AttorneyWorkspaceReads => ({
      threads: calls.threads,
      history: calls.history,
      documents: calls.documents,
      compliance: calls.compliance,
    }),
    clientSource,
    deadlineMs,
  );
}

// The trusted wiring for one request of the client workspace surfaces.
export const CLIENT_WORKSPACE_SOURCES: ClientWorkspaceSources = Object.freeze({
  clientIntake: CLIENT_INTAKE_SOURCES,
  reads: createClientWorkspaceReads(),
});

// The trusted wiring for one request of the attorney workspace surfaces.
export const ATTORNEY_WORKSPACE_SOURCES: AttorneyWorkspaceSources =
  Object.freeze({
    session: SUPABASE_SERVER_SESSION_SOURCE,
    attorney: ATTORNEY_PRINCIPAL_SOURCE,
    reads: createAttorneyWorkspaceReads(),
  });
