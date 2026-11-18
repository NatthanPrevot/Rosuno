-- MVP-001 S7 (2 of 2): the payment engine boundary (MVP-001 Packet S7 capability list; MBS section 12 deliverables,
-- critical sequencing rule, financial invariants and failure tests, and the production financial gate (MBS section
-- 19 / TA section 32 F1-F3); IMP sections 3 and 23 (provider security gate, outbound idempotency, exit list); TA
-- sections 6, 13, 14, 15, 16.1, 26, 27, 52 and 53; PS sections 22.2, 22.3, 22.5, 23.1, 33, 34 and 38; PM sections 1-4
-- and 9-10 (INV-1, INV-3, INV-7, INV-8, INV-9, INV-11, INV-13, INV-14; rows 3-5, 8-10 and 26-36); FP-1 sections 1-13;
-- DM sections 9 and 10).
--
-- No relation, column or policy type is added (Packet rules 8 and 16); nothing settles G-1 to G-5, a refund or
-- cancellation entitlement, a fee or a disclosure. Every value comes from configuration and unset configuration fails
-- closed.
--
-- Sequencing seam (G-2/G-3; FP-1 section 1.2): the payment_flow policy version selected for the Request's
-- jurisdiction and its single active Regulatory Mode holds exactly
--   {"instant":   {"authorization": A, "capture": C},
--    "scheduled": {"authorization": A, "capture": C}}
-- with A in before_attorney_decision | at_attorney_acceptance and C in at_authorization | at_attorney_acceptance |
-- at_consultation_start | at_consultation_completion. Readers validate it (payment_flow_parameters_valid; anything else
-- is policy_incomplete) and staff approval validates it (policy_parameters_approvable replaced forward, PS section
-- 8.4). No value is a default. With authorization before_attorney_decision the Request waits in its pre-decision
-- state (instant created, scheduled slot_held) until a confirmed authorization moves it along DM section 9 (instant
-- created -> payment_authorized -> awaiting_attorney; scheduled slot_held -> awaiting_attorney) in Rosuno's own
-- transaction. With at_attorney_acceptance a scheduled Request moves slot_held -> awaiting_attorney at its creation
-- (request_create replaced forward; nothing else in it changes); an instant Request has no DM section 9 path to
-- awaiting_attorney without payment_authorized, so it stays created (fail closed; an owner question). With no
-- selectable flow policy no payment can be created and the Request stays where S6 leaves it. Capture at_authorization
-- is requested as soon as the authorization is confirmed; every other capture moment is S8's or later, which call
-- payment_request_capture (internal) at the time they decide.
--
-- Payment creation (client_authorize_payment): for the caller's own undecided Request in its pre-decision state whose
-- flow requires authorization before the attorney decision, one transaction records the Payment Transaction with
-- complete FP-1 provenance (FP-1 sections 2-8): the Request's jurisdiction and its single active Regulatory Mode
-- (structurally and temporally valid, approval_status not interpreted, FP-1 section 5), the Request's referral policy
-- version, the current Fee Calculation's fee policy version (its currency and total), and the payment, payment_flow,
-- engagement (the Request's pinned version if any), cancellation and refund versions the environment-anchored
-- resolver selects for that jurisdiction and Regulatory Mode; anything missing fails honestly and nothing is created.
-- In a production-class database every one of the seven must also pass the four-way production financial gate
-- (production_financial_gate, S1) and no development-only version is ever usable (MBS section 12 failure test; TA
-- section 32 F1). The same transaction writes one audit event with the seven policy references (PM INV-7, INV-9) and
-- enqueues the hosted checkout job (TA section 27 outbox), so the provider call happens only after the intent is
-- durable (IMP section 23 outbound).
--
-- Provider operations run from the S2 job protocol (protected worker, skip-locked claims, bounded attempts, backoff,
-- escalation): payment.checkout, payment.capture, payment.release, payment.refund and payment.reconcile, one open job
-- per subject. The worker reads payment_job_context and records each result through payment_record_operation; the
-- webhook route records each authenticated provider event through payment_record_provider_event (receipt first,
-- unique per provider event, then processing in the same transaction). Both map provider observations to Rosuno
-- transitions through one decision table (payment_apply_observation): a new observation applies once; a duplicate or
-- an observation already reflected has no effect; an older or regressive one never overwrites newer canonical state
-- (stale); a contradiction opens a Reconciliation Exception and is never silently corrected (PM rows 33, 34 and 36; TA
-- sections 26 and 53). An exhausted payment job opens a Reconciliation Exception (provider_operation_exhausted).
--
-- Request termination (S6 integration): a Request that becomes cancelled, expired or declined (any path: withdrawal,
-- expiry, a later decline) releases its live payment attempt in the same transaction (release_pending and an
-- enqueued release; PM rows 3-5 and 8-10; TA section 14 B3), after the existing S6 locks (attorney lock, Hold,
-- Request) and only then the payment.
--
-- Ledger (PS section 22.3): a confirmed capture of exactly the authorized Fee Calculation total posts client_payment
-- debit against attorney_share (listed price less platform fee), platform_fee, client_fee and other_required_fee
-- credits; a confirmed refund posts the reversal of the allocation staff chose when they asked for it (the refund
-- allocation is a human decision; nothing here decides a refund entitlement). Each posting happens once per source.
-- Disputes post nothing: the outcome stays separate and goes to human resolution (PM row 30). Attorney earnings are
-- derived from attorney_share entries only; no balance or payout is stored.
--
-- Lock order: client -> Intake -> Referral -> attorney scheduling lock -> Hold -> Request (S4 and S6) -> payment
-- transaction. Staff refunds lock only the payment after the staff authority rows.

-- ---------------------------------------------------------------------------
-- The payment_flow parameter schema and the configuration readers (internal).
-- ---------------------------------------------------------------------------

create function public.payment_flow_parameters_valid(p_parameters jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_path text;
  v_branch jsonb;
begin
  if jsonb_typeof(p_parameters) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p_parameters)) <> 2
     or not (p_parameters ?& array['instant', 'scheduled']) then
    return false;
  end if;
  foreach v_path in array array['instant', 'scheduled'] loop
    v_branch := p_parameters -> v_path;
    if jsonb_typeof(v_branch) is distinct from 'object' then
      return false;
    end if;
    if (select count(*) from jsonb_object_keys(v_branch)) <> 2
       or not (v_branch ?& array['authorization', 'capture']) then
      return false;
    end if;
    if jsonb_typeof(v_branch -> 'authorization') is distinct from 'string'
       or (v_branch ->> 'authorization') not in ('before_attorney_decision', 'at_attorney_acceptance') then
      return false;
    end if;
    if jsonb_typeof(v_branch -> 'capture') is distinct from 'string'
       or (v_branch ->> 'capture') not in (
         'at_authorization', 'at_attorney_acceptance', 'at_consultation_start', 'at_consultation_completion'
       ) then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

