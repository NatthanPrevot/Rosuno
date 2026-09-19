-- P1-010 local candidate. Unreviewed and unapplied.
-- Physical 1J Financial foundation only.
--
-- Authority: the ten pre-existing current/LOCKED Rosuno authority artifacts
-- plus FP-1:
-- rosuno-financial-provenance-physical-correction-fp-1-LOCKED.md
-- SHA-256 ca7d257b6fbf6081c7bd48194a0d39b6fad7a6a6af0f4191e734f9af0d2af1c0
--
-- G-1 through G-5 remain unresolved. This migration does not interpret
-- jurisdiction_regulatory_modes.approval_status, does not activate Production
-- financial behavior, does not seed policy/business data, and does not create
-- public.payouts.

create table public.fee_calculations (
  id uuid primary key default gen_random_uuid(),
  consultation_request_id uuid not null,
  fee_policy_version_id uuid not null,
  attorney_listed_price_minor bigint not null,
  platform_fee_minor bigint not null,
  client_fee_minor bigint not null,
  tax_or_other_required_fee_minor bigint not null default 0,
  total_client_amount_minor bigint not null,
  currency_code char(3) not null,
  quote_valid_until timestamptz,
  calculated_at timestamptz not null,
  supersedes_fee_calculation_id uuid,
  calculation_snapshot jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint fee_calculations_consultation_request_id_fkey
    foreign key (consultation_request_id)
    references public.consultation_requests (id)
    on update restrict
    on delete restrict,
  constraint fee_calculations_fee_policy_version_id_fkey
    foreign key (fee_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint fee_calculations_supersedes_fee_calculation_id_fkey
    foreign key (supersedes_fee_calculation_id)
    references public.fee_calculations (id)
    on update restrict
    on delete restrict,
  constraint fee_calculations_attorney_price_check
    check (attorney_listed_price_minor >= 0),
  constraint fee_calculations_platform_fee_check
    check (platform_fee_minor >= 0),
  constraint fee_calculations_client_fee_check
    check (client_fee_minor >= 0),
  constraint fee_calculations_other_fee_check
    check (tax_or_other_required_fee_minor >= 0),
  constraint fee_calculations_total_check
    check (total_client_amount_minor >= 0),
  constraint fee_calculations_currency_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint fee_calculations_quote_validity_check
    check (
      quote_valid_until is null
      or quote_valid_until > calculated_at
    ),
  constraint fee_calculations_no_self_supersession_check
    check (
      supersedes_fee_calculation_id is null
      or supersedes_fee_calculation_id <> id
    )
);

alter table public.fee_calculations enable row level security;

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  fee_calculation_id uuid not null,
  consultation_request_id uuid not null,
  consultation_id uuid,
  jurisdiction_id uuid not null,
  regulatory_mode_id uuid not null,
  referral_policy_version_id uuid not null,
  payment_policy_version_id uuid not null,
  fee_policy_version_id uuid not null,
  payment_flow_policy_version_id uuid not null,
  engagement_policy_version_id uuid not null,
  cancellation_policy_version_id uuid not null,
  refund_policy_version_id uuid not null,
  state text not null,
  amount_authorized_minor bigint,
  amount_captured_minor bigint,
  amount_refunded_minor bigint not null default 0,
  currency_code char(3) not null,
  provider_code text not null,
  provider_payment_reference text,
  authorized_at timestamptz,
  captured_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint payment_transactions_fee_calculation_id_fkey
    foreign key (fee_calculation_id)
    references public.fee_calculations (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_consultation_request_id_fkey
    foreign key (consultation_request_id)
    references public.consultation_requests (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_regulatory_mode_id_fkey
    foreign key (regulatory_mode_id)
    references public.regulatory_modes (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_referral_policy_version_id_fkey
    foreign key (referral_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_payment_policy_version_id_fkey
    foreign key (payment_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_fee_policy_version_id_fkey
    foreign key (fee_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_payment_flow_policy_version_id_fkey
    foreign key (payment_flow_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_engagement_policy_version_id_fkey
    foreign key (engagement_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_cancellation_policy_version_id_fkey
    foreign key (cancellation_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_refund_policy_version_id_fkey
    foreign key (refund_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint payment_transactions_state_check
    check (btrim(state) <> ''),
  constraint payment_transactions_authorized_amount_check
    check (
      amount_authorized_minor is null
      or amount_authorized_minor >= 0
    ),
  constraint payment_transactions_captured_amount_check
    check (
      amount_captured_minor is null
      or amount_captured_minor >= 0
    ),
  constraint payment_transactions_refunded_amount_check
    check (amount_refunded_minor >= 0),
  constraint payment_transactions_currency_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint payment_transactions_provider_code_check
    check (btrim(provider_code) <> ''),
  constraint payment_transactions_provider_reference_check
    check (
      provider_payment_reference is null
      or btrim(provider_payment_reference) <> ''
    )
);

alter table public.payment_transactions enable row level security;

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  payment_transaction_id uuid,
  payout_id uuid,
  entry_type text not null,
  direction text not null,
  amount_minor bigint not null,
  currency_code char(3) not null,
  effective_at timestamptz not null,
  source_reference text not null,
  reason_code text not null,
  metadata jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint ledger_entries_payment_transaction_id_fkey
    foreign key (payment_transaction_id)
    references public.payment_transactions (id)
    on update restrict
    on delete restrict,
  constraint ledger_entries_payout_inactive_check
    check (payout_id is null),
  constraint ledger_entries_entry_type_check
    check (btrim(entry_type) <> ''),
  constraint ledger_entries_direction_check
    check (btrim(direction) <> ''),
  constraint ledger_entries_amount_check
    check (amount_minor >= 0),
  constraint ledger_entries_currency_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint ledger_entries_source_reference_check
    check (btrim(source_reference) <> ''),
  constraint ledger_entries_reason_code_check
    check (btrim(reason_code) <> '')
);

alter table public.ledger_entries enable row level security;

create table public.reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id uuid,
  canonical_type text not null,
  canonical_id uuid,
  exception_type text not null,
  severity text not null,
  detected_at timestamptz not null,
  status text not null,
  evidence_reference jsonb not null,
  assigned_to_user_id uuid,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint reconciliation_exceptions_assigned_to_user_id_fkey
    foreign key (assigned_to_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint reconciliation_exceptions_source_type_check
    check (btrim(source_type) <> ''),
  constraint reconciliation_exceptions_canonical_type_check
    check (btrim(canonical_type) <> ''),
  constraint reconciliation_exceptions_exception_type_check
    check (btrim(exception_type) <> ''),
  constraint reconciliation_exceptions_severity_check
    check (btrim(severity) <> ''),
  constraint reconciliation_exceptions_status_check
    check (btrim(status) <> '')
);

alter table public.reconciliation_exceptions enable row level security;

create table public.external_event_receipts (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null,
  provider_event_reference text not null,
  event_type text not null,
  received_at timestamptz not null,
  processed_at timestamptz,
  processing_state text not null,
  correlation_reference text,
  payload_digest text,
  minimal_payload jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint external_event_receipts_provider_event_key
    unique (provider_code, provider_event_reference),
  constraint external_event_receipts_provider_code_check
    check (btrim(provider_code) <> ''),
  constraint external_event_receipts_provider_event_reference_check
    check (btrim(provider_event_reference) <> ''),
  constraint external_event_receipts_event_type_check
    check (btrim(event_type) <> ''),
  constraint external_event_receipts_processing_state_check
    check (btrim(processing_state) <> ''),
  constraint external_event_receipts_correlation_reference_check
    check (
      correlation_reference is null
      or btrim(correlation_reference) <> ''
    ),
  constraint external_event_receipts_payload_digest_check
    check (
      payload_digest is null
      or btrim(payload_digest) <> ''
    )
);

alter table public.external_event_receipts enable row level security;

create function public.enforce_fee_calculation_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  prior_request_id uuid;
  policy_type text;
begin
  select pv.policy_type_code
  into policy_type
  from public.policy_versions as pv
  where pv.id = new.fee_policy_version_id;

  if not found then
    raise exception
      'Fee Calculation Fee Policy Version does not exist'
      using errcode = '23503';
  end if;

  if policy_type <> 'fee' then
    raise exception
      'Fee Calculation fee_policy_version_id must reference policy type fee'
      using errcode = '23514';
  end if;

  if new.supersedes_fee_calculation_id is not null then
    select fc.consultation_request_id
    into prior_request_id
    from public.fee_calculations as fc
    where fc.id = new.supersedes_fee_calculation_id;

    if not found then
      raise exception
        'superseded Fee Calculation does not exist'
        using errcode = '23503';
    end if;

    if prior_request_id <> new.consultation_request_id then
      raise exception
        'Fee Calculation supersession must remain within one Consultation Request'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

create function public.prevent_fee_calculation_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  raise exception
    'Fee Calculation is immutable; create a correction/supersession row'
    using errcode = '23514';
end;
$function$;

create function public.enforce_payment_transaction_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  fee_request_id uuid;
  fee_policy_id uuid;
  fee_currency char(3);
  request_referral_policy_id uuid;
  request_engagement_policy_id uuid;
  consultation_request_id_value uuid;
  consultation_referral_policy_id uuid;
  consultation_fee_policy_id uuid;
  consultation_engagement_policy_id uuid;
  consultation_cancellation_policy_id uuid;
  policy_id uuid;
  expected_type text;
  actual_type text;
  policy_jurisdiction_id uuid;
  policy_regulatory_mode_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (
      new.fee_calculation_id is distinct from old.fee_calculation_id
      or new.consultation_request_id is distinct from old.consultation_request_id
      or new.jurisdiction_id is distinct from old.jurisdiction_id
      or new.regulatory_mode_id is distinct from old.regulatory_mode_id
      or new.referral_policy_version_id is distinct from old.referral_policy_version_id
      or new.payment_policy_version_id is distinct from old.payment_policy_version_id
      or new.fee_policy_version_id is distinct from old.fee_policy_version_id
      or new.payment_flow_policy_version_id is distinct from old.payment_flow_policy_version_id
      or new.engagement_policy_version_id is distinct from old.engagement_policy_version_id
      or new.cancellation_policy_version_id is distinct from old.cancellation_policy_version_id
      or new.refund_policy_version_id is distinct from old.refund_policy_version_id
      or new.currency_code is distinct from old.currency_code
      or new.provider_code is distinct from old.provider_code
      or new.created_at is distinct from old.created_at
    ) then
      raise exception
        'Payment Transaction identity/provenance is immutable'
        using errcode = '23514';
    end if;

    if old.consultation_id is not null
       and new.consultation_id is distinct from old.consultation_id then
      raise exception
        'Payment Transaction Consultation association cannot be reassigned'
        using errcode = '23514';
    end if;
  end if;

  select
    fc.consultation_request_id,
    fc.fee_policy_version_id,
    fc.currency_code
  into
    fee_request_id,
    fee_policy_id,
    fee_currency
  from public.fee_calculations as fc
  where fc.id = new.fee_calculation_id;

  if not found then
    raise exception
      'Payment Transaction Fee Calculation does not exist'
      using errcode = '23503';
  end if;

  if fee_request_id <> new.consultation_request_id
     or fee_policy_id <> new.fee_policy_version_id
     or fee_currency <> new.currency_code then
    raise exception
      'Payment Transaction must match Fee Calculation Request, fee policy, and currency'
      using errcode = '23514';
  end if;

  select
    cr.referral_policy_version_id,
    cr.engagement_policy_version_id
  into
    request_referral_policy_id,
    request_engagement_policy_id
  from public.consultation_requests as cr
  where cr.id = new.consultation_request_id;

  if not found then
    raise exception
      'Payment Transaction Consultation Request does not exist'
      using errcode = '23503';
  end if;

  if request_referral_policy_id <> new.referral_policy_version_id then
    raise exception
      'Payment Transaction referral policy must match Consultation Request'
      using errcode = '23514';
  end if;

  if request_engagement_policy_id is not null
     and request_engagement_policy_id <> new.engagement_policy_version_id then
    raise exception
      'Payment Transaction engagement policy contradicts Consultation Request'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.jurisdiction_regulatory_modes as jrm
    where jrm.jurisdiction_id = new.jurisdiction_id
      and jrm.regulatory_mode_id = new.regulatory_mode_id
      and jrm.active_from <= new.created_at
      and (
        jrm.active_until is null
        or new.created_at < jrm.active_until
      )
  ) then
    raise exception
      'Payment Transaction requires a structurally and temporally valid Jurisdiction / Regulatory Mode mapping'
      using errcode = '23514';
  end if;

  for policy_id, expected_type in
    select *
    from (
      values
        (new.referral_policy_version_id, 'referral'::text),
        (new.payment_policy_version_id, 'payment'::text),
        (new.fee_policy_version_id, 'fee'::text),
        (new.payment_flow_policy_version_id, 'payment_flow'::text),
        (new.engagement_policy_version_id, 'engagement'::text),
        (new.cancellation_policy_version_id, 'cancellation'::text),
        (new.refund_policy_version_id, 'refund'::text)
    ) as required_policy(policy_id, expected_type)
  loop
    select
      pv.policy_type_code,
      pv.jurisdiction_id,
      pv.regulatory_mode_id
    into
      actual_type,
      policy_jurisdiction_id,
      policy_regulatory_mode_id
    from public.policy_versions as pv
    where pv.id = policy_id;

    if not found then
      raise exception
        'Payment Transaction Policy Version does not exist'
        using errcode = '23503';
    end if;

    if actual_type <> expected_type then
      raise exception
        'Payment Transaction Policy Version has incorrect policy type'
        using errcode = '23514';
    end if;

    if policy_jurisdiction_id is not null
       and policy_jurisdiction_id <> new.jurisdiction_id then
      raise exception
        'Payment Transaction Policy Version contradicts transaction jurisdiction'
        using errcode = '23514';
    end if;

    if policy_regulatory_mode_id is not null
       and policy_regulatory_mode_id <> new.regulatory_mode_id then
      raise exception
        'Payment Transaction Policy Version contradicts transaction Regulatory Mode'
        using errcode = '23514';
    end if;
  end loop;

  if new.consultation_id is not null then
    select
      c.consultation_request_id,
      c.referral_policy_version_id,
      c.fee_policy_version_id,
      c.engagement_policy_version_id,
      c.cancellation_policy_version_id
    into
      consultation_request_id_value,
      consultation_referral_policy_id,
      consultation_fee_policy_id,
      consultation_engagement_policy_id,
      consultation_cancellation_policy_id
    from public.consultations as c
    where c.id = new.consultation_id;

    if not found then
      raise exception
        'Payment Transaction Consultation does not exist'
        using errcode = '23503';
    end if;

    if consultation_request_id_value <> new.consultation_request_id
       or consultation_referral_policy_id is distinct from new.referral_policy_version_id
       or (
         consultation_fee_policy_id is not null
         and consultation_fee_policy_id <> new.fee_policy_version_id
       )
       or (
         consultation_engagement_policy_id is not null
         and consultation_engagement_policy_id <> new.engagement_policy_version_id
       )
       or (
         consultation_cancellation_policy_id is not null
         and consultation_cancellation_policy_id <> new.cancellation_policy_version_id
       ) then
      raise exception
        'Payment Transaction Consultation context contradicts frozen provenance'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

create function public.enforce_payment_request_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if exists (
    select 1
    from public.payment_transactions as pt
    where pt.consultation_request_id = new.id
      and (
        pt.referral_policy_version_id is distinct from new.referral_policy_version_id
        or (
          new.engagement_policy_version_id is not null
          and pt.engagement_policy_version_id is distinct from new.engagement_policy_version_id
        )
      )
  ) then
    raise exception
      'Consultation Request update would contradict existing Payment Transaction provenance'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_payment_consultation_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if exists (
    select 1
    from public.payment_transactions as pt
    where pt.consultation_id = new.id
      and (
        pt.consultation_request_id is distinct from new.consultation_request_id
        or pt.referral_policy_version_id is distinct from new.referral_policy_version_id
        or (
          new.fee_policy_version_id is not null
          and pt.fee_policy_version_id is distinct from new.fee_policy_version_id
        )
        or (
          new.engagement_policy_version_id is not null
          and pt.engagement_policy_version_id is distinct from new.engagement_policy_version_id
        )
        or (
          new.cancellation_policy_version_id is not null
          and pt.cancellation_policy_version_id is distinct from new.cancellation_policy_version_id
        )
      )
  ) then
    raise exception
      'Consultation update would contradict existing Payment Transaction provenance'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_payment_regulatory_mapping_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  affected_jurisdiction_id uuid;
  affected_regulatory_mode_id uuid;
begin
  for affected_jurisdiction_id, affected_regulatory_mode_id in
    select distinct candidate_jurisdiction_id, candidate_regulatory_mode_id
    from (
      values
        (
          nullif(to_jsonb(old) ->> 'jurisdiction_id', '')::uuid,
          nullif(to_jsonb(old) ->> 'regulatory_mode_id', '')::uuid
        ),
        (
          nullif(to_jsonb(new) ->> 'jurisdiction_id', '')::uuid,
          nullif(to_jsonb(new) ->> 'regulatory_mode_id', '')::uuid
        )
    ) as candidates(candidate_jurisdiction_id, candidate_regulatory_mode_id)
    where candidate_jurisdiction_id is not null
      and candidate_regulatory_mode_id is not null
  loop
    if exists (
      select 1
      from public.payment_transactions as pt
      where pt.jurisdiction_id = affected_jurisdiction_id
        and pt.regulatory_mode_id = affected_regulatory_mode_id
        and not exists (
          select 1
          from public.jurisdiction_regulatory_modes as jrm
          where jrm.jurisdiction_id = pt.jurisdiction_id
            and jrm.regulatory_mode_id = pt.regulatory_mode_id
            and jrm.active_from <= pt.created_at
            and (
              jrm.active_until is null
              or pt.created_at < jrm.active_until
            )
        )
    ) then
      raise exception
        'Jurisdiction / Regulatory Mode mapping change would invalidate Payment Transaction provenance'
        using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$function$;

create function public.enforce_ledger_entry_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  transaction_currency char(3);
begin
  if new.payment_transaction_id is not null then
    select pt.currency_code
    into transaction_currency
    from public.payment_transactions as pt
    where pt.id = new.payment_transaction_id;

    if not found then
      raise exception
        'Ledger Entry Payment Transaction does not exist'
        using errcode = '23503';
    end if;

    if transaction_currency <> new.currency_code then
      raise exception
        'Ledger Entry currency must match Payment Transaction'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

create function public.prevent_ledger_entry_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  raise exception
    'Ledger Entry is append-only; corrections require new entries'
    using errcode = '23514';
end;
$function$;

revoke all on function public.enforce_fee_calculation_integrity()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_fee_calculation_integrity()
  to postgres, service_role;

revoke all on function public.prevent_fee_calculation_mutation()
  from public, anon, authenticated, service_role;
grant execute on function public.prevent_fee_calculation_mutation()
  to postgres, service_role;

revoke all on function public.enforce_payment_transaction_integrity()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_payment_transaction_integrity()
  to postgres, service_role;

revoke all on function public.enforce_payment_request_consistency()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_payment_request_consistency()
  to postgres, service_role;

revoke all on function public.enforce_payment_consultation_consistency()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_payment_consultation_consistency()
  to postgres, service_role;

revoke all on function public.enforce_payment_regulatory_mapping_consistency()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_payment_regulatory_mapping_consistency()
  to postgres, service_role;

revoke all on function public.enforce_ledger_entry_integrity()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_ledger_entry_integrity()
  to postgres, service_role;

revoke all on function public.prevent_ledger_entry_mutation()
  from public, anon, authenticated, service_role;
grant execute on function public.prevent_ledger_entry_mutation()
  to postgres, service_role;

create trigger fee_calculations_integrity
before insert on public.fee_calculations
for each row
execute function public.enforce_fee_calculation_integrity();

create trigger fee_calculations_immutable
before update or delete on public.fee_calculations
for each row
execute function public.prevent_fee_calculation_mutation();

create trigger payment_transactions_integrity
before insert or update on public.payment_transactions
for each row
execute function public.enforce_payment_transaction_integrity();

create constraint trigger consultation_requests_payment_consistency
after update on public.consultation_requests
deferrable initially deferred
for each row
execute function public.enforce_payment_request_consistency();

create constraint trigger consultations_payment_consistency
after update on public.consultations
deferrable initially deferred
for each row
execute function public.enforce_payment_consultation_consistency();

create constraint trigger jurisdiction_regulatory_modes_payment_consistency
after update or delete on public.jurisdiction_regulatory_modes
deferrable initially deferred
for each row
execute function public.enforce_payment_regulatory_mapping_consistency();

create trigger ledger_entries_integrity
before insert on public.ledger_entries
for each row
execute function public.enforce_ledger_entry_integrity();

create trigger ledger_entries_immutable
before update or delete on public.ledger_entries
for each row
execute function public.prevent_ledger_entry_mutation();

create trigger payment_transactions_set_updated_at
before update on public.payment_transactions
for each row
execute function public.set_updated_at();

create trigger reconciliation_exceptions_set_updated_at
before update on public.reconciliation_exceptions
for each row
execute function public.set_updated_at();

create unique index fee_calculations_one_root_per_request_idx
  on public.fee_calculations (consultation_request_id)
  where supersedes_fee_calculation_id is null;

create unique index fee_calculations_one_successor_idx
  on public.fee_calculations (supersedes_fee_calculation_id)
  where supersedes_fee_calculation_id is not null;

create index fee_calculations_consultation_request_id_idx
  on public.fee_calculations (consultation_request_id);

create index payment_transactions_provider_reference_idx
  on public.payment_transactions (provider_code, provider_payment_reference);

create index payment_transactions_consultation_request_id_idx
  on public.payment_transactions (consultation_request_id);

create index ledger_entries_payment_transaction_id_idx
  on public.ledger_entries (payment_transaction_id);

create index reconciliation_exceptions_status_severity_idx
  on public.reconciliation_exceptions (status, severity);

revoke all on table public.fee_calculations
  from public, anon, authenticated, service_role;
grant select, insert on table public.fee_calculations to service_role;

revoke all on table public.payment_transactions
  from public, anon, authenticated, service_role;
grant select, insert on table public.payment_transactions to service_role;
grant update (
  consultation_id,
  state,
  amount_authorized_minor,
  amount_captured_minor,
  amount_refunded_minor,
  provider_payment_reference,
  authorized_at,
  captured_at,
  failed_at
) on table public.payment_transactions to service_role;

revoke all on table public.ledger_entries
  from public, anon, authenticated, service_role;
grant select, insert on table public.ledger_entries to service_role;

revoke all on table public.reconciliation_exceptions
  from public, anon, authenticated, service_role;
grant select, insert on table public.reconciliation_exceptions to service_role;
grant update (
  status,
  assigned_to_user_id,
  resolved_at,
  resolution_notes
) on table public.reconciliation_exceptions to service_role;

revoke all on table public.external_event_receipts
  from public, anon, authenticated, service_role;
grant select, insert on table public.external_event_receipts to service_role;
grant update (
  processed_at,
  processing_state
) on table public.external_event_receipts to service_role;

comment on table public.fee_calculations is
  'Immutable pricing snapshot for one Consultation Request attempt. Correction creates a new same-Request supersession row; later attorney pricing never rewrites historical quote state.';

comment on table public.payment_transactions is
  'Canonical Rosuno payment state with immutable FP-1 jurisdiction, Regulatory Mode, and independent policy provenance. Payment and Consultation remain independent; G-1 through G-5 remain unresolved.';

comment on table public.ledger_entries is
  'Append-only financial history. payout_id is intentionally NULL-only until a separately approved payout architecture activates the conditional Payout relation by forward migration.';

comment on table public.reconciliation_exceptions is
  'Durable operational record of provider/canonical disagreement. It does not become competing canonical state.';

comment on table public.external_event_receipts is
  'Generalized provider observation/evidence. Provider receipt state is not Rosuno business-state authority and raw payload retention is intentionally not introduced.';
