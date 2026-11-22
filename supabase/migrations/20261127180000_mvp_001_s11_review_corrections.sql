-- MVP-001 S11 review corrections (18 of 18): the defects the S11 correction pass names, corrected forward (MVP-001
-- Packet section 2 rule 4; MBS sections 12, 16, 18.4, 18.6 and 19; TA sections 40, 41, 61 and 62; PS sections 25 and
-- 30; PM section 1 INV-11 and rows 11 to 21). Every committed migration stays unchanged; each function below is
-- replaced with its signature, volatility, security mode, search_path, lock bound, owner and privileges, and keeps every
-- earlier branch and outcome except where a correction names the change.
--
-- No relation, column, policy type, policy, grant on a relation or seed is added (Packet rules 8, 10 and 16); one
-- internal function is added (audit_snapshot_redacted).
--
-- R1 (a Consultation that has ended can still be paid). A cancellation or a staff outcome leaves the Request accepted,
-- so the client's payment step and authorization still answered payable and created, a confirmed authorization then
-- requested the capture and the captured payment recorded the Engagement as effective; an attempt that was
-- pending_authorization at the cancellation was captured once its authorization was confirmed.
-- - client_request_payment: an accepted Request whose Consultation is terminal (completed, cancelled, no_show,
--   technical_failure) answers the existing not_applicable step (not payable).
-- - client_authorize_payment: such a Request answers the existing not_payable outcome (problem consultation_ended)
--   and creates nothing; the attorney's scheduling lock it already takes first serializes it with every command that
--   ends a Consultation.
-- - payment_confirm_authorization (internal): an authorization confirmed after the Consultation was cancelled or ended
--   unperformed (no_show, technical_failure) is recorded (a provider fact) but requests no capture; the Consultation's
--   open review item is reused or one high item opened (cancellation_payment_review for a cancellation,
--   outcome_payment_review otherwise; source the Consultation, as the cancellation and the staff outcome open them).
--   Release or capture stays a human decision (PM INV-11). A completed Consultation keeps the earlier rule (the
--   service was performed; PM rows 20 and 21).
-- - decision_payment_captured (trigger): a capture confirmed after the Consultation was cancelled or ended unperformed
--   records no Engagement and reuses or opens the same review item (after a failure to connect, PM row 17, the
--   critical funds_retained_after_technical_failure item the staff outcome opens for retained funds).
--
-- R2 (fail-closed; a cancellation after the booked slot turned a no-show into a cancellation). consultation_cancel
-- refuses at or after the Consultation's nominal end (consultation_nominal_end: the booked slot's end; an instant
-- Consultation's creation plus its duration) with the new outcome time_passed and changes nothing; the outcome stays
-- with staff (the staff outcome window opens only after the nominal end and the overrun). Whether a cancellation
-- after the scheduled start (before the end) should also be refused is an owner question.
--
-- R3 (fail-closed; dual-role accounts). Client administration (client_account_rows, so staff_clients and staff_client,
-- and staff_change_client_account) excludes a User holding an Attorney Profile exactly as it excludes staff: it is
-- answered as unknown (not_found). How a dual-role account is administered is an owner question.
--
-- R4 (free text in the audit workspace). staff_audit_event returns each snapshot through audit_snapshot_redacted
-- (above): free-text values are replaced by {"redacted": true}; codes and identifiers are kept; the stored rows are
-- unchanged. The list read staff_audit_events returns no snapshot (unchanged).
--
-- R5 (the capture at completion checked only the payment_flow version). consultation_apply_completion (early
-- completion by agreement, manual resolution) and consultation_end (normal completion) keep their refusal in a
-- production-class database (configuration_unavailable with the gate problem; nothing changes) and widen its
-- condition: besides the payment_flow version (the earlier check, kept), the four-way gate must be open for every
-- version the payment recorded (payment_capture_gate_problem, as D3). A strict tightening: every completion refused
-- before is refused alike; nothing else changes. (D3's complete-without-capture handling stays only where an
-- asynchronous provider confirmation cannot be refused.)
--
-- R6 (a repeated assignment re-audited). staff_update_complaint 'assign' on a case already assigned to the caller in
-- review or escalated answers applied and changes and audits nothing.

-- ---------------------------------------------------------------------------
-- R1: no payment, capture or Engagement for an ended Consultation.
-- ---------------------------------------------------------------------------

create or replace function public.client_request_payment(p_request_id uuid)
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
  if v_pre_decision then
    select f.* into v_flow from public.payment_flow_for_path(v_jurisdiction, v_request.request_path, clock_timestamp()) as f;
    v_step := case
      when v_flow.outcome is distinct from 'selected' then 'unavailable'
      when v_flow.authorization_timing = 'before_attorney_decision' then 'authorization_required'
      else 'not_required_now'
    end;
  elsif v_request.state = 'accepted'
        and exists (
          select 1 from public.consultations as c
          where c.consultation_request_id = v_request.id
            and c.state in ('completed', 'cancelled', 'no_show', 'technical_failure')
        ) then
    -- MVP-001 S11 review correction R1: the Request's Consultation has ended; nothing is payable any more.
    v_step := 'not_applicable';
  elsif v_request.state = 'accepted' then
    select f.* into v_flow from public.payment_flow_for_path(v_jurisdiction, v_request.request_path, clock_timestamp()) as f;
    v_step := case
      when v_flow.outcome is distinct from 'selected' then 'unavailable'
      when v_flow.authorization_timing = 'at_attorney_acceptance' then 'authorization_after_acceptance'
      else 'not_applicable'
    end;
  else
    v_step := 'not_applicable';
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
    v_step in ('authorization_required', 'authorization_after_acceptance')
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


