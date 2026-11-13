// Fresh server-side identity for professional operations (P3-003).
//
// Shared by the attorney professional setup and the staff verification
// workspace. For the current request it establishes, from nothing the
// browser sends, the trusted session subject, a fresh read of that same Auth
// account with a confirmed email, and that account's one Rosuno User in the
// active state. Each step fails closed with a fixed refusal that carries no
// identifier or provider detail. Role, identity, and confirmation never come
// from Auth metadata, email text, request input, or a caller-supplied id.

import { resolveSession, type ServerSessionSource } from "./session.ts";
import { isOneOf, isUuid, readExact } from "./professional-records.ts";

// Rows one database operation returned, exactly as reported, or "unreadable"
// when it failed, was refused, timed out, or its outcome is unknown.
export type RowsResult =
  | { readonly kind: "rows"; readonly rows: readonly unknown[] }
  | { readonly kind: "unreadable" };

// One fresh read of the request's own Auth user, exactly as reported.
export type AccountRead =
  | {
      readonly kind: "user";
      readonly id: unknown;
      readonly emailConfirmedAt: unknown;
    }
  | { readonly kind: "unreadable" };

// Request-scoped, unprivileged: reads the request's own Auth user afresh from
// its own session; no identifier is passed in.
export type AccountSource = {
  readonly currentAccount: () => Promise<AccountRead>;
};

export const SIGN_IN_REQUIRED = Object.freeze({
  status: "sign-in-required",
} as const);
export const DENIED = Object.freeze({ status: "denied" } as const);
export const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);

export type Refusal =
  typeof SIGN_IN_REQUIRED | typeof DENIED | typeof UNAVAILABLE;

export const USER_COLUMNS = "id, auth_user_id, account_state";

const INACTIVE_ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "suspended",
  "closed",
] as const);

// Runs one port call. A thrown call is an unknown outcome, never an answer.
export async function attempt(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

// The rows of a result, or null when it is unreadable or malformed.
export function rowsOf(result: unknown): readonly unknown[] | null {
  const fields = readExact(result, ["kind", "rows"]);
  const rows = fields?.get("rows");
  if (fields?.get("kind") !== "rows" || !Array.isArray(rows)) {
    return null;
  }
  return Object.freeze([...rows]);
}

// Builds a port for the current request, or null when its configuration or
// project binding is absent, unverifiable, or the source throws.
export async function portFrom<Port>(
  source: () => Promise<Port | null>,
): Promise<Port | null> {
  try {
    const port = await source();
    return port !== null && typeof port === "object" ? port : null;
  } catch {
    return null;
  }
}

// The confirmed Auth account id of the request, or the fixed refusal. A
// fresh read of the request's own Auth user must name exactly the trusted
// session subject, in canonical form, with a confirmed email.
export async function confirmedAccountOf(
  session: ServerSessionSource,
  account: AccountSource,
): Promise<{ readonly accountId: string } | Refusal> {
  let subject: string | null;
  try {
    const resolved = await resolveSession(session);
    subject = resolved.status === "authenticated" ? resolved.subject : null;
  } catch {
    return UNAVAILABLE;
  }
  if (subject === null) {
    return SIGN_IN_REQUIRED;
  }
  const read = await attempt(() => account.currentAccount());
  const user = readExact(read, ["kind", "id", "emailConfirmedAt"]);
  if (user?.get("kind") !== "user") {
    return UNAVAILABLE;
  }
  const confirmedAt = user.get("emailConfirmedAt");
  if (
    user.get("id") !== subject ||
    typeof confirmedAt !== "string" ||
    confirmedAt === ""
  ) {
    return DENIED;
  }
  return isUuid(subject) ? { accountId: subject } : UNAVAILABLE;
}

// The verified account's one Rosuno User, which must be active, read only by
// the exact verified account id. Anything missing is denied; anything
// repeated, unreadable, inconsistent, or of an unknown state is unavailable.
export async function activeUserOf(
  usersOf: (accountId: string) => Promise<RowsResult>,
  accountId: string,
): Promise<{ readonly userId: string } | Refusal> {
  const users = rowsOf(await attempt(() => usersOf(accountId)));
  if (users === null || users.length > 1) {
    return UNAVAILABLE;
  }
  if (users.length === 0) {
    return DENIED;
  }
  const row = readExact(users[0], USER_COLUMNS.split(", "));
  const id = row?.get("id");
  if (row === null || !isUuid(id) || row.get("auth_user_id") !== accountId) {
    return UNAVAILABLE;
  }
  const state = row.get("account_state");
  if (state !== "active") {
    return isOneOf(INACTIVE_ACCOUNT_STATES, state) ? DENIED : UNAVAILABLE;
  }
  return { userId: id };
}

export function isRefusal(value: object): value is Refusal {
  return (
    value === SIGN_IN_REQUIRED || value === DENIED || value === UNAVAILABLE
  );
}

// The work's answer, or the fallback once the deadline passes first or the
// work throws. A late answer is ignored, and the timer never outlives the
// work. Used by the infrastructure adapters to bound every call.
export async function withinDeadline<T>(
  work: () => Promise<T>,
  fallback: T,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs);
  });
  try {
    return await Promise.race([work(), expired]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export const UNREADABLE_ROWS: RowsResult = Object.freeze({
  kind: "unreadable",
});

// A Supabase-style { data, error } answer as rows, or unreadable.
export function rowsResultOf(result: {
  readonly data: unknown;
  readonly error: unknown;
}): RowsResult {
  return result.error === null && Array.isArray(result.data)
    ? Object.freeze({ kind: "rows", rows: Object.freeze([...result.data]) })
    : UNREADABLE_ROWS;
}

// Bounded text from a submitted form: trimmed, without control characters,
// and within length; "" when empty. null means unusable input.
export function textField(
  value: string | undefined,
  maxLength: number,
): string | null {
  if (value === undefined) {
    return "";
  }
  const trimmed = value.trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  return trimmed.length > maxLength ? null : trimmed;
}
