-- MVP-001 S11 (2 of 7): the completion types of a Consultation and their payment consequences (MVP-001 Packet S11
-- "completion types (normal, early, cancellation, no-show, technical failure) with PM distinctions"; MBS section 16
-- "Completion" and its failure tests; DM section 2.4; TA sections 18, 41, 48, 61 and 62; PS sections 17, 30.4 and 37;
-- PM section 1 INV-1, INV-8, INV-9, INV-11, INV-13 and INV-14, rows 11 to 22 and 35).
--
-- No relation, column or policy type is added (Packet rules 8 and 16). Rosuno determines the canonical outcome: every
-- outcome below is recorded by a command of a participant or of authorized staff. Nothing here, and nothing anywhere,
-- infers a cancellation, a no-show or a failure from time passing, from a sweep or from a provider event (MBS section
-- 16: "an attorney no-show is not inferred from a missing Daily callback alone"; PM INV-13); provider evidence that
-- arrives after an outcome still only opens the S9 Reconciliation Exceptions (20261125030000).
--
-- Nothing settles a gated value. PM rows 11 to 16, 18, 21 and 22 are policy-gated (their thresholds and refund
-- treatments are undecided) and G-1 governs every Engagement column: no command below classifies a cancellation as
-- early or late, decides a refund or a charge, or changes an Engagement. Where a row's financial treatment is settled
-- it is applied (row 17; row 21 "as row 20"); where it is not, the live payment attempt is left exactly as it is and
-- one Reconciliation Exception is opened for human resolution with the facts a human needs (PM INV-11: never guessed,
-- never silently absorbed).
--
-- Outcomes and their consequences (the vocabulary is 20261127010000):
-- - completed / normal: consultation_end (S9; PM row 20; replaced forward only to complete the Booking, below);
-- - completed / early_by_agreement (PM row 21): consultation_end_early, the Consultation's own attorney at aal2, only
--   while it is live and before its nominal end (scheduled: the confirmed Booking's end; instant: the start plus the
--   requested duration). The agreement is the attorney's recorded declaration (the client is notified of the recorded
--   outcome, 20261127070000, and can contest it through a complaint; a two-party confirmation would need a pending
--   state the lifecycle does not have: an owner question). Payment as row 20: the capture is requested exactly when
--   the governing flow captures at_consultation_completion, an attempt that cannot be captured then opens the S9
--   capture_unavailable_at_completion exception, and no refund is made;
-- - cancelled / client_cancelled | attorney_cancelled (PM rows 11 to 13; TA sections 61 and 62): consultation_cancel,
--   the Consultation's own client (an active User, any aal) or its own attorney (approved, aal2), while it is created,
--   scheduled or ready, never once it is live or decided. In the same transaction the confirmed Booking is cancelled,
--   so the attorney's slot is free again (S4 counts only confirmed Bookings), the Media Room closes through the S9
--   lifecycle and the other participant is notified. The payment is not moved: with a live payment attempt (S7: any
--   attempt not failed, cancelled or released) one high cancellation_payment_review exception records who cancelled,
--   the state it was cancelled from, the whole seconds before the scheduled start (null on the instant path), the
--   payment state and the cancellation and refund policy versions the payment recorded. No "late" classification is
--   made (the threshold is undecided). Without a payment attempt there is only the audit event;
-- - no_show / client_no_show | attorney_no_show | both_no_show (PM rows 14 to 16), technical_failure /
--   neither_connected (PM row 17) for a Consultation that never started, and completed / manual_resolution or
--   technical_failure / mid_consultation_failure (PM row 18) for a live one: staff_record_consultation_outcome, staff
--   holding manage_consultation_operations for the Consultation's jurisdiction at aal2, and only once the
--   participants can no longer proceed (the window rule below). The decision snapshots the S9 participation evidence
--   into its audit event; a decision the evidence contradicts is accepted only with an explicit acknowledgement and is
--   recorded as an evidence conflict. Consequences: manual_resolution follows the completion rule above; for
--   neither_connected (row 17, settled: no charge retained for an unperformed platform failure) an attempt that is
--   pending or authorized is released through the S7 release path, and one that is being or has been captured opens
--   one critical funds_retained_after_technical_failure exception (the S7 posture for captured funds: a refund is a
--   human decision, never automatic); every other outcome with a live attempt opens one high outcome_payment_review
--   exception citing its PM row.
--
-- The window rule of staff outcome recording ("never while the participants could still proceed"): the outcome is
-- accepted only at or after the end of the Consultation's permitted window as S9 computes it from the governing
-- scheduling version (consultation_timing). When that window cannot be computed (the timing configuration is
-- missing, incomplete or not selectable), the fail-safe rule applies: the Consultation's nominal end (the confirmed
-- Booking's end, or the start, else the creation, plus the requested duration) plus 86400 seconds, the upper bound of
-- the consultation_overrun_seconds key itself, so that no configuration that could still arrive would let the
-- participants proceed after it. Without a nominal end either (no confirmed Booking, no requested duration) the
-- outcome is refused (window_unavailable; fail closed). The basis (configured or fail_safe) is audited.
--
-- Evidence conflicts (the snapshot is consultation_participation, S9): client_no_show while the client was observed
-- joining; attorney_no_show while the attorney was; both_no_show or neither_connected while either was;
-- manual_resolution or mid_consultation_failure while the two were never observed present together. Absence of
-- evidence contradicts nothing and is recorded as such (provider_sessions 0): the decision is the staff member's.
--
-- Lock order (the canonical order of S4 to S9; every command below takes it): the caller's own rows (client: User,
-- then Client Profile; attorney: User, then Attorney Profile; staff: User, Staff Profile, grant) -> the attorney's
-- scheduling lock -> the Request's Hold and the Request (request_expire_if_due, FOR UPDATE) -> the Consultation (FOR
-- UPDATE) -> its confirmed Booking (FOR UPDATE; the cancellation only) -> its Media Room (FOR UPDATE) -> the live
-- payment attempt (FOR UPDATE). Every command that decides a Consultation (S8 acceptance, S9 start and end, and these)
-- holds the attorney's scheduling lock first, so they serialize per attorney and the loser of every race reads the
-- winner's committed state: a cancellation after a start answers in_progress, a start after a cancellation ended, a
-- second cancellation already_cancelled, an outcome after any decision already_decided. No command here makes a
-- scheduled Consultation ready (a cancellation or an outcome must not create a Media Room first).
--
-- Booking status (DM section 2.7: Booking completion is a fact separate from Consultation completion; the S4 guard,
-- unchanged, admits confirmed -> superseded | cancelled | completed, but no command performed the last two before
-- S11). In the same transaction as every terminal transition of a Consultation its confirmed Booking ends: the
-- cancellation cancels it (above); every other terminal transition completes it: consultation_end (S9, replaced
-- forward below with exactly that one addition), consultation_end_early, manual_resolution and the staff no-show and
-- technical-failure outcomes. An ended Booking is never deleted (S4), no Booking is superseded (rescheduling does not
-- exist), and S4 counts only confirmed Bookings, so an ended Booking no longer blocks its slot for bookability or a
-- new Hold. The Booking is locked FOR UPDATE right after the Consultation (consultation_end, S9, keeps its own order
-- and changes the Booking right after the Consultation's update; every command that touches a Booking holds the
-- attorney's scheduling lock first, so no two of them can wait on each other's Booking). consultation_context (S9,
-- internal) is replaced forward to read the Consultation's confirmed Booking, else its completed one, so the timing,
-- messaging and document rules that read a decided Consultation's slot after its end see exactly the slot they saw
-- before S11 (a cancelled Booking stays outside it, as the cancellation already proves).
--
-- Finance staff (manage_financial_operations, global grant, aal2) gain staff_request_release: the release of a
-- pending or authorized attempt of a Consultation that has reached a terminal state, through the S7 release path,
-- with a required reason recorded in its audit event. It lets a human resolve the review exceptions above for an
-- uncaptured authorization without a database edit; like the S7 staff refund, it decides no entitlement.