create or replace function public.client_authorize_payment(p_request_id uuid)
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
  v_consultation public.consultations;
  v_accepted boolean;
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
  v_accepted := v_request.state = 'accepted';
  if not (
    (v_request.request_path = 'instant' and v_request.state = 'created')
    or (v_request.request_path = 'scheduled' and v_request.state = 'slot_held')
    or v_accepted
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
  if v_accepted then
    if v_flow.authorization_timing is distinct from 'at_attorney_acceptance' then
      return query select 'not_payable'::text, null::uuid, null::text;
      return;
    end if;
    select c.* into v_consultation from public.consultations as c where c.consultation_request_id = p_request_id;
    -- MVP-001 S11 review correction R1: a Request whose Consultation has ended is not payable (the attorney's
    -- scheduling lock, held above, serializes this with every command that ends a Consultation).
    if v_consultation.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
      return query select 'not_payable'::text, null::uuid, 'consultation_ended'::text;
      return;
    end if;
  elsif v_flow.authorization_timing is distinct from 'before_attorney_decision' then
    return query select 'not_required'::text, null::uuid, null::text;
    return;
  end if;
  foreach v_type in array array['payment', 'engagement', 'cancellation', 'refund'] loop
    if v_type = 'engagement'
       and coalesce(v_request.engagement_policy_version_id, v_consultation.engagement_policy_version_id) is not null then
      v_policies := v_policies || jsonb_build_object(
        'engagement', coalesce(v_request.engagement_policy_version_id, v_consultation.engagement_policy_version_id)
      );
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
    if v_consultation.id is not null then
      update public.payment_transactions as pt
      set consultation_id = v_consultation.id
      where pt.id = v_payment.id
      returning * into v_payment;
    end if;
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


create or replace function public.payment_confirm_authorization(
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
  v_problem text;
  v_consultation public.consultations;
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
  -- MVP-001 S11 review correction R1: an authorization confirmed after the Consultation was cancelled or ended
  -- without being performed (no_show, technical_failure) requests no capture: the payment stays authorized and the
  -- Consultation's open financial review item (cancellation_payment_review or outcome_payment_review) is reused or
  -- opened; release or capture stays a human decision (PM INV-11). Read without a lock: the payment is the last
  -- object of the canonical lock order and is already locked by the caller.
  select c.* into v_consultation
  from public.consultations as c
  where c.consultation_request_id = v_after.consultation_request_id;
  if v_consultation.state in ('cancelled', 'no_show', 'technical_failure') then
    perform public.payment_open_exception(
      'consultation', v_consultation.id, v_after.id,
      case v_consultation.state when 'cancelled' then 'cancellation_payment_review' else 'outcome_payment_review' end,
      'high',
      jsonb_build_object(
        'event', 'authorization_confirmed_after_end',
        'consultation_state', v_consultation.state,
        'outcome_code', v_consultation.outcome_code,
        'payment_state', v_after.state
      )
    );
    return 'applied';
  end if;
  select r.* into v_request from public.consultation_requests as r where r.id = v_after.consultation_request_id;
  select v.parameters into v_parameters from public.policy_versions as v where v.id = v_after.payment_flow_policy_version_id;
  if public.payment_flow_parameters_valid(v_parameters)
     and (
       (v_parameters -> v_request.request_path ->> 'capture') = 'at_authorization'
       or (v_request.state = 'accepted' and (v_parameters -> v_request.request_path ->> 'capture') = 'at_attorney_acceptance')
     ) then
    -- MVP-001 S11 (D3): in a production-class database the four-way gate is re-run for the payment's recorded
    -- versions before the capture is requested; a closed gate requests nothing and opens a critical review item.
    v_problem := public.payment_capture_gate_problem(v_after);
    if v_problem is null then
      perform public.payment_request_capture(v_after.id);
    else
      perform public.payment_open_exception(
        'payment_transaction', v_after.id, v_after.id, 'capture_gate_closed', 'critical',
        jsonb_build_object(
          'problem', v_problem,
          'capture', v_parameters -> v_request.request_path ->> 'capture',
          'request_state', v_request.state,
          'payment_state', v_after.state
        )
      );
    end if;
  end if;
  return 'applied';
end;
$function$;


create or replace function public.decision_payment_captured()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_request public.consultation_requests;
  v_consultation public.consultations;
  v_version uuid;
  v_parameters jsonb;
  v_jurisdiction uuid;
begin
  select r.* into v_request from public.consultation_requests as r where r.id = new.consultation_request_id;
  if v_request.state is distinct from 'accepted' then
    return null;
  end if;
  v_version := coalesce(v_request.engagement_policy_version_id, new.engagement_policy_version_id);
  v_parameters := public.decision_engagement_parameters(v_version);
  if v_parameters is null then
    return null;
  end if;
  select c.* into v_consultation from public.consultations as c where c.consultation_request_id = v_request.id;
  if v_consultation.id is null then
    if v_request.request_path = 'instant'
       and (
         (v_parameters ->> 'consultation_creation') = 'attorney_acceptance_and_payment_captured'
         or (
           (v_parameters ->> 'consultation_creation') = 'attorney_acceptance_and_engagement_effective'
           and (v_parameters ->> 'engagement_effective') = 'at_payment_capture'
         )
       ) then
      perform public.decision_create_consultation(
        v_request.id, v_version, v_parameters, null, 'system', 'payment_captured'
      );
    end if;
    return null;
  end if;
  -- MVP-001 S11 review correction R1: a capture confirmed after the Consultation was cancelled or ended without being
  -- performed records no Engagement; the Consultation's open financial review item is reused or opened instead (for
  -- a failure to connect, PM row 17, the critical funds_retained_after_technical_failure item the staff outcome opens
  -- for retained funds).
  if v_consultation.state in ('cancelled', 'no_show', 'technical_failure') then
    perform public.payment_open_exception(
      'consultation', v_consultation.id, new.id,
      case
        when v_consultation.state = 'cancelled' then 'cancellation_payment_review'
        when v_consultation.outcome_code = 'neither_connected' then 'funds_retained_after_technical_failure'
        else 'outcome_payment_review'
      end,
      case when v_consultation.outcome_code = 'neither_connected' then 'critical' else 'high' end,
      jsonb_build_object(
        'event', 'capture_confirmed_after_end',
        'consultation_state', v_consultation.state,
        'outcome_code', v_consultation.outcome_code,
        'payment_state', new.state
      )
    );
    return null;
  end if;
  if (v_parameters ->> 'engagement_effective') = 'at_payment_capture' then
    select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
    perform public.decision_record_engagement_if_due(
      v_consultation, v_parameters, v_request, new.captured_at, v_jurisdiction
    );
  end if;
  return null;
end;
$function$;


-- ---------------------------------------------------------------------------
-- R2: no cancellation at or after the nominal end.
-- ---------------------------------------------------------------------------

create or replace function public.consultation_cancel(p_consultation_id uuid)
returns table (outcome text, problem text, cancelled_at timestamptz)
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
  v_locked uuid;
  v_context record;
  v_profile public.attorney_profiles;
  v_role text;
  v_consultation public.consultations;
  v_before_state text;
  v_booking public.bookings;
  v_room public.media_rooms;
  v_payment public.payment_transactions;
  v_now timestamptz;
  v_code text;
  v_seconds bigint;
  v_exception uuid;
begin
  if p_consultation_id is null then
    return query select 'invalid'::text, null::text, null::timestamptz;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select 'configuration_unavailable'::text, v_environment, null::timestamptz;
    return;
  end if;
  select u.id into v_user
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  if v_user is null or v_context.consultation_id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;
  -- The caller's own rows first: another User, an attorney at aal1 and an unknown id answer alike.
  if v_user = v_context.client_user_id then
    select l.user_id into v_locked from public.lock_current_client() as l;
    if v_locked is distinct from v_user then
      return query select 'not_found'::text, null::text, null::timestamptz;
      return;
    end if;
    v_role := 'client';
  elsif v_user = v_context.attorney_user_id then
    v_profile := public.lock_current_attorney_profile(false);
    if v_profile.id is distinct from v_context.attorney_id then
      return query select 'not_found'::text, null::text, null::timestamptz;
      return;
    end if;
    if v_profile.profile_state is distinct from 'approved' then
      return query select 'denied'::text, null::text, null::timestamptz;
      return;
    end if;
    v_role := 'attorney';
  else
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;
  perform public.scheduling_lock_attorney(v_context.attorney_id);
  perform public.request_expire_if_due(v_context.consultation_request_id, false);
  select c.* into v_consultation from public.consultations as c where c.id = p_consultation_id for update;
  select b.* into v_booking
  from public.bookings as b
  where b.consultation_id = p_consultation_id
    and b.status = 'confirmed'
  for update;
  select m.* into v_room from public.media_rooms as m where m.consultation_id = p_consultation_id for update;
  v_payment := public.consultation_lock_live_payment(v_context.consultation_request_id);
  if v_consultation.state = 'cancelled' then
    return query select 'already_cancelled'::text, v_consultation.outcome_code, null::timestamptz;
    return;
  end if;
  if v_consultation.state in ('completed', 'no_show', 'technical_failure') then
    return query select 'ended'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  if v_consultation.state = 'live' then
    return query select 'in_progress'::text, null::text, null::timestamptz;
    return;
  end if;
  -- MVP-001 S11 review correction R2 (fail-closed): at or after the Consultation's nominal end (the booked slot's end;
  -- an instant Consultation's creation plus its duration) a cancellation would turn an unattended Consultation (PM rows
  -- 14 to 16) into a cancellation (rows 11 to 13): it is refused and the outcome stays with staff.
  if clock_timestamp() >= public.consultation_nominal_end(p_consultation_id) then
    return query select 'time_passed'::text, null::text, null::timestamptz;
    return;
  end if;
  v_before_state := v_consultation.state;
  v_now := clock_timestamp();
  v_code := case v_role when 'client' then 'client_cancelled' else 'attorney_cancelled' end;
  update public.consultations as c
  set state = 'cancelled',
      ended_at = v_now,
      outcome_code = v_code
  where c.id = p_consultation_id
  returning c.* into v_consultation;
  if v_booking.id is not null then
    -- The slot is free again: S4 counts only confirmed Bookings.
    update public.bookings as b
    set status = 'cancelled',
        cancelled_at = v_now
    where b.id = v_booking.id;
    v_seconds := floor(extract(epoch from (v_booking.starts_at - v_now)))::bigint;
  end if;
  if v_payment.id is not null then
    -- PM rows 11 to 13 are policy-gated: nothing is released, refunded or captured here. One review item for a human.
    v_exception := public.payment_open_exception(
      'consultation', p_consultation_id, v_payment.id, 'cancellation_payment_review', 'high',
      jsonb_build_object(
        'payment_matrix_rows', case v_role when 'client' then jsonb_build_array(11, 12) else jsonb_build_array(13) end,
        'cancelled_by', v_role,
        'outcome_code', v_code,
        'consultation_state_before', v_before_state,
        'request_path', v_consultation.request_path,
        'seconds_before_scheduled_start', v_seconds,
        'payment_state', v_payment.state,
        'cancellation_policy_version_id', v_payment.cancellation_policy_version_id,
        'refund_policy_version_id', v_payment.refund_policy_version_id
      )
    );
  end if;
  perform public.decision_audit(
    v_user, v_role, 'consultation.cancelled', 'consultation', p_consultation_id,
    jsonb_build_object('state', v_before_state),
    jsonb_build_object(
      'state', 'cancelled',
      'outcome_code', v_code,
      'ended_at', v_consultation.ended_at,
      'booking_id', v_booking.id,
      'seconds_before_scheduled_start', v_seconds,
      'media_room_id', v_room.id,
      'payment_transaction_id', v_payment.id,
      'payment_state', v_payment.state,
      'reconciliation_exception_id', v_exception
    ),
    v_code,
    public.consultation_unwind_policy_references(v_payment),
    v_context.jurisdiction_id
  );
  return query select 'cancelled'::text, null::text, v_consultation.ended_at;
