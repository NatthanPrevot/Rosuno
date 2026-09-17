import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260917045031_p1_consultation_engagement_media_foundation.sql";

export const tables = [
  "consultations",
  "engagements",
  "media_rooms",
  "media_sessions",
  "session_participation_records",
];

export const columns = {
  consultations:
    "id:uuid consultation_request_id:uuid client_id:uuid attorney_id:uuid request_path:text referral_policy_version_id:uuid fee_policy_version_id:uuid engagement_policy_version_id:uuid cancellation_policy_version_id:uuid modality:text state:text started_at:timestamp_with_time_zone ended_at:timestamp_with_time_zone outcome_code:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  engagements:
    "id:uuid consultation_id:uuid engagement_policy_version_id:uuid version_number:integer supersedes_engagement_id:uuid effective_at:timestamp_with_time_zone ended_at:timestamp_with_time_zone state:text terms_reference:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  media_rooms:
    "id:uuid consultation_id:uuid modality:text state:text created_at:timestamp_with_time_zone ended_at:timestamp_with_time_zone",
  media_sessions:
    "id:uuid media_room_id:uuid provider_code:text provider_session_reference:text started_at:timestamp_with_time_zone ended_at:timestamp_with_time_zone provider_state:text created_at:timestamp_with_time_zone",
  session_participation_records:
    "id:uuid media_session_id:uuid participant_user_id:uuid joined_at:timestamp_with_time_zone left_at:timestamp_with_time_zone observed_participation:jsonb provider_observation_reference:text created_at:timestamp_with_time_zone",
};

export const required = {
  consultations:
    "id consultation_request_id client_id attorney_id request_path referral_policy_version_id modality state created_at updated_at",
  engagements:
    "id consultation_id engagement_policy_version_id version_number state created_at updated_at",
  media_rooms: "id consultation_id modality state created_at",
  media_sessions:
    "id media_room_id provider_code provider_session_reference created_at",
  session_participation_records:
    "id media_session_id participant_user_id created_at",
};

export function readMigrationSql() {
  return readFileSync(
    new URL("../../../" + migrationPath, import.meta.url),
    "utf8",
  );
}
