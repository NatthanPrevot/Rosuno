import { readFileSync } from "node:fs";

export const migrationPath =
  "supabase/migrations/20260919000112_p1_financial_foundation.sql";

export const tables = [
  "fee_calculations",
  "payment_transactions",
  "ledger_entries",
  "reconciliation_exceptions",
  "external_event_receipts",
];

export const columns = {
  fee_calculations:
    "id:uuid consultation_request_id:uuid fee_policy_version_id:uuid attorney_listed_price_minor:bigint platform_fee_minor:bigint client_fee_minor:bigint tax_or_other_required_fee_minor:bigint total_client_amount_minor:bigint currency_code:character quote_valid_until:timestamp_with_time_zone calculated_at:timestamp_with_time_zone supersedes_fee_calculation_id:uuid calculation_snapshot:jsonb created_at:timestamp_with_time_zone",
  payment_transactions:
    "id:uuid fee_calculation_id:uuid consultation_request_id:uuid consultation_id:uuid jurisdiction_id:uuid regulatory_mode_id:uuid referral_policy_version_id:uuid payment_policy_version_id:uuid fee_policy_version_id:uuid payment_flow_policy_version_id:uuid engagement_policy_version_id:uuid cancellation_policy_version_id:uuid refund_policy_version_id:uuid state:text amount_authorized_minor:bigint amount_captured_minor:bigint amount_refunded_minor:bigint currency_code:character provider_code:text provider_payment_reference:text authorized_at:timestamp_with_time_zone captured_at:timestamp_with_time_zone failed_at:timestamp_with_time_zone created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  ledger_entries:
    "id:uuid payment_transaction_id:uuid payout_id:uuid entry_type:text direction:text amount_minor:bigint currency_code:character effective_at:timestamp_with_time_zone source_reference:text reason_code:text metadata:jsonb created_at:timestamp_with_time_zone",
  reconciliation_exceptions:
    "id:uuid source_type:text source_id:uuid canonical_type:text canonical_id:uuid exception_type:text severity:text detected_at:timestamp_with_time_zone status:text evidence_reference:jsonb assigned_to_user_id:uuid resolved_at:timestamp_with_time_zone resolution_notes:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  external_event_receipts:
    "id:uuid provider_code:text provider_event_reference:text event_type:text received_at:timestamp_with_time_zone processed_at:timestamp_with_time_zone processing_state:text correlation_reference:text payload_digest:text minimal_payload:jsonb created_at:timestamp_with_time_zone",
};

export const required = {
  fee_calculations:
    "id consultation_request_id fee_policy_version_id attorney_listed_price_minor platform_fee_minor client_fee_minor tax_or_other_required_fee_minor total_client_amount_minor currency_code calculated_at calculation_snapshot created_at",
  payment_transactions:
    "id fee_calculation_id consultation_request_id jurisdiction_id regulatory_mode_id referral_policy_version_id payment_policy_version_id fee_policy_version_id payment_flow_policy_version_id engagement_policy_version_id cancellation_policy_version_id refund_policy_version_id state amount_refunded_minor currency_code provider_code created_at updated_at",
  ledger_entries:
    "id entry_type direction amount_minor currency_code effective_at source_reference reason_code created_at",
  reconciliation_exceptions:
    "id source_type canonical_type exception_type severity detected_at status evidence_reference created_at updated_at",
  external_event_receipts:
    "id provider_code provider_event_reference event_type received_at processing_state created_at",
};

export const policyTypes = [
  "referral",
  "payment",
  "fee",
  "payment_flow",
  "engagement",
  "cancellation",
  "refund",
];

export function readMigrationSql() {
  return readFileSync(
    new URL("../../../" + migrationPath, import.meta.url),
    "utf8",
  );
}
