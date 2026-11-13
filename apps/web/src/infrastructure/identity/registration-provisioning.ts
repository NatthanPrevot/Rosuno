// Server-only registration provisioning (P2-006), attorney-applicant
// provisioning (P3-002), professional setup and staff verification
// provisioning (P3-003), and quota decision (P2-007).
//
// The only module that reads the privileged project credential. For each
// request it builds a separate, cookie-free Supabase client that is used for
// nothing but Admin creation and rereads of one unconfirmed account and the
// bounded User and Client-profile operations of that account's registration.
// Another such client is used for nothing but the bounded User and Attorney
// Profile reads of an already verified account's attorney application. Two
// more serve only the fixed, exact-key reads of the attorney professional
// setup and the staff verification workspace; neither offers a generic
// query, a write, a removal, or an Admin operation. No privileged client
// writes an attorney profile, professional record, evidence row, evaluation,
// or audit event (P3-904): those changes are made only by the database's own
// operation-specific functions, called through the request's own
// authenticated session, so a privileged credential can never stand in for
// an attorney's or a reviewer's current authority.
// Another makes only the one fixed registration quota decision call. A
// further client, built from
// the publishable key alone and never given the privileged credential, only
// requests signup confirmation emails. No client receives a request cookie or
// Authorization header, stores or refreshes a session, or reaches
// presentation code, and neither the credential nor a client is exported.
// Each is built only after the environment's project binding is verified;
// anything missing, malformed, or unbound reports null or nothing before any
// client exists, so nothing privileged runs.

import { createClient } from "@supabase/supabase-js";

import type { AttorneyApplicationRecords } from "../../application/attorney-application.ts";
import type { AttorneyProfessionalProvisioning } from "../../application/attorney-professional.ts";
import type {
  AccountCreation,
  AccountRead,
  ConfirmationDispatch,
  RegistrationProvisioning,
  RowsResult,
} from "../../application/client-registration.ts";
import {
  AUTHORITY_REFERENCE_COLUMNS,
  ELIGIBILITY_POLICY_TYPE,
  POLICY_VERSION_COLUMNS,
} from "../../application/policy-selection.ts";
import {
  DISCIPLINE_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  isUuid,
  JURISDICTION_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS as ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS,
  subjectColumnOf,
  type SubjectKind,
} from "../../application/professional-records.ts";
import type { StaffProvisioning } from "../../application/staff-verification.ts";

// The four server runtime inputs this module reads, and nothing else. The URL
// and publishable key are the ones the request-scoped session client already
// uses; the expected project reference and the privileged key are server-only
// and are never read from a request, form, header, or cookie.
export type RegistrationEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL: string | undefined;
  readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string | undefined;
  readonly ROSUNO_SUPABASE_ADMIN_KEY: string | undefined;
  readonly ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: string | undefined;
};

type ClientFactory = typeof createClient;

type ProjectBinding = {
  readonly url: string;
  readonly publishableKey: string;
  readonly adminKey: string;
};

function runtimeEnvironment(): RegistrationEnvironment {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ROSUNO_SUPABASE_ADMIN_KEY: process.env.ROSUNO_SUPABASE_ADMIN_KEY,
    ROSUNO_SUPABASE_EXPECTED_PROJECT_REF:
      process.env.ROSUNO_SUPABASE_EXPECTED_PROJECT_REF,
  };
}

const PROJECT_REF = /^[a-z]{20}$/;
// Visible ASCII only: a key with whitespace or anything else is malformed.
const KEY_TEXT = /^[\x21-\x7e]+$/;

// Neither client keeps, refreshes, or looks for a session anywhere. Each
// client gets its own copy of these options.
function clientOptions() {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
}

// Whether a key can be bound to this project for this purpose: a current key
// carrying the purpose's prefix, or a legacy JWT key whose payload names this
// exact project and role. Any other shape cannot be bound and is refused.
function isKeyFor(
  key: unknown,
  projectRef: string,
  role: string,
  prefix: string,
): key is string {
  if (typeof key !== "string" || !KEY_TEXT.test(key)) {
    return false;
  }
  if (key.startsWith(prefix)) {
    return key.length > prefix.length;
  }
  const parts = key.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return (
      payload !== null &&
      typeof payload === "object" &&
      (payload as { readonly ref?: unknown }).ref === projectRef &&
      (payload as { readonly role?: unknown }).role === role
    );
  } catch {
    return false;
  }
}

