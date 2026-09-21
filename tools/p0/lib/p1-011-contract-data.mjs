import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260921051204_p1_compliance_foundation.sql";

export const tables = [
  "audit_events",
  "retention_rules",
  "legal_holds",
  "complaint_cases",
];

export const columns = {
  audit_events:
    "id:uuid actor_user_id:uuid actor_type:text action_code:text resource_type:text resource_id:uuid before_snapshot:jsonb after_snapshot:jsonb reason_code:text policy_references:jsonb jurisdiction_id:uuid occurred_at:timestamp_with_time_zone created_at:timestamp_with_time_zone",
  retention_rules:
    "id:uuid record_class:text jurisdiction_id:uuid policy_version_id:uuid retention_parameters:jsonb effective_from:timestamp_with_time_zone effective_until:timestamp_with_time_zone status:text created_at:timestamp_with_time_zone",
  legal_holds:
    "id:uuid scope_type:text scope_id:uuid status:text reason:text started_at:timestamp_with_time_zone released_at:timestamp_with_time_zone created_by_user_id:uuid released_by_user_id:uuid created_at:timestamp_with_time_zone",
  complaint_cases:
    "id:uuid complainant_user_id:uuid consultation_id:uuid referral_id:uuid jurisdiction_id:uuid state:text category_code:text opened_at:timestamp_with_time_zone resolved_at:timestamp_with_time_zone assigned_to_user_id:uuid resolution_code:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
};

export const required = {
  audit_events:
    "id actor_type action_code resource_type occurred_at created_at",
  retention_rules:
    "id record_class policy_version_id retention_parameters effective_from status created_at",
  legal_holds:
    "id scope_type scope_id status reason started_at created_by_user_id created_at",
  complaint_cases:
    "id complainant_user_id state opened_at created_at updated_at",
};

export const foreignKeyCount = 11;

export function readMigrationSql() {
  return readFileSync(
    new URL("../../../" + migrationPath, import.meta.url),
    "utf8",
  );
}
