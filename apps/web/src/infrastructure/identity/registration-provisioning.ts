// Server-only registration provisioning (P2-006), attorney-applicant
// provisioning (P3-002), professional setup and staff verification
// provisioning (P3-003), and quota decision (P2-007).
//
// The only module that reads the privileged project credential. For each
// request it builds a separate, cookie-free Supabase client that is used for
// nothing but Admin creation and rereads of one unconfirmed account and the
// bounded User and Client-profile operations of that account's registration.
// Another such client is used for nothing but the bounded User and Attorney
// Profile reads, and the one applicant-state Attorney Profile insert, of an
// already verified account's attorney application. Two more serve only the
// fixed, exact-key professional-claim operations of a verified attorney's own
// profile and the fixed staff verification operations that run after the
// caller's own staff authorization; neither offers a generic query, a
// lifecycle value chosen by its caller, a removal, or an Admin operation.
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

import type { AttorneyApplicantProvisioning } from "../../application/attorney-application.ts";
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
  EVALUATION_COLUMNS,
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

// P3-003 professional ports. Every list read is bounded, every id list is
// checked to hold only canonical ids before it reaches a filter, and every
// change is keyed by the verified profile and guarded by the record's
// current state. The caller derives each id from a verified server-side
// read; nothing here takes request input or decides authorization.
const MAX_IDS = 500;

function idListOf(ids: readonly string[]): readonly string[] | null {
  return ids.length > 0 && ids.length <= MAX_IDS && ids.every(isUuid)
    ? [...new Set(ids)]
    : null;
}

const EVIDENCE_FLAG_COLUMNS = "id, discrepancy_flag, retrieved_at";
const ATTORNEY_EVALUATION_COLUMNS =
  "id, jurisdiction_id, context_type, context_id, result, evaluated_at";
const EVALUATION_INSERT_KEYS = Object.freeze([
  "id",
  "attorney_id",
  "jurisdiction_id",
  "context_type",
  "context_id",
  "evaluated_at",
  "as_of",
  "result",
  "factor_results",
  "policy_references",
  "evidence_references",
]);
const AUDIT_KEYS = Object.freeze([
  "actor_user_id",
  "actor_type",
  "action_code",
  "resource_type",
  "resource_id",
  "before_snapshot",
  "after_snapshot",
  "reason_code",
  "policy_references",
  "jurisdiction_id",
  "occurred_at",
]);