// The verified binding of all four inputs to the one expected project, or
// null. The URL must be exactly that project's managed HTTPS origin: no other
// host, scheme, port, credentials, path, query, or fragment, and no fallback,
// default project, or inference from the request.
function readProjectBinding(
  environment: RegistrationEnvironment,
): ProjectBinding | null {
  const projectRef = environment.ROSUNO_SUPABASE_EXPECTED_PROJECT_REF;
  if (typeof projectRef !== "string" || !PROJECT_REF.test(projectRef)) {
    return null;
  }
  const origin = `https://${projectRef}.supabase.co`;
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  if (url !== origin && url !== `${origin}/`) {
    return null;
  }
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const adminKey = environment.ROSUNO_SUPABASE_ADMIN_KEY;
  if (
    !isKeyFor(publishableKey, projectRef, "anon", "sb_publishable_") ||
    !isKeyFor(adminKey, projectRef, "service_role", "sb_secret_") ||
    adminKey === publishableKey
  ) {
    return null;
  }
  return Object.freeze({ url: origin, publishableKey, adminKey });
}

const REJECTED: AccountCreation = Object.freeze({ kind: "rejected" });
const UNKNOWN: AccountCreation = Object.freeze({ kind: "unknown" });
const UNREADABLE_ACCOUNT: AccountRead = Object.freeze({ kind: "unreadable" });
const UNREADABLE_ROWS: RowsResult = Object.freeze({ kind: "unreadable" });

const USER_COLUMNS = "id, auth_user_id, account_state";
const PROFILE_COLUMNS = "id, user_id";

type ProviderUser = {
  readonly id?: unknown;
  readonly email?: unknown;
  readonly email_confirmed_at?: unknown;
} | null;

function accountRecordOf(user: ProviderUser) {
  return Object.freeze({
    id: user?.id,
    email: user?.email,
    emailConfirmedAt: user?.email_confirmed_at,
  });
}

function rowsResultOf(result: {
  readonly data: unknown;
  readonly error: unknown;
}): RowsResult {
  return result.error === null && Array.isArray(result.data)
    ? Object.freeze({ kind: "rows", rows: Object.freeze([...result.data]) })
    : UNREADABLE_ROWS;
}

export async function createRegistrationProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<RegistrationProvisioning | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    // email_confirm stays false: the account is unconfirmed, no email is sent
    // by creation, and no session is started. Only a definite client error
    // means nothing was created; anything else leaves the outcome unknown.
    createAccount: async ({ email, password }) => {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: false,
      });
      if (error !== null) {
        return typeof error.status === "number" &&
          error.status >= 400 &&
          error.status < 500
          ? REJECTED
          : UNKNOWN;
      }
      return data.user === null
        ? UNKNOWN
        : Object.freeze({
            kind: "created",
            account: accountRecordOf(data.user),
          });
    },
    readAccount: async (accountId) => {
      const { data, error } = await admin.auth.admin.getUserById(accountId);
      return error !== null || data.user === null
        ? UNREADABLE_ACCOUNT
        : Object.freeze({
            kind: "account",
            account: accountRecordOf(data.user),
          });
    },
    usersOf: async (accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .select(USER_COLUMNS)
          .eq("auth_user_id", accountId)
          .limit(2),
      ),
    insertPendingUser: async (accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .insert({
            auth_user_id: accountId,
            account_state: "pending_verification",
          })
          .select(USER_COLUMNS),
      ),
    clientProfilesOf: async (userId) =>
      rowsResultOf(
        await admin
          .from("client_profiles")
          .select(PROFILE_COLUMNS)
          .eq("user_id", userId)
          .limit(2),
      ),
    insertClientProfile: async (userId) =>
      rowsResultOf(
        await admin
          .from("client_profiles")
          .insert({ user_id: userId })
          .select(PROFILE_COLUMNS),
      ),
    activatePendingUser: async (userId, accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .update({ account_state: "active" })
          .eq("id", userId)
          .eq("auth_user_id", accountId)
          .eq("account_state", "pending_verification")
          .select(USER_COLUMNS),
      ),
  } satisfies RegistrationProvisioning);
}

