import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql";

export const columns = {
  attorney_profiles:
    "id:uuid user_id:uuid display_name:text bio:text headline:text years_experience:smallint response_expectation_seconds:integer profile_state:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  licenses:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid license_number:text license_type:text effective_from:date effective_until:date reported_status:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  insurance_records:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid carrier_name:text policy_reference:text coverage_type:text per_occurrence_limit_minor:bigint aggregate_limit_minor:bigint currency_code:character(3) coverage_from:date coverage_until:date created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  discipline_records:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid external_reference:text finding_type:text opened_at:date resolved_at:date status:text details_reference:jsonb created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  practice_areas: "id:uuid code:text name:text active:boolean",
  practice_area_authorisations:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid practice_area_id:uuid status:text requested_at:timestamp_with_time_zone decided_at:timestamp_with_time_zone effective_from:timestamp_with_time_zone effective_until:timestamp_with_time_zone criteria_policy_version_id:uuid created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  verification_evidence:
    "id:uuid jurisdiction_id:uuid source_type:text source_uri:text source_reference:text retrieved_at:timestamp_with_time_zone retrieved_by_user_id:uuid evidence_summary:text evidence_digest:text verification_method:text discrepancy_flag:boolean retention_class:text created_at:timestamp_with_time_zone",
  eligibility_evaluations:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid context_type:text context_id:uuid evaluated_at:timestamp_with_time_zone policy_references:jsonb result:text factor_results:jsonb evidence_references:jsonb as_of:timestamp_with_time_zone created_at:timestamp_with_time_zone",
  verification_evidence_subjects:
    "id:uuid verification_evidence_id:uuid license_id:uuid insurance_record_id:uuid discipline_record_id:uuid practice_area_authorisation_id:uuid created_at:timestamp_with_time_zone",
};

export const required = {
  attorney_profiles: "id user_id profile_state created_at updated_at",
  licenses:
    "id attorney_id jurisdiction_id license_number created_at updated_at",
  insurance_records: "id attorney_id created_at updated_at",
  discipline_records: "id attorney_id jurisdiction_id created_at updated_at",
  practice_areas: "id code name active",
  practice_area_authorisations:
    "id attorney_id jurisdiction_id practice_area_id status requested_at created_at updated_at",
  verification_evidence: "id retrieved_at discrepancy_flag created_at",
  eligibility_evaluations:
    "id attorney_id jurisdiction_id context_type evaluated_at policy_references result factor_results evidence_references as_of created_at",
  verification_evidence_subjects: "id verification_evidence_id created_at",
};

export const tables = Object.keys(columns);

export function readMigrationSql() {
  return readFileSync(
    new URL(`../../../${migrationPath}`, import.meta.url),
    "utf8",
  );
}
