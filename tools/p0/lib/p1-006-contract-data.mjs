import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260914000658_p1_marketplace_referral_foundation.sql";

export const tables = [
  "referrals",
  "referral_eligible_pool_entries",
  "referral_presentations",
];

export const columns = {
  referrals:
    "id:uuid intake_id:uuid attorney_id:uuid jurisdiction_id:uuid attempt_ordinal:integer allocation_method:text outcome_code:text created_at:timestamp_with_time_zone outcome_recorded_at:timestamp_with_time_zone",
  referral_eligible_pool_entries:
    "id:uuid referral_id:uuid attorney_id:uuid eligibility_evaluation_id:uuid eligible_as_of:timestamp_with_time_zone pool_reason:jsonb created_at:timestamp_with_time_zone",
  referral_presentations:
    "id:uuid referral_id:uuid attorney_id:uuid display_position:integer client_filter_context:jsonb platform_presentation_filter_context:jsonb narrowing_actor:text shown_at:timestamp_with_time_zone created_at:timestamp_with_time_zone",
};

export const required = {
  referrals: "id intake_id jurisdiction_id attempt_ordinal created_at",
  referral_eligible_pool_entries:
    "id referral_id attorney_id eligibility_evaluation_id eligible_as_of created_at",
  referral_presentations:
    "id referral_id attorney_id display_position narrowing_actor shown_at created_at",
};

export function readMigrationSql() {
  return readFileSync(
    new URL("../../../" + migrationPath, import.meta.url),
    "utf8",
  );
}