export async function createConfirmationDispatch(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<ConfirmationDispatch | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const publicClient = create(
    binding.url,
    binding.publishableKey,
    clientOptions(),
  );
  return Object.freeze({
    // The provider's normal signup confirmation for an existing unconfirmed
    // address, with no caller-chosen redirect.
    requestSignupConfirmation: async (email) => {
      const { error } = await publicClient.auth.resend({
        type: "signup",
        email,
      });
      return error === null;
    },
  } satisfies ConfirmationDispatch);
}

// Whether the environment holds a verified project binding, answered without
// building any client and without returning the binding or a credential. It
// lets a page refrain from offering an action that the privileged boundary
// would certainly refuse (P3-003 correction of the P3-002 entry limitation).
export function hasPrivilegedProjectBinding(
  environment: RegistrationEnvironment = runtimeEnvironment(),
): boolean {
  return readProjectBinding(environment) !== null;
}

// P3-003 professional read ports. Every list read is bounded and every id
// list is checked to hold only canonical ids before it reaches a filter. The
// caller derives each id from a verified server-side read; nothing here takes
// request input, decides authorization, or writes anything.
const MAX_IDS = 500;

function idListOf(ids: readonly string[]): readonly string[] | null {
  return ids.length > 0 && ids.length <= MAX_IDS && ids.every(isUuid)
    ? [...new Set(ids)]
    : null;
}

const EVIDENCE_FLAG_COLUMNS = "id, discrepancy_flag, retrieved_at";
const ATTORNEY_EVALUATION_COLUMNS =
  "id, jurisdiction_id, context_type, context_id, result, evaluated_at";

export async function createAttorneyProfessionalProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<AttorneyProfessionalProvisioning | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jurisdictions: async () =>
      rowsResultOf(
        await admin
          .from("jurisdictions")
          .select(JURISDICTION_COLUMNS)
          .order("code")
          .limit(MAX_IDS),
      ),
    evidenceSubjectsOf: async (kind: SubjectKind, recordIds) => {
      const ids = idListOf(recordIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      const column = subjectColumnOf(kind);
      return rowsResultOf(
        await admin
          .from("verification_evidence_subjects")
          .select(`verification_evidence_id, ${column}`)
          .in(column, ids)
          .limit(MAX_IDS),
      );
    },
    evidenceFlagsOf: async (evidenceIds) => {
      const ids = idListOf(evidenceIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("verification_evidence")
          .select(EVIDENCE_FLAG_COLUMNS)
          .in("id", ids)
          .limit(MAX_IDS),
      );
    },
    evaluationsOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("eligibility_evaluations")
          .select(ATTORNEY_EVALUATION_COLUMNS)
          .eq("attorney_id", attorneyId)
          .order("evaluated_at", { ascending: false })
          .limit(MAX_IDS),
      ),
    // The staff requests for more information about this applicant's own
    // profile, each recorded together with its return to the applicant stage.
    informationRequestsOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("audit_events")
          .select("id, occurred_at, action_code, after_snapshot")
          .eq("resource_type", "attorney_profile")
          .eq("resource_id", attorneyId)
          .eq("action_code", "attorney_information_requested")
          .order("occurred_at", { ascending: false })
          .limit(100),
      ),
  } satisfies AttorneyProfessionalProvisioning);
}