// Whether a row to insert holds exactly the expected keys, no more.
function hasExactKeys(
  row: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(row);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

// The only staff profile transitions the staff port performs.
const STAFF_TRANSITIONS = Object.freeze([
  "under_review>approved",
  "under_review>applicant",
  "approved>suspended",
]);

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
    // The applicant's own information requests and the outcome rows of the
    // write-ahead audit protocol for the same profile.
    informationRequestsOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("audit_events")
          .select("id, occurred_at, action_code, after_snapshot")
          .eq("resource_type", "attorney_profile")
          .eq("resource_id", attorneyId)
          .in("action_code", [
            "attorney_information_requested",
            "audited_change_outcome",
          ])
          .order("occurred_at", { ascending: false })
          .limit(100),
      ),
    updateProfileDetails: async (attorneyId, userId, details) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .update({
            display_name: details.display_name,
            headline: details.headline,
            bio: details.bio,
            years_experience: details.years_experience,
          })
          .eq("id", attorneyId)
          .eq("user_id", userId)
          .eq("profile_state", "applicant")
          .select(ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS),
      ),
    insertLicense: async (attorneyId, licenseId, claim) =>
      rowsResultOf(
        await admin
          .from("licenses")
          .insert({
            id: licenseId,
            attorney_id: attorneyId,
            jurisdiction_id: claim.jurisdiction_id,
            license_number: claim.license_number,
            license_type: claim.license_type,
            effective_from: claim.effective_from,
            effective_until: claim.effective_until,
          })
          .select(LICENSE_COLUMNS),
      ),
    // Only an unobserved claim is ever revised: the source-observed status
    // must still be empty, and the row must be exactly the one read.
    updateLicense: async (attorneyId, licenseId, expectedUpdatedAt, claim) =>
      rowsResultOf(
        await admin
          .from("licenses")
          .update({
            jurisdiction_id: claim.jurisdiction_id,
            license_number: claim.license_number,
            license_type: claim.license_type,
            effective_from: claim.effective_from,
            effective_until: claim.effective_until,
          })
          .eq("id", licenseId)
          .eq("attorney_id", attorneyId)
          .eq("updated_at", expectedUpdatedAt)
          .is("reported_status", null)
          .select(LICENSE_COLUMNS),
      ),
    insertInsurance: async (attorneyId, recordId, claim) =>
      rowsResultOf(
        await admin
          .from("insurance_records")
          .insert({
            id: recordId,
            attorney_id: attorneyId,
            jurisdiction_id: claim.jurisdiction_id,
            carrier_name: claim.carrier_name,
            policy_reference: claim.policy_reference,
            coverage_type: claim.coverage_type,
            per_occurrence_limit_minor: claim.per_occurrence_limit_minor,
            aggregate_limit_minor: claim.aggregate_limit_minor,
            currency_code: claim.currency_code,
            coverage_from: claim.coverage_from,
            coverage_until: claim.coverage_until,
          })
          .select(INSURANCE_COLUMNS),
      ),
    updateInsurance: async (attorneyId, recordId, expectedUpdatedAt, claim) =>
      rowsResultOf(
        await admin
          .from("insurance_records")
          .update({
            jurisdiction_id: claim.jurisdiction_id,
            carrier_name: claim.carrier_name,
            policy_reference: claim.policy_reference,
            coverage_type: claim.coverage_type,
            per_occurrence_limit_minor: claim.per_occurrence_limit_minor,
            aggregate_limit_minor: claim.aggregate_limit_minor,
            currency_code: claim.currency_code,
            coverage_from: claim.coverage_from,
            coverage_until: claim.coverage_until,
          })
          .eq("id", recordId)
          .eq("attorney_id", attorneyId)
          .eq("updated_at", expectedUpdatedAt)
          .select(INSURANCE_COLUMNS),
      ),
    insertAuthorisationRequest: async (
      attorneyId,
      authorisationId,
      jurisdictionId,
      practiceAreaId,
      requestedAt,
    ) =>
      rowsResultOf(
        await admin
          .from("practice_area_authorisations")
          .insert({
            id: authorisationId,
            attorney_id: attorneyId,
            jurisdiction_id: jurisdictionId,
            practice_area_id: practiceAreaId,
            status: "requested",
            requested_at: requestedAt,
          })
          .select(PRACTICE_AUTHORISATION_COLUMNS),
      ),
    // Only an undecided request changes, and only between requested and
    // withdrawn; a staff decision is never touched.
    updateAuthorisationRequest: async (
      attorneyId,
      authorisationId,
      expectedStatus,
      expectedUpdatedAt,
      next,
    ) =>
      rowsResultOf(
        await admin
          .from("practice_area_authorisations")
          .update(
            next.status === "withdrawn"
              ? { status: "withdrawn" }
              : { status: "requested", requested_at: next.requestedAt },
          )
          .eq("id", authorisationId)
          .eq("attorney_id", attorneyId)
          .eq(
            "status",
            expectedStatus === "requested" ? "requested" : "withdrawn",
          )
          .eq("updated_at", expectedUpdatedAt)
          .is("decided_at", null)
          .select(PRACTICE_AUTHORISATION_COLUMNS),
      ),
    submitApplication: async (attorneyId, userId) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .update({ profile_state: "under_review" })
          .eq("id", attorneyId)
          .eq("user_id", userId)
          .eq("profile_state", "applicant")
          .select(ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS),
      ),
    insertAuditEvent: async (event) =>
      event.actor_type !== "attorney" || !hasExactKeys(event, AUDIT_KEYS)
        ? UNREADABLE_ROWS
        : rowsResultOf(
            await admin.from("audit_events").insert(event).select("id"),
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
    insertEvidence: async (evidence) =>
      rowsResultOf(
        await admin
          .from("verification_evidence")
          .insert({
            id: evidence.id,
            jurisdiction_id: evidence.jurisdiction_id,
            source_type: evidence.source_type,
            source_uri: evidence.source_uri,
            source_reference: evidence.source_reference,
            retrieved_at: evidence.retrieved_at,
            retrieved_by_user_id: evidence.retrieved_by_user_id,
            evidence_summary: evidence.evidence_summary,
            evidence_digest: evidence.evidence_digest,
            verification_method: evidence.verification_method,
            discrepancy_flag: evidence.discrepancy_flag,
          })
          .select(EVIDENCE_COLUMNS),
      ),
    linkEvidence: async (evidenceId, kind: SubjectKind, recordId) =>
      rowsResultOf(
        await admin
          .from("verification_evidence_subjects")
          .insert({
            verification_evidence_id: evidenceId,
            [subjectColumnOf(kind)]: recordId,
          })
          .select(EVIDENCE_SUBJECT_COLUMNS),
      ),
    recordLicenseObservation: async (
      attorneyId,
      licenseId,
      expectedUpdatedAt,
      reportedStatus,
    ) =>
      rowsResultOf(
        await admin
          .from("licenses")
          .update({ reported_status: reportedStatus })
          .eq("id", licenseId)
          .eq("attorney_id", attorneyId)
          .eq("updated_at", expectedUpdatedAt)
          .select(LICENSE_COLUMNS),
      ),
    insertDiscipline: async (attorneyId, disciplineId, record) =>
      rowsResultOf(
        await admin
          .from("discipline_records")
          .insert({
            id: disciplineId,
            attorney_id: attorneyId,
            jurisdiction_id: record.jurisdiction_id,
            external_reference: record.external_reference,
            finding_type: record.finding_type,
            opened_at: record.opened_at,
            resolved_at: record.resolved_at,
            status: record.status,
          })
          .select(DISCIPLINE_COLUMNS),
      ),
    // A resolved date is only ever added, never cleared.
    updateDisciplineStatus: async (
      attorneyId,
      recordId,
      expectedUpdatedAt,
      status,
      resolvedAt,
    ) =>
      rowsResultOf(
        await admin
          .from("discipline_records")
          .update(
            resolvedAt === null
              ? { status }
              : { status, resolved_at: resolvedAt },
          )
          .eq("id", recordId)
          .eq("attorney_id", attorneyId)
          .eq("updated_at", expectedUpdatedAt)
          .select(DISCIPLINE_COLUMNS),
      ),
    // Only a pending request is decided.
    decideAuthorisation: async (
      attorneyId,
      authorisationId,
      expectedUpdatedAt,
      decision,
    ) =>
      rowsResultOf(
        await admin
          .from("practice_area_authorisations")
          .update({
            status: decision.status === "authorised" ? "authorised" : "refused",
            decided_at: decision.decided_at,
            effective_from: decision.effective_from,
            effective_until: decision.effective_until,
          })
          .eq("id", authorisationId)
          .eq("attorney_id", attorneyId)
          .eq("status", "requested")
          .eq("updated_at", expectedUpdatedAt)
          .select(PRACTICE_AUTHORISATION_COLUMNS),
      ),
    transitionProfile: async (attorneyId, transition) =>
      !STAFF_TRANSITIONS.includes(`${transition.from}>${transition.to}`)
        ? UNREADABLE_ROWS
        : rowsResultOf(
            await admin
              .from("attorney_profiles")
              .update({ profile_state: transition.to })
              .eq("id", attorneyId)
              .eq("profile_state", transition.from)
              .select(ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS),
          ),
    evaluationById: async (evaluationId) =>
      rowsResultOf(
        await admin
          .from("eligibility_evaluations")
          .select(EVALUATION_COLUMNS)
          .eq("id", evaluationId)
          .limit(2),
      ),
    insertEvaluation: async (row) =>
      !hasExactKeys(row, EVALUATION_INSERT_KEYS)
        ? UNREADABLE_ROWS
        : rowsResultOf(
            await admin
              .from("eligibility_evaluations")
              .insert(row)
              .select(EVALUATION_COLUMNS),
          ),
    insertAuditEvent: async (event) =>
      event.actor_type !== "staff" || !hasExactKeys(event, AUDIT_KEYS)
        ? UNREADABLE_ROWS
        : rowsResultOf(
            await admin.from("audit_events").insert(event).select("id"),
          ),
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

// Attorney-applicant provisioning (P3-002), through its own cookie-free
// privileged client. It reads the User of exactly one Auth account id and the
// Attorney Profile of exactly one User id, and inserts at most one Attorney
// Profile for exactly one User id, always in the applicant state. The
// profile's id and timestamps are the database's own defaults, its unique
// User link decides duplicates, and no other column, state, update, removal,
// or Admin operation is offered. The caller derives every id from a verified
// server-side read; nothing here takes request input.
export async function createAttorneyApplicantProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<AttorneyApplicantProvisioning | null> {
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
    // A failed or refused insert, a duplicate included, is unreadable here;
    // the caller decides only from a fresh read afterwards.
    insertApplicantProfile: async (userId) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .insert({ user_id: userId, profile_state: "applicant" })
          .select(ATTORNEY_PROFILE_COLUMNS),
      ),
  } satisfies AttorneyApplicantProvisioning);
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
