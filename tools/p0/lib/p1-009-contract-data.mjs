import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260918060600_p1_resources_communications_foundation.sql";

export const tables = [
  "resources",
  "documents",
  "voice_memos",
  "resource_sharing_grants",
  "messages",
  "notifications",
  "notification_attempts",
  "operational_jobs",
];

export const columns = {
  resources:
    "id:uuid resource_kind:text owner_user_id:uuid intake_id:uuid consultation_id:uuid storage_bucket:text storage_object_path:text mime_type:text byte_size:bigint content_digest:text visibility_state:text retention_state:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  documents:
    "id:uuid resource_id:uuid document_type:text version_label:text created_at:timestamp_with_time_zone",
  voice_memos:
    "id:uuid resource_id:uuid intake_id:uuid duration_seconds:integer created_at:timestamp_with_time_zone",
  resource_sharing_grants:
    "id:uuid resource_id:uuid recipient_user_id:uuid context_type:text context_id:uuid purpose_code:text granted_at:timestamp_with_time_zone expires_at:timestamp_with_time_zone revoked_at:timestamp_with_time_zone granted_by_user_id:uuid",
  messages:
    "id:uuid consultation_id:uuid sender_user_id:uuid recipient_user_id:uuid body:text sent_at:timestamp_with_time_zone visibility_state:text created_at:timestamp_with_time_zone",
  notifications:
    "id:uuid recipient_user_id:uuid notification_type:text source_event_type:text source_event_id:uuid channel:text state:text critical:boolean ack_required:boolean sent_at:timestamp_with_time_zone delivered_at:timestamp_with_time_zone failed_at:timestamp_with_time_zone created_at:timestamp_with_time_zone",
  notification_attempts:
    "id:uuid notification_id:uuid provider_code:text provider_reference:text attempted_at:timestamp_with_time_zone result:text failure_code:text created_at:timestamp_with_time_zone",
  operational_jobs:
    "id:uuid job_type:text subject_type:text subject_id:uuid state:text available_at:timestamp_with_time_zone locked_at:timestamp_with_time_zone locked_by:text attempt_count:integer max_attempts:integer last_error_code:text last_error_message:text completed_at:timestamp_with_time_zone failed_at:timestamp_with_time_zone created_at:timestamp_with_time_zone",
};

export const required = {
  resources:
    "id resource_kind owner_user_id storage_bucket storage_object_path visibility_state retention_state created_at updated_at",
  documents: "id resource_id created_at",
  voice_memos: "id resource_id intake_id created_at",
  resource_sharing_grants:
    "id resource_id recipient_user_id context_type context_id purpose_code granted_at granted_by_user_id",
  messages:
    "id consultation_id sender_user_id recipient_user_id body sent_at visibility_state created_at",
  notifications:
    "id recipient_user_id notification_type source_event_type channel state critical ack_required created_at",
  notification_attempts:
    "id notification_id provider_code attempted_at result created_at",
  operational_jobs:
    "id job_type state available_at attempt_count max_attempts created_at",
};

export function readMigrationSql() {
  return readFileSync(
    new URL("../../../" + migrationPath, import.meta.url),
    "utf8",
  );
}
