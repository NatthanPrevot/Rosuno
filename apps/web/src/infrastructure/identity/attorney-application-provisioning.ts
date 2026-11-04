// Server-only attorney application adapter (P3-002).
//
// Builds the attorney application ports for one request. The account port
// reads the request's own Auth user afresh through the request-scoped,
// unprivileged server client, and the entry's record port reads that
// account's User and the User's Attorney Profile through the same kind of
// client, under the database's own-row policies, keyed only by the verified
// account id and the User row it names; neither holds a privileged credential
// or writes anything. The applicant provisioning port is the shared,
// server-only provisioning boundary's narrow attorney-applicant port, which
// alone reads the privileged credential, verifies the project binding, and
// builds its cookie-free client; this module never sees a credential or a
// privileged client, and only bounds each of that port's calls in time. Every
// call answers within its deadline, and anything that fails, throws, or is
// too slow is reported as unreadable, with no provider detail. Nothing is
// cached or shared between requests, and nothing the browser sends is read.

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AttorneyApplicantProvisioning,
  AttorneyApplicationAccountRead,
  AttorneyApplicationAccountSource,
  AttorneyApplicationRecords,
  AttorneyApplicationRows,
} from "../../application/attorney-application.ts";
import {
  createAttorneyApplicantProvisioning,
  hasPrivilegedProjectBinding,
} from "./registration-provisioning.ts";

type RequestReadClient = Pick<SupabaseClient, "auth" | "from">;

type RequestClientSource = () => Promise<RequestReadClient | null>;

type ProvisioningSource = () => Promise<AttorneyApplicantProvisioning | null>;

async function createDefaultRequestClient(): Promise<RequestReadClient | null> {
  const { createSupabaseServerClient } = await import("./supabase-server.ts");

  return createSupabaseServerClient();
}

// The longest one call may take before its outcome is treated as unreadable.
const CALL_DEADLINE_MS = 8000;

const UNREADABLE_ACCOUNT: AttorneyApplicationAccountRead = Object.freeze({
  kind: "unreadable",
});
const UNREADABLE_ROWS: AttorneyApplicationRows = Object.freeze({
  kind: "unreadable",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkDeadline(deadlineMs: number): void {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new TypeError("a positive whole-millisecond deadline is required");
  }
}

// The work's answer, or the fallback once the deadline passes first or the
// work throws. A late answer is ignored, and the timer never outlives the
// work.
async function withinDeadline<T>(
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

function rowsResultOf(result: {
  readonly data: unknown;
  readonly error: unknown;
}): AttorneyApplicationRows {
  return result.error === null && Array.isArray(result.data)
    ? Object.freeze({ kind: "rows", rows: Object.freeze([...result.data]) })
    : UNREADABLE_ROWS;
}

// A fresh read of the request's own Auth user, never the session alone, a
// caller-supplied id, or a token field. Only the id and confirmation time
// travel on, exactly as reported.
async function accountReadOf(
  clientSource: RequestClientSource,
): Promise<AttorneyApplicationAccountRead> {
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
}

export function createAttorneyApplicationAccountSource(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): AttorneyApplicationAccountSource {
  checkDeadline(deadlineMs);
  return Object.freeze({
    currentAccount: () =>
      withinDeadline(
        () => accountReadOf(clientSource),
        UNREADABLE_ACCOUNT,
        deadlineMs,
      ),
  } satisfies AttorneyApplicationAccountSource);
}

// The entry's read-only record port over one request-scoped client, or null
// when no client can be built.
export function createAttorneyApplicationRecordSource(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyApplicationRecords | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return Object.freeze({
      usersOf: (accountId) =>
        withinDeadline(
          async () =>
            rowsResultOf(
              await client
                .from("users")
                .select("id, auth_user_id, account_state")
                .eq("auth_user_id", accountId)
                .limit(2),
            ),
          UNREADABLE_ROWS,
          deadlineMs,
        ),
      attorneyProfilesOf: (userId) =>
        withinDeadline(
          async () =>
            rowsResultOf(
              await client
                .from("attorney_profiles")
                .select("id, user_id, profile_state")
                .eq("user_id", userId)
                .limit(2),
            ),
          UNREADABLE_ROWS,
          deadlineMs,
        ),
    } satisfies AttorneyApplicationRecords);
  };
}

// The shared boundary's applicant provisioning port, each call bounded in
// time, or null when that boundary reports no verified binding.
export function createBoundedApplicantProvisioning(
  shared: ProvisioningSource = () => createAttorneyApplicantProvisioning(),
  deadlineMs: number = CALL_DEADLINE_MS,
): ProvisioningSource {
  checkDeadline(deadlineMs);
  return async () => {
    const port = await withinDeadline(shared, null, deadlineMs);
    if (port === null || typeof port !== "object") {
      return null;
    }
    const bounded = (call: () => Promise<AttorneyApplicationRows>) =>
      withinDeadline(call, UNREADABLE_ROWS, deadlineMs);
    return Object.freeze({
      usersOf: (accountId) => bounded(() => port.usersOf(accountId)),
      attorneyProfilesOf: (userId) =>
        bounded(() => port.attorneyProfilesOf(userId)),
      insertApplicantProfile: (userId) =>
        bounded(() => port.insertApplicantProfile(userId)),
    } satisfies AttorneyApplicantProvisioning);
  };
}

export const ATTORNEY_APPLICATION_ACCOUNT =
  createAttorneyApplicationAccountSource();

export const ATTORNEY_APPLICATION_RECORDS =
  createAttorneyApplicationRecordSource();

export const ATTORNEY_APPLICANT_PROVISIONING =
  createBoundedApplicantProvisioning();

// Whether the shared boundary would build the applicant port, answered from
// the binding check alone: no client is built and nothing is sent (P3-003).
export const ATTORNEY_APPLICANT_START_CONFIGURED = async (): Promise<boolean> =>
  hasPrivilegedProjectBinding();
