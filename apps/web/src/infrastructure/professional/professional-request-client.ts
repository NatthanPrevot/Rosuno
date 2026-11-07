// Request-scoped building blocks for the professional adapters (P3-003).
//
// The request's own, unprivileged server client (cookie session, publishable
// key) and the bounds used by the attorney and staff adapters: a fresh read
// of the request's own Auth user, a time limit on every port call, and the
// strict reading of one write function's answer (P3-904). No privileged
// credential or client is seen here, nothing is cached between requests, and
// nothing the browser sends is read beyond the session cookie the server
// client itself uses.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  WRITE_OUTCOMES,
  type WriteAnswer,
} from "../../application/professional-audit.ts";
import {
  UNREADABLE_ROWS,
  withinDeadline,
  type AccountRead,
  type AccountSource,
} from "../../application/professional-identity.ts";

// The request's own server client. Reads go through it under the row
// policies; the staff adapter makes the read-only scope predicate call
// through it; and every professional write is one write function called
// through it, so the database sees the request's own authenticated session.
export type RequestClient = SupabaseClient;

const REJECTED: WriteAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE_WRITE: WriteAnswer = Object.freeze({ kind: "unreadable" });

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// One write function's answer as the API reported it. A success carrying one
// of the fixed outcomes is that outcome. An HTTP error response carrying a
// database error code means the database raised the error inside the call's
// own transaction, which therefore rolled back: "rejected", nothing
// committed. Connection-class errors (08) and operator interventions (57P)
// are excluded, since they can end a session around its commit. Anything
// else (a transport failure, a gateway error without a database code, a
// malformed body) leaves the outcome unknown.
export function writeAnswerOf(result: unknown): WriteAnswer {
  const error = ownField(result, "error");
  if (error === null) {
    const data = ownField(result, "data");
    const outcome = WRITE_OUTCOMES.find((entry) => entry === data);
    return outcome === undefined
      ? UNREADABLE_WRITE
      : Object.freeze({ kind: "outcome", outcome });
  }
  const code = ownField(error, "code");
  const status = ownField(result, "status");
  return typeof code === "string" &&
    SQLSTATE.test(code) &&
    !code.startsWith("08") &&
    !code.startsWith("57P") &&
    typeof status === "number" &&
    status >= 400 &&
    status <= 599
    ? REJECTED
    : UNREADABLE_WRITE;
}

// A refusal made before anything was sent: nothing can have committed.
export const NOT_SENT: WriteAnswer = REJECTED;

// Calls one named write function with exactly the given named arguments
// through the request's own client and reads its answer strictly.
export async function callWrite(
  client: Pick<RequestClient, "rpc">,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<WriteAnswer> {
  return writeAnswerOf(await client.rpc(name, args));
}

export type RequestClientSource = () => Promise<RequestClient | null>;

export async function createDefaultRequestClient(): Promise<RequestClient | null> {
  const { createSupabaseServerClient } =
    await import("../identity/supabase-server.ts");
  return createSupabaseServerClient();
}

// The longest one call may take before its outcome is treated as unreadable.
export const CALL_DEADLINE_MS = 8000;

export function checkDeadline(deadlineMs: number): void {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new TypeError("a positive whole-millisecond deadline is required");
  }
}

const UNREADABLE_ACCOUNT: AccountRead = Object.freeze({ kind: "unreadable" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A fresh read of the request's own Auth user, never the session alone, a
// caller-supplied id, or a token field. Only the id and confirmation time
// travel on, exactly as reported.
export function createRequestAccountSource(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): AccountSource {
  checkDeadline(deadlineMs);
  const read = async (): Promise<AccountRead> => {
    const client = await clientSource();
    if (client === null) {
      return UNREADABLE_ACCOUNT;
    }
    const { data, error } = await client.auth.getUser();
    if (error !== null || !isRecord(data?.user)) {
      return UNREADABLE_ACCOUNT;
    }
    return Object.freeze({
      kind: "user",
      id: data.user.id,
      emailConfirmedAt: data.user.email_confirmed_at,
    });
  };
  return Object.freeze({
    currentAccount: () => withinDeadline(read, UNREADABLE_ACCOUNT, deadlineMs),
  });
}

// A port whose every call answers a result of a declared kind, of which
// "unreadable" is always one (rows, or a scope answer).
type KindPort = Readonly<
  Record<string, (...args: never[]) => Promise<{ readonly kind: string }>>
>;

// The same port with every call bounded in time: a call that throws, fails,
// or is too slow answers unreadable.
export function boundedPort<Port extends KindPort>(
  port: Port,
  deadlineMs: number,
): Port {
  const bounded: Record<string, unknown> = {};
  for (const [name, call] of Object.entries(port)) {
    bounded[name] = (...args: never[]) =>
      withinDeadline<{ readonly kind: string }>(
        () => call(...args),
        UNREADABLE_ROWS,
        deadlineMs,
      );
  }
  return Object.freeze(bounded) as Port;
}

// A port source whose port, once built, has every call bounded; building it
// is bounded as well, and a missing or unusable port is null.
export function boundedSource<Port extends KindPort>(
  source: () => Promise<Port | null>,
  deadlineMs: number,
): () => Promise<Port | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const port = await withinDeadline(source, null, deadlineMs);
    return port === null || typeof port !== "object"
      ? null
      : boundedPort(port, deadlineMs);
  };
}
