import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260914231532_p1_scheduling_request_booking_bookability_foundation.sql";

export const tables = [
  "availability_rules",
  "blackouts",
  "consultation_requests",
  "slot_holds",
  "bookings",
  "instant_availability_intents",
  "bookability_evaluations",
];

export const columns = {
  availability_rules:
    "id:uuid attorney_id:uuid rule_kind:text timezone_name:text weekday:smallint specific_date:date local_start_time:time_without_time_zone local_end_time:time_without_time_zone effective_from:date effective_until:date active:boolean created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  blackouts:
    "id:uuid attorney_id:uuid starts_at:timestamp_with_time_zone ends_at:timestamp_with_time_zone reason_code:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  consultation_requests:
    "id:uuid intake_id:uuid client_id:uuid selected_attorney_id:uuid referral_id:uuid request_path:text referral_policy_version_id:uuid engagement_policy_version_id:uuid requested_modality:text state:text response_deadline_at:timestamp_with_time_zone created_at:timestamp_with_time_zone accepted_at:timestamp_with_time_zone declined_at:timestamp_with_time_zone expired_at:timestamp_with_time_zone cancelled_at:timestamp_with_time_zone",
  slot_holds:
    "id:uuid consultation_request_id:uuid attorney_id:uuid slot_start_at:timestamp_with_time_zone slot_end_at:timestamp_with_time_zone held_at:timestamp_with_time_zone expires_at:timestamp_with_time_zone released_at:timestamp_with_time_zone release_reason:text created_at:timestamp_with_time_zone",
  bookings:
    "id:uuid consultation_id:uuid attorney_id:uuid client_id:uuid starts_at:timestamp_with_time_zone ends_at:timestamp_with_time_zone status:text supersedes_booking_id:uuid created_at:timestamp_with_time_zone superseded_at:timestamp_with_time_zone cancelled_at:timestamp_with_time_zone",
  instant_availability_intents:
    "id:uuid attorney_id:uuid application_session_id:uuid enabled_at:timestamp_with_time_zone expires_at:timestamp_with_time_zone revoked_at:timestamp_with_time_zone created_at:timestamp_with_time_zone",
  bookability_evaluations:
    "id:uuid attorney_id:uuid eligibility_evaluation_id:uuid context_type:text context_id:uuid evaluated_at:timestamp_with_time_zone as_of:timestamp_with_time_zone modality:text presence_observed:boolean presence_trust_method:text instant_intent_observed:boolean slot_start_at:timestamp_with_time_zone slot_end_at:timestamp_with_time_zone availability_basis:jsonb constraint_results:jsonb result:text created_at:timestamp_with_time_zone",
};

export const required = {
  availability_rules:
    "id attorney_id rule_kind timezone_name local_start_time local_end_time active created_at updated_at",
  blackouts: "id attorney_id starts_at ends_at created_at updated_at",
  consultation_requests:
    "id intake_id client_id selected_attorney_id referral_id request_path referral_policy_version_id requested_modality state created_at",
  slot_holds:
    "id consultation_request_id attorney_id slot_start_at slot_end_at held_at expires_at created_at",
  bookings:
    "id consultation_id attorney_id client_id starts_at ends_at status created_at",
  instant_availability_intents:
    "id attorney_id application_session_id enabled_at expires_at created_at",
  bookability_evaluations:
    "id attorney_id eligibility_evaluation_id context_type evaluated_at as_of modality constraint_results result created_at",
};

export function readMigrationSql() {
  return readFileSync(
    new URL("../../../" + migrationPath, import.meta.url),
    "utf8",
  );
}