-- The jurisdiction's single active Regulatory Mode at an instant (FP-1 section 5: structural and temporal validity
-- only; approval_status is not interpreted): ('selected', mode), ('regulatory_mode_unavailable', null) or
-- ('regulatory_mode_conflict', null) when two different modes are active.
create function public.payment_regulatory_mode(p_jurisdiction uuid, p_as_of timestamptz)
returns table (outcome text, regulatory_mode_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_count integer;
  v_id uuid;
begin
  if p_jurisdiction is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select count(distinct m.regulatory_mode_id)::integer, (array_agg(m.regulatory_mode_id order by m.regulatory_mode_id))[1]
  into v_count, v_id
  from public.jurisdiction_regulatory_modes as m
  where m.jurisdiction_id = p_jurisdiction
    and m.active_from <= p_as_of
    and (m.active_until is null or p_as_of < m.active_until);
  if v_count = 0 then
    return query select 'regulatory_mode_unavailable'::text, null::uuid;
  elsif v_count > 1 then
    return query select 'regulatory_mode_conflict'::text, null::uuid;
  else
    return query select 'selected'::text, v_id;
  end if;
end;
$function$;

-- The payment_flow version for a jurisdiction and Regulatory Mode at an instant: ('selected', version, parameters),
-- the resolver's own refusal, or ('policy_incomplete', version, null) for parameters outside the schema.
create function public.payment_flow_policy(p_jurisdiction uuid, p_regulatory_mode uuid, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, parameters jsonb)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_outcome text;
  v_id uuid;
  v_raw jsonb;
begin
  if p_jurisdiction is null or p_regulatory_mode is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::jsonb;
    return;
  end if;
  select s.outcome, s.policy_version_id into v_outcome, v_id
  from public.policy_select_version('payment_flow', p_jurisdiction, p_regulatory_mode, p_as_of) as s;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::jsonb;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  if not public.payment_flow_parameters_valid(v_raw) then
    return query select 'policy_incomplete'::text, v_id, null::jsonb;
    return;
  end if;
  return query select 'selected'::text, v_id, v_raw;
end;
$function$;

-- The flow of one request path in a jurisdiction now: ('selected', authorization, capture, version, mode) or the
-- first refusal (regulatory mode, then flow policy).
create function public.payment_flow_for_path(p_jurisdiction uuid, p_path text, p_as_of timestamptz)
returns table (
  outcome text,
  authorization_timing text,
  capture_timing text,
  policy_version_id uuid,
  regulatory_mode_id uuid
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_mode record;
  v_flow record;
begin
  if p_path is null or p_path not in ('instant', 'scheduled') then
    return query select 'invalid'::text, null::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  select m.outcome, m.regulatory_mode_id into v_mode
  from public.payment_regulatory_mode(p_jurisdiction, p_as_of) as m;
  if v_mode.outcome is distinct from 'selected' then
    return query select coalesce(v_mode.outcome, 'regulatory_mode_unavailable'), null::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  select f.outcome, f.policy_version_id, f.parameters into v_flow
  from public.payment_flow_policy(p_jurisdiction, v_mode.regulatory_mode_id, p_as_of) as f;
  if v_flow.outcome is distinct from 'selected' then
    return query select coalesce(v_flow.outcome, 'no_applicable_policy'), null::text, null::text,
      v_flow.policy_version_id, v_mode.regulatory_mode_id;
    return;
  end if;
  return query select
    'selected'::text,
    v_flow.parameters -> p_path ->> 'authorization',
    v_flow.parameters -> p_path ->> 'capture',
    v_flow.policy_version_id,
    v_mode.regulatory_mode_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Approval validation (PS section 8.4): the S6 function with the payment_flow schema added (unchanged otherwise).
-- ---------------------------------------------------------------------------

create or replace function public.policy_parameters_approvable(
  p_policy_type_code text,
  p_jurisdiction_id uuid,
  p_parameters jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_policy_type_code
    when 'fee' then
      case
        when p_jurisdiction_id is null then public.pricing_platform_parameters_valid(p_parameters)
        else public.pricing_fee_parameters_valid(p_parameters)
      end
    when 'referral' then
      coalesce(
        jsonb_typeof(p_parameters) = 'object'
        and (
          not (p_parameters ? 'request_message_maximum_characters')
          or public.pricing_integer_within(p_parameters -> 'request_message_maximum_characters', 1, 20000)
        ),
        false)
    when 'payment_flow' then public.payment_flow_parameters_valid(p_parameters)
    else true
  end;
$function$;

-- ---------------------------------------------------------------------------
-- Internal helpers.
-- ---------------------------------------------------------------------------

-- The audited view of a payment: state, amounts, currency and times; never a provider reference.
create function public.payment_snapshot(p_payment public.payment_transactions)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select jsonb_build_object(
    'state', p_payment.state,
    'amount_authorized_minor', p_payment.amount_authorized_minor,
    'amount_captured_minor', p_payment.amount_captured_minor,
    'amount_refunded_minor', p_payment.amount_refunded_minor,
    'currency_code', p_payment.currency_code
  );
$function$;

-- The seven FP-1 policy references of a payment, in audit-event form.
create function public.payment_policy_references(p_payment public.payment_transactions)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select jsonb_build_array(
    jsonb_build_object('policy_type_code', 'referral', 'policy_version_id', p_payment.referral_policy_version_id),
    jsonb_build_object('policy_type_code', 'payment', 'policy_version_id', p_payment.payment_policy_version_id),
    jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', p_payment.fee_policy_version_id),
    jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', p_payment.payment_flow_policy_version_id),
    jsonb_build_object('policy_type_code', 'engagement', 'policy_version_id', p_payment.engagement_policy_version_id),
    jsonb_build_object('policy_type_code', 'cancellation', 'policy_version_id', p_payment.cancellation_policy_version_id),
    jsonb_build_object('policy_type_code', 'refund', 'policy_version_id', p_payment.refund_policy_version_id)
  );
$function$;

-- One audit event about one payment (PM INV-9: actor, action, before/after, reason and the policy versions).
create function public.payment_audit(
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_before public.payment_transactions,
  p_after public.payment_transactions,
  p_reason text
)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    p_actor, p_actor_type, p_action, 'payment_transaction', p_after.id,
    case when p_before.id is null then null else public.payment_snapshot(p_before) end,
    public.payment_snapshot(p_after),
    p_reason, public.payment_policy_references(p_after), p_after.jurisdiction_id, clock_timestamp()
  );
$function$;

-- Opens one Reconciliation Exception, or answers the open one of the same type and source (idempotent), with one
-- system audit event when it is new (PM INV-11; TA section 26).
create function public.payment_open_exception(
  p_source_type text,
  p_source_id uuid,
  p_canonical_id uuid,
  p_exception_type text,
  p_severity text,
  p_evidence jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_id uuid;
  v_jurisdiction uuid;
begin
  insert into public.reconciliation_exceptions (
    source_type, source_id, canonical_type, canonical_id, exception_type, severity,
    detected_at, status, evidence_reference
  ) values (
    p_source_type, p_source_id, 'payment_transaction', p_canonical_id, p_exception_type, p_severity,
    clock_timestamp(), 'open', coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (exception_type, source_type, source_id) where status = 'open' and source_id is not null
  do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id
    from public.reconciliation_exceptions as e
    where e.exception_type = p_exception_type
      and e.source_type = p_source_type
      and e.source_id = p_source_id
      and e.status = 'open';
    return v_id;
  end if;
  select pt.jurisdiction_id into v_jurisdiction from public.payment_transactions as pt where pt.id = p_canonical_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'reconciliation_exception.opened', 'reconciliation_exception', v_id,
    null,
    jsonb_build_object(
      'exception_type', p_exception_type,
      'severity', p_severity,
      'source_type', p_source_type,
      'canonical_type', 'payment_transaction',
      'canonical_id', p_canonical_id
    ),
    p_exception_type, null, v_jurisdiction, clock_timestamp()
  );
  return v_id;
end;
$function$;

-- Enqueues one payment job (bounded attempts per operation; S2 one open job per type and subject).
create function public.payment_enqueue(p_job_type text, p_subject_type text, p_subject_id uuid)
returns uuid
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select public.job_enqueue(
    p_job_type, p_subject_type, p_subject_id, clock_timestamp(),
    case p_job_type
      when 'payment.checkout' then 5
      when 'payment.reconcile' then 3
      else 8
    end
  );
$function$;

-- The current (unsuperseded) Fee Calculation of a Request.
create function public.payment_current_fee_calculation(p_request_id uuid)
returns public.fee_calculations
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select c.*
  from public.fee_calculations as c
  where c.consultation_request_id = p_request_id
    and not exists (select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = c.id)
  order by c.calculated_at desc, c.id
  limit 1;
$function$;

-- The latest refund request of a payment (the staff audit event that asked for it) with its allocation.
create function public.payment_latest_refund_request(p_payment_id uuid)
returns table (
  refund_request_id uuid,
  attorney_share_minor bigint,
  platform_fee_minor bigint,
  client_fee_minor bigint,
  other_required_fee_minor bigint,
  amount_minor bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    a.id,
    (a.after_snapshot ->> 'attorney_share_minor')::bigint,
    (a.after_snapshot ->> 'platform_fee_minor')::bigint,
    (a.after_snapshot ->> 'client_fee_minor')::bigint,
    (a.after_snapshot ->> 'other_required_fee_minor')::bigint,
    (a.after_snapshot ->> 'amount_minor')::bigint
  from public.audit_events as a
  where a.resource_type = 'payment_transaction'
    and a.resource_id = p_payment_id
    and a.action_code = 'payment.refund_requested'
    and a.actor_type = 'staff'
  order by a.occurred_at desc, a.id desc
  limit 1;
$function$;

-- The ledger posting of a confirmed capture of exactly the authorized Fee Calculation total (PS section 22.3). A
-- component allocation that does not balance opens an exception and posts nothing. Answers the entries posted.
create function public.payment_post_capture(p_payment public.payment_transactions, p_source_id uuid, p_source_type text)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_fee public.fee_calculations;
  v_share bigint;
  v_count integer;
begin
  select c.* into v_fee from public.fee_calculations as c where c.id = p_payment.fee_calculation_id;
  v_share := v_fee.attorney_listed_price_minor - v_fee.platform_fee_minor;
  if v_share < 0
     or v_fee.total_client_amount_minor
        <> v_share + v_fee.platform_fee_minor + v_fee.client_fee_minor + v_fee.tax_or_other_required_fee_minor
     or p_payment.amount_captured_minor is distinct from v_fee.total_client_amount_minor then
    perform public.payment_open_exception(
      p_source_type, p_source_id, p_payment.id, 'ledger_allocation_invalid', 'critical',
      jsonb_build_object('fee_calculation_id', v_fee.id, 'amount_captured_minor', p_payment.amount_captured_minor)
    );
    return 0;
  end if;
  insert into public.ledger_entries (
    payment_transaction_id, entry_type, direction, amount_minor, currency_code, effective_at,
    source_reference, reason_code, metadata
  )
  select
    p_payment.id, x.entry_type, x.direction, x.amount, p_payment.currency_code, p_payment.captured_at,
    'capture:' || p_payment.id::text, 'payment_captured',
    jsonb_build_object('fee_calculation_id', v_fee.id)
  from (
    values
      ('client_payment', 'debit', v_fee.total_client_amount_minor, 1),
      ('attorney_share', 'credit', v_share, 2),
      ('platform_fee', 'credit', v_fee.platform_fee_minor, 3),
      ('client_fee', 'credit', v_fee.client_fee_minor, 4),
      ('other_required_fee', 'credit', v_fee.tax_or_other_required_fee_minor, 5)
  ) as x(entry_type, direction, amount, ordinal)
  where x.amount > 0
  order by x.ordinal
  on conflict (payment_transaction_id, entry_type, source_reference) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- The ledger reversal of one confirmed refund, with the allocation staff chose (PS section 22.3: appended, never
-- edited). Answers the entries posted (0 when this refund was already posted).
create function public.payment_post_refund(
  p_payment public.payment_transactions,
  p_refund_request_id uuid,
  p_attorney_share bigint,
  p_platform_fee bigint,
  p_client_fee bigint,
  p_other_fee bigint,
  p_refund_reference text
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_count integer;
begin
  insert into public.ledger_entries (
    payment_transaction_id, entry_type, direction, amount_minor, currency_code, effective_at,
    source_reference, reason_code, metadata
  )
  select
    p_payment.id, x.entry_type, x.direction, x.amount, p_payment.currency_code, clock_timestamp(),
    'refund:' || p_refund_request_id::text, 'payment_refunded',
    jsonb_build_object('refund_reference', p_refund_reference)
  from (
    values
      ('client_payment', 'credit', p_attorney_share + p_platform_fee + p_client_fee + p_other_fee, 1),
      ('attorney_share', 'debit', p_attorney_share, 2),
      ('platform_fee', 'debit', p_platform_fee, 3),
      ('client_fee', 'debit', p_client_fee, 4),
      ('other_required_fee', 'debit', p_other_fee, 5)
  ) as x(entry_type, direction, amount, ordinal)
  where x.amount > 0
  order by x.ordinal
  on conflict (payment_transaction_id, entry_type, source_reference) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- What remains refundable of each component of a captured payment: its capture credit less its refund debits.
create function public.payment_refundable_components(p_payment_id uuid)
returns table (
  attorney_share_minor bigint,
  platform_fee_minor bigint,
  client_fee_minor bigint,
  other_required_fee_minor bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    coalesce(sum(case when l.entry_type = 'attorney_share' then
      case l.direction when 'credit' then l.amount_minor else -l.amount_minor end end), 0)::bigint,
    coalesce(sum(case when l.entry_type = 'platform_fee' then
      case l.direction when 'credit' then l.amount_minor else -l.amount_minor end end), 0)::bigint,
    coalesce(sum(case when l.entry_type = 'client_fee' then
      case l.direction when 'credit' then l.amount_minor else -l.amount_minor end end), 0)::bigint,
    coalesce(sum(case when l.entry_type = 'other_required_fee' then
      case l.direction when 'credit' then l.amount_minor else -l.amount_minor end end), 0)::bigint
  from public.ledger_entries as l
  where l.payment_transaction_id = p_payment_id;
$function$;

-- Moves a Request along DM section 9 when its payment's flow required authorization before the attorney decision
-- and the authorization is now confirmed: instant created -> payment_authorized -> awaiting_attorney, scheduled
-- slot_held -> awaiting_attorney. The caller holds the attorney lock, the Request and the payment. Answers whether
-- the Request moved.
create function public.payment_advance_request(p_payment public.payment_transactions)
returns boolean
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_request public.consultation_requests;
  v_parameters jsonb;
  v_before text;
begin
  select r.* into v_request from public.consultation_requests as r where r.id = p_payment.consultation_request_id;
  select v.parameters into v_parameters from public.policy_versions as v where v.id = p_payment.payment_flow_policy_version_id;
  if not public.payment_flow_parameters_valid(v_parameters)
     or (v_parameters -> v_request.request_path ->> 'authorization') is distinct from 'before_attorney_decision' then
    return false;
  end if;
  v_before := v_request.state;
  if v_request.request_path = 'instant' and v_request.state = 'created' then
    update public.consultation_requests as r set state = 'payment_authorized' where r.id = v_request.id;
    update public.consultation_requests as r set state = 'awaiting_attorney' where r.id = v_request.id;
  elsif v_request.request_path = 'scheduled' and v_request.state = 'slot_held' then
    update public.consultation_requests as r set state = 'awaiting_attorney' where r.id = v_request.id;
  else
    return false;
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'consultation_request.payment_authorized', 'consultation_request', v_request.id,
    jsonb_build_object('state', v_before),
    jsonb_build_object('state', 'awaiting_attorney', 'payment_transaction_id', p_payment.id),
    'payment_authorized',
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', p_payment.payment_flow_policy_version_id)
    ),
    p_payment.jurisdiction_id, clock_timestamp()
  );
  return true;
end;
$function$;

-- Requests the capture of an authorized payment (internal; S8 and later call it at the moment their configuration
-- decides; at_authorization is requested here when the authorization is confirmed). Takes the S6 lock order itself:
-- attorney lock, Request expiry, the Request, then the payment. Outcomes: capture_requested, not_authorized,
-- not_found.
create function public.payment_request_capture(p_payment_id uuid)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_request uuid;
  v_before public.payment_transactions;
  v_after public.payment_transactions;
begin
  select pt.consultation_request_id, r.selected_attorney_id into v_request, v_attorney
  from public.payment_transactions as pt
  join public.consultation_requests as r on r.id = pt.consultation_request_id
  where pt.id = p_payment_id;
  if not found then
    return 'not_found';
  end if;
  perform public.scheduling_lock_attorney(v_attorney);
  perform public.request_expire_if_due(v_request, false);
  perform 1 from public.consultation_requests as r where r.id = v_request for update;
  select pt.* into v_before from public.payment_transactions as pt where pt.id = p_payment_id for update;
  if v_before.state is distinct from 'authorized' then
    return 'not_authorized';
  end if;
  update public.payment_transactions as pt
  set state = 'capture_pending'
  where pt.id = p_payment_id
  returning pt.* into v_after;
  perform public.payment_audit(null, 'system', 'payment.capture_requested', v_before, v_after, 'capture_requested');
  perform public.payment_enqueue('payment.capture', 'payment_transaction', p_payment_id);
  return 'capture_requested';
end;
$function$;

-- Releases the live payment attempt of a Request that became cancelled, expired or declined, in the same
-- transaction (trigger on consultation_requests; PM rows 3-5 and 8-10; TA section 14 B3).
create function public.payment_request_terminated()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_before public.payment_transactions;
  v_after public.payment_transactions;
begin
  for v_before in
    select pt.*
    from public.payment_transactions as pt
    where pt.consultation_request_id = new.id
      and pt.state in ('pending_authorization', 'authorized')
    order by pt.created_at, pt.id
    for update
  loop
    update public.payment_transactions as pt
    set state = 'release_pending'
    where pt.id = v_before.id
    returning pt.* into v_after;
    perform public.payment_audit(
      null, 'system', 'payment.release_requested', v_before, v_after, 'request_' || new.state
    );
    perform public.payment_enqueue('payment.release', 'payment_transaction', v_before.id);
  end loop;
  -- PM rows 3-5 and 8-10 (settled): when a Request ends without acceptance, no funds are retained. Funds already
  -- captured, or being captured, cannot be released automatically, and the refund is not decided here (refund
  -- policy is gated): the disagreement is surfaced for human resolution, never absorbed (PM INV-11).
  for v_before in
    select pt.*
    from public.payment_transactions as pt
    where pt.consultation_request_id = new.id
      and pt.state in ('capture_pending', 'captured', 'refund_pending', 'partially_refunded')
    order by pt.created_at, pt.id
  loop
    perform public.payment_open_exception(
      'consultation_request', new.id, v_before.id, 'funds_retained_after_request_end', 'critical',
      jsonb_build_object(
        'request_state', new.state,
        'payment_state', v_before.state,
        'amount_captured_minor', v_before.amount_captured_minor,
        'amount_refunded_minor', v_before.amount_refunded_minor,
        'currency_code', v_before.currency_code
      )
    );
  end loop;
  return null;
end;
$function$;

create trigger consultation_requests_payment_release
after update of state on public.consultation_requests
for each row
when (old.state is distinct from new.state and new.state in ('cancelled', 'expired', 'declined'))
execute function public.payment_request_terminated();

-- An exhausted payment job is a provider/canonical disagreement nobody resolved automatically: one Reconciliation
-- Exception per job (trigger on operational_jobs; MVP-001 Packet S7 outbound reliability).
create function public.payment_job_escalated()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_payment uuid;
begin
  if new.subject_type = 'payment_transaction' then
    v_payment := new.subject_id;
  elsif new.subject_type = 'payment_refund_request' then
    select a.resource_id into v_payment
    from public.audit_events as a
    where a.id = new.subject_id
      and a.action_code = 'payment.refund_requested'
      and a.resource_type = 'payment_transaction';
  end if;
  if v_payment is null or not exists (select 1 from public.payment_transactions as pt where pt.id = v_payment) then
    return null;
  end if;
  perform public.payment_open_exception(
    'operational_job', new.id, v_payment, 'provider_operation_exhausted', 'high',
    jsonb_build_object(
      'job_type', new.job_type,
      'attempt_count', new.attempt_count,
      'last_error_code', new.last_error_code
    )
  );
  return null;
end;
$function$;

create trigger operational_jobs_payment_escalation
after update of state on public.operational_jobs
for each row
when (new.state = 'escalated' and old.state is distinct from 'escalated' and new.job_type like 'payment.%')
execute function public.payment_job_escalated();

-- ---------------------------------------------------------------------------
-- Provider observations (provider-neutral; TA section 16.1: the adapter translates provider states into
-- Rosuno-relevant observations; FP-1 section 13 and PS section 38: they never are Rosuno truth by themselves).
-- ---------------------------------------------------------------------------

-- Whether an observation has exactly the allowed shape: a kind of the vocabulary and only known members, each of its
-- own form. The minimal payload of a receipt is exactly such an observation (policy-minimized; never card data or the
-- raw provider payload).
create function public.payment_observation_valid(p_observation jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_key text;
  v_value jsonb;
begin
  if jsonb_typeof(p_observation) is distinct from 'object'
     or jsonb_typeof(p_observation -> 'kind') is distinct from 'string'
     or (p_observation ->> 'kind') not in (
       'checkout_open', 'checkout_completed', 'checkout_expired', 'authorization_confirmed',
       'authorization_failed', 'authorization_released', 'capture_confirmed', 'capture_refused',
       'refund_confirmed', 'refund_refused', 'refund_observed', 'dispute_opened', 'dispute_updated',
       'dispute_closed', 'provider_state', 'ignored'
     ) then
    return false;
  end if;
  for v_key, v_value in select e.key, e.value from jsonb_each(p_observation) as e loop
    if v_key = 'kind' then
      continue;
    end if;
    if jsonb_typeof(v_value) = 'null' then
      continue;
    end if;
    if v_key in ('checkout_reference', 'payment_reference', 'refund_reference', 'dispute_reference') then
      if jsonb_typeof(v_value) is distinct from 'string'
         or (v_value #>> '{}') collate "C" !~ '^[A-Za-z0-9_]{3,255}$' then
        return false;
      end if;
    elsif v_key in ('payment_transaction_id', 'refund_request_id') then
      if jsonb_typeof(v_value) is distinct from 'string'
         or (v_value #>> '{}') collate "C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return false;
      end if;
    elsif v_key in ('amount_minor', 'amount_capturable_minor', 'amount_received_minor', 'amount_refunded_minor') then
      if not public.pricing_integer_within(v_value, 0, 1000000000000) then
        return false;
      end if;
    elsif v_key = 'currency_code' then
      if jsonb_typeof(v_value) is distinct from 'string' or (v_value #>> '{}') collate "C" !~ '^[A-Z]{3}$' then
        return false;
      end if;
    elsif v_key = 'provider_status' then
      if jsonb_typeof(v_value) is distinct from 'string'
         or (v_value #>> '{}') collate "C" !~ '^[a-z][a-z0-9_]{1,39}$' then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

-- Records a confirmed authorization on a locked pending payment: exactly the current Fee Calculation total in the
-- payment's currency moves it to authorized (and the Request along DM section 9; capture at_authorization requested);
-- any other amount or currency records the facts, releases the attempt and opens a critical exception.
create function public.payment_confirm_authorization(
  p_payment public.payment_transactions,
  p_reference text,
  p_amount bigint,
  p_currency text,
  p_source_type text,
  p_source_id uuid,
  p_actor_type text
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_fee public.fee_calculations;
  v_after public.payment_transactions;
  v_parameters jsonb;
  v_request public.consultation_requests;
begin
  select c.* into v_fee from public.fee_calculations as c where c.id = p_payment.fee_calculation_id;
  if p_amount is distinct from v_fee.total_client_amount_minor or p_currency is distinct from p_payment.currency_code::text then
    update public.payment_transactions as pt
    set state = 'release_pending',
        authorized_at = clock_timestamp(),
        amount_authorized_minor = p_amount,
        provider_payment_reference = p_reference
    where pt.id = p_payment.id
    returning pt.* into v_after;
    perform public.payment_audit(null, p_actor_type, 'payment.release_requested', p_payment, v_after, 'amount_mismatch');
    perform public.payment_enqueue('payment.release', 'payment_transaction', p_payment.id);
    perform public.payment_open_exception(
      p_source_type, p_source_id, p_payment.id, 'amount_mismatch', 'critical',
      jsonb_build_object(
        'expected_amount_minor', v_fee.total_client_amount_minor,
        'expected_currency_code', p_payment.currency_code,
        'observed_amount_minor', p_amount,
        'observed_currency_code', p_currency
      )
    );
    return 'contradiction';
  end if;
  update public.payment_transactions as pt
  set state = 'authorized',
      authorized_at = clock_timestamp(),
      amount_authorized_minor = p_amount,
      provider_payment_reference = p_reference
  where pt.id = p_payment.id
  returning pt.* into v_after;
  perform public.payment_audit(null, p_actor_type, 'payment.authorized', p_payment, v_after, 'authorization_confirmed');
  perform public.payment_advance_request(v_after);
  select r.* into v_request from public.consultation_requests as r where r.id = v_after.consultation_request_id;
  select v.parameters into v_parameters from public.policy_versions as v where v.id = v_after.payment_flow_policy_version_id;
  if public.payment_flow_parameters_valid(v_parameters)
     and (v_parameters -> v_request.request_path ->> 'capture') = 'at_authorization' then
    perform public.payment_request_capture(v_after.id);
  end if;
  return 'applied';
end;
$function$;

-- Applies one validated observation to one payment, after the S6 locks (attorney lock, Request expiry, Request) and
-- then the payment. Answers applied | no_effect | stale | contradiction. Every contradiction opens a Reconciliation
-- Exception from the given source; nothing is silently corrected.
create function public.payment_apply_observation(
  p_payment_id uuid,
  p_observation jsonb,
  p_source_type text,
  p_source_id uuid,
  p_actor_type text
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_request_id uuid;
  v_attorney uuid;
  v_payment public.payment_transactions;
  v_after public.payment_transactions;
  v_kind text := p_observation ->> 'kind';
  v_reference text := p_observation ->> 'payment_reference';
  v_checkout text := p_observation ->> 'checkout_reference';
  v_amount bigint := (p_observation ->> 'amount_minor')::bigint;
  v_currency text := p_observation ->> 'currency_code';
  v_status text := p_observation ->> 'provider_status';
  v_refund_request uuid := (p_observation ->> 'refund_request_id')::uuid;
  v_request record;
  v_evidence jsonb;
  v_target text;
begin
  select pt.consultation_request_id, r.selected_attorney_id into v_request_id, v_attorney
  from public.payment_transactions as pt
  join public.consultation_requests as r on r.id = pt.consultation_request_id
  where pt.id = p_payment_id;
  if not found then
    return 'unmatched';
  end if;
  perform public.scheduling_lock_attorney(v_attorney);
  perform public.request_expire_if_due(v_request_id, false);
  perform 1 from public.consultation_requests as r where r.id = v_request_id for update;
  select pt.* into v_payment from public.payment_transactions as pt where pt.id = p_payment_id for update;
  v_evidence := jsonb_build_object('observation', p_observation, 'canonical_state', v_payment.state);

  -- Provider references must agree with what Rosuno recorded: the payment reference once an authorization is
  -- recorded, the checkout reference before.
  if v_kind <> 'checkout_open'
     and (
       (v_payment.authorized_at is not null and v_reference is not null
        and v_reference is distinct from v_payment.provider_payment_reference)
       or (v_payment.authorized_at is null and v_payment.provider_payment_reference is not null
           and v_checkout is not null and v_checkout is distinct from v_payment.provider_payment_reference)
     ) then
    perform public.payment_open_exception(
      p_source_type, p_source_id, v_payment.id, 'provider_reference_mismatch', 'high', v_evidence
    );
    return 'contradiction';
  end if;

  -- A provider snapshot (reconciliation) becomes the observation it implies, or is compared with recorded state.
  if v_kind = 'provider_state' then
    if v_status = 'requires_capture' then
      if v_payment.state in ('pending_authorization', 'release_pending', 'failed', 'cancelled') then
        v_kind := 'authorization_confirmed';
        v_amount := (p_observation ->> 'amount_capturable_minor')::bigint;
      elsif v_payment.state in ('authorized', 'capture_pending')
            and (p_observation ->> 'amount_capturable_minor')::bigint is not distinct from v_payment.amount_authorized_minor then
        return 'no_effect';
      else
        perform public.payment_open_exception(
          p_source_type, p_source_id, v_payment.id, 'reconciliation_mismatch', 'high', v_evidence
        );
        return 'contradiction';
      end if;
    elsif v_status = 'succeeded' then
      if v_payment.state in ('capture_pending', 'authorized', 'pending_authorization', 'release_pending',
                             'authorization_released', 'cancelled', 'failed', 'capture_failed') then
        v_kind := 'capture_confirmed';
        v_amount := (p_observation ->> 'amount_received_minor')::bigint;
      elsif (p_observation ->> 'amount_received_minor')::bigint is not distinct from v_payment.amount_captured_minor
            and (
              (p_observation ->> 'amount_refunded_minor')::bigint is not distinct from v_payment.amount_refunded_minor
              or (v_payment.state = 'refund_pending'
                  and (p_observation ->> 'amount_refunded_minor')::bigint >= v_payment.amount_refunded_minor)
              or v_payment.state = 'charged_back'
            ) then
        return 'no_effect';
      else
        perform public.payment_open_exception(
          p_source_type, p_source_id, v_payment.id, 'reconciliation_mismatch', 'high', v_evidence
        );
        return 'contradiction';
      end if;
    elsif v_status = 'canceled' then
      v_kind := 'authorization_released';
      v_amount := null;
    elsif v_status = 'checkout_expired' then
      v_kind := 'checkout_expired';
    elsif v_status in ('checkout_open', 'checkout_complete', 'requires_payment', 'processing') then
      if v_payment.state in ('pending_authorization', 'release_pending', 'failed', 'cancelled') then
        return 'no_effect';
      end if;
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'reconciliation_mismatch', 'high', v_evidence
      );
      return 'contradiction';
    else
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'reconciliation_mismatch', 'medium', v_evidence
      );
      return 'contradiction';
    end if;
  end if;

  if v_kind = 'checkout_open' then
    if v_payment.provider_payment_reference is not distinct from v_checkout then
      return 'no_effect';
    end if;
    if v_payment.state in ('pending_authorization', 'release_pending') and v_payment.provider_payment_reference is null then
      update public.payment_transactions as pt
      set provider_payment_reference = v_checkout
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.checkout_opened', v_payment, v_after, 'checkout_opened');
      return 'applied';
    end if;
    perform public.payment_open_exception(
      p_source_type, p_source_id, v_payment.id, 'checkout_after_terminal', 'high', v_evidence
    );
    return 'contradiction';
  end if;

  if v_kind = 'checkout_completed' then
    if v_payment.state = 'pending_authorization' then
      perform public.payment_enqueue('payment.reconcile', 'payment_transaction', v_payment.id);
      return 'applied';
    end if;
    return 'no_effect';
  end if;

  if v_kind = 'checkout_expired' then
    if v_payment.state = 'pending_authorization'
       or (v_payment.state = 'release_pending' and v_payment.authorized_at is null) then
      update public.payment_transactions as pt
      set state = 'cancelled'
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.cancelled', v_payment, v_after, 'checkout_expired');
      return 'applied';
    end if;
    if v_payment.state in ('release_pending', 'failed', 'cancelled') then
      return 'no_effect';
    end if;
    return 'stale';
  end if;

  if v_kind = 'authorization_confirmed' then
    if v_reference is null or v_amount is null or v_currency is null then
      return 'no_effect';
    end if;
    if v_payment.state = 'pending_authorization' then
      return public.payment_confirm_authorization(
        v_payment, v_reference, v_amount, v_currency, p_source_type, p_source_id, p_actor_type
      );
    end if;
    if v_payment.state = 'release_pending' then
      if v_payment.authorized_at is not null then
        return 'no_effect';
      end if;
      update public.payment_transactions as pt
      set authorized_at = clock_timestamp(),
          amount_authorized_minor = v_amount,
          provider_payment_reference = v_reference
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(
        null, p_actor_type, 'payment.authorization_recorded', v_payment, v_after, 'authorization_during_release'
      );
      return 'applied';
    end if;
    if v_payment.state in ('failed', 'cancelled') then
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'authorization_after_terminal',
        case when v_payment.state = 'failed' then 'high' else 'critical' end, v_evidence
      );
      if v_payment.state = 'failed' then
        perform public.payment_enqueue('payment.release', 'payment_transaction', v_payment.id);
      end if;
      return 'contradiction';
    end if;
    return 'stale';
  end if;

  if v_kind = 'authorization_failed' then
    if v_payment.state = 'pending_authorization' then
      update public.payment_transactions as pt
      set state = 'failed',
          failed_at = clock_timestamp()
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.failed', v_payment, v_after, 'authorization_failed');
      perform public.payment_enqueue('payment.release', 'payment_transaction', v_payment.id);
      return 'applied';
    end if;
    if v_payment.state in ('release_pending', 'failed', 'cancelled') then
      return 'no_effect';
    end if;
    return 'stale';
  end if;

  if v_kind = 'authorization_released' then
    if v_payment.state = 'release_pending' then
      if v_payment.authorized_at is null and v_amount is not null and v_reference is not null then
        update public.payment_transactions as pt
        set state = 'authorization_released',
            authorized_at = clock_timestamp(),
            amount_authorized_minor = v_amount,
            provider_payment_reference = v_reference
        where pt.id = v_payment.id
        returning pt.* into v_after;
      else
        update public.payment_transactions as pt
        set state = case when pt.authorized_at is null then 'cancelled' else 'authorization_released' end
        where pt.id = v_payment.id
        returning pt.* into v_after;
      end if;
      perform public.payment_audit(
        null, p_actor_type,
        case when v_after.state = 'cancelled' then 'payment.cancelled' else 'payment.authorization_released' end,
        v_payment, v_after, 'release_confirmed'
      );
      return 'applied';
    end if;
    if v_payment.state in ('failed', 'cancelled', 'authorization_released') then
      return 'no_effect';
    end if;
    if v_payment.state in ('captured', 'refund_pending', 'partially_refunded', 'fully_refunded', 'charged_back') then
      return 'stale';
    end if;
    -- pending_authorization, authorized, capture_pending, capture_failed: a release Rosuno did not ask for.
    perform public.payment_open_exception(
      p_source_type, p_source_id, v_payment.id, 'provider_state_contradiction', 'high', v_evidence
    );
    return 'contradiction';
  end if;

  if v_kind = 'capture_confirmed' then
    if v_payment.state = 'capture_pending' then
      if v_amount is null or v_amount > v_payment.amount_authorized_minor then
        perform public.payment_open_exception(
          p_source_type, p_source_id, v_payment.id, 'amount_mismatch', 'critical', v_evidence
        );
        return 'contradiction';
      end if;
      update public.payment_transactions as pt
      set state = 'captured',
          captured_at = clock_timestamp(),
          amount_captured_minor = v_amount
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.captured', v_payment, v_after, 'capture_confirmed');
      perform public.payment_post_capture(v_after, p_source_id, p_source_type);
      return 'applied';
    end if;
    if v_payment.state in ('captured', 'refund_pending', 'partially_refunded', 'fully_refunded', 'charged_back')
       and v_amount is not distinct from v_payment.amount_captured_minor then
      return 'no_effect';
    end if;
    perform public.payment_open_exception(
      p_source_type, p_source_id, v_payment.id,
      case when v_payment.state = 'authorized' then 'unexpected_provider_capture' else 'provider_state_contradiction' end,
      'critical', v_evidence
    );
    return 'contradiction';
  end if;

  if v_kind = 'capture_refused' then
    if v_payment.state = 'capture_pending' then
      update public.payment_transactions as pt
      set state = 'capture_failed',
          failed_at = clock_timestamp()
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.capture_failed', v_payment, v_after, 'capture_failed');
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'capture_failed', 'high', v_evidence
      );
      return 'applied';
    end if;
    return 'no_effect';
  end if;

  if v_kind in ('refund_confirmed', 'refund_refused', 'refund_observed') then
    if v_kind = 'refund_observed' and v_status = 'pending' then
      return 'no_effect';
    end if;
    if v_kind = 'refund_observed' and v_status in ('failed', 'canceled') then
      v_kind := 'refund_refused';
    elsif v_kind = 'refund_observed' and v_status = 'succeeded' then
      v_kind := 'refund_confirmed';
    elsif v_kind = 'refund_observed' then
      return 'no_effect';
    end if;
    if v_refund_request is not null
       and exists (
         select 1 from public.ledger_entries as l
         where l.payment_transaction_id = v_payment.id
           and l.source_reference = 'refund:' || v_refund_request::text
       ) then
      return 'no_effect';
    end if;
    select x.* into v_request from public.payment_latest_refund_request(v_payment.id) as x;
    if v_refund_request is null
       or v_request.refund_request_id is distinct from v_refund_request then
      if v_kind = 'refund_refused' then
        return 'no_effect';
      end if;
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'unexpected_provider_refund', 'critical', v_evidence
      );
      return 'contradiction';
    end if;
    if v_payment.state <> 'refund_pending' then
      return 'no_effect';
    end if;
    if v_kind = 'refund_refused' then
      update public.payment_transactions as pt
      set state = case when pt.amount_refunded_minor = 0 then 'captured' else 'partially_refunded' end
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.refund_failed', v_payment, v_after, 'refund_failed');
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'refund_failed', 'high', v_evidence
      );
      return 'applied';
    end if;
    if v_amount is distinct from v_request.amount_minor then
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'amount_mismatch', 'critical', v_evidence
      );
      return 'contradiction';
    end if;
    v_target := case
      when v_payment.amount_refunded_minor + v_amount = v_payment.amount_captured_minor then 'fully_refunded'
      else 'partially_refunded'
    end;
    update public.payment_transactions as pt
    set state = v_target,
        amount_refunded_minor = pt.amount_refunded_minor + v_amount
    where pt.id = v_payment.id
    returning pt.* into v_after;
    perform public.payment_audit(null, p_actor_type, 'payment.refunded', v_payment, v_after, 'refund_confirmed');
    perform public.payment_post_refund(
      v_after, v_refund_request, v_request.attorney_share_minor, v_request.platform_fee_minor,
      v_request.client_fee_minor, v_request.other_required_fee_minor, p_observation ->> 'refund_reference'
    );
    return 'applied';
  end if;

  if v_kind = 'dispute_opened' then
    if v_payment.state in ('captured', 'refund_pending', 'partially_refunded', 'fully_refunded') then
      update public.payment_transactions as pt
      set state = 'charged_back'
      where pt.id = v_payment.id
      returning pt.* into v_after;
      perform public.payment_audit(null, p_actor_type, 'payment.charged_back', v_payment, v_after, 'dispute_opened');
      perform public.payment_open_exception(
        p_source_type, p_source_id, v_payment.id, 'dispute_opened', 'high', v_evidence
      );
      return 'applied';
    end if;
    perform public.payment_open_exception(
      p_source_type, p_source_id, v_payment.id,
      case when v_payment.state = 'charged_back' then 'dispute_opened' else 'provider_state_contradiction' end,
      'high', v_evidence
    );
    return case when v_payment.state = 'charged_back' then 'no_effect' else 'contradiction' end;
  end if;

  if v_kind in ('dispute_updated', 'dispute_closed') then
    perform public.payment_open_exception(
      p_source_type, p_source_id, v_payment.id, v_kind, 'medium', v_evidence
    );
    return 'no_effect';
  end if;

  return 'no_effect';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Request creation with the G-3 seam (replaces the S6 PS-A3 function under its own signature; every S6 guarantee,
-- step, refusal, lock and audit field is unchanged; only step 7a and its policy reference are added).
-- ---------------------------------------------------------------------------

create or replace function public.request_create(
  p_referral_id uuid,
  p_path text,
  p_modality text,
  p_duration_minutes integer,
  p_slot_start timestamptz,
  p_client_message text
)
returns table (outcome text, request_id uuid, problem text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_client uuid;
  v_intake uuid;
  v_state text;
  v_referral public.referrals;
  v_path text;
  v_area uuid;
  v_now timestamptz;
  v_refusal text;
  v_problem text;
  v_selection text;
  v_referral_policy uuid;
  v_limit record;
  v_window record;
  v_request uuid;
  v_evaluation uuid;
  v_area_evaluation uuid;
  v_result text;
  v_bookability uuid;
  v_bookability_result text;
  v_slot_end timestamptz;
  v_quote record;
  v_calculated timestamptz;
  v_fee uuid;
  v_hold_outcome text;
  v_hold uuid;
  v_hold_problem text;
  v_final_state text := 'created';
  v_policy_references jsonb;
  v_flow record;
begin
  if p_referral_id is null
     or p_path is null
     or p_path not in ('instant', 'scheduled')
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440
     or (p_path = 'scheduled' and p_slot_start is null)
     or (p_path = 'instant' and p_slot_start is not null)
     or (p_client_message is not null and btrim(p_client_message) = '') then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  -- Beyond the technical ceiling (PS-A1), longer than any configurable maximum.
  if p_client_message is not null and char_length(p_client_message) > 20000 then
    return query select 'message_too_long'::text, null::uuid, null::text;
    return;
  end if;
  select l.user_id, l.client_id into v_user, v_client from public.lock_current_client() as l;
  if v_client is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  select r.intake_id into v_intake
  from public.referrals as r
  join public.intakes as i on i.id = r.intake_id
  where r.id = p_referral_id
    and i.client_id = v_client;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  perform 1
  from public.intakes as i
  where i.id = v_intake
    and i.client_id = v_client
  for update;
  v_state := public.intake_expire_if_due(v_intake);
  if v_state is null or v_state not in ('submitted', 'active') then
    return query select 'intake_not_ready'::text, null::uuid, null::text;
    return;
  end if;
  select r.* into v_referral
  from public.referrals as r
  where r.id = p_referral_id
  for update;
  if exists (select 1 from public.consultation_requests as q where q.referral_id = p_referral_id) then
    return query select 'already_requested'::text, null::uuid, null::text;
    return;
  end if;
  if v_referral.outcome_code is not null or v_referral.attorney_id is null then
    return query select 'not_available'::text, null::uuid, 'referral_ended'::text;
    return;
  end if;
  v_path := public.request_referral_path(p_referral_id);
  if v_path is distinct from p_path then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  select case
    when p.client_filter_context ->> 'practice_area_id'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (p.client_filter_context ->> 'practice_area_id')::uuid
  end
  into v_area
  from public.referral_presentations as p
  where p.referral_id = p_referral_id
    and p.attorney_id = v_referral.attorney_id
  limit 1;
  -- The attorney's scheduling lock before any Request or Hold row (S4 lock order).
  perform public.scheduling_lock_attorney(v_referral.attorney_id);
  begin
    v_now := clock_timestamp();

    -- 1. The referral policy of the Referral's jurisdiction.
    select s.outcome, s.policy_version_id
    into v_selection, v_referral_policy
    from public.policy_select_version('referral', v_referral.jurisdiction_id, null, v_now) as s;
    if v_selection is distinct from 'selected' or v_referral_policy is null then
      v_refusal := 'policy_unavailable';
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 1a. The message limit of that referral policy (PS-A3 section 3.3), only when a message is given.
    if p_client_message is not null then
      select l.outcome, l.maximum_characters
      into v_limit
      from public.request_message_limit(v_referral_policy) as l;
      if v_limit.outcome = 'absent' then
        v_refusal := 'message_not_permitted';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      if v_limit.outcome is distinct from 'set' then
        v_refusal := 'policy_unavailable';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      if char_length(p_client_message) > v_limit.maximum_characters then
        v_refusal := 'message_too_long';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
    end if;

    -- 2. The response window for the path.
    select w.outcome, w.policy_version_id, w.window_seconds
    into v_window
    from public.request_response_window(v_referral.jurisdiction_id, p_path, v_now) as w;
    if v_window.outcome is distinct from 'selected' then
      v_refusal := 'policy_unavailable';
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 3. The Request, with its duration and the client's message as given.
    insert into public.consultation_requests (
      intake_id, client_id, selected_attorney_id, referral_id, request_path,
      referral_policy_version_id, requested_modality, requested_duration_minutes, client_message,
      state, response_deadline_at
    ) values (
      v_intake, v_client, v_referral.attorney_id, p_referral_id, p_path,
      v_referral_policy, p_modality, p_duration_minutes, p_client_message,
      'created', clock_timestamp() + make_interval(secs => v_window.window_seconds)
    )
    returning id into v_request;

    -- 4. Fresh eligibility (jurisdiction context, and the filtered practice-area context).
    select d.evaluation_id, d.result
    into v_evaluation, v_result
    from public.eligibility_record_decision_point(
      v_referral.attorney_id, v_referral.jurisdiction_id, null, v_now
    ) as d;
    if v_result is distinct from 'eligible' then
      v_refusal := 'not_available';
      v_problem := 'not_eligible';
      raise exception 'request refused' using errcode = 'RS601';
    end if;
    if v_area is not null then
      select d.evaluation_id, d.result
      into v_area_evaluation, v_result
      from public.eligibility_record_decision_point(
        v_referral.attorney_id, v_referral.jurisdiction_id, v_area, v_now
      ) as d;
      if v_result is distinct from 'eligible' then
        v_refusal := 'not_available';
        v_problem := 'not_eligible';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      v_evaluation := v_area_evaluation;
    end if;

    -- 5. Fresh Bookability for the Request.
    if p_path = 'scheduled' then
      v_slot_end := p_slot_start + make_interval(mins => p_duration_minutes);
    end if;
    select b.result, b.evaluation_id
    into v_bookability_result, v_bookability
    from public.scheduling_evaluate_bookability(
      v_referral.attorney_id, v_evaluation, 'consultation_request', v_request,
      p_modality, p_slot_start, v_slot_end
    ) as b;
    if v_bookability_result is distinct from 'bookable' then
      v_refusal := 'not_available';
      select f ->> 'reason' into v_problem
      from public.bookability_evaluations as e
      cross join lateral jsonb_array_elements(e.constraint_results) with ordinality as x(f, n)
      where e.id = v_bookability
        and (f ->> 'passed') is distinct from 'true'
      order by x.n
      limit 1;
      v_problem := coalesce(v_problem, 'not_bookable');
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 6. The quote from the attorney's current offer and the Fee Calculation.
    select q.* into v_quote
    from public.pricing_quote(
      v_referral.attorney_id, v_referral.jurisdiction_id, p_modality, p_duration_minutes, v_now
    ) as q;
    if v_quote.outcome is distinct from 'priced' then
      v_refusal := coalesce(v_quote.outcome, 'policy_unavailable');
      raise exception 'request refused' using errcode = 'RS601';
    end if;
    v_calculated := clock_timestamp();
    insert into public.fee_calculations (
      consultation_request_id, fee_policy_version_id, attorney_listed_price_minor,
      platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor,
      total_client_amount_minor, currency_code, quote_valid_until, calculated_at,
      supersedes_fee_calculation_id, calculation_snapshot
    ) values (
      v_request, v_quote.fee_policy_version_id, v_quote.attorney_listed_price_minor,
      v_quote.platform_fee_minor, v_quote.client_fee_minor, v_quote.tax_or_other_required_fee_minor,
      v_quote.total_client_amount_minor, v_quote.currency_code,
      v_calculated + make_interval(secs => v_quote.quote_validity_seconds), v_calculated,
      null, v_quote.calculation_snapshot
    )
    returning id into v_fee;

    -- 7. Scheduled: the Hold (exactly the offer's duration), then slot_held.
    if p_path = 'scheduled' then
      select a.outcome, a.hold_id, a.problem
      into v_hold_outcome, v_hold, v_hold_problem
      from public.scheduling_acquire_hold(v_request, p_slot_start, v_slot_end) as a;
      if v_hold_outcome is distinct from 'held' then
        v_refusal := case
          when v_hold_outcome in ('not_available', 'cap_reached', 'too_late', 'policy_unavailable')
            then v_hold_outcome
          else 'not_available'
        end;
        v_problem := v_hold_problem;
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      update public.consultation_requests as r
      set state = 'slot_held'
      where r.id = v_request;
      v_final_state := 'slot_held';
    end if;

    -- 7a. MVP-001 S7 (G-3 seam): when the payment_flow policy selected for the Referral's jurisdiction and its
    -- single active Regulatory Mode authorizes the scheduled path at the attorney's acceptance (no authorization
    -- before the decision), the scheduled Request moves slot_held -> awaiting_attorney now (DM section 9). Anything
    -- else (no selectable flow, authorization before the decision, the instant path) leaves the state as it is.
    if p_path = 'scheduled' then
      select f.* into v_flow
      from public.payment_flow_for_path(v_referral.jurisdiction_id, 'scheduled', v_now) as f;
      if v_flow.outcome = 'selected' and v_flow.authorization_timing = 'at_attorney_acceptance' then
        update public.consultation_requests as r
        set state = 'awaiting_attorney'
        where r.id = v_request;
        v_final_state := 'awaiting_attorney';
      end if;
    end if;

    -- 8. One audit event.
    select case when jsonb_typeof(e.policy_references) = 'array' then e.policy_references else '[]'::jsonb end
    into v_policy_references
    from public.eligibility_evaluations as e
    where e.id = v_evaluation;
    v_policy_references := coalesce(v_policy_references, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('policy_type_code', 'referral', 'policy_version_id', v_referral_policy),
      jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', v_quote.fee_policy_version_id),
      jsonb_build_object(
        'policy_type_code', 'fee',
        'policy_version_id', v_quote.calculation_snapshot -> 'inputs' -> 'platform_fee_policy_version_id'
      ),
      jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_window.policy_version_id)
    );
    if v_final_state = 'awaiting_attorney' then
      v_policy_references := v_policy_references || jsonb_build_array(
        jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', v_flow.policy_version_id)
      );
    end if;
    insert into public.audit_events (
      actor_user_id, actor_type, action_code, resource_type, resource_id,
      before_snapshot, after_snapshot, reason_code, policy_references,
      jurisdiction_id, occurred_at
    ) values (
      v_user, 'client', 'consultation_request.created', 'consultation_request', v_request,
      null,
      jsonb_build_object(
        'referral_id', p_referral_id,
        'intake_id', v_intake,
        'attorney_id', v_referral.attorney_id,
        'request_path', p_path,
        'requested_modality', p_modality,
        'duration_minutes', p_duration_minutes,
        'state', v_final_state,
        'eligibility_evaluation_id', v_evaluation,
        'bookability_evaluation_id', v_bookability,
        'fee_calculation_id', v_fee,
        'offer_id', v_quote.calculation_snapshot -> 'inputs' -> 'offer' -> 'id',
        'hold_id', v_hold,
        'attorney_listed_price_minor', v_quote.attorney_listed_price_minor,
        'platform_fee_minor', v_quote.platform_fee_minor,
        'client_fee_minor', v_quote.client_fee_minor,
        'tax_or_other_required_fee_minor', v_quote.tax_or_other_required_fee_minor,
        'total_client_amount_minor', v_quote.total_client_amount_minor,
        'currency_code', v_quote.currency_code,
        'quote_valid_until', v_calculated + make_interval(secs => v_quote.quote_validity_seconds)
      ),
      null, v_policy_references, v_referral.jurisdiction_id, clock_timestamp()
    );
  exception
    when sqlstate 'RS601' then
      return query select v_refusal, null::uuid, v_problem;
      return;
    when unique_violation then
      return query select 'already_requested'::text, null::uuid, null::text;
      return;
    when foreign_key_violation then
      return query select 'not_available'::text, null::uuid, null::text;
      return;
  end;
  return query select 'created'::text, v_request, null::text;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The client's payment authorization and reads (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Creates the payment attempt for one of the caller's own undecided Requests whose flow requires authorization
-- before the attorney decision, with complete FP-1 provenance, one audit event and the enqueued hosted checkout.
-- Outcomes: created (payment id), pending (the live attempt's id), invalid, not_found (another client's Request and
-- an unknown one alike), expired, not_payable (with the live attempt's state, or none: the Request is not in its
-- pre-decision state), not_required (the flow authorizes at the attorney's acceptance), policy_unavailable (with the
-- missing piece), production_gate_closed (with the gate's reason). Any refusal writes nothing.
create function public.client_authorize_payment(p_request_id uuid)
returns table (outcome text, payment_transaction_id uuid, problem text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_environment text;
  v_user uuid;
  v_client uuid;
  v_attorney uuid;
  v_state text;
  v_request public.consultation_requests;
  v_jurisdiction uuid;
  v_fee public.fee_calculations;
  v_now timestamptz;
  v_flow record;
  v_policies jsonb := '{}'::jsonb;
  v_type text;
  v_selection record;
  v_check record;
  v_development boolean;
  v_gate record;
  v_existing public.payment_transactions;
  v_payment public.payment_transactions;
begin
  if p_request_id is null then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select 'policy_unavailable'::text, null::uuid, v_environment;
    return;
  end if;
  select l.user_id, l.client_id into v_user, v_client from public.lock_current_client() as l;
  if v_client is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  select r.selected_attorney_id into v_attorney
  from public.consultation_requests as r
  where r.id = p_request_id
    and r.client_id = v_client;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- S6 lock order: the attorney's scheduling lock, the Request's expiry (Hold, then Request), then the payment.
  perform public.scheduling_lock_attorney(v_attorney);
  v_state := public.request_expire_if_due(p_request_id, false);
  if v_state = 'expired' then
    return query select 'expired'::text, null::uuid, null::text;
    return;
  end if;
  select r.* into v_request from public.consultation_requests as r where r.id = p_request_id for update;
  if not (
    (v_request.request_path = 'instant' and v_request.state = 'created')
    or (v_request.request_path = 'scheduled' and v_request.state = 'slot_held')
  ) then
    return query select 'not_payable'::text, null::uuid, null::text;
    return;
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  v_now := clock_timestamp();
  v_fee := public.payment_current_fee_calculation(p_request_id);
  if v_fee.id is null then
    return query select 'policy_unavailable'::text, null::uuid, 'fee_calculation_unavailable'::text;
    return;
  end if;
  select f.* into v_flow from public.payment_flow_for_path(v_jurisdiction, v_request.request_path, v_now) as f;
  if v_flow.outcome is distinct from 'selected' then
    return query select 'policy_unavailable'::text, null::uuid,
      case
        when v_flow.outcome like 'regulatory_mode_%' then v_flow.outcome
        else 'payment_flow_' || coalesce(v_flow.outcome, 'no_applicable_policy')
      end;
    return;
  end if;
  if v_flow.authorization_timing is distinct from 'before_attorney_decision' then
    return query select 'not_required'::text, null::uuid, null::text;
    return;
  end if;
  foreach v_type in array array['payment', 'engagement', 'cancellation', 'refund'] loop
    if v_type = 'engagement' and v_request.engagement_policy_version_id is not null then
      v_policies := v_policies || jsonb_build_object('engagement', v_request.engagement_policy_version_id);
      continue;
    end if;
    select s.outcome, s.policy_version_id into v_selection
    from public.policy_select_version(v_type, v_jurisdiction, v_flow.regulatory_mode_id, v_now) as s;
    if v_selection.outcome is distinct from 'selected' or v_selection.policy_version_id is null then
      return query select 'policy_unavailable'::text, null::uuid,
        v_type || '_' || coalesce(v_selection.outcome, 'no_applicable_policy');
      return;
    end if;
    v_policies := v_policies || jsonb_build_object(v_type, v_selection.policy_version_id);
  end loop;
  -- The four-way production financial gate, for every policy the payment records (MBS section 19; TA section 32 F1
  -- and F2): a production-class database uses no development-only version, and each version must be the approved
  -- one the gate selects for a live, launch-authorized jurisdiction.
  if public.rosuno_environment_class() = 'production' then
    for v_check in
      select x.policy_type_code, x.policy_version_id, x.scope_mode
      from (
        values
          ('referral'::text, v_request.referral_policy_version_id, null::uuid),
          ('fee'::text, v_fee.fee_policy_version_id, null::uuid),
          ('payment_flow'::text, v_flow.policy_version_id, v_flow.regulatory_mode_id),
          ('payment'::text, (v_policies ->> 'payment')::uuid, v_flow.regulatory_mode_id),
          ('engagement'::text, (v_policies ->> 'engagement')::uuid, v_flow.regulatory_mode_id),
          ('cancellation'::text, (v_policies ->> 'cancellation')::uuid, v_flow.regulatory_mode_id),
          ('refund'::text, (v_policies ->> 'refund')::uuid, v_flow.regulatory_mode_id)
      ) as x(policy_type_code, policy_version_id, scope_mode)
    loop
      select v.development_only into v_development
      from public.policy_versions as v
      where v.id = v_check.policy_version_id;
      if v_development is distinct from false then
        return query select 'production_gate_closed'::text, null::uuid, 'development_policy'::text;
        return;
      end if;
      select g.permitted, g.reason into v_gate
      from public.production_financial_gate(v_jurisdiction, v_check.policy_type_code, v_check.scope_mode, v_now) as g;
      if v_gate.permitted is distinct from true then
        return query select 'production_gate_closed'::text, null::uuid, coalesce(v_gate.reason, 'gate_unavailable');
        return;
      end if;
      select s.outcome, s.policy_version_id into v_selection
      from public.policy_select_version(v_check.policy_type_code, v_jurisdiction, v_check.scope_mode, v_now) as s;
      if v_selection.policy_version_id is distinct from v_check.policy_version_id then
        return query select 'production_gate_closed'::text, null::uuid, 'policy_not_current'::text;
        return;
      end if;
    end loop;
  end if;
  select pt.* into v_existing
  from public.payment_transactions as pt
  where pt.consultation_request_id = p_request_id
    and pt.state not in ('failed', 'cancelled', 'authorization_released')
  for update;
  if found then
    if v_existing.state = 'pending_authorization' then
      return query select 'pending'::text, v_existing.id, null::text;
    else
      return query select 'not_payable'::text, v_existing.id, v_existing.state;
    end if;
    return;
  end if;
  begin
    insert into public.payment_transactions (
      fee_calculation_id, consultation_request_id, consultation_id, jurisdiction_id, regulatory_mode_id,
      referral_policy_version_id, payment_policy_version_id, fee_policy_version_id,
      payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id,
      refund_policy_version_id, state, currency_code, provider_code
    ) values (
      v_fee.id, p_request_id, null, v_jurisdiction, v_flow.regulatory_mode_id,
      v_request.referral_policy_version_id, (v_policies ->> 'payment')::uuid, v_fee.fee_policy_version_id,
      v_flow.policy_version_id, (v_policies ->> 'engagement')::uuid, (v_policies ->> 'cancellation')::uuid,
      (v_policies ->> 'refund')::uuid, 'pending_authorization', v_fee.currency_code, 'stripe'
    )
    returning * into v_payment;
  exception
    when check_violation or foreign_key_violation then
      return query select 'policy_unavailable'::text, null::uuid, 'provenance_invalid'::text;
      return;
  end;
  perform public.payment_audit(
    v_user, 'client', 'payment.created', null::public.payment_transactions, v_payment, 'client_authorization'
  );
  perform public.payment_enqueue('payment.checkout', 'payment_transaction', v_payment.id);
  return query select 'created'::text, v_payment.id, null::text;
end;
$function$;

-- The hosted checkout reference of one of the caller's own pending attempts: ready (with the reference), preparing
-- (the checkout job has not recorded it yet) or not_pending. Another client's or an unknown attempt answers no row.
create function public.client_payment_checkout(p_payment_id uuid)
returns table (outcome text, checkout_reference text, consultation_request_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    case
      when pt.state <> 'pending_authorization' then 'not_pending'
      when pt.provider_payment_reference is null then 'preparing'
      else 'ready'
    end,
    case when pt.state = 'pending_authorization' then pt.provider_payment_reference end,
    pt.consultation_request_id
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id
  join public.payment_transactions as pt on pt.consultation_request_id = r.id and pt.id = p_payment_id
  where p_payment_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

-- The payment step of one of the caller's own Requests and its latest attempt: authorization_required (the flow asks
-- for authorization before the attorney decision and the Request waits for it), not_required_now (the flow authorizes
-- at the attorney's acceptance), unavailable (no selectable flow) or not_applicable (the Request is past its
-- pre-decision state, or due to expire). payable: an attempt can be started or continued now. Another client's or an
-- unknown Request answers no row. Never a provider reference, a policy or the attorney-side fee.
create function public.client_request_payment(p_request_id uuid)
returns table (
  consultation_request_id uuid,
  payment_step text,
  payable boolean,
  payment_transaction_id uuid,
  payment_state text,
  amount_authorized_minor bigint,
  amount_captured_minor bigint,
  amount_refunded_minor bigint,
  total_client_amount_minor bigint,
  currency_code text,
  created_at timestamptz,
  authorized_at timestamptz,
  captured_at timestamptz,
  failed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_request public.consultation_requests;
  v_jurisdiction uuid;
  v_pre_decision boolean;
  v_flow record;
  v_step text;
  v_payment public.payment_transactions;
  v_fee public.fee_calculations;
begin
  if p_request_id is null then
    return;
  end if;
  select r.* into v_request
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id and r.id = p_request_id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
  if not found then
    return;
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  v_pre_decision := (
    (v_request.request_path = 'instant' and v_request.state = 'created')
    or (v_request.request_path = 'scheduled' and v_request.state = 'slot_held')
  ) and not coalesce(public.request_expired_due(v_request.id), false);
  if not v_pre_decision then
    v_step := 'not_applicable';
  else
    select f.* into v_flow from public.payment_flow_for_path(v_jurisdiction, v_request.request_path, clock_timestamp()) as f;
    v_step := case
      when v_flow.outcome is distinct from 'selected' then 'unavailable'
      when v_flow.authorization_timing = 'before_attorney_decision' then 'authorization_required'
      else 'not_required_now'
    end;
  end if;
  select pt.* into v_payment
  from public.payment_transactions as pt
  where pt.consultation_request_id = v_request.id
  order by pt.created_at desc, pt.id desc
  limit 1;
  v_fee := public.payment_current_fee_calculation(v_request.id);
  return query select
    v_request.id,
    v_step,
    v_step = 'authorization_required'
      and (v_payment.id is null or v_payment.state in ('pending_authorization', 'failed', 'cancelled', 'authorization_released')),
    v_payment.id,
    v_payment.state,
    v_payment.amount_authorized_minor,
    v_payment.amount_captured_minor,
    v_payment.amount_refunded_minor,
    v_fee.total_client_amount_minor,
    coalesce(v_payment.currency_code, v_fee.currency_code)::text,
    v_payment.created_at,
    v_payment.authorized_at,
    v_payment.captured_at,
    v_payment.failed_at;
end;
$function$;

-- The receipt of one of the caller's own payment attempts: the client-side quote amounts from its Fee Calculation,
-- its state and amounts, and each refund as the ledger recorded it. Another client's or an unknown attempt answers no
-- row.
create function public.client_payment_receipt(p_payment_id uuid)
returns table (
  payment_transaction_id uuid,
  consultation_request_id uuid,
  payment_state text,
  attorney_listed_price_minor bigint,
  client_fee_minor bigint,
  tax_or_other_required_fee_minor bigint,
  total_client_amount_minor bigint,
  currency_code text,
  amount_authorized_minor bigint,
  amount_captured_minor bigint,
  amount_refunded_minor bigint,
  created_at timestamptz,
  authorized_at timestamptz,
  captured_at timestamptz,
  refunds jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    pt.id,
    pt.consultation_request_id,
    pt.state,
    c.attorney_listed_price_minor,
    c.client_fee_minor,
    c.tax_or_other_required_fee_minor,
    c.total_client_amount_minor,
    pt.currency_code::text,
    pt.amount_authorized_minor,
    pt.amount_captured_minor,
    pt.amount_refunded_minor,
    pt.created_at,
    pt.authorized_at,
    pt.captured_at,
    coalesce((
      select jsonb_agg(
        jsonb_build_object('amount_minor', l.amount_minor, 'effective_at', l.effective_at)
        order by l.effective_at, l.id
      )
      from public.ledger_entries as l
      where l.payment_transaction_id = pt.id
        and l.entry_type = 'client_payment'
        and l.direction = 'credit'
    ), '[]'::jsonb)
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id
  join public.payment_transactions as pt on pt.consultation_request_id = r.id and pt.id = p_payment_id
  join public.fee_calculations as c on c.id = pt.fee_calculation_id
  where p_payment_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

-- ---------------------------------------------------------------------------
-- The attorney's ledger-derived earnings (EXECUTE for authenticated only; aal2 and an approved profile).
-- ---------------------------------------------------------------------------

-- Per payment of the attorney's own Requests: the attorney_share credits and debits the ledger holds and their net,
-- in the payment's currency. Derived only from the ledger: no balance, payout or settlement is stored or implied.
create function public.attorney_payment_earnings()
returns table (
  payment_transaction_id uuid,
  consultation_request_id uuid,
  captured_at timestamptz,
  currency_code text,
  attributed_minor bigint,
  reversed_minor bigint,
  net_minor bigint
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with me as (
    select p.id
    from public.attorney_profiles as p
    join public.users as u on u.id = p.user_id
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
      and p.profile_state = 'approved'
      and public.current_session_aal2() is true
  )
  select
    pt.id,
    pt.consultation_request_id,
    pt.captured_at,
    pt.currency_code::text,
    coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)::bigint,
    coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0)::bigint,
    (coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)
      - coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0))::bigint
  from me
  join public.consultation_requests as r on r.selected_attorney_id = me.id
  join public.payment_transactions as pt on pt.consultation_request_id = r.id
  join public.ledger_entries as l on l.payment_transaction_id = pt.id and l.entry_type = 'attorney_share'
  group by pt.id, pt.consultation_request_id, pt.captured_at, pt.currency_code
  order by pt.captured_at desc nulls last, pt.id
  limit 500;
$function$;

-- ---------------------------------------------------------------------------
-- The staff finance workspace (manage_financial_operations, global grant, aal2). Reads answer no row without the
-- capability; changes lock User -> Staff Profile -> grant, then the row, and write the change and one audit event.
-- ---------------------------------------------------------------------------

-- One page (25 rows, plus one to tell whether another page follows) of payments in a group: open (in flight),
-- collected (captured, refunded or charged back), ended (failed, cancelled, released, capture failed) or all.
create function public.staff_finance_payments(p_group text, p_offset integer)
returns table (
  payment_transaction_id uuid,
  consultation_request_id uuid,
  state text,
  currency_code text,
  total_client_amount_minor bigint,
  amount_authorized_minor bigint,
  amount_captured_minor bigint,
  amount_refunded_minor bigint,
  created_at timestamptz,
  updated_at timestamptz,
  open_exceptions integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    pt.id,
    pt.consultation_request_id,
    pt.state,
    pt.currency_code::text,
    c.total_client_amount_minor,
    pt.amount_authorized_minor,
    pt.amount_captured_minor,
    pt.amount_refunded_minor,
    pt.created_at,
    pt.updated_at,
    (
      select count(*)::integer from public.reconciliation_exceptions as e
      where e.canonical_type = 'payment_transaction' and e.canonical_id = pt.id and e.status = 'open'
    )
  from public.payment_transactions as pt
  join public.fee_calculations as c on c.id = pt.fee_calculation_id
  where public.has_staff_capability('manage_financial_operations', null, false)
    and p_group in ('open', 'collected', 'ended', 'all')
    and p_offset between 0 and 100000
    and (
      p_group = 'all'
      or (p_group = 'open'
          and pt.state in ('pending_authorization', 'authorized', 'release_pending', 'capture_pending', 'refund_pending'))
      or (p_group = 'collected'
          and pt.state in ('captured', 'partially_refunded', 'fully_refunded', 'charged_back'))
      or (p_group = 'ended'
          and pt.state in ('failed', 'cancelled', 'authorization_released', 'capture_failed'))
    )
  order by pt.created_at desc, pt.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One payment in full for finance staff: state, amounts, the Fee Calculation components, the provider reference and
-- the FP-1 provenance. Never card data (Rosuno holds none).
create function public.staff_finance_payment(p_payment_id uuid)
returns table (
  payment_transaction_id uuid,
  consultation_request_id uuid,
  request_path text,
  request_state text,
  state text,
  currency_code text,
  attorney_listed_price_minor bigint,
  platform_fee_minor bigint,
  client_fee_minor bigint,
  tax_or_other_required_fee_minor bigint,
  total_client_amount_minor bigint,
  amount_authorized_minor bigint,
  amount_captured_minor bigint,
  amount_refunded_minor bigint,
  provider_code text,
  provider_payment_reference text,
  jurisdiction_id uuid,
  regulatory_mode_id uuid,
  referral_policy_version_id uuid,
  payment_policy_version_id uuid,
  fee_policy_version_id uuid,
  payment_flow_policy_version_id uuid,
  engagement_policy_version_id uuid,
  cancellation_policy_version_id uuid,
  refund_policy_version_id uuid,
  created_at timestamptz,
  authorized_at timestamptz,
  captured_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    pt.id, pt.consultation_request_id, r.request_path, r.state, pt.state, pt.currency_code::text,
    c.attorney_listed_price_minor, c.platform_fee_minor, c.client_fee_minor, c.tax_or_other_required_fee_minor,
    c.total_client_amount_minor, pt.amount_authorized_minor, pt.amount_captured_minor, pt.amount_refunded_minor,
    pt.provider_code, pt.provider_payment_reference, pt.jurisdiction_id, pt.regulatory_mode_id,
    pt.referral_policy_version_id, pt.payment_policy_version_id, pt.fee_policy_version_id,
    pt.payment_flow_policy_version_id, pt.engagement_policy_version_id, pt.cancellation_policy_version_id,
    pt.refund_policy_version_id, pt.created_at, pt.authorized_at, pt.captured_at, pt.failed_at, pt.updated_at
  from public.payment_transactions as pt
  join public.fee_calculations as c on c.id = pt.fee_calculation_id
  join public.consultation_requests as r on r.id = pt.consultation_request_id
  where pt.id = p_payment_id
    and public.has_staff_capability('manage_financial_operations', null, false);
$function$;

-- The ledger entries of one payment, in posting order.
create function public.staff_finance_ledger(p_payment_id uuid)
returns table (
  ledger_entry_id uuid,
  entry_type text,
  direction text,
  amount_minor bigint,
  currency_code text,
  effective_at timestamptz,
  source_reference text,
  reason_code text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select l.id, l.entry_type, l.direction, l.amount_minor, l.currency_code::text, l.effective_at,
    l.source_reference, l.reason_code
  from public.ledger_entries as l
  where l.payment_transaction_id = p_payment_id
    and public.has_staff_capability('manage_financial_operations', null, false)
  order by l.created_at, l.source_reference,
    case l.entry_type
      when 'client_payment' then 1
      when 'attorney_share' then 2
      when 'platform_fee' then 3
      when 'client_fee' then 4
      else 5
    end,
    l.id
  limit 200;
$function$;

-- The provider event receipts correlated to one payment (event type, outcome and times; no payload).
create function public.staff_finance_receipts(p_payment_id uuid)
returns table (
  provider_code text,
  provider_event_reference text,
  event_type text,
  processing_state text,
  received_at timestamptz,
  processed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select x.provider_code, x.provider_event_reference, x.event_type, x.processing_state, x.received_at, x.processed_at
  from public.external_event_receipts as x
  where p_payment_id is not null
    and x.correlation_reference = p_payment_id::text
    and public.has_staff_capability('manage_financial_operations', null, false)
  order by x.received_at desc, x.id
  limit 200;
$function$;

-- One page (25 rows, plus one) of Reconciliation Exceptions by status (open first by detection, or resolved).
create function public.staff_finance_exceptions(p_status text, p_offset integer)
returns table (
  exception_id uuid,
  exception_type text,
  severity text,
  status text,
  source_type text,
  source_id uuid,
  canonical_type text,
  canonical_id uuid,
  detected_at timestamptz,
  evidence_reference jsonb,
  assigned_to_user_id uuid,
  assigned_to_me boolean,
  resolved_at timestamptz,
  resolution_notes text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    e.id, e.exception_type, e.severity, e.status, e.source_type, e.source_id, e.canonical_type, e.canonical_id,
    e.detected_at, e.evidence_reference, e.assigned_to_user_id,
    coalesce(e.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false),
    e.resolved_at, e.resolution_notes
  from public.reconciliation_exceptions as e
  where public.has_staff_capability('manage_financial_operations', null, false)
    and p_status in ('open', 'resolved')
    and e.status = p_status
    and p_offset between 0 and 100000
  order by e.detected_at desc, e.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- A staff refund of a captured payment, within what remains of each Fee Calculation component (captured less earlier
-- refunds). Staff choose the allocation and give a reason (bounded plain text, recorded in the audit event with the
-- payment's refund policy version); entitlement is not decided here (refund policy is gated). The request is the
-- audit event itself (its id is the refund request id the provider sees in metadata and the ledger source); the
-- payment moves to refund_pending and the refund job is enqueued, all in one transaction, so a second refund waits
-- for this one. Outcomes: requested (refund request id), invalid, denied, not_found, refund_in_progress,
-- not_refundable, exceeds_refundable, policy_unavailable (environment unrecorded or mismatched).
create function public.staff_request_refund(
  p_payment_id uuid,
  p_attorney_share_minor bigint,
  p_platform_fee_minor bigint,
  p_client_fee_minor bigint,
  p_other_required_fee_minor bigint,
  p_reason text
)
returns table (outcome text, refund_request_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_before public.payment_transactions;
  v_after public.payment_transactions;
  v_remaining record;
  v_amount bigint;
  v_request uuid;
begin
  if p_payment_id is null
     or p_attorney_share_minor is null or p_attorney_share_minor not between 0 and 1000000000000
     or p_platform_fee_minor is null or p_platform_fee_minor not between 0 and 1000000000000
     or p_client_fee_minor is null or p_client_fee_minor not between 0 and 1000000000000
     or p_other_required_fee_minor is null or p_other_required_fee_minor not between 0 and 1000000000000
     or p_attorney_share_minor + p_platform_fee_minor + p_client_fee_minor + p_other_required_fee_minor <= 0
     or p_reason is null
     or not public.professional_text_within(p_reason, 500) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if public.rosuno_environment_status() <> 'ok' then
    return query select 'policy_unavailable'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_financial_operations', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  select pt.* into v_before from public.payment_transactions as pt where pt.id = p_payment_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_before.state = 'refund_pending' then
    return query select 'refund_in_progress'::text, null::uuid;
    return;
  end if;
  if v_before.state not in ('captured', 'partially_refunded') then
    return query select 'not_refundable'::text, null::uuid;
    return;
  end if;
  select x.* into v_remaining from public.payment_refundable_components(p_payment_id) as x;
  v_amount := p_attorney_share_minor + p_platform_fee_minor + p_client_fee_minor + p_other_required_fee_minor;
  if p_attorney_share_minor > v_remaining.attorney_share_minor
     or p_platform_fee_minor > v_remaining.platform_fee_minor
     or p_client_fee_minor > v_remaining.client_fee_minor
     or p_other_required_fee_minor > v_remaining.other_required_fee_minor
     or v_amount > v_before.amount_captured_minor - v_before.amount_refunded_minor then
    return query select 'exceeds_refundable'::text, null::uuid;
    return;
  end if;
  update public.payment_transactions as pt
  set state = 'refund_pending'
  where pt.id = p_payment_id
  returning pt.* into v_after;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'payment.refund_requested', 'payment_transaction', p_payment_id,
    public.payment_snapshot(v_before),
    public.payment_snapshot(v_after) || jsonb_build_object(
      'amount_minor', v_amount,
      'attorney_share_minor', p_attorney_share_minor,
      'platform_fee_minor', p_platform_fee_minor,
      'client_fee_minor', p_client_fee_minor,
      'other_required_fee_minor', p_other_required_fee_minor,
      'reason', p_reason
    ),
    'staff_refund',
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'refund', 'policy_version_id', v_before.refund_policy_version_id)
    ),
    v_before.jurisdiction_id, clock_timestamp()
  )
  returning id into v_request;
  perform public.payment_enqueue('payment.refund', 'payment_refund_request', v_request);
  return query select 'requested'::text, v_request;
end;
$function$;

-- Assigns an open exception to the calling finance staff member (p_assign true) or clears its assignment (false).
-- No User id is taken as input: the assignee is always the caller. Outcomes: applied, invalid, denied, not_found,
-- invalid_transition (resolved).
create function public.staff_assign_reconciliation_exception(p_exception_id uuid, p_assign boolean)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.reconciliation_exceptions;
begin
  if p_exception_id is null or p_assign is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_financial_operations', null);
  if v_staff is null then
    return 'denied';
  end if;
  select e.* into v_before from public.reconciliation_exceptions as e where e.id = p_exception_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.status <> 'open' then
    return 'invalid_transition';
  end if;
  update public.reconciliation_exceptions as e
  set assigned_to_user_id = case when p_assign then v_staff else null end
  where e.id = p_exception_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'reconciliation_exception.assigned', 'reconciliation_exception', p_exception_id,
    jsonb_build_object('assigned_to_user_id', v_before.assigned_to_user_id),
    jsonb_build_object('assigned_to_user_id', case when p_assign then v_staff else null end),
    null, null, null, clock_timestamp()
  );
  return 'applied';
end;
$function$;

-- Resolves an open exception once, with the staff member's notes (bounded plain text stored on the exception; the
-- audit event carries the status change only). Outcomes: applied, invalid, denied, not_found, invalid_transition.
create function public.staff_resolve_reconciliation_exception(p_exception_id uuid, p_notes text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.reconciliation_exceptions;
begin
  if p_exception_id is null or p_notes is null or not public.professional_text_within(p_notes, 2000) then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_financial_operations', null);
  if v_staff is null then
    return 'denied';
  end if;
  select e.* into v_before from public.reconciliation_exceptions as e where e.id = p_exception_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.status <> 'open' then
    return 'invalid_transition';
  end if;
  update public.reconciliation_exceptions as e
  set status = 'resolved',
      resolved_at = clock_timestamp(),
      resolution_notes = p_notes
  where e.id = p_exception_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'reconciliation_exception.resolved', 'reconciliation_exception', p_exception_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'resolved', 'exception_type', v_before.exception_type),
    null, null, null, clock_timestamp()
  );
  return 'applied';
end;
$function$;

-- Asks the worker to compare canonical state with the provider for one payment, or (null) for every payment that has
-- a provider reference and is not ended (at most 200, oldest update first). Outcomes: requested (with the number
-- enqueued; an open reconciliation job is reused), invalid, denied, not_found.
create function public.staff_request_reconciliation(p_payment_id uuid)
returns table (outcome text, enqueued integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_id uuid;
  v_count integer := 0;
begin
  v_staff := public.lock_current_capability_staff('manage_financial_operations', null);
  if v_staff is null then
    return query select 'denied'::text, 0;
    return;
  end if;
  if p_payment_id is not null then
    if not exists (
      select 1 from public.payment_transactions as pt
      where pt.id = p_payment_id and pt.provider_payment_reference is not null
    ) then
      return query select 'not_found'::text, 0;
      return;
    end if;
    perform public.payment_enqueue('payment.reconcile', 'payment_transaction', p_payment_id);
    v_count := 1;
  else
    for v_id in
      select pt.id
      from public.payment_transactions as pt
      where pt.provider_payment_reference is not null
        and pt.state not in ('failed', 'cancelled', 'authorization_released')
      order by pt.updated_at, pt.id
      limit 200
    loop
      perform public.payment_enqueue('payment.reconcile', 'payment_transaction', v_id);
      v_count := v_count + 1;
    end loop;
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'payment.reconciliation_requested', 'payment_transaction', p_payment_id,
    null, jsonb_build_object('enqueued', v_count), null, null, null, clock_timestamp()
  );
  return query select 'requested'::text, v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The worker and the webhook (service_role only: the server-only privileged credential).
-- ---------------------------------------------------------------------------

-- The payment a running payment job concerns (its subject, or the refund request's payment), or null.
create function public.payment_of_job(p_job public.operational_jobs)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_job.subject_type
    when 'payment_transaction' then p_job.subject_id
    when 'payment_refund_request' then (
      select a.resource_id
      from public.audit_events as a
      where a.id = p_job.subject_id
        and a.action_code = 'payment.refund_requested'
        and a.resource_type = 'payment_transaction'
        and a.actor_type = 'staff'
    )
  end;
$function$;

-- What a running payment job is to do now: act (with what the provider call needs), nothing_to_do (the payment no
-- longer needs it), wait (a release whose checkout is still being prepared) or not_running (not a running payment
-- job). The provider call's deterministic idempotency key is built by the worker from the payment id, the operation
-- and the refund request id; amounts and the checkout expiry bound come from canonical state only.
create function public.payment_job_context(p_job_id uuid)
returns table (
  outcome text,
  operation text,
  payment_transaction_id uuid,
  consultation_request_id uuid,
  state text,
  provider_reference text,
  reference_kind text,
  currency_code text,
  amount_minor bigint,
  refund_request_id uuid,
  checkout_expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_job public.operational_jobs;
  v_payment public.payment_transactions;
  v_operation text;
  v_fee public.fee_calculations;
  v_request public.consultation_requests;
  v_refund record;
  v_kind text;
  v_outcome text := 'nothing_to_do';
  v_amount bigint;
  v_expires timestamptz;
begin
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
    and j.state = 'running'
    and j.job_type in ('payment.checkout', 'payment.capture', 'payment.release', 'payment.refund', 'payment.reconcile');
  if not found then
    return query select 'not_running'::text, null::text, null::uuid, null::uuid, null::text, null::text, null::text,
      null::text, null::bigint, null::uuid, null::timestamptz;
    return;
  end if;
  v_operation := substring(v_job.job_type from 9);
  select pt.* into v_payment from public.payment_transactions as pt where pt.id = public.payment_of_job(v_job);
  if not found then
    return query select 'not_running'::text, v_operation, null::uuid, null::uuid, null::text, null::text, null::text,
      null::text, null::bigint, null::uuid, null::timestamptz;
    return;
  end if;
  select c.* into v_fee from public.fee_calculations as c where c.id = v_payment.fee_calculation_id;
  select r.* into v_request from public.consultation_requests as r where r.id = v_payment.consultation_request_id;
  v_kind := case
    when v_payment.provider_payment_reference is null then 'none'
    when v_payment.authorized_at is null then 'checkout'
    else 'payment'
  end;
  v_amount := coalesce(v_payment.amount_authorized_minor, v_fee.total_client_amount_minor);
  if v_operation = 'checkout' then
    if v_payment.state = 'pending_authorization' and v_kind = 'none' then
      v_outcome := 'act';
      v_amount := v_fee.total_client_amount_minor;
      select least(
        v_fee.quote_valid_until,
        v_request.response_deadline_at,
        (select h.expires_at from public.slot_holds as h
         where h.consultation_request_id = v_request.id and h.released_at is null)
      ) into v_expires;
    end if;
  elsif v_operation = 'capture' then
    if v_payment.state = 'capture_pending' and v_kind = 'payment' then
      v_outcome := 'act';
    end if;
  elsif v_operation = 'release' then
    if v_payment.state = 'release_pending' then
      if v_kind = 'none' and exists (
        select 1 from public.operational_jobs as j
        where j.job_type = 'payment.checkout'
          and j.subject_type = 'payment_transaction'
          and j.subject_id = v_payment.id
          and j.state in ('pending', 'running')
      ) then
        v_outcome := 'wait';
      else
        v_outcome := 'act';
      end if;
    elsif v_payment.state = 'failed' and v_kind = 'checkout' then
      v_outcome := 'act';
    end if;
  elsif v_operation = 'refund' then
    select x.* into v_refund from public.payment_latest_refund_request(v_payment.id) as x;
    if v_payment.state = 'refund_pending'
       and v_kind = 'payment'
       and v_refund.refund_request_id = v_job.subject_id then
      v_outcome := 'act';
      v_amount := v_refund.amount_minor;
    end if;
  elsif v_operation = 'reconcile' then
    if v_kind <> 'none' then
      v_outcome := 'act';
    end if;
  end if;
  return query select
    v_outcome,
    v_operation,
    v_payment.id,
    v_payment.consultation_request_id,
    v_payment.state,
    v_payment.provider_payment_reference,
    v_kind,
    v_payment.currency_code::text,
    v_amount,
    case when v_operation = 'refund' then v_job.subject_id end,
    v_expires;
end;
$function$;

-- Records the result of one provider call made by a running payment job, as an observation of that job's payment
-- (the kinds each operation may report are fixed). Answers applied, no_effect, stale, contradiction (an exception is
-- open), invalid or not_running.
create function public.payment_record_operation(p_job_id uuid, p_observation jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_job public.operational_jobs;
  v_payment uuid;
  v_kind text;
begin
  if p_job_id is null or not public.payment_observation_valid(p_observation) then
    return 'invalid';
  end if;
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
    and j.state = 'running'
    and j.job_type in ('payment.checkout', 'payment.capture', 'payment.release', 'payment.refund', 'payment.reconcile');
  if not found then
    return 'not_running';
  end if;
  v_payment := public.payment_of_job(v_job);
  if v_payment is null then
    return 'not_running';
  end if;
  v_kind := p_observation ->> 'kind';
  if not (
    (v_job.job_type = 'payment.checkout' and v_kind = 'checkout_open')
    or (v_job.job_type = 'payment.capture' and v_kind in ('capture_confirmed', 'capture_refused', 'provider_state'))
    or (v_job.job_type = 'payment.release'
        and v_kind in ('checkout_expired', 'authorization_released', 'provider_state'))
    or (v_job.job_type = 'payment.refund'
        and v_kind in ('refund_confirmed', 'refund_refused')
        and (p_observation ->> 'refund_request_id') = v_job.subject_id::text)
    or (v_job.job_type = 'payment.reconcile' and v_kind = 'provider_state')
  ) then
    return 'invalid';
  end if;
  return public.payment_apply_observation(v_payment, p_observation, 'operational_job', v_job.id, 'system');
end;
$function$;

-- Records one authenticated provider event (the webhook route verified its signature first): the receipt first,
-- unique per (provider, event reference), so a replay or a concurrent duplicate is a no-op ('duplicate'); then, in the
-- same transaction, the observation is matched to its payment (provider payment reference, then checkout reference,
-- then the payment id the provider metadata carries) and applied. An event for no known payment opens an exception
-- (unknown_payment_reference); an event kind outside the vocabulary is recorded as ignored. The receipt keeps only the
-- validated observation and the payload digest. Outcomes: recorded (with the processing outcome), duplicate (with the
-- first delivery's outcome), invalid.
create function public.payment_record_provider_event(
  p_provider_code text,
  p_event_reference text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload_digest text,
  p_observation jsonb
)
returns table (outcome text, processing_state text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_receipt uuid;
  v_kind text;
  v_payment uuid;
  v_state text;
  v_reference text;
  v_checkout text;
  v_metadata uuid;
begin
  if p_provider_code is null or p_provider_code collate "C" !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_event_reference is null or p_event_reference collate "C" !~ '^[A-Za-z0-9_]{3,255}$'
     or p_event_type is null or p_event_type collate "C" !~ '^[a-z][a-z0-9_.]{2,99}$'
     or p_occurred_at is null
     or p_payload_digest is null or p_payload_digest collate "C" !~ '^sha256:[0-9a-f]{64}$'
     or not public.payment_observation_valid(p_observation)
     or (p_observation ->> 'kind') in ('checkout_open', 'refund_confirmed', 'refund_refused', 'capture_refused') then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  insert into public.external_event_receipts (
    provider_code, provider_event_reference, event_type, received_at, processed_at, processing_state,
    correlation_reference, payload_digest, minimal_payload
  ) values (
    p_provider_code, p_event_reference, p_event_type, clock_timestamp(), null, 'received',
    null, p_payload_digest,
    p_observation || jsonb_build_object('provider_created_at', p_occurred_at)
  )
  on conflict (provider_code, provider_event_reference) do nothing
  returning id into v_receipt;
  if v_receipt is null then
    return query
      select 'duplicate'::text, x.processing_state
      from public.external_event_receipts as x
      where x.provider_code = p_provider_code
        and x.provider_event_reference = p_event_reference;
    return;
  end if;
  v_kind := p_observation ->> 'kind';
  if v_kind = 'ignored' then
    v_state := 'ignored';
  else
    v_reference := p_observation ->> 'payment_reference';
    v_checkout := p_observation ->> 'checkout_reference';
    v_metadata := (p_observation ->> 'payment_transaction_id')::uuid;
    if v_reference is not null then
      select pt.id into v_payment from public.payment_transactions as pt
      where pt.provider_code = p_provider_code and pt.provider_payment_reference = v_reference;
    end if;
    if v_payment is null and v_checkout is not null then
      select pt.id into v_payment from public.payment_transactions as pt
      where pt.provider_code = p_provider_code and pt.provider_payment_reference = v_checkout;
    end if;
    if v_payment is null and v_metadata is not null then
      select pt.id into v_payment from public.payment_transactions as pt
      where pt.provider_code = p_provider_code and pt.id = v_metadata;
    end if;
    if v_payment is null then
      v_state := 'unmatched';
      perform public.payment_open_exception(
        'external_event_receipt', v_receipt, null, 'unknown_payment_reference', 'medium',
        jsonb_build_object('event_type', p_event_type, 'observation', p_observation)
      );
    else
      v_state := public.payment_apply_observation(
        v_payment, p_observation, 'external_event_receipt', v_receipt, 'provider'
      );
    end if;
  end if;
  update public.external_event_receipts as x
  set processing_state = v_state,
      processed_at = clock_timestamp(),
      correlation_reference = v_payment::text
  where x.id = v_receipt;
  return query select 'recorded'::text, v_state;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.payment_flow_parameters_valid(jsonb)',
    'public.payment_regulatory_mode(uuid, timestamptz)',
    'public.payment_flow_policy(uuid, uuid, timestamptz)',
    'public.payment_flow_for_path(uuid, text, timestamptz)',
    'public.policy_parameters_approvable(text, uuid, jsonb)',
    'public.payment_snapshot(public.payment_transactions)',
    'public.payment_policy_references(public.payment_transactions)',
    'public.payment_audit(uuid, text, text, public.payment_transactions, public.payment_transactions, text)',
    'public.payment_open_exception(text, uuid, uuid, text, text, jsonb)',
    'public.payment_enqueue(text, text, uuid)',
    'public.payment_current_fee_calculation(uuid)',
    'public.payment_latest_refund_request(uuid)',
    'public.payment_post_capture(public.payment_transactions, uuid, text)',
    'public.payment_post_refund(public.payment_transactions, uuid, bigint, bigint, bigint, bigint, text)',
    'public.payment_refundable_components(uuid)',
    'public.payment_advance_request(public.payment_transactions)',
    'public.payment_request_capture(uuid)',
    'public.payment_request_terminated()',
    'public.payment_job_escalated()',
    'public.payment_observation_valid(jsonb)',
    'public.payment_confirm_authorization(public.payment_transactions, text, bigint, text, text, uuid, text)',
    'public.payment_apply_observation(uuid, jsonb, text, uuid, text)',
    'public.payment_of_job(public.operational_jobs)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.client_authorize_payment(uuid)',
    'public.client_payment_checkout(uuid)',
    'public.client_request_payment(uuid)',
    'public.client_payment_receipt(uuid)',
    'public.attorney_payment_earnings()',
    'public.staff_finance_payments(text, integer)',
    'public.staff_finance_payment(uuid)',
    'public.staff_finance_ledger(uuid)',
    'public.staff_finance_receipts(uuid)',
    'public.staff_finance_exceptions(text, integer)',
    'public.staff_request_refund(uuid, bigint, bigint, bigint, bigint, text)',
    'public.staff_assign_reconciliation_exception(uuid, boolean)',
    'public.staff_resolve_reconciliation_exception(uuid, text)',
    'public.staff_request_reconciliation(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.payment_job_context(uuid)',
    'public.payment_record_operation(uuid, jsonb)',
    'public.payment_record_provider_event(text, text, text, timestamptz, text, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$privileges$;

-- request_create keeps its S6 grant (authenticated only).
revoke all on function public.request_create(uuid, text, text, integer, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_create(uuid, text, text, integer, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.payment_flow_parameters_valid(jsonb) is
  'MVP-001 S7 (internal): whether payment_flow parameters are exactly {"instant": {"authorization", "capture"}, "scheduled": {"authorization", "capture"}} with authorization before_attorney_decision | at_attorney_acceptance and capture at_authorization | at_attorney_acceptance | at_consultation_start | at_consultation_completion (G-2/G-3 stay configuration; no default).';
comment on function public.payment_regulatory_mode(uuid, timestamptz) is
  'MVP-001 S7 (internal): the jurisdiction''s single active Regulatory Mode (FP-1 section 5 structural and temporal validity only), or regulatory_mode_unavailable / regulatory_mode_conflict.';
comment on function public.payment_flow_policy(uuid, uuid, timestamptz) is
  'MVP-001 S7 (internal): the payment_flow version selected for a jurisdiction and Regulatory Mode with validated parameters, the resolver''s refusal, or policy_incomplete.';
comment on function public.payment_flow_for_path(uuid, text, timestamptz) is
  'MVP-001 S7 (internal): the authorization and capture timing of one request path in a jurisdiction now, with the flow version and Regulatory Mode, or the first refusal.';
comment on function public.policy_parameters_approvable(text, uuid, jsonb) is
  'MVP-001 S6 (PS-A3 section 3.4) with MVP-001 S7: a fee version matches its scope''s schema, a referral version''s message maximum is 1..20000, a payment_flow version matches the S7 flow schema; other types are not concerned.';
comment on function public.payment_open_exception(text, uuid, uuid, text, text, jsonb) is
  'MVP-001 S7 (internal): opens one Reconciliation Exception about a payment (or answers the open one of the same type and source), audited as a system action.';
comment on function public.payment_request_capture(uuid) is
  'MVP-001 S7 (internal, for S8 and later): requests the capture of an authorized payment after the S6 locks (capture_pending, one audit event, the enqueued capture job). Outcomes: capture_requested, not_authorized, not_found.';
comment on function public.payment_request_terminated() is
  'MVP-001 S7 (trigger): a Request that becomes cancelled, expired or declined releases its live payment attempt in the same transaction (release_pending, audited, release job enqueued).';
comment on function public.payment_job_escalated() is
  'MVP-001 S7 (trigger): an escalated payment job opens one provider_operation_exhausted Reconciliation Exception.';
comment on function public.payment_apply_observation(uuid, jsonb, text, uuid, text) is
  'MVP-001 S7 (internal): applies one provider observation to one payment through the S7 decision table after the S6 locks: applied, no_effect, stale (never overwriting newer state) or contradiction (Reconciliation Exception; never silently corrected).';
comment on function public.client_authorize_payment(uuid) is
  'MVP-001 S7: creates the payment attempt of one of the caller''s own pre-decision Requests whose flow requires authorization before the attorney decision, with complete FP-1 provenance, the production financial gate in a production-class database, one audit event and the enqueued hosted checkout. Outcomes: created, pending, invalid, not_found, expired, not_payable, not_required, policy_unavailable, production_gate_closed.';
comment on function public.client_payment_checkout(uuid) is
  'MVP-001 S7: the hosted checkout reference of one of the caller''s own pending attempts (ready, preparing or not_pending).';
comment on function public.client_request_payment(uuid) is
  'MVP-001 S7: the payment step of one of the caller''s own Requests (authorization_required, not_required_now, unavailable, not_applicable), whether an attempt can be started or continued, and its latest attempt''s state and amounts.';
comment on function public.client_payment_receipt(uuid) is
  'MVP-001 S7: the receipt of one of the caller''s own attempts: client-side quote amounts, state, amounts and ledger-recorded refunds.';
comment on function public.attorney_payment_earnings() is
  'MVP-001 S7: per payment of the attorney''s own Requests, the attorney_share ledger credits, debits and net (aal2, approved profile). Derived from the ledger only; no balance or payout.';
comment on function public.staff_finance_payments(text, integer) is
  'MVP-001 S7: one page of payments by group for finance staff (manage_financial_operations, global grant, aal2).';
comment on function public.staff_finance_payment(uuid) is
  'MVP-001 S7: one payment with its Fee Calculation components, provider reference and FP-1 provenance for finance staff.';
comment on function public.staff_finance_ledger(uuid) is
  'MVP-001 S7: the ledger entries of one payment for finance staff.';
comment on function public.staff_finance_receipts(uuid) is
  'MVP-001 S7: the provider event receipts correlated to one payment for finance staff (no payload).';
comment on function public.staff_finance_exceptions(text, integer) is
  'MVP-001 S7: one page of Reconciliation Exceptions by status for finance staff.';
comment on function public.staff_request_refund(uuid, bigint, bigint, bigint, bigint, text) is
  'MVP-001 S7: a staff refund within each component''s refundable amount, with a required reason and the refund policy version recorded; entitlement is not decided here. Outcomes: requested, invalid, denied, not_found, refund_in_progress, not_refundable, exceeds_refundable, policy_unavailable.';
comment on function public.staff_assign_reconciliation_exception(uuid, boolean) is
  'MVP-001 S7: assigns an open exception to the calling finance staff member, or clears its assignment; audited.';
comment on function public.staff_resolve_reconciliation_exception(uuid, text) is
  'MVP-001 S7: resolves an open exception once with notes; audited.';
comment on function public.staff_request_reconciliation(uuid) is
  'MVP-001 S7: enqueues provider reconciliation for one payment or for every live one (at most 200); audited.';
comment on function public.payment_job_context(uuid) is
  'MVP-001 S7 (service_role only): what a running payment job is to do now, from canonical state only (act, nothing_to_do, wait, not_running).';
comment on function public.payment_record_operation(uuid, jsonb) is
  'MVP-001 S7 (service_role only): records the result of one provider call of a running payment job as an observation of its payment.';
comment on function public.payment_record_provider_event(text, text, text, timestamptz, text, jsonb) is
  'MVP-001 S7 (service_role only): records one authenticated provider event (receipt first, unique per provider event; replays are no-ops) and applies its observation in the same transaction. Outcomes: recorded, duplicate, invalid.';