-- ---------------------------------------------------------------------------
-- Internal helpers.
-- ---------------------------------------------------------------------------

-- The nominal end of a Consultation: the confirmed Booking's end (scheduled) or the start, else the creation, plus the
-- requested duration (instant). Null when it cannot be derived.
create function public.consultation_nominal_end(p_consultation_id uuid)
returns timestamptz
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case x.request_path
    when 'scheduled' then x.slot_end_at
    when 'instant' then coalesce(x.started_at, x.created_at) + make_interval(mins => x.duration_minutes)
  end
  from public.consultation_context(p_consultation_id) as x;
$function$;

-- When staff may record the outcome of a Consultation (see the header): the end of its permitted window under the
-- governing scheduling version ('configured', with that version), else its nominal end plus the overrun key's own
-- upper bound ('fail_safe'), else nothing ('unavailable').
create function public.consultation_outcome_window(p_consultation_id uuid, p_as_of timestamptz)
returns table (closes_at timestamptz, basis text, policy_version_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_timing record;
  v_nominal timestamptz;
begin
  select t.* into v_timing from public.consultation_timing(p_consultation_id, p_as_of) as t;
  if v_timing.outcome = 'selected' and v_timing.closes_at is not null then
    return query select v_timing.closes_at, 'configured'::text, v_timing.policy_version_id;
    return;
  end if;
  v_nominal := public.consultation_nominal_end(p_consultation_id);
  if v_nominal is null then
    return query select null::timestamptz, 'unavailable'::text, null::uuid;
    return;
  end if;
  return query select v_nominal + interval '86400 seconds', 'fail_safe'::text, null::uuid;
end;
$function$;

-- The live payment attempt of a Request (S7: the one attempt not failed, cancelled or released), locked.
create function public.consultation_lock_live_payment(p_request_id uuid)
returns public.payment_transactions
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select pt.*
  from public.payment_transactions as pt
  where pt.consultation_request_id = p_request_id
    and pt.state not in ('failed', 'cancelled', 'authorization_released')
  order by pt.created_at desc, pt.id desc
  limit 1
  for update;
$function$;

-- The confirmed Booking of a Consultation, locked (null without one). Taken right after the Consultation's own lock.
create function public.consultation_lock_booking(p_consultation_id uuid)
returns uuid
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select b.id
  from public.bookings as b
  where b.consultation_id = p_consultation_id
    and b.status = 'confirmed'
  order by b.created_at, b.id
  limit 1
  for update;
$function$;

-- Completes the confirmed Booking of a Consultation that has just reached a terminal state other than cancelled (DM
-- section 2.7; the S4 guard admits confirmed -> completed, with no timestamp). Returns the Booking, or null without a
-- confirmed one (the instant path).
create function public.consultation_complete_booking(p_consultation_id uuid)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_booking uuid;
begin
  update public.bookings as b
  set status = 'completed'
  where b.consultation_id = p_consultation_id
    and b.status = 'confirmed'
  returning b.id into v_booking;
  return v_booking;
end;
$function$;

-- Requests the release of a pending or authorized payment attempt through the S7 release path (release_pending, one
-- system audit event with the reason, one payment.release job; the provider call follows commit). The caller holds
-- the payment's locks. Outcomes: release_requested, not_releasable, not_found.
create function public.payment_request_release(p_payment_id uuid, p_reason text)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_before public.payment_transactions;
  v_after public.payment_transactions;
begin
  select pt.* into v_before from public.payment_transactions as pt where pt.id = p_payment_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state not in ('pending_authorization', 'authorized') then
    return 'not_releasable';
  end if;
  update public.payment_transactions as pt
  set state = 'release_pending'
  where pt.id = p_payment_id
  returning pt.* into v_after;
  perform public.payment_audit(null, 'system', 'payment.release_requested', v_before, v_after, p_reason);
  perform public.payment_enqueue('payment.release', 'payment_transaction', p_payment_id);
  return 'release_requested';
end;
$function$;

-- The cancellation and refund policy versions a payment attempt recorded (FP-1 provenance), in audit-event form; null
-- without an attempt.
create function public.consultation_unwind_policy_references(p_payment public.payment_transactions)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case when p_payment.id is null then null else jsonb_build_array(
    jsonb_build_object('policy_type_code', 'cancellation', 'policy_version_id', p_payment.cancellation_policy_version_id),
    jsonb_build_object('policy_type_code', 'refund', 'policy_version_id', p_payment.refund_policy_version_id)
  ) end;
$function$;

-- Completes a live Consultation with a completion reason, applying the S9 completion rule (PM rows 20 and 21): the
-- capture is requested exactly when the governing flow captures at_consultation_completion (in a production-class
-- database only with the four-way gate for the payment_flow version); an attempt that cannot be captured then opens
-- the S9 capture_unavailable_at_completion exception. One audit event. The caller holds every lock of the canonical
-- order and has established that the Consultation is live. Outcomes: completed (with the end instant),
-- configuration_unavailable (with the problem), conflict; a refusal changes nothing.
create function public.consultation_apply_completion(
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
  if v_capture = 'at_consultation_completion' then
    v_problem := public.media_production_problem(
      p_jurisdiction,
      jsonb_build_array(jsonb_build_object(
        'policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id,
        'regulatory_mode_id', v_payment.regulatory_mode_id
      )),
      clock_timestamp()
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

-- ---------------------------------------------------------------------------
-- Early completion by agreement (EXECUTE for authenticated only; PM row 21).
-- ---------------------------------------------------------------------------

create function public.consultation_end_early(p_consultation_id uuid)
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
  v_consultation public.consultations;
  v_room public.media_rooms;
  v_payment public.payment_transactions;
  v_jurisdiction uuid;
  v_nominal timestamptz;
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
  select c.* into v_consultation from public.consultations as c where c.id = p_consultation_id for update;
  perform public.consultation_lock_booking(p_consultation_id);
  select m.* into v_room from public.media_rooms as m where m.consultation_id = p_consultation_id for update;
  v_payment := public.consultation_lock_live_payment(v_request_id);
  select f.jurisdiction_id into v_jurisdiction
  from public.consultation_requests as r
  join public.referrals as f on f.id = r.referral_id
  where r.id = v_request_id;
  if v_consultation.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return query select 'ended'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  if v_consultation.state is distinct from 'live' then
    return query select 'not_started'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  -- Early means before the nominal end; at or after it the attorney's declaration is the normal end (S9).
  v_nominal := public.consultation_nominal_end(p_consultation_id);
  if v_nominal is null or clock_timestamp() >= v_nominal then
    return query select 'not_early'::text, null::text, null::timestamptz;
    return;
  end if;
  return query
    select a.outcome, a.problem, a.ended_at
    from public.consultation_apply_completion(
      v_consultation, v_payment, 'early_by_agreement', v_profile.user_id, 'attorney', 'consultation.completed',
      'attorney_completed_early', v_jurisdiction, jsonb_build_object('nominal_end_at', v_nominal)
    ) as a;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Cancellation by a participant (EXECUTE for authenticated only; PM rows 11 to 13).
-- ---------------------------------------------------------------------------

create function public.consultation_cancel(p_consultation_id uuid)
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
-- Staff outcome recording (EXECUTE for authenticated only; PM rows 14 to 18).
-- ---------------------------------------------------------------------------

create function public.staff_record_consultation_outcome(
  p_consultation_id uuid,
  p_outcome_code text,
  p_acknowledge_evidence_conflict boolean
)
returns table (outcome text, problem text, recorded_at timestamptz, closes_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_environment text;
  v_context record;
  v_staff uuid;
  v_consultation public.consultations;
  v_room public.media_rooms;
  v_payment public.payment_transactions;
  v_window record;
  v_now timestamptz;
  v_evidence record;
  v_snapshot jsonb;
  v_conflict boolean;
  v_state text;
  v_row integer;
  v_before_state text;
  v_consequence text := 'none';
  v_release text;
  v_exception uuid;
  v_details jsonb;
  v_answer record;
  v_booking uuid;
begin
  if p_consultation_id is null
     or p_acknowledge_evidence_conflict is null
     or p_outcome_code is null
     or p_outcome_code not in (
       'client_no_show', 'attorney_no_show', 'both_no_show', 'neither_connected', 'mid_consultation_failure',
       'manual_resolution'
     ) then
    return query select 'invalid'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select 'configuration_unavailable'::text, v_environment, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- The jurisdiction is an immutable fact of the Consultation, read before any lock; a caller without the capability
  -- for it (or, for an unknown id, without a global grant) is denied either way.
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  v_staff := public.lock_current_capability_staff('manage_consultation_operations', v_context.jurisdiction_id);
  if v_staff is null then
    return query select 'denied'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_context.consultation_id is null then
    return query select 'not_found'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  perform public.scheduling_lock_attorney(v_context.attorney_id);
  perform public.request_expire_if_due(v_context.consultation_request_id, false);
  select c.* into v_consultation from public.consultations as c where c.id = p_consultation_id for update;
  perform public.consultation_lock_booking(p_consultation_id);
  select m.* into v_room from public.media_rooms as m where m.consultation_id = p_consultation_id for update;
  v_payment := public.consultation_lock_live_payment(v_context.consultation_request_id);
  if v_consultation.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return query select 'already_decided'::text, v_consultation.state, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A Consultation that never started can be a no-show or a failure to connect; a live one a manual resolution or a
  -- failure mid-consultation.
  if (v_consultation.state = 'live') is distinct from (p_outcome_code in ('manual_resolution', 'mid_consultation_failure')) then
    return query select 'not_applicable'::text, v_consultation.state, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_now := clock_timestamp();
  select w.* into v_window from public.consultation_outcome_window(p_consultation_id, v_now) as w;
  if v_window.closes_at is null then
    return query select 'window_unavailable'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_now < v_window.closes_at then
    return query select 'window_open'::text, v_window.basis, null::timestamptz, v_window.closes_at;
    return;
  end if;
  select p.* into v_evidence from public.consultation_participation(p_consultation_id) as p;
  v_conflict := case p_outcome_code
    when 'client_no_show' then v_evidence.client_joined_at is not null
    when 'attorney_no_show' then v_evidence.attorney_joined_at is not null
    when 'both_no_show' then v_evidence.client_joined_at is not null or v_evidence.attorney_joined_at is not null
    when 'neither_connected' then v_evidence.client_joined_at is not null or v_evidence.attorney_joined_at is not null
    else not coalesce(v_evidence.both_present, false)
  end;
  if v_conflict and not p_acknowledge_evidence_conflict then
    return query select 'evidence_conflict'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_snapshot := jsonb_build_object(
    'attorney_joined', v_evidence.attorney_joined_at is not null,
    'client_joined', v_evidence.client_joined_at is not null,
    'both_present', coalesce(v_evidence.both_present, false),
    'either_left', coalesce(v_evidence.either_left, false),
    'provider_sessions', coalesce(v_evidence.provider_sessions, 0),
    'interruptions', coalesce(v_evidence.reconnections, 0)
  );
  v_details := jsonb_build_object(
    'evidence', v_snapshot,
    'evidence_conflict', v_conflict,
    'evidence_conflict_acknowledged', v_conflict and p_acknowledge_evidence_conflict,
    'window_closes_at', v_window.closes_at,
    'window_basis', v_window.basis
  );
  if p_outcome_code = 'manual_resolution' then
    -- Performance recorded by staff: the completion rule (PM row 20).
    select a.* into v_answer
    from public.consultation_apply_completion(
      v_consultation, v_payment, 'manual_resolution', v_staff, 'staff', 'consultation.outcome_recorded',
      'manual_resolution', v_context.jurisdiction_id, v_details
    ) as a;
    return query select
      case v_answer.outcome when 'completed' then 'recorded' else v_answer.outcome end,
      v_answer.problem, v_answer.ended_at, null::timestamptz;
    return;
  end if;
  v_state := case p_outcome_code
    when 'neither_connected' then 'technical_failure'
    when 'mid_consultation_failure' then 'technical_failure'
    else 'no_show'
  end;
  v_row := case p_outcome_code
    when 'client_no_show' then 14
    when 'attorney_no_show' then 15
    when 'both_no_show' then 16
    when 'neither_connected' then 17
    else 18
  end;
  v_before_state := v_consultation.state;
  update public.consultations as c
  set state = v_state,
      ended_at = v_now,
      outcome_code = p_outcome_code
  where c.id = p_consultation_id
  returning c.* into v_consultation;
  v_booking := public.consultation_complete_booking(p_consultation_id);
  if v_payment.id is not null then
    if p_outcome_code = 'neither_connected' then
      -- PM row 17 (settled): no charge is retained for an unperformed platform failure.
      if v_payment.state in ('pending_authorization', 'authorized') then
        v_release := public.payment_request_release(v_payment.id, 'consultation_neither_connected');
        if v_release is distinct from 'release_requested' then
          raise exception 'the release could not be requested' using errcode = 'RS901';
        end if;
        v_consequence := 'release_requested';
      elsif v_payment.state in ('capture_pending', 'captured', 'refund_pending', 'partially_refunded') then
        v_exception := public.payment_open_exception(
          'consultation', p_consultation_id, v_payment.id, 'funds_retained_after_technical_failure', 'critical',
          jsonb_build_object(
            'payment_matrix_rows', jsonb_build_array(17),
            'outcome_code', p_outcome_code,
            'payment_state', v_payment.state,
            'amount_captured_minor', v_payment.amount_captured_minor,
            'amount_refunded_minor', v_payment.amount_refunded_minor,
            'currency_code', v_payment.currency_code,
            'refund_policy_version_id', v_payment.refund_policy_version_id
          )
        );
        v_consequence := 'refund_review';
      end if;
    else
      -- PM rows 14 to 16 and 18 are policy-gated: nothing is moved. One review item for a human.
      v_exception := public.payment_open_exception(
        'consultation', p_consultation_id, v_payment.id, 'outcome_payment_review', 'high',
        jsonb_build_object(
          'payment_matrix_rows', jsonb_build_array(v_row),
          'outcome_code', p_outcome_code,
          'payment_state', v_payment.state,
          'evidence', v_snapshot,
          'cancellation_policy_version_id', v_payment.cancellation_policy_version_id,
          'refund_policy_version_id', v_payment.refund_policy_version_id
        )
      );
      v_consequence := 'payment_review';
    end if;
    select pt.* into v_payment from public.payment_transactions as pt where pt.id = v_payment.id;
  end if;
  perform public.decision_audit(
    v_staff, 'staff', 'consultation.outcome_recorded', 'consultation', p_consultation_id,
    jsonb_build_object('state', v_before_state),
    jsonb_build_object(
      'state', v_state,
      'outcome_code', p_outcome_code,
      'ended_at', v_consultation.ended_at,
      'payment_matrix_row', v_row,
      'payment_transaction_id', v_payment.id,
      'payment_state', v_payment.state,
      'payment_consequence', v_consequence,
      'reconciliation_exception_id', v_exception,
      'media_room_id', v_room.id,
      'booking_id', v_booking
    ) || v_details,
    p_outcome_code,
    case
      when v_window.policy_version_id is null then '[]'::jsonb
      else jsonb_build_array(
        jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_window.policy_version_id)
      )
    end || coalesce(public.consultation_unwind_policy_references(v_payment), '[]'::jsonb),
    v_context.jurisdiction_id
  );
  return query select 'recorded'::text, null::text, v_consultation.ended_at, null::timestamptz;
exception
  when sqlstate 'RS901' then
    return query select 'conflict'::text, null::text, null::timestamptz, null::timestamptz;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Finance: releasing an uncaptured attempt after a terminal outcome (manage_financial_operations, aal2).
-- ---------------------------------------------------------------------------

-- A staff release of a pending or authorized attempt whose Consultation is terminal, through the S7 release path, with
-- a reason (bounded plain text, recorded in the audit event with the payment's cancellation and refund policy
-- versions); entitlement is not decided here. Outcomes: requested, invalid, denied, not_found, not_releasable (the
-- attempt's state), matter_open (no Consultation, or one not yet decided), policy_unavailable (environment unrecorded
-- or mismatched).
create function public.staff_request_release(p_payment_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.payment_transactions;
  v_after public.payment_transactions;
  v_state text;
begin
  if p_payment_id is null or p_reason is null or not public.professional_text_within(p_reason, 500) then
    return 'invalid';
  end if;
  if public.rosuno_environment_status() <> 'ok' then
    return 'policy_unavailable';
  end if;
  v_staff := public.lock_current_capability_staff('manage_financial_operations', null);
  if v_staff is null then
    return 'denied';
  end if;
  select pt.* into v_before from public.payment_transactions as pt where pt.id = p_payment_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state not in ('pending_authorization', 'authorized') then
    return 'not_releasable';
  end if;
  select c.state into v_state
  from public.consultations as c
  where c.consultation_request_id = v_before.consultation_request_id;
  if v_state is null or v_state not in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return 'matter_open';
  end if;
  update public.payment_transactions as pt
  set state = 'release_pending'
  where pt.id = p_payment_id
  returning pt.* into v_after;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'payment.release_requested', 'payment_transaction', p_payment_id,
    public.payment_snapshot(v_before),
    public.payment_snapshot(v_after) || jsonb_build_object('consultation_state', v_state, 'reason', p_reason),
    'staff_release',
    public.consultation_unwind_policy_references(v_before),
    v_before.jurisdiction_id, clock_timestamp()
  );
  perform public.payment_enqueue('payment.release', 'payment_transaction', p_payment_id);
  return 'requested';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reads.
-- ---------------------------------------------------------------------------

-- The caller's own Consultations as their client (an active User), every state: live first, then those whose window
-- is open, then upcoming ones, soonest first, then decided ones, the most recent first; at most 200. For a Consultation
-- without a confirmed Booking any more (cancelled) the times are its last Booking's.
create function public.client_consultations()
returns table (
  consultation_id uuid,
  state text,
  ready_due boolean,
  request_path text,
  modality text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    v.consultation_id,
    v.state,
    v.ready_due,
    v.request_path,
    v.modality,
    v.duration_minutes,
    coalesce(v.booking_starts_at, k.starts_at),
    coalesce(v.booking_ends_at, k.ends_at),
    v.opens_at,
    v.closes_at,
    v.started_at,
    v.ended_at,
    v.outcome_code
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultations as c on c.client_id = cp.id
  cross join lateral public.consultation_view(c.id) as v
  left join lateral (
    select b.starts_at, b.ends_at
    from public.bookings as b
    where b.consultation_id = c.id
    order by b.created_at desc, b.id desc
    limit 1
  ) as k on true
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
  order by
    case
      when v.state = 'live' then 0
      when v.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then 4
      when v.closes_at is not null and v.closes_at <= clock_timestamp() then 3
      when v.opens_at is not null and v.opens_at <= clock_timestamp() then 1
      else 2
    end,
    case
      when v.state in ('created', 'scheduled', 'ready')
           and not (v.closes_at is not null and v.closes_at <= clock_timestamp())
        then coalesce(v.booking_starts_at, c.created_at)
    end asc nulls last,
    coalesce(v.ended_at, v.booking_starts_at, c.created_at) desc,
    v.consultation_id
  limit 200;
$function$;

-- One page (25 rows, plus one to tell whether another follows) of the Consultations nobody decided whose outcome
-- staff may now record (the window rule; oldest first), in the jurisdictions the caller holds
-- manage_consultation_operations for (aal2). Minimum necessary information: identifiers, states, times, the three
-- participation facts and the latest payment state; never a participant's identity.
create function public.staff_stale_consultations(p_offset integer)
returns table (
  consultation_id uuid,
  jurisdiction_id uuid,
  state text,
  request_path text,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  started_at timestamptz,
  closes_at timestamptz,
  window_basis text,
  attorney_joined boolean,
  client_joined boolean,
  both_present boolean,
  payment_state text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    c.id,
    f.jurisdiction_id,
    c.state,
    c.request_path,
    k.starts_at,
    k.ends_at,
    c.started_at,
    w.closes_at,
    w.basis,
    p.attorney_joined_at is not null,
    p.client_joined_at is not null,
    coalesce(p.both_present, false),
    (
      select pt.state
      from public.payment_transactions as pt
      where pt.consultation_request_id = c.consultation_request_id
      order by pt.created_at desc, pt.id desc
      limit 1
    )
  from public.consultations as c
  join public.consultation_requests as r on r.id = c.consultation_request_id
  join public.referrals as f on f.id = r.referral_id
  left join public.bookings as k on k.consultation_id = c.id and k.status = 'confirmed'
  cross join lateral public.consultation_outcome_window(c.id, clock_timestamp()) as w
  cross join lateral public.consultation_participation(c.id) as p
  where p_offset between 0 and 100000
    and c.state in ('created', 'scheduled', 'ready', 'live')
    -- The nominal end has passed (a cheap necessary condition before the window is computed).
    and case c.request_path
      when 'scheduled' then k.ends_at
      else coalesce(c.started_at, c.created_at) + make_interval(mins => r.requested_duration_minutes)
    end <= clock_timestamp()
    and public.has_staff_capability('manage_consultation_operations', f.jurisdiction_id, false)
    and w.closes_at is not null
    and w.closes_at <= clock_timestamp()
  order by w.closes_at, c.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One Consultation for operations staff (manage_consultation_operations for its jurisdiction, aal2): its state and
-- outcome, times, when its outcome may be recorded (and on which basis), whether it may be recorded now, the S9
-- participation evidence summary, the latest payment state and the number of open review exceptions about it. Never a
-- participant's identity, a message, a document or Intake content. No row without the capability or for an unknown id.
create function public.staff_consultation(p_consultation_id uuid)
returns table (
  consultation_id uuid,
  jurisdiction_id uuid,
  state text,
  outcome_code text,
  request_path text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  closes_at timestamptz,
  window_basis text,
  recordable boolean,
  attorney_joined boolean,
  client_joined boolean,
  both_present boolean,
  either_left boolean,
  provider_sessions integer,
  interruptions integer,
  payment_state text,
  open_exceptions integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    x.consultation_id,
    x.jurisdiction_id,
    x.state,
    c.outcome_code,
    x.request_path,
    x.duration_minutes,
    coalesce(x.slot_start_at, k.starts_at),
    coalesce(x.slot_end_at, k.ends_at),
    x.started_at,
    x.ended_at,
    w.closes_at,
    w.basis,
    x.state in ('created', 'scheduled', 'ready', 'live')
      and w.closes_at is not null
      and w.closes_at <= clock_timestamp(),
    p.attorney_joined_at is not null,
    p.client_joined_at is not null,
    coalesce(p.both_present, false),
    coalesce(p.either_left, false),
    coalesce(p.provider_sessions, 0),
    coalesce(p.reconnections, 0),
    (
      select pt.state
      from public.payment_transactions as pt
      where pt.consultation_request_id = x.consultation_request_id
      order by pt.created_at desc, pt.id desc
      limit 1
    ),
    (
      select count(*)::integer
      from public.reconciliation_exceptions as e
      where e.status = 'open'
        and (
          (e.canonical_type = 'consultation' and e.canonical_id = x.consultation_id)
          or (e.source_type = 'consultation' and e.source_id = x.consultation_id)
        )
    )
  from public.consultation_context(p_consultation_id) as x
  join public.consultations as c on c.id = x.consultation_id
  left join lateral (
    select b.starts_at, b.ends_at
    from public.bookings as b
    where b.consultation_id = x.consultation_id
    order by b.created_at desc, b.id desc
    limit 1
  ) as k on true
  cross join lateral public.consultation_outcome_window(x.consultation_id, clock_timestamp()) as w
  cross join lateral public.consultation_participation(x.consultation_id) as p
  where p_consultation_id is not null
    and public.has_staff_capability('manage_consultation_operations', x.jurisdiction_id, false);
$function$;

-- ---------------------------------------------------------------------------
-- S9 replaced forward: Booking completion (DM section 2.7; see the header).
-- ---------------------------------------------------------------------------

-- The S9 facts of one Consultation (20261125020000), unchanged except that the slot is the Consultation's confirmed
-- Booking, else its completed one: a decided Consultation keeps the slot it had before its Booking was completed.
create or replace function public.consultation_context(p_consultation_id uuid)
returns table (
  consultation_id uuid,
  consultation_request_id uuid,
  jurisdiction_id uuid,
  client_user_id uuid,
  attorney_user_id uuid,
  attorney_id uuid,
  request_path text,
  modality text,
  duration_minutes integer,
  state text,
  created_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz,
  slot_start_at timestamptz,
  slot_end_at timestamptz,
  engagement_policy_version_id uuid,
  media_room_id uuid,
  media_room_state text
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    c.id,
    c.consultation_request_id,
    f.jurisdiction_id,
    cp.user_id,
    ap.user_id,
    c.attorney_id,
    c.request_path,
    c.modality,
    r.requested_duration_minutes,
    c.state,
    c.created_at,
    c.started_at,
    c.ended_at,
    c.updated_at,
    b.starts_at,
    b.ends_at,
    c.engagement_policy_version_id,
    m.id,
    m.state
  from public.consultations as c
  join public.consultation_requests as r on r.id = c.consultation_request_id
  join public.referrals as f on f.id = r.referral_id
  join public.client_profiles as cp on cp.id = c.client_id
  join public.attorney_profiles as ap on ap.id = c.attorney_id
  left join lateral (
    select k.starts_at, k.ends_at
    from public.bookings as k
    where k.consultation_id = c.id and k.status in ('confirmed', 'completed')
    order by k.created_at, k.id
    limit 1
  ) as b on true
  left join public.media_rooms as m on m.consultation_id = c.id
  where c.id = p_consultation_id;
$function$;

-- The attorney's normal end (S9, 20261125020000), unchanged except that the confirmed Booking is completed in the same
-- transaction, right after the Consultation's update (its own lock order is kept).
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
  -- database, the four-way gate only for the payment_flow version and only when the governing flow captures at
  -- completion (the end then requests a capture or surfaces why it cannot).
  if v_capture = 'at_consultation_completion' then
    v_problem := public.media_production_problem(
      v_jurisdiction,
      jsonb_build_array(jsonb_build_object(
        'policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id,
        'regulatory_mode_id', v_payment.regulatory_mode_id
      )),
      v_now
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
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.consultation_nominal_end(uuid)',
    'public.consultation_outcome_window(uuid, timestamptz)',
    'public.consultation_lock_live_payment(uuid)',
    'public.consultation_lock_booking(uuid)',
    'public.consultation_complete_booking(uuid)',
    'public.consultation_context(uuid)',
    'public.payment_request_release(uuid, text)',
    'public.consultation_unwind_policy_references(public.payment_transactions)',
    'public.consultation_apply_completion(public.consultations, public.payment_transactions, text, uuid, text, text, text, uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.consultation_end(uuid)',
    'public.consultation_end_early(uuid)',
    'public.consultation_cancel(uuid)',
    'public.staff_record_consultation_outcome(uuid, text, boolean)',
    'public.staff_request_release(uuid, text)',
    'public.client_consultations()',
    'public.staff_stale_consultations(integer)',
    'public.staff_consultation(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.consultation_nominal_end(uuid) is
  'MVP-001 S11 (internal): the nominal end of a Consultation: its confirmed Booking''s end (scheduled) or its start, else its creation, plus the requested duration (instant); null when it cannot be derived.';
comment on function public.consultation_outcome_window(uuid, timestamptz) is
  'MVP-001 S11 (internal): when staff may record a Consultation''s outcome: the end of its permitted window under the governing scheduling version (configured), else its nominal end plus 86400 seconds, the overrun key''s own upper bound (fail_safe), else nothing (unavailable).';
comment on function public.consultation_lock_live_payment(uuid) is
  'MVP-001 S11 (internal): the live payment attempt of a Request (not failed, cancelled or released), locked FOR UPDATE; a null row without one.';
comment on function public.payment_request_release(uuid, text) is
  'MVP-001 S11 (internal): requests the release of a pending or authorized payment attempt through the S7 release path (release_pending, one system audit event with the reason, one payment.release job). Answers release_requested, not_releasable or not_found.';
comment on function public.consultation_unwind_policy_references(public.payment_transactions) is
  'MVP-001 S11 (internal): the cancellation and refund policy versions a payment attempt recorded, in audit-event form; null without an attempt.';
comment on function public.consultation_apply_completion(public.consultations, public.payment_transactions, text, uuid, text, text, text, uuid, jsonb) is
  'MVP-001 S11 (internal): completes a locked live Consultation with a completion reason under the S9 completion rule (capture only when the governing flow captures at_consultation_completion, with the production gate; an attempt that cannot be captured opens capture_unavailable_at_completion); audited. Answers completed, configuration_unavailable or conflict.';
comment on function public.consultation_lock_booking(uuid) is
  'MVP-001 S11 (internal): the confirmed Booking of a Consultation, locked FOR UPDATE right after the Consultation; null without one.';
comment on function public.consultation_complete_booking(uuid) is
  'MVP-001 S11 (internal): completes the confirmed Booking of a Consultation that has just reached a terminal state other than cancelled (DM section 2.7); returns it, or null without one.';
comment on function public.consultation_context(uuid) is
  'MVP-001 S9 (internal), replaced forward by S11: the facts of one Consultation the S9 decisions read (Request, jurisdiction, participants, path, duration, state and times, the confirmed Booking or else the completed one, engagement version, Media Room).';
comment on function public.consultation_end(uuid) is
  'MVP-001 S9, replaced forward by S11: the attorney declares normal completion of one of their own live Consultations (completed, completion reason normal, PM row 20); its confirmed Booking is completed; no timing configuration needed; the production gate (payment_flow) only when the flow captures at completion; the configured capture at completion; the Media Room closes; audited. Outcomes: completed, invalid, denied, not_found, not_started, ended, configuration_unavailable, conflict.';
comment on function public.consultation_end_early(uuid) is
  'MVP-001 S11: the attorney declares the early completion by agreement of one of their own live Consultations before its nominal end (completed, completion reason early_by_agreement, PM row 21; payment as the normal end, no refund); the Media Room closes; audited. Outcomes: completed, invalid, denied, not_found, not_started, ended, not_early, configuration_unavailable, conflict.';
comment on function public.consultation_cancel(uuid) is
  'MVP-001 S11: the Consultation''s own client (any aal) or attorney (approved, aal2) cancels it while created, scheduled or ready (cancelled, client_cancelled | attorney_cancelled, PM rows 11 to 13): the confirmed Booking is cancelled, the Media Room closes, the payment is not moved and a live attempt opens one high cancellation_payment_review exception; audited. Outcomes: cancelled, invalid, denied, not_found, already_cancelled, ended, in_progress, configuration_unavailable.';
comment on function public.staff_record_consultation_outcome(uuid, text, boolean) is
  'MVP-001 S11: staff holding manage_consultation_operations for the Consultation''s jurisdiction (aal2) record the outcome of a Consultation nobody decided, once its window has ended: client_no_show, attorney_no_show, both_no_show or neither_connected when it never started; manual_resolution or mid_consultation_failure when it is live. The S9 participation evidence is snapshotted into the audit event; a contradicted decision needs the acknowledgement. PM row 17 releases an uncaptured attempt and surfaces captured funds; manual_resolution follows the completion rule; every other outcome with a live attempt opens one review exception. Outcomes: recorded, invalid, denied, not_found, already_decided, not_applicable, window_open, window_unavailable, evidence_conflict, configuration_unavailable, conflict.';
comment on function public.staff_request_release(uuid, text) is
  'MVP-001 S11 finance workspace: releases a pending or authorized payment attempt of a Consultation that reached a terminal state, through the S7 release path, with a required reason; audited with the cancellation and refund policy versions. Entitlement is not decided. Outcomes: requested, invalid, denied, not_found, not_releasable, matter_open, policy_unavailable.';
comment on function public.client_consultations() is
  'MVP-001 S11: the caller''s own Consultations as their client (active User), every state: live, open, upcoming, then decided; at most 200; state, window, times and completion reason only.';
comment on function public.staff_stale_consultations(integer) is
  'MVP-001 S11 operations workspace: one page of the undecided Consultations whose outcome staff may now record, oldest first, in the jurisdictions the caller holds manage_consultation_operations for (aal2); identifiers, states, times, three participation facts and the latest payment state only.';
comment on function public.staff_consultation(uuid) is
  'MVP-001 S11 operations workspace: one Consultation for staff holding manage_consultation_operations for its jurisdiction (aal2): state, outcome, times, the outcome window and whether the outcome may be recorded now, the participation evidence summary, the latest payment state and the open review exceptions about it; never a participant''s identity or any content.';
