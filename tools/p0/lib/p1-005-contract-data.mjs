import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260911062917_p1_client_intake_ai_foundation.sql";
export const columns = {
  client_profiles:
    "id:uuid user_id:uuid created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  intakes:
    "id:uuid client_id:uuid matter_reference:text state:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone expires_at:timestamp_with_time_zone closed_at:timestamp_with_time_zone",
  ai_suggestions:
    "id:uuid context_type:text context_id:uuid suggestion_type:text suggestion_value:jsonb generated_at:timestamp_with_time_zone model_reference:text presented_at:timestamp_with_time_zone confirmed_at:timestamp_with_time_zone confirmed_by_user_id:uuid rejected_at:timestamp_with_time_zone created_at:timestamp_with_time_zone",
  jurisdiction_assessments:
    "id:uuid intake_id:uuid jurisdiction_id:uuid assessment_basis:text source_type:text ai_suggestion_id:uuid review_status:text created_at:timestamp_with_time_zone reviewed_at:timestamp_with_time_zone reviewed_by_user_id:uuid",
};

export const required = {
  client_profiles: "id user_id created_at updated_at",
  intakes: "id client_id state created_at updated_at",
  ai_suggestions:
    "id context_type context_id suggestion_type suggestion_value generated_at created_at",
  jurisdiction_assessments: "id intake_id jurisdiction_id created_at",
};

export const tables = [
  "client_profiles",
  "intakes",
  "ai_suggestions",
  "jurisdiction_assessments",
];

export function readMigrationSql() {
  return readFileSync(
    new URL(`../../../${migrationPath}`, import.meta.url),
    "utf8",
  );
}