export async function createStaffVerificationProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<StaffProvisioning | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jurisdictions: async () =>
      rowsResultOf(
        await admin
          .from("jurisdictions")
          .select(JURISDICTION_COLUMNS)
          .order("code")
          .limit(MAX_IDS),
      ),
    attorneyProfileOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .select(ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS)
          .eq("id", attorneyId)
          .limit(2),
      ),
    accountStateOf: async (userId) =>
      rowsResultOf(
        await admin
          .from("users")
          .select("id, account_state")
          .eq("id", userId)
          .limit(2),
      ),
    // Each professional table is named literally; the privileged client
    // never receives a table chosen at run time.
    licensesIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("licenses")
          .select(LICENSE_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    insuranceIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("insurance_records")
          .select(INSURANCE_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    disciplineIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("discipline_records")
          .select(DISCIPLINE_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    authorisationsIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("practice_area_authorisations")
          .select(PRACTICE_AUTHORISATION_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    evidenceSubjectsOf: async (kind: SubjectKind, recordIds) => {
      const ids = idListOf(recordIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("verification_evidence_subjects")
          .select(EVIDENCE_SUBJECT_COLUMNS)
          .in(subjectColumnOf(kind), ids)
          .limit(MAX_IDS),
      );
    },
    evidenceOf: async (evidenceIds) => {
      const ids = idListOf(evidenceIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("verification_evidence")
          .select(EVIDENCE_COLUMNS)
          .in("id", ids)
          .limit(MAX_IDS),
      );
    },
    // Only the one eligibility policy type, for exactly one jurisdiction.
    policyVersionsFor: async (policyTypeCode, jurisdictionId) =>
      policyTypeCode !== ELIGIBILITY_POLICY_TYPE
        ? UNREADABLE_ROWS
        : rowsResultOf(
            await admin
              .from("policy_versions")
              .select(POLICY_VERSION_COLUMNS)
              .eq("policy_type_code", ELIGIBILITY_POLICY_TYPE)
              .eq("jurisdiction_id", jurisdictionId)
              .limit(50),
          ),
    authorityReferencesFor: async (versionIds) => {
      const ids = idListOf(versionIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("policy_authority_references")
          .select(AUTHORITY_REFERENCE_COLUMNS)
          .in("policy_version_id", ids)
          .limit(MAX_IDS),
      );
    },
    profileHistoryOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("audit_events")
          .select("occurred_at, action_code, after_snapshot")
          .eq("resource_type", "attorney_profile")
          .eq("resource_id", attorneyId)
          .order("occurred_at", { ascending: false })
          .limit(100),
      ),
  } satisfies StaffProvisioning);
}

const ATTORNEY_PROFILE_COLUMNS = "id, user_id, profile_state";

// Attorney-applicant reads (P3-002), through their own cookie-free privileged
// client: the User of exactly one Auth account id and the Attorney Profile of
// exactly one User id. No insert, update, removal, or Admin operation is
// offered; the one applicant-state creation is the database's own
// attorney_start_application function, called through the request's own
// session (P3-904). The caller derives every id from a verified server-side
// read; nothing here takes request input.
export async function createAttorneyApplicantProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<AttorneyApplicationRecords | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    usersOf: async (accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .select(USER_COLUMNS)
          .eq("auth_user_id", accountId)
          .limit(2),
      ),
    attorneyProfilesOf: async (userId) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .select(ATTORNEY_PROFILE_COLUMNS)
          .eq("user_id", userId)
          .limit(2),
      ),
  } satisfies AttorneyApplicationRecords);
}

// The opaque digests and validated deployment maxima of one quota decision.
type QuotaDigests = {
  readonly ip: string;
  readonly identity: string;
  readonly global: string;
};

type QuotaMaxima = {
  readonly ipPerHour: number;
  readonly identityPerDay: number;
  readonly globalPerHour: number;
};

const DIGEST = /^[0-9a-f]{64}$/;

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function isMaximum(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

// One registration quota decision (P2-007), made by the fixed
// registration_quota_decide database function through its own cookie-free
// privileged client. Only the three opaque digests and three validated
// maxima are sent, under the caller's abort signal; nothing else from the
// request reaches the call. It resolves the function's answer exactly as
// returned, or undefined when the binding or an argument is invalid or the
// call fails, is refused, or is aborted. The database bounds the maxima
// again and owns the clock and windows.
export async function decideQuotaRpc(
  digests: QuotaDigests,
  maxima: QuotaMaxima,
  signal: AbortSignal,
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<unknown> {
  const binding = readProjectBinding(environment);
  if (
    binding === null ||
    !isDigest(digests.ip) ||
    !isDigest(digests.identity) ||
    !isDigest(digests.global) ||
    !isMaximum(maxima.ipPerHour) ||
    !isMaximum(maxima.identityPerDay) ||
    !isMaximum(maxima.globalPerHour)
  ) {
    return undefined;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  const { data, error } = await admin
    .rpc("registration_quota_decide", {
      ip_digest: digests.ip,
      identity_digest: digests.identity,
      global_digest: digests.global,
      ip_max: maxima.ipPerHour,
      identity_max: maxima.identityPerDay,
      global_max: maxima.globalPerHour,
    })
    .abortSignal(signal);
  return error === null ? data : undefined;
}
