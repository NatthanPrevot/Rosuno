// Generates rollback-only P1-010 validation SQL.
// This module never connects to a database and never executes generated SQL.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readMigrationSql, tables } from "./lib/p1-010-contract-data.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `01000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

export function buildRollbackValidation() {
  const statements = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '90s';",
    "SET LOCAL lock_timeout = '5s';",
    readMigrationSql(),
    "SET CONSTRAINTS ALL IMMEDIATE;",
  ];
  const checks = [];
  const add = (sql) => statements.push(sql);
  const check = (name, expression, category = "structure") => {
    add(
      `DO $assert$ BEGIN IF (${expression}) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION ${q(
        name,
      )}; END IF; END $assert$;`,
    );
    checks.push({ name, category });
  };
  const denied = (
    name,
    statement,
    sqlstate = "23514",
    category = "integrity",
  ) => {
    add(
      `DO $deny$ BEGIN BEGIN EXECUTE ${q(
        statement,
      )}; RAISE EXCEPTION 'Expected rejection: %',${q(
        name,
      )}; EXCEPTION WHEN SQLSTATE '${sqlstate}' THEN NULL; END; END $deny$;`,
    );
    checks.push({ name, category });
  };

  check(
    "all five P1-010 relations exist with RLS enabled",
    `(select count(*)
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname in (${tables.map(q).join(",")})
        and c.relkind='r'
        and c.relrowsecurity)=5`,
  );

  check(
    "Payout relation is absent",
    `not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname='payouts'
        and c.relkind in ('r','p')
    )`,
  );

  check(
    "all seventeen concrete P1-010 foreign keys are RESTRICT/RESTRICT",
    `(select count(*)
      from pg_constraint c
      join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='public'
        and t.relname in (
          'fee_calculations',
          'payment_transactions',
          'ledger_entries',
          'reconciliation_exceptions'
        )
        and c.contype='f'
        and c.confupdtype='r'
        and c.confdeltype='r')=17`,
  );

  check(
    "service_role receives no P1-010 DELETE privilege",
    `${tables
      .map(
        (table) =>
          `not has_table_privilege('service_role','public.${table}','DELETE')`,
      )
      .join(" and ")}`,
    "security",
  );

  check(
    "ordinary authenticated role receives no direct P1-010 table privileges",
    `${tables
      .map(
        (table) =>
          `not has_any_column_privilege('authenticated','public.${table}','SELECT,INSERT,UPDATE')
           and not has_table_privilege('authenticated','public.${table}','DELETE')`,
      )
      .join(" and ")}`,
    "security",
  );

  add(`insert into auth.users(id) values
    (${u(101)}),
    (${u(102)});`);

  add(`
insert into public.users(id, auth_user_id, account_state)
values
  (${u(1)}, ${u(101)}, 'active'),
  (${u(2)}, ${u(102)}, 'active');`);

  add(`
insert into public.client_profiles(id, user_id)
values (${u(3)}, ${u(1)});`);

  add(`
insert into public.intakes(id, client_id, state)
values (${u(4)}, ${u(3)}, 'active');`);

  add(`
insert into public.jurisdictions(
  id, code, name, region_type, lifecycle_state
)
values (
  ${u(5)}, 'P1010_TEST', 'P1-010 Test', 'state', 'staged'
);`);

  add(`
insert into public.regulatory_modes(
  id, code, name, status
)
values (
  ${u(6)}, 'P1010_MODE', 'P1-010 Mode', 'validation_only'
);`);

  add(`
insert into public.jurisdiction_regulatory_modes(
  jurisdiction_id,
  regulatory_mode_id,
  active_from,
  active_until,
  approval_status
)
values (
  ${u(5)},
  ${u(6)},
  statement_timestamp() - interval '1 day',
  statement_timestamp() + interval '1 day',
  'validation_only'
);`);

  add(`
insert into public.attorney_profiles(id, user_id, profile_state)
values (${u(7)}, ${u(2)}, 'approved');`);

  add(`
insert into public.policy_types(code, name)
values
  ('referral', 'Referral'),
  ('payment', 'Payment'),
  ('fee', 'Fee'),
  ('payment_flow', 'Payment Flow'),
  ('engagement', 'Engagement'),
  ('cancellation', 'Cancellation'),
  ('refund', 'Refund');`);

  for (const [n, code] of [
    [10, "referral"],
    [11, "payment"],
    [12, "fee"],
    [13, "payment_flow"],
    [14, "engagement"],
    [15, "cancellation"],
    [16, "refund"],
  ]) {
    add(`
insert into public.policy_versions(
  id,
  policy_type_code,
  jurisdiction_id,
  regulatory_mode_id,
  version_label,
  parameters,
  status
)
values (
  ${u(n)},
  ${q(code)},
  ${u(5)},
  ${u(6)},
  'validation-v1',
  '{}'::jsonb,
  'draft'
);`);
  }

  add(`
insert into public.referrals(
  id,
  intake_id,
  attorney_id,
  jurisdiction_id,
  attempt_ordinal,
  allocation_method
)
values (
  ${u(20)},
  ${u(4)},
  ${u(7)},
  ${u(5)},
  1,
  'validation_fixture'
);`);

  add("SET LOCAL ROLE service_role;");

  add(`
insert into public.consultation_requests(
  id,
  intake_id,
  client_id,
  selected_attorney_id,
  referral_id,
  request_path,
  referral_policy_version_id,
  engagement_policy_version_id,
  requested_modality,
  state,
  accepted_at
)
values (
  ${u(21)},
  ${u(4)},
  ${u(3)},
  ${u(7)},
  ${u(20)},
  'instant',
  ${u(10)},
  ${u(14)},
  'video',
  'accepted',
  statement_timestamp()
);`);

  add(`
insert into public.fee_calculations(
  id,
  consultation_request_id,
  fee_policy_version_id,
  attorney_listed_price_minor,
  platform_fee_minor,
  client_fee_minor,
  tax_or_other_required_fee_minor,
  total_client_amount_minor,
  currency_code,
  calculated_at,
  calculation_snapshot
)
values (
  ${u(30)},
  ${u(21)},
  ${u(12)},
  10000,
  500,
  250,
  0,
  10750,
  'USD',
  statement_timestamp(),
  '{"fixture":true}'::jsonb
);`);

  denied(
    "second root Fee Calculation for one Request is rejected",
    `insert into public.fee_calculations(
       id, consultation_request_id, fee_policy_version_id,
       attorney_listed_price_minor, platform_fee_minor, client_fee_minor,
       tax_or_other_required_fee_minor, total_client_amount_minor,
       currency_code, calculated_at, calculation_snapshot
     )
     values (
       ${u(31)}, ${u(21)}, ${u(12)},
       10000, 500, 250, 0, 10750,
       'USD', statement_timestamp(), '{}'::jsonb
     )`,
    "23505",
    "fee_calculation",
  );

  add(`
insert into public.fee_calculations(
  id,
  consultation_request_id,
  fee_policy_version_id,
  attorney_listed_price_minor,
  platform_fee_minor,
  client_fee_minor,
  tax_or_other_required_fee_minor,
  total_client_amount_minor,
  currency_code,
  calculated_at,
  supersedes_fee_calculation_id,
  calculation_snapshot
)
values (
  ${u(32)},
  ${u(21)},
  ${u(12)},
  10000,
  500,
  250,
  0,
  10750,
  'USD',
  statement_timestamp(),
  ${u(30)},
  '{"fixture":"correction"}'::jsonb
);`);

  denied(
    "parallel Fee Calculation successor is rejected",
    `insert into public.fee_calculations(
       id, consultation_request_id, fee_policy_version_id,
       attorney_listed_price_minor, platform_fee_minor, client_fee_minor,
       tax_or_other_required_fee_minor, total_client_amount_minor,
       currency_code, calculated_at, supersedes_fee_calculation_id,
       calculation_snapshot
     )
     values (
       ${u(33)}, ${u(21)}, ${u(12)},
       10000, 500, 250, 0, 10750,
       'USD', statement_timestamp(), ${u(30)}, '{}'::jsonb
     )`,
    "23505",
    "fee_calculation",
  );

  denied(
    "Fee Calculation update is rejected",
    `update public.fee_calculations
     set attorney_listed_price_minor=9999
     where id=${u(32)}`,
    "42501",
    "privileges",
  );

  add(`
insert into public.payment_transactions(
  id,
  fee_calculation_id,
  consultation_request_id,
  jurisdiction_id,
  regulatory_mode_id,
  referral_policy_version_id,
  payment_policy_version_id,
  fee_policy_version_id,
  payment_flow_policy_version_id,
  engagement_policy_version_id,
  cancellation_policy_version_id,
  refund_policy_version_id,
  state,
  amount_authorized_minor,
  currency_code,
  provider_code
)
values (
  ${u(40)},
  ${u(32)},
  ${u(21)},
  ${u(5)},
  ${u(6)},
  ${u(10)},
  ${u(11)},
  ${u(12)},
  ${u(13)},
  ${u(14)},
  ${u(15)},
  ${u(16)},
  'validation_pending',
  10750,
  'USD',
  'validation_provider'
);`);

  denied(
    "Payment Transaction wrong policy type is rejected",
    `insert into public.payment_transactions(
       id, fee_calculation_id, consultation_request_id,
       jurisdiction_id, regulatory_mode_id,
       referral_policy_version_id, payment_policy_version_id,
       fee_policy_version_id, payment_flow_policy_version_id,
       engagement_policy_version_id, cancellation_policy_version_id,
       refund_policy_version_id, state, currency_code, provider_code
     )
     values (
       ${u(41)}, ${u(32)}, ${u(21)},
       ${u(5)}, ${u(6)},
       ${u(10)}, ${u(12)},
       ${u(12)}, ${u(13)},
       ${u(14)}, ${u(15)}, ${u(16)},
       'invalid', 'USD', 'validation_provider'
     )`,
    "23514",
    "provenance",
  );

  denied(
    "Payment Transaction provenance update is rejected",
    `update public.payment_transactions
     set payment_policy_version_id=${u(12)}
     where id=${u(40)}`,
    "42501",
    "provenance",
  );

  add(`
insert into public.consultations(
  id,
  consultation_request_id,
  client_id,
  attorney_id,
  request_path,
  referral_policy_version_id,
  fee_policy_version_id,
  engagement_policy_version_id,
  cancellation_policy_version_id,
  modality,
  state
)
values (
  ${u(50)},
  ${u(21)},
  ${u(3)},
  ${u(7)},
  'instant',
  ${u(10)},
  ${u(12)},
  ${u(14)},
  ${u(15)},
  'video',
  'validation_fixture'
);`);

  add(`
update public.payment_transactions
set consultation_id=${u(50)}
where id=${u(40)};`);

  denied(
    "Payment Transaction Consultation reassignment is rejected",
    `update public.payment_transactions
     set consultation_id=null
     where id=${u(40)}`,
    "23514",
    "provenance",
  );

  add(`
insert into public.ledger_entries(
  id,
  payment_transaction_id,
  entry_type,
  direction,
  amount_minor,
  currency_code,
  effective_at,
  source_reference,
  reason_code
)
values (
  ${u(60)},
  ${u(40)},
  'validation',
  'credit',
  10750,
  'USD',
  statement_timestamp(),
  'validation-source',
  'validation'
);`);

  denied(
    "Ledger payout_id is NULL-only while Payout is inactive",
    `insert into public.ledger_entries(
       id, payment_transaction_id, payout_id,
       entry_type, direction, amount_minor, currency_code,
       effective_at, source_reference, reason_code
     )
     values (
       ${u(61)}, ${u(40)}, ${u(62)},
       'validation', 'credit', 1, 'USD',
       statement_timestamp(), 'validation-source', 'validation'
     )`,
    "23514",
    "payout",
  );

  denied(
    "Ledger currency mismatch is rejected",
    `insert into public.ledger_entries(
       id, payment_transaction_id,
       entry_type, direction, amount_minor, currency_code,
       effective_at, source_reference, reason_code
     )
     values (
       ${u(63)}, ${u(40)},
       'validation', 'credit', 1, 'EUR',
       statement_timestamp(), 'validation-source', 'validation'
     )`,
    "23514",
    "ledger",
  );

  denied(
    "Ledger update is rejected",
    `update public.ledger_entries
     set amount_minor=1
     where id=${u(60)}`,
    "42501",
    "privileges",
  );

  add(`
insert into public.external_event_receipts(
  id,
  provider_code,
  provider_event_reference,
  event_type,
  received_at,
  processing_state,
  minimal_payload
)
values (
  ${u(70)},
  'validation_provider',
  'event-70',
  'validation',
  statement_timestamp(),
  'received',
  '{"minimal":true}'::jsonb
);`);

  denied(
    "duplicate provider event receipt is rejected",
    `insert into public.external_event_receipts(
       id, provider_code, provider_event_reference,
       event_type, received_at, processing_state
     )
     values (
       ${u(71)}, 'validation_provider', 'event-70',
       'validation', statement_timestamp(), 'received'
     )`,
    "23505",
    "provider",
  );

  add("RESET ROLE;");

  add("ROLLBACK;");

  return {
    sql: statements.join("\n\n") + "\n",
    checks,
  };
}

const directExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (directExecution) {
  const outputPath = process.argv[2];

  if (!outputPath) {
    throw new Error("P1-010 rollback generator requires an output path");
  }

  writeFileSync(outputPath, buildRollbackValidation().sql, "utf8");
}
