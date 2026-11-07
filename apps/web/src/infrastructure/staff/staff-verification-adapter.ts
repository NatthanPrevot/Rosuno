// Server-only staff verification adapter (P3-003).
//
// Builds the staff verification ports for one request. Every read a reviewer
// sees goes through the request-scoped, unprivileged server client, so the
// database's own row policies decide what it returns; the verification
// scope is answered by the database's own has_manage_attorney_verification_
// scope predicate, called through that same session, so it is decided for
// the caller's own Auth identity and never for an id this module passes in.
// Every change is one staff write function called through that same
// request-scoped client (P3-904), so the database derives and locks the
// reviewer's own authority and writes the change and its audit event in one
// transaction; no write sends a reviewer, User, grant, or scope. The
// privileged port is the shared, server-only provisioning boundary's narrow
// staff verification port, now reads only; this module never sees a
// credential or a privileged client, and only bounds each call in time.

import { randomUUID } from "node:crypto";

import {
  rowsResultOf,
  USER_COLUMNS,
  withinDeadline,
} from "../../application/professional-identity.ts";
import {
  DISCIPLINE_COLUMNS,
  EVALUATION_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  isUuid,
  LICENSE_COLUMNS,
  PRACTICE_AREA_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
  subjectColumnOf,
  type SubjectKind,
} from "../../application/professional-records.ts";
import {
  STAFF_PROFILE_COLUMNS,
  type ScopeAnswer,
  type StaffProvisioning,
  type StaffReads,
  type StaffSources,
  type StaffWrites,
} from "../../application/staff-verification.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { createStaffVerificationProvisioning } from "../identity/registration-provisioning.ts";
import {
  boundedPort,
  boundedSource,
  CALL_DEADLINE_MS,
  callWrite,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  NOT_SENT,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";

const MAX_ROWS = 500;

const UNREADABLE_SCOPE: ScopeAnswer = Object.freeze({ kind: "unreadable" });

const TABLES: Readonly<Record<SubjectKind, readonly [string, string]>> =
  Object.freeze({
    license: ["licenses", LICENSE_COLUMNS],
    insurance: ["insurance_records", INSURANCE_COLUMNS],
    discipline: ["discipline_records", DISCIPLINE_COLUMNS],
    practice_area_authorisation: [
      "practice_area_authorisations",
      PRACTICE_AUTHORISATION_COLUMNS,
    ],
  });

function idList(ids: readonly string[]): readonly string[] | null {
  return ids.length > 0 && ids.length <= MAX_ROWS && ids.every(isUuid)
    ? [...new Set(ids)]
    : null;
}

const NO_ROWS_FOR_BAD_IDS = Object.freeze({ kind: "unreadable" } as const);

export function createStaffReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<StaffReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    const ofAttorney = async (kind: SubjectKind, attorneyId: string) => {
      const [table, columns] = TABLES[kind];
      return rowsResultOf(
        await client
          .from(table)
          .select(columns)
          .eq("attorney_id", attorneyId)
          .order("created_at")
          .limit(MAX_ROWS),
      );
    };
    return boundedPort(
      {
        usersOf: async (accountId: string) =>
          rowsResultOf(
            await client
              .from("users")
              .select(USER_COLUMNS)
              .eq("auth_user_id", accountId)
              .limit(2),
          ),
        staffProfilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("staff_profiles")
              .select(STAFF_PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        ownAttorneyProfilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("attorney_profiles")
              .select(PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        // The one predicate call: exact scope, never the any-jurisdiction
        // mode, and only a boolean answer counts.
        holdsVerificationScope: async (
          jurisdictionId: string | null,
        ): Promise<ScopeAnswer> => {
          if (jurisdictionId !== null && !isUuid(jurisdictionId)) {
            return UNREADABLE_SCOPE;
          }
          const { data, error } = await client.rpc(
            "has_manage_attorney_verification_scope",
            {
              required_jurisdiction: jurisdictionId,
              allow_any_jurisdiction: false,
            },
          );
          return error === null && typeof data === "boolean"
            ? Object.freeze({ kind: "answer", granted: data })
            : UNREADABLE_SCOPE;
        },
        attorneyProfiles: async () =>
          rowsResultOf(
            await client
              .from("attorney_profiles")
              .select(PROFILE_COLUMNS)
              .order("updated_at", { ascending: false })
              .limit(MAX_ROWS),
          ),
        attorneyProfileById: async (attorneyId: string) =>
          rowsResultOf(
            await client
              .from("attorney_profiles")
              .select(PROFILE_COLUMNS)
              .eq("id", attorneyId)
              .limit(2),
          ),
        licensesOf: (attorneyId: string) => ofAttorney("license", attorneyId),
        insuranceOf: (attorneyId: string) =>
          ofAttorney("insurance", attorneyId),
        disciplineOf: (attorneyId: string) =>
          ofAttorney("discipline", attorneyId),
        authorisationsOf: (attorneyId: string) =>
          ofAttorney("practice_area_authorisation", attorneyId),
        pendingAuthorisations: async () =>
          rowsResultOf(
            await client
              .from("practice_area_authorisations")
              .select(PRACTICE_AUTHORISATION_COLUMNS)
              .eq("status", "requested")
              .limit(MAX_ROWS),
          ),
        visibleLicenses: async () =>
          rowsResultOf(
            await client
              .from("licenses")
              .select(LICENSE_COLUMNS)
              .order("created_at")
              .limit(MAX_ROWS),
          ),
        recordById: async (kind: SubjectKind, recordId: string) => {
          const [table, columns] = TABLES[kind];
          return rowsResultOf(
            await client
              .from(table)
              .select(columns)
              .eq("id", recordId)
              .limit(2),
          );
        },
        evidenceSubjectsFor: async (
          kind: SubjectKind,
          recordIds: readonly string[],
        ) => {
          const ids = idList(recordIds);
          return ids === null
            ? NO_ROWS_FOR_BAD_IDS
            : rowsResultOf(
                await client
                  .from("verification_evidence_subjects")
                  .select(EVIDENCE_SUBJECT_COLUMNS)
                  .in(subjectColumnOf(kind), ids)
                  .limit(MAX_ROWS),
              );
        },
        evidenceByIds: async (evidenceIds: readonly string[]) => {
          const ids = idList(evidenceIds);
          return ids === null
            ? NO_ROWS_FOR_BAD_IDS
            : rowsResultOf(
                await client
                  .from("verification_evidence")
                  .select(EVIDENCE_COLUMNS)
                  .in("id", ids)
                  .limit(MAX_ROWS),
              );
        },
        evaluationsOf: async (attorneyId: string) =>
          rowsResultOf(
            await client
              .from("eligibility_evaluations")
              .select(EVALUATION_COLUMNS)
              .eq("attorney_id", attorneyId)
              .order("evaluated_at", { ascending: false })
              .limit(MAX_ROWS),
          ),
        practiceAreas: async () =>
          rowsResultOf(
            await client
              .from("practice_areas")
              .select(PRACTICE_AREA_COLUMNS)
              .order("name")
              .limit(MAX_ROWS),
          ),
      } satisfies StaffReads,
      deadlineMs,
    );
  };
}

export function createBoundedStaffProvisioning(
  shared: () => Promise<StaffProvisioning | null> = () =>
    createStaffVerificationProvisioning(),
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<StaffProvisioning | null> {
  return boundedSource(shared, deadlineMs);
}

// The exact keys of one evaluation row as the assessment builds it. The
// evaluation time is the database's own and is not sent.
const EVALUATION_ROW_KEYS = Object.freeze([
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

function hasExactKeys(
  row: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(row);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

// The staff write port over one request-scoped client: each call is one
// fixed write function with exactly its named arguments. A call that fails,
// throws, or is too slow is unreadable (outcome unknown).
export function createStaffWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<StaffWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        recordFinding: (write) =>
          callWrite(client, "staff_record_verification_finding", {
            p_evidence_id: write.evidenceId,
            p_subject_kind: write.subjectKind,
            p_subject_id: write.subjectId,
            p_expected_updated_at: write.expectedUpdatedAt,
            p_source_type: write.evidence.source_type,
            p_source_uri: write.evidence.source_uri,
            p_source_reference: write.evidence.source_reference,
            p_retrieved_at: write.evidence.retrieved_at,
            p_verification_method: write.evidence.verification_method,
            p_evidence_summary: write.evidence.evidence_summary,
            p_evidence_digest: write.evidence.evidence_digest,
            p_discrepancy_flag: write.evidence.discrepancy_flag,
            p_observed_status: write.observedStatus,
            p_discipline_status: write.disciplineStatus,
            p_resolved_at: write.resolvedAt,
          }),
        recordSourceUnavailable: (subjectKind, subjectId, note) =>
          callWrite(client, "staff_record_source_unavailable", {
            p_subject_kind: subjectKind,
            p_subject_id: subjectId,
            p_note: note,
          }),
        recordDisciplineFinding: (write) =>
          callWrite(client, "staff_record_discipline_finding", {
            p_discipline_id: write.disciplineId,
            p_evidence_id: write.evidenceId,
            p_attorney_id: write.attorneyId,
            p_jurisdiction_id: write.record.jurisdiction_id,
            p_external_reference: write.record.external_reference,
            p_finding_type: write.record.finding_type,
            p_opened_at: write.record.opened_at,
            p_resolved_at: write.record.resolved_at,
            p_status: write.record.status,
            p_source_type: write.evidence.source_type,
            p_source_uri: write.evidence.source_uri,
            p_source_reference: write.evidence.source_reference,
            p_retrieved_at: write.evidence.retrieved_at,
            p_verification_method: write.evidence.verification_method,
            p_evidence_summary: write.evidence.evidence_summary,
            p_evidence_digest: write.evidence.evidence_digest,
            p_discrepancy_flag: write.evidence.discrepancy_flag,
          }),
        decidePracticeArea: (
          authorisationId,
          expectedUpdatedAt,
          decision,
          note,
        ) =>
          callWrite(client, "staff_decide_practice_area", {
            p_authorisation_id: authorisationId,
            p_expected_updated_at: expectedUpdatedAt,
            p_decision: decision.status,
            p_effective_from: decision.effective_from,
            p_effective_until: decision.effective_until,
            p_note: note,
          }),
        changeProfileStage: (attorneyId, intent, message, note) =>
          callWrite(client, "staff_change_profile_stage", {
            p_attorney_id: attorneyId,
            p_intent: intent,
            p_message: message,
            p_note: note,
          }),
        // A malformed row is refused here, before anything is sent.
        recordEvaluation: async (row) =>
          !hasExactKeys(row, EVALUATION_ROW_KEYS)
            ? NOT_SENT
            : callWrite(client, "staff_record_eligibility_evaluation", {
                p_evaluation_id: row.id,
                p_attorney_id: row.attorney_id,
                p_jurisdiction_id: row.jurisdiction_id,
                p_context_type: row.context_type,
                p_context_id: row.context_id,
                p_as_of: row.as_of,
                p_result: row.result,
                p_factor_results: row.factor_results,
                p_policy_references: row.policy_references,
                p_evidence_references: row.evidence_references,
              }),
      } satisfies StaffWrites,
      deadlineMs,
    );
  };
}

// The trusted wiring for one request of the staff verification workspace.
export const STAFF_VERIFICATION_SOURCES: StaffSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  account: createRequestAccountSource(),
  reads: createStaffReads(),
  provisioning: createBoundedStaffProvisioning(),
  writes: createStaffWrites(),
  clock: () => Date.now(),
  newId: () => randomUUID(),
});