end;
$function$;


-- ---------------------------------------------------------------------------
-- R3: client administration excludes attorney accounts.
-- ---------------------------------------------------------------------------

create or replace function public.client_account_rows(p_user_id uuid, p_account_state text, p_offset integer, p_limit integer)
returns table (
  user_id uuid,
  display_name text,
  account_state text,
  created_at timestamptz,
  intakes bigint,
  requests bigint,
  consultations bigint,
  open_requests bigint,
  open_consultations bigint,
  open_complaints bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    u.id,
    u.display_name,
    u.account_state,
    u.created_at,
    (select count(*) from public.intakes as i where i.client_id = c.id),
    (select count(*) from public.consultation_requests as r where r.client_id = c.id),
    (select count(*) from public.consultations as k where k.client_id = c.id),
    (select count(*) from public.consultation_requests as r
     where r.client_id = c.id and r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')),
    (select count(*) from public.consultations as k
     where k.client_id = c.id and k.state in ('created', 'scheduled', 'ready', 'live')),
    (select count(*) from public.complaint_cases as x where x.complainant_user_id = u.id and x.state <> 'resolved')
  from public.users as u
  join public.client_profiles as c on c.user_id = u.id
  where not exists (select 1 from public.staff_profiles as s where s.user_id = u.id)
    -- MVP-001 S11 review correction R3: a User holding an Attorney Profile is administered through the attorney
    -- lifecycle commands, never through client administration.
    and not exists (select 1 from public.attorney_profiles as a where a.user_id = u.id)
    and (p_user_id is null or u.id = p_user_id)
    and (p_account_state is null or u.account_state = p_account_state)
  order by u.created_at desc, u.id
  offset p_offset
  limit p_limit;
$function$;


create or replace function public.staff_change_client_account(p_client_account_id uuid, p_intent text, p_note text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.users;
  v_client uuid;
  v_to text;
  v_requests uuid[];
  v_consultations uuid[];
begin
  if p_client_account_id is null
     or p_intent is null
     or p_intent not in ('suspend', 'reactivate')
     or p_note is null
     or not public.professional_text_within(p_note, 500) then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_client_accounts', null);
  if v_staff is null then
    return 'denied';
  end if;
  if p_client_account_id = v_staff then
    return 'denied';
  end if;
  select u.* into v_before
  from public.users as u
  where u.id = p_client_account_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  select c.id into v_client from public.client_profiles as c where c.user_id = v_before.id;
  if v_client is null
     or exists (select 1 from public.staff_profiles as s where s.user_id = v_before.id)
     -- MVP-001 S11 review correction R3: a User holding an Attorney Profile answers as unknown.
     or exists (select 1 from public.attorney_profiles as a where a.user_id = v_before.id) then
    return 'not_found';
  end if;
  if not (
    (p_intent = 'suspend' and v_before.account_state = 'active')
    or (p_intent = 'reactivate' and v_before.account_state = 'suspended')
  ) then
    return 'locked';
  end if;
  v_to := case p_intent when 'suspend' then 'suspended' else 'active' end;
  update public.users as u
  set account_state = v_to
  where u.id = v_before.id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'user.account_state_changed', 'user', v_before.id,
    jsonb_build_object('account_state', v_before.account_state),
    jsonb_build_object('account_state', v_to, 'staff_note', p_note),
    'staff_client_' || p_intent, null, null, clock_timestamp()
  );
  if p_intent = 'suspend' then
    -- Counted after the User is locked: every client command that could add a matter has committed or waits.
    select coalesce(array_agg(x.id order by x.created_at, x.id), array[]::uuid[]) into v_requests
    from (
      select r.id, r.created_at from public.consultation_requests as r
      where r.client_id = v_client
        and r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
      order by r.created_at, r.id
      limit 100
    ) as x;
    select coalesce(array_agg(x.id order by x.created_at, x.id), array[]::uuid[]) into v_consultations
    from (
      select k.id, k.created_at from public.consultations as k
      where k.client_id = v_client
        and k.state in ('created', 'scheduled', 'ready', 'live')
      order by k.created_at, k.id
      limit 100
    ) as x;
    if cardinality(v_requests) > 0 or cardinality(v_consultations) > 0 then
      perform public.decision_open_review(
        'client_account_review', 'user', v_before.id, 'high', null,
        jsonb_build_object(
          'user_id', v_before.id,
          'client_profile_id', v_client,
          'payment_matrix_row', 46,
          'open_request_ids', to_jsonb(v_requests),
          'open_consultation_ids', to_jsonb(v_consultations)
        )
      );
    end if;
  end if;
  return 'applied';
end;
$function$;


-- ---------------------------------------------------------------------------
-- R4: the audit workspace redacts free text.
-- ---------------------------------------------------------------------------

-- The audit workspace's view of one recorded snapshot (internal): every free-text value an earlier migration writes
-- into audit snapshots is replaced by {"redacted": true}; every other key, code, identifier, number and structure is
-- returned as stored. Free-text keys (each found by searching every migration that writes audit snapshots):
--   staff_note            staff notes of the attorney stage, attorney lifecycle and client account commands;
--   message_to_applicant  the staff request for more information sent to an applicant;
--   note                  the verification-source-unavailable record and the practice-area decision;
--   display_name, headline, bio                           an attorney's profile presentation details;
--   license_number, license_type, carrier_name, policy_reference, coverage_type    an attorney's licence and
--                                                          insurance claims;
--   finding_type, external_reference                      a discipline finding recorded by staff;
--   reason                free text in payment.release_requested (staff_request_release), payment.refund_requested
--                         (staff_request_refund) and launch_authorization.revoked; elsewhere 'reason' carries codes
--                         (eligibility factors, gate reasons), which are kept, and any value that is not a lower-snake
--                         code is redacted all the same.
-- The stored audit rows are never changed.
create function public.audit_snapshot_redacted(p_action_code text, p_snapshot jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_result jsonb;
  v_key text;
  v_value jsonb;
begin
  if p_snapshot is null then
    return null;
  end if;
  if jsonb_typeof(p_snapshot) = 'array' then
    select coalesce(jsonb_agg(public.audit_snapshot_redacted(p_action_code, e.value) order by e.n), '[]'::jsonb)
    into v_result
    from jsonb_array_elements(p_snapshot) with ordinality as e(value, n);
    return v_result;
  end if;
  if jsonb_typeof(p_snapshot) <> 'object' then
    return p_snapshot;
  end if;
  v_result := '{}'::jsonb;
  for v_key, v_value in select k.key, k.value from jsonb_each(p_snapshot) as k loop
    if jsonb_typeof(v_value) = 'string'
       and (
         v_key in (
           'staff_note', 'message_to_applicant', 'note', 'display_name', 'headline', 'bio', 'license_number',
           'license_type', 'carrier_name', 'policy_reference', 'coverage_type', 'finding_type', 'external_reference'
         )
         or (
           v_key = 'reason'
           and (
             p_action_code in ('payment.release_requested', 'payment.refund_requested', 'launch_authorization.revoked')
             or not ((v_value #>> '{}') collate "C" ~ '^[a-z][a-z0-9_]{0,63}$')
           )
         )
       ) then
      v_result := v_result || jsonb_build_object(v_key, jsonb_build_object('redacted', true));
    else
      v_result := v_result || jsonb_build_object(v_key, public.audit_snapshot_redacted(p_action_code, v_value));
    end if;
  end loop;
  return v_result;
end;
$function$;

create or replace function public.staff_audit_event(p_audit_event_id uuid)
returns table (
  audit_event_id uuid,
  occurred_at timestamptz,
  created_at timestamptz,
  actor_type text,
  actor_user_id uuid,
  action_code text,
  resource_type text,
  resource_id uuid,
  jurisdiction_id uuid,
  reason_code text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  policy_references jsonb
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_scope record;
  v_rows integer;
begin
  if p_audit_event_id is null then
    return;
  end if;
  select s.* into v_scope from public.audit_view_scope() as s;
  if v_scope.user_id is null then
    return;
  end if;
  return query
    select e.id, e.occurred_at, e.created_at, e.actor_type, e.actor_user_id, e.action_code, e.resource_type,
      e.resource_id, e.jurisdiction_id, e.reason_code,
      public.audit_snapshot_redacted(e.action_code, e.before_snapshot),
      public.audit_snapshot_redacted(e.action_code, e.after_snapshot),
      e.policy_references
    from public.audit_events as e
    where e.id = p_audit_event_id
      and (v_scope.global_grant or e.jurisdiction_id = any (v_scope.jurisdictions));
  get diagnostics v_rows = row_count;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_scope.user_id, 'staff', 'audit_event.viewed', 'audit_event', p_audit_event_id,
    null,
    jsonb_build_object(
      'rows', v_rows,
      'scope', case when v_scope.global_grant then 'global' else 'jurisdiction' end
    ),
    null, null, null, clock_timestamp()
  );
end;
$function$;


-- ---------------------------------------------------------------------------
-- R5: the completion that requests the capture needs the four-way gate for every recorded version.
-- ---------------------------------------------------------------------------

create or replace function public.consultation_apply_completion(
  p_consultation public.consultations,
  p_payment public.payment_transactions,
  p_outcome_code text,
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_reason text,
  p_jurisdiction uuid,
  p_details jsonb
)
returns table (outcome text, problem text, ended_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_consultation public.consultations;
  v_payment public.payment_transactions;
  v_room uuid;
  v_flow jsonb;
  v_capture text;
  v_problem text;
  v_capture_answer text;
  v_exception uuid;
  v_booking uuid;
begin
  v_payment := p_payment;
  if v_payment.id is not null then
    select v.parameters into v_flow from public.policy_versions as v where v.id = v_payment.payment_flow_policy_version_id;
    if not public.payment_flow_parameters_valid(v_flow) then
      return query select 'configuration_unavailable'::text, 'payment_flow_policy_incomplete'::text, null::timestamptz;
      return;
    end if;
    v_capture := v_flow -> p_consultation.request_path ->> 'capture';
  end if;
  -- MVP-001 S11 review correction R5: in a production-class database a completion that will request the capture is
  -- refused unless the four-way gate is open for every version the payment recorded (payment_capture_gate_problem, as
  -- D3), not only for the payment_flow version: the earlier check is kept and widened, and its refusal is unchanged.
  if v_capture = 'at_consultation_completion' then
    v_problem := coalesce(
      public.media_production_problem(
        p_jurisdiction,
        jsonb_build_array(jsonb_build_object(
          'policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id,
          'regulatory_mode_id', v_payment.regulatory_mode_id
        )),
        clock_timestamp()
      ),
      public.payment_capture_gate_problem(v_payment)
    );
    if v_problem is not null then
      return query select 'configuration_unavailable'::text, v_problem, null::timestamptz;
      return;
    end if;
  end if;
  select m.id into v_room from public.media_rooms as m where m.consultation_id = p_consultation.id;
  begin
    update public.consultations as c
    set state = 'completed',
        ended_at = clock_timestamp(),
        outcome_code = p_outcome_code
    where c.id = p_consultation.id
    returning c.* into v_consultation;
    v_booking := public.consultation_complete_booking(p_consultation.id);
    if v_capture = 'at_consultation_completion' then
      if v_payment.state = 'authorized' then
        v_capture_answer := public.payment_request_capture(v_payment.id);
        if v_capture_answer is distinct from 'capture_requested' then
          raise exception 'the capture could not be requested' using errcode = 'RS901';
        end if;
      else
        -- The configured capture cannot be requested from this state: surfaced for human resolution, never absorbed.
        v_exception := public.payment_open_exception(
          'consultation', p_consultation.id, v_payment.id, 'capture_unavailable_at_completion', 'high',
          jsonb_build_object(
            'payment_state', v_payment.state, 'capture_timing', v_capture, 'consultation_state', 'completed',
            'outcome_code', p_outcome_code
          )
        );
      end if;
    end if;
    select pt.* into v_payment from public.payment_transactions as pt where pt.id = v_payment.id;
    perform public.decision_audit(
      p_actor, p_actor_type, p_action, 'consultation', p_consultation.id,
      jsonb_build_object('state', 'live'),
      jsonb_build_object(
        'state', 'completed',
        'ended_at', v_consultation.ended_at,
        'outcome_code', p_outcome_code,
        'payment_transaction_id', v_payment.id,
        'payment_state', v_payment.state,
        'capture_timing', v_capture,
        'capture_requested', v_capture_answer is not null,
        'reconciliation_exception_id', v_exception,
        'media_room_id', v_room,
        'booking_id', v_booking
      ) || coalesce(p_details, '{}'::jsonb),
      p_reason,
      case when v_payment.id is null then null else jsonb_build_array(
        jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id)
      ) end,
      p_jurisdiction
    );
  exception
    when sqlstate 'RS901' then
      return query select 'conflict'::text, null::text, null::timestamptz;
      return;
  end;
  return query select 'completed'::text, null::text, v_consultation.ended_at;
end;
$function$;


create or replace function public.consultation_end(p_consultation_id uuid)
returns table (outcome text, problem text, ended_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_environment text;
  v_profile public.attorney_profiles;
  v_request_id uuid;
  v_request public.consultation_requests;
  v_consultation public.consultations;
  v_room public.media_rooms;
  v_payment public.payment_transactions;
  v_jurisdiction uuid;
  v_now timestamptz;
  v_flow jsonb;
  v_capture text;
  v_problem text;
  v_capture_answer text;
  v_exception uuid;
begin
  if p_consultation_id is null then
    return query select 'invalid'::text, null::text, null::timestamptz;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select 'configuration_unavailable'::text, v_environment, null::timestamptz;
    return;
  end if;
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null or v_profile.profile_state is distinct from 'approved' then
    return query select 'denied'::text, null::text, null::timestamptz;
    return;
  end if;
  select c.consultation_request_id into v_request_id
  from public.consultations as c
  where c.id = p_consultation_id
    and c.attorney_id = v_profile.id;
  if not found then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;
  perform public.scheduling_lock_attorney(v_profile.id);
  perform public.request_expire_if_due(v_request_id, false);
  perform public.consultation_ready_if_due(p_consultation_id, false);
  select c.* into v_consultation from public.consultations as c where c.id = p_consultation_id;
  select m.* into v_room from public.media_rooms as m where m.consultation_id = p_consultation_id for update;
  select pt.* into v_payment
  from public.payment_transactions as pt
  where pt.consultation_request_id = v_request_id
    and pt.state not in ('failed', 'cancelled', 'authorization_released')
  order by pt.created_at desc, pt.id desc
  limit 1
  for update;
  select r.* into v_request from public.consultation_requests as r where r.id = v_request_id;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  if v_consultation.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return query select 'ended'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  if v_consultation.state is distinct from 'live' then
    return query select 'not_started'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  v_now := clock_timestamp();
  if v_payment.id is not null then
    select v.parameters into v_flow from public.policy_versions as v where v.id = v_payment.payment_flow_policy_version_id;
    if not public.payment_flow_parameters_valid(v_flow) then
      return query select 'configuration_unavailable'::text, 'payment_flow_policy_incomplete'::text, null::timestamptz;
      return;
    end if;
    v_capture := v_flow -> v_consultation.request_path ->> 'capture';
  end if;
  -- Ending is protective (it closes media access): it needs no timing configuration and, in a production-class
  -- database, the four-way gate only when the governing flow captures at completion (the end then requests a capture
  -- or surfaces why it cannot). MVP-001 S11 review correction R5: the gate covers every version the payment recorded
  -- (payment_capture_gate_problem, as D3), not only the payment_flow version: the earlier check is kept and widened,
  -- and its refusal is unchanged.
  if v_capture = 'at_consultation_completion' then
    v_problem := coalesce(
      public.media_production_problem(
        v_jurisdiction,
        jsonb_build_array(jsonb_build_object(
          'policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id,
          'regulatory_mode_id', v_payment.regulatory_mode_id
        )),
        v_now
      ),
      public.payment_capture_gate_problem(v_payment)
    );
    if v_problem is not null then
      return query select 'configuration_unavailable'::text, v_problem, null::timestamptz;
      return;
    end if;
  end if;
  begin
    update public.consultations as c
    set state = 'completed',
        ended_at = clock_timestamp(),
        outcome_code = 'normal'
    where c.id = p_consultation_id
    returning c.* into v_consultation;
    -- S11: the confirmed Booking is completed with the Consultation (DM section 2.7).
    perform public.consultation_complete_booking(p_consultation_id);
    if v_capture = 'at_consultation_completion' then
      if v_payment.state = 'authorized' then
        v_capture_answer := public.payment_request_capture(v_payment.id);
        if v_capture_answer is distinct from 'capture_requested' then
          raise exception 'the capture could not be requested' using errcode = 'RS901';
        end if;
      else
        -- The configured capture cannot be requested from this state: surfaced for human resolution, never absorbed.
        v_exception := public.payment_open_exception(
          'consultation', p_consultation_id, v_payment.id, 'capture_unavailable_at_completion', 'high',
          jsonb_build_object('payment_state', v_payment.state, 'capture_timing', v_capture, 'consultation_state', 'completed')
        );
      end if;
    end if;
    select pt.* into v_payment from public.payment_transactions as pt where pt.id = v_payment.id;
    perform public.decision_audit(
      v_profile.user_id, 'attorney', 'consultation.completed', 'consultation', p_consultation_id,
      jsonb_build_object('state', 'live'),
      jsonb_build_object(
        'state', 'completed',
        'ended_at', v_consultation.ended_at,
        'outcome_code', 'normal',
        'payment_transaction_id', v_payment.id,
        'payment_state', v_payment.state,
        'capture_timing', v_capture,
        'capture_requested', v_capture_answer is not null,
        'reconciliation_exception_id', v_exception,
        'media_room_id', v_room.id
      ),
      'attorney_completed',
      case when v_payment.id is null then null else jsonb_build_array(
        jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id)
      ) end,
      v_jurisdiction
    );
  exception
    when sqlstate 'RS901' then
      return query select 'conflict'::text, null::text, null::timestamptz;
      return;
  end;
  return query select 'completed'::text, null::text, v_consultation.ended_at;
end;
$function$;


-- ---------------------------------------------------------------------------
-- R6: assigning a case already assigned to the caller is a no-op.
-- ---------------------------------------------------------------------------

create or replace function public.staff_update_complaint(p_complaint_case_id uuid, p_action text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_before public.complaint_cases;
  v_state text;
  v_assignee uuid;
begin
  if p_complaint_case_id is null
     or p_action is null
     or p_action not in ('assign', 'unassign', 'escalate', 'return_to_review') then
    return 'invalid';
  end if;
  select l.* into v_lock from public.complaint_lock_staff(p_complaint_case_id) as l;
  if v_lock.staff_user_id is null then
    return 'denied';
  end if;
  if not v_lock.case_known then
    return 'not_found';
  end if;
  select k.* into v_before from public.complaint_cases as k where k.id = p_complaint_case_id for update;
  v_state := v_before.state;
  v_assignee := v_before.assigned_to_user_id;
  -- MVP-001 S11 review correction R6: assigning a case already assigned to the caller changes and audits nothing.
  if p_action = 'assign'
     and v_before.state in ('in_review', 'escalated')
     and v_before.assigned_to_user_id = v_lock.staff_user_id then
    return 'applied';
  end if;
  if p_action = 'assign' and v_before.state in ('opened', 'in_review', 'escalated') then
    v_state := case v_before.state when 'opened' then 'in_review' else v_before.state end;
    v_assignee := v_lock.staff_user_id;
  elsif p_action = 'unassign' and v_before.state = 'in_review' then
    v_state := 'opened';
    v_assignee := null;
  elsif p_action = 'escalate' and v_before.state = 'in_review' then
    v_state := 'escalated';
  elsif p_action = 'return_to_review' and v_before.state = 'escalated' then
    v_state := 'in_review';
  else
    return 'invalid_transition';
  end if;
  update public.complaint_cases as k
  set state = v_state,
      assigned_to_user_id = v_assignee
  where k.id = p_complaint_case_id;
  perform public.decision_audit(
    v_lock.staff_user_id, 'staff',
    case p_action
      when 'assign' then 'complaint_case.assigned'
      when 'unassign' then 'complaint_case.unassigned'
      when 'escalate' then 'complaint_case.escalated'
      else 'complaint_case.returned_to_review'
    end,
    'complaint_case', p_complaint_case_id,
    jsonb_build_object('state', v_before.state, 'assigned', v_before.assigned_to_user_id is not null),
    jsonb_build_object('state', v_state, 'assigned', v_assignee is not null),
    null, null, v_lock.jurisdiction_id
  );
  return 'applied';
end;
$function$;


-- ---------------------------------------------------------------------------
-- Function privileges (the replaced functions keep theirs; the new internal function is executable by no API role).
-- ---------------------------------------------------------------------------

revoke all on function public.audit_snapshot_redacted(text, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.audit_snapshot_redacted(text, jsonb) is
  'MVP-001 S11 (internal; review correction R4): one audit snapshot as the audit workspace shows it: every free-text value earlier migrations write (staff notes, the information request message, notes, profile presentation details, licence and insurance claim texts, discipline finding texts, free-text reasons) replaced by {"redacted": true}; codes, identifiers and structure kept. Executable by no API role.';
comment on function public.client_authorize_payment(uuid) is
  'MVP-001 S7 (MVP-001 S8: also an accepted Request whose flow authorizes at the attorney''s acceptance; MVP-001 S11 R1: never once its Consultation has ended): creates the client''s payment attempt with complete FP-1 provenance, one audit event and the enqueued hosted checkout; any refusal writes nothing.';
comment on function public.client_request_payment(uuid) is
  'MVP-001 S7 (MVP-001 S8: authorization_after_acceptance; MVP-001 S11 R1: not_applicable once the Consultation has ended): the payment step of one of the caller''s own Requests and its latest attempt; never a provider reference, a policy or the attorney-side fee.';
comment on function public.payment_confirm_authorization(public.payment_transactions, text, bigint, text, text, uuid, text) is
  'MVP-001 S7 (internal; MVP-001 S8: an accepted Request whose flow captures at the attorney''s acceptance is captured once its authorization is confirmed; MVP-001 S11 D3: the four-way gate before that capture; MVP-001 S11 R1: no capture once the Consultation was cancelled or ended unperformed, its financial review item reused or opened): records a confirmed authorization of exactly the quoted total, or releases a mismatched one with a critical exception.';
comment on function public.decision_payment_captured() is
  'MVP-001 S8 (trigger): on a confirmed capture of an accepted Request, creates the deferred instant Consultation its configuration conditions on a captured payment and records an Engagement effective at_payment_capture (MVP-001 S11 R1: none for a Consultation cancelled or ended unperformed, whose financial review item is reused or opened).';
comment on function public.consultation_apply_completion(public.consultations, public.payment_transactions, text, uuid, text, text, text, uuid, jsonb) is
  'MVP-001 S11 (internal): completes a locked live Consultation with a completion reason under the S9 completion rule (capture only when the governing flow captures at_consultation_completion, with the production gate, R5: for the payment_flow version and every other version the payment recorded; an attempt that cannot be captured opens capture_unavailable_at_completion); audited. Answers completed, configuration_unavailable or conflict.';
comment on function public.consultation_end(uuid) is
  'MVP-001 S9, replaced forward by S11: the attorney declares normal completion of one of their own live Consultations (completed, completion reason normal, PM row 20); its confirmed Booking is completed; no timing configuration needed; the production gate (payment_flow and, R5, every other version the payment recorded) only when the flow captures at completion; the configured capture at completion; the Media Room closes; audited. Outcomes: completed, invalid, denied, not_found, not_started, ended, configuration_unavailable, conflict.';
comment on function public.consultation_cancel(uuid) is
  'MVP-001 S11: the Consultation''s own client (any aal) or attorney (approved, aal2) cancels it while created, scheduled or ready and before its nominal end (R2) (cancelled, client_cancelled | attorney_cancelled, PM rows 11 to 13): the confirmed Booking is cancelled, the Media Room closes, the payment is not moved and a live attempt opens one high cancellation_payment_review exception; audited. Outcomes: cancelled, invalid, denied, not_found, already_cancelled, ended, in_progress, time_passed, configuration_unavailable.';
comment on function public.staff_update_complaint(uuid, text) is
  'MVP-001 S11: staff holding manage_complaints for the case''s jurisdiction (aal2) assign a case to themselves, unassign it, escalate it or return it to review; audited (R6: assigning a case already assigned to the caller changes and audits nothing). Outcomes: applied, invalid, denied, not_found, invalid_transition.';
comment on function public.staff_audit_event(uuid) is
  'MVP-001 S11 audit workspace: one audit event with its recorded snapshots as stored except free-text values, which are redacted (R4), for staff holding view_audit_events covering its jurisdiction (aal2); an event outside the scope answers as an unknown id. Each request is audited once with the requested identifier.';
comment on function public.client_account_rows(uuid, text, integer, integer) is
  'MVP-001 S11 (internal): client account metadata rows (User id, display name, account state, creation, counts of Intakes, Requests, Consultations, open matters and unresolved complaints) for Users holding a Client Profile and neither a Staff Profile nor (R3) an Attorney Profile. Executable by no API role.';
comment on function public.staff_change_client_account(uuid, text, text) is
  'MVP-001 S11 client administration: suspend (active -> suspended) or reactivate (suspended -> active) a client account with a required staff note on the audit event, for staff holding the global manage_client_accounts grant (aal2), never their own account nor (R3) a User holding an Attorney Profile (not_found); a suspension with open matters opens one client_account_review compliance item (PM row 46) and changes nothing else. Outcomes: applied, invalid, denied, not_found, locked.';
