// Server-only attorney professional setup adapter (P3-003, P3-904).
//
// Builds the attorney professional setup ports for one request. Reads of the
// attorney's own User, profile, claims, and requests go through the
// request-scoped, unprivileged server client under the database's own-row
// policies, keyed only by the verified account, User, and profile ids the
// application boundary derives. Every change is one attorney write function
// called through that same request-scoped client, so the database decides
// the actor from the request's own authenticated session and writes the
// change and its audit event in one transaction; no write sends an actor,
// User, or profile id. The privileged port is the shared, server-only
// provisioning boundary's narrow professional port, now reads only, which
// alone reads the privileged credential and verifies the project binding;
// this module never sees a credential or a privileged client, and only
// bounds each call in time. Every call answers within its deadline; anything
// that fails, throws, or is too slow is reported as unreadable.

import { randomUUID } from "node:crypto";

import type {
  AttorneyProfessionalProvisioning,
  AttorneyProfessionalReads,
  AttorneyProfessionalSources,
  AttorneyProfessionalWrites,
} from "../../application/attorney-professional.ts";
import {
  rowsResultOf,
  USER_COLUMNS,
  withinDeadline,
} from "../../application/professional-identity.ts";
import {
  INSURANCE_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AREA_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
} from "../../application/professional-records.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { createAttorneyProfessionalProvisioning } from "../identity/registration-provisioning.ts";
import {
  boundedPort,
  boundedSource,
  CALL_DEADLINE_MS,
  callWrite,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  type RequestClientSource,
} from "./professional-request-client.ts";

const MAX_ROWS = 200;

export function createAttorneyProfessionalReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyProfessionalReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    const own = async (
      table: "licenses" | "insurance_records" | "practice_area_authorisations",
      columns: string,
      attorneyId: string,
    ) =>
      rowsResultOf(
        await client
          .from(table)
          .select(columns)
          .eq("attorney_id", attorneyId)
          .order("created_at")
          .limit(MAX_ROWS),
      );
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
        profilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("attorney_profiles")
              .select(PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        licensesOf: (attorneyId: string) =>
          own("licenses", LICENSE_COLUMNS, attorneyId),
        insuranceOf: (attorneyId: string) =>
          own("insurance_records", INSURANCE_COLUMNS, attorneyId),
        authorisationsOf: (attorneyId: string) =>
          own(
            "practice_area_authorisations",
            PRACTICE_AUTHORISATION_COLUMNS,
            attorneyId,
          ),
        practiceAreas: async () =>
          rowsResultOf(
            await client
              .from("practice_areas")
              .select(PRACTICE_AREA_COLUMNS)
              .order("name")
              .limit(MAX_ROWS),
          ),
      } satisfies AttorneyProfessionalReads,
      deadlineMs,
    );
  };
}

export function createBoundedProfessionalProvisioning(
  shared: () => Promise<AttorneyProfessionalProvisioning | null> = () =>
    createAttorneyProfessionalProvisioning(),
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyProfessionalProvisioning | null> {
  return boundedSource(shared, deadlineMs);
}

// The attorney write port over one request-scoped client: each call is one
// fixed write function with exactly its named arguments. A call that fails,
// throws, or is too slow is unreadable (outcome unknown).
export function createAttorneyProfessionalWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyProfessionalWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        saveProfileDetails: (expectedStage, details) =>
          callWrite(client, "attorney_save_profile_details", {
            p_expected_state: expectedStage,
            p_display_name: details.display_name,
            p_headline: details.headline,
            p_bio: details.bio,
            p_years_experience: details.years_experience,
          }),
        saveLicense: (licenseId, expectedUpdatedAt, claim) =>
          callWrite(client, "attorney_save_license_claim", {
            p_license_id: licenseId,
            p_expected_updated_at: expectedUpdatedAt,
            p_jurisdiction_id: claim.jurisdiction_id,
            p_license_number: claim.license_number,
            p_license_type: claim.license_type,
            p_effective_from: claim.effective_from,
            p_effective_until: claim.effective_until,
          }),
        saveInsurance: (recordId, expectedUpdatedAt, claim) =>
          callWrite(client, "attorney_save_insurance_claim", {
            p_record_id: recordId,
            p_expected_updated_at: expectedUpdatedAt,
            p_jurisdiction_id: claim.jurisdiction_id,
            p_carrier_name: claim.carrier_name,
            p_policy_reference: claim.policy_reference,
            p_coverage_type: claim.coverage_type,
            p_per_occurrence_limit_minor: claim.per_occurrence_limit_minor,
            p_aggregate_limit_minor: claim.aggregate_limit_minor,
            p_currency_code: claim.currency_code,
            p_coverage_from: claim.coverage_from,
            p_coverage_until: claim.coverage_until,
          }),
        requestPracticeArea: (
          authorisationId,
          jurisdictionId,
          practiceAreaId,
        ) =>
          callWrite(client, "attorney_request_practice_area", {
            p_authorisation_id: authorisationId,
            p_jurisdiction_id: jurisdictionId,
            p_practice_area_id: practiceAreaId,
          }),
        changePracticeAreaRequest: (
          authorisationId,
          intent,
          expectedUpdatedAt,
        ) =>
          callWrite(client, "attorney_change_practice_area_request", {
            p_authorisation_id: authorisationId,
            p_intent: intent,
            p_expected_updated_at: expectedUpdatedAt,
          }),
        submitApplication: () =>
          callWrite(client, "attorney_submit_application", {}),
      } satisfies AttorneyProfessionalWrites,
      deadlineMs,
    );
  };
}

// The trusted wiring for one request of the attorney professional setup.
export const ATTORNEY_PROFESSIONAL_SOURCES: AttorneyProfessionalSources =
  Object.freeze({
    session: SUPABASE_SERVER_SESSION_SOURCE,
    account: createRequestAccountSource(),
    reads: createAttorneyProfessionalReads(),
    provisioning: createBoundedProfessionalProvisioning(),
    writes: createAttorneyProfessionalWrites(),
    clock: () => Date.now(),
    newId: () => randomUUID(),
  });
