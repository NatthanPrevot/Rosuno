// Server-only staff verification adapter (P3-003).
//
// Builds the staff verification ports for one request. Every read a reviewer
// sees goes through the request-scoped, unprivileged server client, so the
// database's own row policies decide what it returns; the verification
// scope is answered by the database's own has_manage_attorney_verification_
// scope predicate, called through that same session, so it is decided for
// the caller's own Auth identity and never for an id this module passes in.
// The privileged port is the shared, server-only provisioning boundary's
// narrow staff verification port; this module never sees a credential or a
// privileged client, and only bounds each call in time.

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
} from "../../application/staff-verification.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { createStaffVerificationProvisioning } from "../identity/registration-provisioning.ts";
import {
  boundedPort,
  boundedSource,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
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

// The trusted wiring for one request of the staff verification workspace.
export const STAFF_VERIFICATION_SOURCES: StaffSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  account: createRequestAccountSource(),
  reads: createStaffReads(),
  provisioning: createBoundedStaffProvisioning(),
  clock: () => Date.now(),
});
