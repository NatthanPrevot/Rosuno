// Trusted Attorney principal source (P3-001).
//
// Implements the existing PrincipalContextSource port for the unchanged
// Security Shell, which passes in the subject of the trusted server session,
// and the attorney workspace adapter's one-read principal port. It reports
// the attorney context only when a fresh authenticated read of the request's
// own Auth session names exactly that subject with a confirmed email, that
// subject's one Rosuno User is active, and that User holds exactly one linked
// Attorney Profile whose lifecycle state is applicant, under_review, or
// approved. Reads go through the request-scoped, unprivileged server client,
// under the database's own-row policies, keyed only by the trusted subject and
// the User row it names; no privileged credential is used and nothing is
// written. A definite absence (another account, an unconfirmed email, no User,
// a User that is not active, no Attorney Profile, or a suspended or removed
// one) reports no context. Anything unreadable, inconsistent, of an unknown
// state, or not answered within the deadline throws a fixed error, which the
// Security Shell turns into "unavailable". Role and identity never come from
// Auth metadata, email text, request input, or a caller-supplied identifier.
// It resolves the attorney context only: it never reports a client or staff
// context, never removes one another source reports, never changes a User,
// and asserts no capability. An admitted lifecycle state, approved included,
// is not professional verification, current eligibility, or bookability.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isAttorneyWorkspaceStage,
  type AttorneyPrincipal,
  type AttorneyPrincipalSource,
  type AttorneyWorkspaceStage,
} from "../../application/attorney-access.ts";
import type { PrincipalContext } from "../../application/security.ts";

type PrincipalReadClient = Pick<SupabaseClient, "auth" | "from">;

type ReadClientSource = () => Promise<PrincipalReadClient | null>;

async function createDefaultReadClient(): Promise<PrincipalReadClient | null> {
  const { createSupabaseServerClient } = await import("./supabase-server.ts");

  return createSupabaseServerClient();
}

// The longest one resolution may take before it is treated as unavailable.
const RESOLUTION_DEADLINE_MS = 8000;

// User account states other than active. Each one definitely holds no
// attorney context; any other value is unreadable.
const INACTIVE_ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "suspended",
  "closed",
] as const);

// Attorney Profile states that definitely hold no workspace access. Any value
// that is neither one of these nor an admitted stage is unreadable.
const REFUSED_PROFILE_STATES = Object.freeze(["suspended", "removed"] as const);

const NO_CONTEXT: readonly PrincipalContext[] = Object.freeze([]);
const ATTORNEY_CONTEXT: readonly PrincipalContext[] = Object.freeze([
  "attorney",
]);

const NO_ATTORNEY: AttorneyPrincipal = Object.freeze({
  contexts: NO_CONTEXT,
  stage: null,
});
const ADMITTED: Readonly<Record<AttorneyWorkspaceStage, AttorneyPrincipal>> =
  Object.freeze({
    applicant: Object.freeze({
      contexts: ATTORNEY_CONTEXT,
      stage: "applicant",
    }),
    under_review: Object.freeze({
      contexts: ATTORNEY_CONTEXT,
      stage: "under_review",
    }),
    approved: Object.freeze({ contexts: ATTORNEY_CONTEXT, stage: "approved" }),
  });

// Thrown for anything that cannot be read, does not add up, or is too slow.
// The message is fixed, and the Security Shell never passes it on.
function unavailable(): Error {
  return new Error("The Attorney principal could not be resolved.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isOneOf(list: readonly string[], value: unknown): boolean {
  return list.some((entry) => entry === value);
}

// The one row of a successful query, or undefined when it found none. A
// failed query, more than one row, or a malformed row cannot be read.
function singleRowOf(result: {
  readonly data: unknown;
  readonly error: unknown;
}): Record<string, unknown> | undefined {
  if (
    result.error !== null ||
    !Array.isArray(result.data) ||
    result.data.length > 1
  ) {
    throw unavailable();
  }
  const row: unknown = result.data[0];
  if (row === undefined) {
    return undefined;
  }
  if (!isRecord(row)) {
    throw unavailable();
  }
  return row;
}

async function attorneyPrincipalOf(
  clientSource: ReadClientSource,
  subject: string,
): Promise<AttorneyPrincipal> {
  if (!isNonEmptyString(subject)) {
    throw unavailable();
  }
  const client = await clientSource();
  if (client === null) {
    throw unavailable();
  }
  // A fresh read of the request's own Auth user, never the session alone, a
  // client-supplied id, or a token field. Confirmation is taken from this
  // read, never from session claims that may be stale.
  const { data, error } = await client.auth.getUser();
  if (error !== null || !isRecord(data?.user)) {
    throw unavailable();
  }
  if (
    data.user.id !== subject ||
    !isNonEmptyString(data.user.email_confirmed_at)
  ) {
    return NO_ATTORNEY;
  }
  const user = singleRowOf(
    await client
      .from("users")
      .select("id, auth_user_id, account_state")
      .eq("auth_user_id", subject)
      .limit(2),
  );
  if (user === undefined) {
    return NO_ATTORNEY;
  }
  if (user.auth_user_id !== subject || !isNonEmptyString(user.id)) {
    throw unavailable();
  }
  if (user.account_state !== "active") {
    if (isOneOf(INACTIVE_ACCOUNT_STATES, user.account_state)) {
      return NO_ATTORNEY;
    }
    throw unavailable();
  }
  // Keyed by the User row read above, so another User's profile, which a
  // separately scoped reviewer could see, is never asked for.
  const profile = singleRowOf(
    await client
      .from("attorney_profiles")
      .select("id, user_id, profile_state")
      .eq("user_id", user.id)
      .limit(2),
  );
  if (profile === undefined) {
    return NO_ATTORNEY;
  }
  if (profile.user_id !== user.id || !isNonEmptyString(profile.id)) {
    throw unavailable();
  }
  const state = profile.profile_state;
  if (isAttorneyWorkspaceStage(state)) {
    return ADMITTED[state];
  }
  if (isOneOf(REFUSED_PROFILE_STATES, state)) {
    return NO_ATTORNEY;
  }
  throw unavailable();
}

// The work's answer, or a fixed rejection once the deadline passes first. A
// late answer is ignored, and the timer never outlives the work.
async function withinDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unavailable()), deadlineMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function createAttorneyPrincipalSource(
  clientSource: ReadClientSource = createDefaultReadClient,
  deadlineMs: number = RESOLUTION_DEADLINE_MS,
): AttorneyPrincipalSource {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new TypeError("a positive whole-millisecond deadline is required");
  }
  // Whatever a read throws is replaced by the fixed error, so no provider
  // detail travels with it. Each call reads afresh; nothing is cached.
  const principalOf = async (subject: string): Promise<AttorneyPrincipal> => {
    try {
      return await withinDeadline(
        attorneyPrincipalOf(clientSource, subject),
        deadlineMs,
      );
    } catch {
      throw unavailable();
    }
  };
  return Object.freeze({
    contextsOf: async (subject: string) =>
      (await principalOf(subject)).contexts,
    principalOf,
  } satisfies AttorneyPrincipalSource);
}

export const ATTORNEY_PRINCIPAL_SOURCE = createAttorneyPrincipalSource();
