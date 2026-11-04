// Request-scoped building blocks for the professional adapters (P3-003).
//
// The request's own, unprivileged server client (cookie session, publishable
// key) and two bounds used by the attorney and staff adapters: a fresh read
// of the request's own Auth user, and a time limit on every port call. No
// privileged credential or client is seen here, nothing is cached between
// requests, and nothing the browser sends is read beyond the session cookie
// the server client itself uses.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  UNREADABLE_ROWS,
  withinDeadline,
  type AccountRead,
  type AccountSource,
} from "../../application/professional-identity.ts";

// The request's own server client. The staff adapter alone makes the one
// read-only predicate call through it; the attorney adapter only reads.
export type RequestClient = SupabaseClient;

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
