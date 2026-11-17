-- MVP-001 S4 (3 of 3): slot checks, Bookability evaluation persistence, the Slot Hold lifecycle, booking support
-- and the expiry sweep (MVP-001 Packet S4; MBS section 9 invariants 1-6; IMP section 20; DM sections 2.5-2.7 and 8;
-- PS sections 16, 35 and 36; TA sections 11 and 24; Packet section 2 rule 13).
--
-- No relation, column, policy type, capability or seed is added (Packet rules 8, 10 and 16). Every function here is
-- an internal building block, executable by no API role: the later slices' own commands (S5 referral, S6 request,
-- S8 acceptance) call them inside their transactions and record their own audit events for what they decide;
-- the one action taken by the system itself, Hold expiry, is audited here as a system action.
--
-- Concurrency (MBS section 9; IMP section 11): every Hold and Booking change of one attorney first takes the same
-- per-attorney transaction advisory lock as the P1 conflict trigger (enforce_scheduling_conflicts, key
-- hashtext(attorney_id), 7007), then locks rows in the order Hold -> Request -> Consultation, and re-reads every
-- deadline under that lock. A later command that changes a scheduled Request (acceptance, decline, withdrawal)
-- takes the same lock first, through scheduling_lock_attorney, before it locks the Request, so it can never
-- deadlock with an expiry that holds the lock and waits for the Request. Together with the P1 triggers (overlapping active Holds, Hold versus confirmed Booking,
-- overlapping confirmed Bookings, Request/Hold consistency at commit), the P1 unique index of one confirmed Booking
-- per Consultation, and the S4 guards (20261120010000), this makes:
-- 1. at most one confirmed Booking per Consultation (zero is valid);
-- 2. overlapping active Holds for one attorney impossible;
-- 3. a scheduled Request and its Hold one unit: a Hold is acquired only for an open scheduled Request without one,
--    and an open scheduled Request cannot commit without an active Hold;
-- 4. an ended or expired Request unable to keep an active Hold, and an expired Hold unable to keep its Request open:
--    expiring a Hold expires its open Request in the same transaction;
-- 5. no Booking before acceptance (the Booking needs a Consultation whose Request is accepted);
-- 6. overlapping current Bookings for one attorney impossible.
-- Every deadline is a stored server timestamp evaluated by the database (TA section 24): a command that meets a Hold
-- past its expires_at expires it first; the pg_cron sweep only makes expiry prompt.
--
-- Hold timing comes only from the 'scheduling' policy of the Request's jurisdiction (its Referral's jurisdiction):
-- expires_at is the earliest of now + hold_response_window_seconds, the slot start minus
-- hold_pre_slot_interval_seconds, and the Request's response deadline when set; a Hold that would expire at once is
-- refused (too_late). pending_hold_cap bounds an attorney's active Holds; minimum_notice_seconds bounds how soon a
-- slot may start. Unset or incomplete policy refuses (policy_unavailable). Fixed bounds: a slot lasts at most one
-- day; the sweep ends at most 500 Holds per run.
--
-- Bookability (MBS section 2.4; DM section 8; PS section 16): each evaluation appends one immutable row recording
-- every factor with its reason. Instant: the Eligibility Evaluation's result is eligible, the attorney's Instant
-- intent is on (unrevoked, unexpired, live session), Presence is observed (scheduling_presence) and the attorney is
-- not in a Consultation that has started and not ended. Scheduled: eligible, and the slot has no problem
-- (scheduling_slot_problem). The jurisdiction is the Eligibility Evaluation's own.

-- ---------------------------------------------------------------------------
-- Slot checks (internal).
-- ---------------------------------------------------------------------------

-- Null when the slot can be held for the attorney now, otherwise the first problem, in this order: invalid,
-- policy_unavailable, notice, outside_availability (not inside one availability window), blackout,
-- booking_conflict, hold_conflict.
create function public.scheduling_slot_problem(
  p_attorney uuid,
  p_slot_start timestamptz,
  p_slot_end timestamptz,
  p_jurisdiction uuid
)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_outcome text;
  v_parameters jsonb;
begin
  if p_attorney is null
     or p_slot_start is null
     or p_slot_end is null
     or p_slot_start >= p_slot_end
     or p_slot_end - p_slot_start > interval '1 day' then
    return 'invalid';
  end if;
  select p.outcome, p.parameters
  into v_outcome, v_parameters
  from public.scheduling_policy('scheduling', p_jurisdiction, v_now) as p;
  if v_outcome is distinct from 'selected' then
    return 'policy_unavailable';
  end if;
  if p_slot_start < v_now + make_interval(secs => (v_parameters ->> 'minimum_notice_seconds')::bigint) then
    return 'notice';
  end if;
  if not exists (
    select 1
    from public.scheduling_expand_availability(
      p_attorney,
      (p_slot_start at time zone 'UTC')::date - 1,
      (p_slot_end at time zone 'UTC')::date + 1
    ) as w
    where w.window_start <= p_slot_start
      and w.window_end >= p_slot_end
  ) then
    return 'outside_availability';
  end if;
  if exists (
    select 1
    from public.blackouts as b
    where b.attorney_id = p_attorney
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_slot_start, p_slot_end, '[)')
  ) then
    return 'blackout';
  end if;
  if exists (
    select 1
    from public.bookings as b
    where b.attorney_id = p_attorney
      and b.status = 'confirmed'
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_slot_start, p_slot_end, '[)')
  ) then
    return 'booking_conflict';
  end if;
  if exists (
    select 1
    from public.slot_holds as h
    where h.attorney_id = p_attorney
      and h.released_at is null
      and h.expires_at > clock_timestamp()
      and tstzrange(h.slot_start_at, h.slot_end_at, '[)') && tstzrange(p_slot_start, p_slot_end, '[)')
  ) then
    return 'hold_conflict';
  end if;
  return null;
end;
$function$;

-- The per-attorney scheduling lock (transaction advisory lock, the P1 conflict trigger's key). Every command that
-- changes a scheduled Request, a Hold or a Booking of the attorney takes it before any row lock.
create function public.scheduling_lock_attorney(p_attorney uuid)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select pg_advisory_xact_lock(hashtext(p_attorney::text), 7007);
$function$;

-- ---------------------------------------------------------------------------
-- Bookability evaluation (internal).
-- ---------------------------------------------------------------------------

-- Appends one Bookability Evaluation and answers its result and id, or ('invalid', null) for a malformed call or an
-- Eligibility Evaluation that is unknown or belongs to another attorney. Instant when both slot bounds are null,
-- scheduled when both are set.
create function public.scheduling_evaluate_bookability(
  p_attorney uuid,
  p_eligibility_evaluation_id uuid,
  p_context_type text,
  p_context_id uuid,
  p_modality text,
  p_slot_start timestamptz,
  p_slot_end timestamptz
)
returns table (result text, evaluation_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_eligibility record;
  v_factors jsonb := '[]'::jsonb;
  v_basis jsonb;
  v_bookable boolean;
  v_intent_id uuid;
  v_intent_expires timestamptz;
  v_presence_observed boolean;
  v_trust_method text;
  v_presence_reason text;
  v_presence_policy uuid;
  v_in_consultation boolean;
  v_problem text;
  v_policy uuid;
  v_id uuid;
begin
  if p_attorney is null
     or p_eligibility_evaluation_id is null
     or p_context_type is null
     or p_context_type not in ('referral', 'consultation_request')
     or p_context_id is null
     or p_modality is null
     or btrim(p_modality) = ''
     or char_length(p_modality) > 64
     or (p_slot_start is null) <> (p_slot_end is null) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select e.attorney_id, e.jurisdiction_id, e.result, e.as_of
  into v_eligibility
  from public.eligibility_evaluations as e
  where e.id = p_eligibility_evaluation_id;
  if not found or v_eligibility.attorney_id is distinct from p_attorney then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_bookable := v_eligibility.result = 'eligible';
  v_factors := v_factors || jsonb_build_array(jsonb_build_object(
    'factor', 'eligibility',
    'passed', v_bookable,
    'reason', case when v_bookable then 'eligible' else 'eligibility_' || v_eligibility.result end,
    'eligibility_evaluation_id', p_eligibility_evaluation_id,
    'eligibility_as_of', v_eligibility.as_of
  ));
  if p_slot_start is null then
    select i.id, i.expires_at
    into v_intent_id, v_intent_expires
    from public.instant_availability_intents as i
    join public.application_sessions as s on s.id = i.application_session_id
    where i.attorney_id = p_attorney
      and i.revoked_at is null
      and i.enabled_at <= v_now
      and i.expires_at > v_now
      and s.ended_at is null
      and s.revoked_at is null
      and s.expires_at > v_now
    order by i.expires_at desc, i.id
    limit 1;
    v_factors := v_factors || jsonb_build_array(jsonb_build_object(
      'factor', 'instant_intent',
      'passed', v_intent_id is not null,
      'reason', case when v_intent_id is not null then 'intent_on' else 'intent_off' end
    ));
    select pr.observed, pr.trust_method, pr.reason, pr.policy_version_id
    into v_presence_observed, v_trust_method, v_presence_reason, v_presence_policy
    from public.scheduling_presence(p_attorney) as pr;
    v_factors := v_factors || jsonb_build_array(jsonb_build_object(
      'factor', 'presence',
      'passed', v_presence_observed,
      'reason', v_presence_reason,
      'policy_version_id', v_presence_policy
    ));
    v_in_consultation := exists (
      select 1
      from public.consultations as c
      where c.attorney_id = p_attorney
        and c.started_at is not null
        and c.ended_at is null
    );
    v_factors := v_factors || jsonb_build_array(jsonb_build_object(
      'factor', 'consultation',
      'passed', not v_in_consultation,
      'reason', case when v_in_consultation then 'in_consultation' else 'not_in_consultation' end
    ));
    v_bookable := v_bookable and v_intent_id is not null and v_presence_observed and not v_in_consultation;
    v_basis := case
      when v_intent_id is not null
        then jsonb_build_object('instant_intent_id', v_intent_id, 'intent_expires_at', v_intent_expires)
    end;
  else
    v_problem := public.scheduling_slot_problem(
      p_attorney, p_slot_start, p_slot_end, v_eligibility.jurisdiction_id
    );
    select p.policy_version_id into v_policy
    from public.scheduling_policy('scheduling', v_eligibility.jurisdiction_id, v_now) as p;
    v_factors := v_factors || jsonb_build_array(jsonb_build_object(
      'factor', 'slot',
      'passed', v_problem is null,
      'reason', coalesce(v_problem, 'slot_available'),
      'policy_version_id', v_policy
    ));
    v_bookable := v_bookable and v_problem is null;
    select jsonb_build_object(
             'rule_id', w.rule_id,
             'timezone_name', w.timezone_name,
             'local_date', w.local_date,
             'window_start', w.window_start,
             'window_end', w.window_end
           )
    into v_basis
    from public.scheduling_expand_availability(
      p_attorney,
      (p_slot_start at time zone 'UTC')::date - 1,
      (p_slot_end at time zone 'UTC')::date + 1
    ) as w
    where w.window_start <= p_slot_start
      and w.window_end >= p_slot_end
    order by w.window_start, w.rule_id
    limit 1;
  end if;
  insert into public.bookability_evaluations (
    attorney_id, eligibility_evaluation_id, context_type, context_id,
    evaluated_at, as_of, modality, presence_observed, presence_trust_method,
    instant_intent_observed, slot_start_at, slot_end_at, availability_basis,
    constraint_results, result
  ) values (
    p_attorney, p_eligibility_evaluation_id, p_context_type, p_context_id,
    v_now, v_now, p_modality,
    case when p_slot_start is null then v_presence_observed end,
    case when p_slot_start is null then v_trust_method end,
    case when p_slot_start is null then v_intent_id is not null end,
    p_slot_start, p_slot_end, v_basis,
    v_factors,
    case when v_bookable then 'bookable' else 'not_bookable' end
  )
  returning id into v_id;
  return query select case when v_bookable then 'bookable' else 'not_bookable' end, v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The Slot Hold lifecycle (internal).
-- ---------------------------------------------------------------------------

-- Expires one Hold whose server deadline has passed: released_at now, release_reason 'expired', and its open
-- scheduled Request moves to 'expired' in the same transaction; one system audit event. Outcomes: expired, active
-- (deadline not reached), ended (already ended), not_found, busy (p_skip_busy only: the attorney's lock or the row
-- is held by another transaction).
create function public.scheduling_expire_hold_if_due(p_hold_id uuid, p_skip_busy boolean default false)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_hold public.slot_holds;
  v_request_state text;
  v_request_path text;
  v_request_expired boolean := false;
begin
  select h.attorney_id into v_attorney from public.slot_holds as h where h.id = p_hold_id;
  if not found then
    return 'not_found';
  end if;
  if coalesce(p_skip_busy, false) then
    if not pg_try_advisory_xact_lock(hashtext(v_attorney::text), 7007) then
      return 'busy';
    end if;
    select h.* into v_hold from public.slot_holds as h where h.id = p_hold_id for update skip locked;
    if not found then
      return 'busy';
    end if;
  else
    perform pg_advisory_xact_lock(hashtext(v_attorney::text), 7007);
    select h.* into v_hold from public.slot_holds as h where h.id = p_hold_id for update;
  end if;
  if v_hold.released_at is not null then
    return 'ended';
  end if;
  if v_hold.expires_at > clock_timestamp() then
    return 'active';
  end if;
  update public.slot_holds as h
  set released_at = clock_timestamp(),
      release_reason = 'expired'
  where h.id = p_hold_id;
  select r.state, r.request_path
  into v_request_state, v_request_path
  from public.consultation_requests as r
  where r.id = v_hold.consultation_request_id
  for update;
  if v_request_path = 'scheduled'
     and v_request_state not in ('accepted', 'declined', 'expired', 'cancelled') then
    update public.consultation_requests as r
    set state = 'expired',
        expired_at = clock_timestamp()
    where r.id = v_hold.consultation_request_id;
    v_request_expired := true;
  end if;
  perform public.scheduling_audit(
    null, 'system', 'slot_hold.expired', 'slot_hold', p_hold_id,
    jsonb_build_object('state', 'held', 'expires_at', v_hold.expires_at),
    jsonb_build_object('release_reason', 'expired', 'request_expired', v_request_expired),
    'expires_at_reached'
  );
  return 'expired';
end;
$function$;

-- Acquires the Hold of one open scheduled Request without a Hold, for its selected attorney. Outcomes: held (with
-- the Hold id), invalid, not_found, not_available (with the slot problem), cap_reached, policy_unavailable,
-- too_late.
create function public.scheduling_acquire_hold(
  p_request_id uuid,
  p_slot_start timestamptz,
  p_slot_end timestamptz
)
returns table (outcome text, hold_id uuid, problem text)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_jurisdiction uuid;
  v_request public.consultation_requests;
  v_due uuid;
  v_outcome text;
  v_parameters jsonb;
  v_problem text;
  v_now timestamptz;
  v_expires timestamptz;
  v_id uuid;
begin
  if p_request_id is null or p_slot_start is null or p_slot_end is null then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  select r.selected_attorney_id, f.jurisdiction_id
  into v_attorney, v_jurisdiction
  from public.consultation_requests as r
  join public.referrals as f on f.id = r.referral_id
  where r.id = p_request_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext(v_attorney::text), 7007);
  select r.* into v_request
  from public.consultation_requests as r
  where r.id = p_request_id
  for update;
  if v_request.request_path is distinct from 'scheduled'
     or v_request.state in ('accepted', 'declined', 'expired', 'cancelled')
     or exists (select 1 from public.slot_holds as h where h.consultation_request_id = p_request_id) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  for v_due in
    select h.id
    from public.slot_holds as h
    where h.attorney_id = v_attorney
      and h.released_at is null
      and h.expires_at <= clock_timestamp()
    order by h.expires_at, h.id
    limit 500
  loop
    perform public.scheduling_expire_hold_if_due(v_due, false);
  end loop;
  select p.outcome, p.parameters
  into v_outcome, v_parameters
  from public.scheduling_policy('scheduling', v_jurisdiction, clock_timestamp()) as p;
  if v_outcome is distinct from 'selected' then
    return query select 'policy_unavailable'::text, null::uuid, null::text;
    return;
  end if;
  v_problem := public.scheduling_slot_problem(v_attorney, p_slot_start, p_slot_end, v_jurisdiction);
  if v_problem = 'invalid' then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  if v_problem = 'policy_unavailable' then
    return query select 'policy_unavailable'::text, null::uuid, null::text;
    return;
  end if;
  if v_problem is not null then
    return query select 'not_available'::text, null::uuid, v_problem;
    return;
  end if;
  if (select count(*) from public.slot_holds as h
      where h.attorney_id = v_attorney
        and h.released_at is null
        and h.expires_at > clock_timestamp())
     >= (v_parameters ->> 'pending_hold_cap')::bigint then
    return query select 'cap_reached'::text, null::uuid, null::text;
    return;
  end if;
  v_now := clock_timestamp();
  v_expires := least(
    v_now + make_interval(secs => (v_parameters ->> 'hold_response_window_seconds')::bigint),
    p_slot_start - make_interval(secs => (v_parameters ->> 'hold_pre_slot_interval_seconds')::bigint),
    coalesce(v_request.response_deadline_at, 'infinity'::timestamptz)
  );
  if v_expires <= v_now then
    return query select 'too_late'::text, null::uuid, null::text;
    return;
  end if;
  begin
    insert into public.slot_holds (
      consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at
    ) values (
      p_request_id, v_attorney, p_slot_start, p_slot_end, v_now, v_expires
    )
    returning id into v_id;
  exception
    when exclusion_violation then
      return query select 'not_available'::text, null::uuid, 'hold_conflict'::text;
      return;
    when unique_violation or check_violation then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;
  return query select 'held'::text, v_id, null::text;
end;
$function$;

-- Releases one active Hold whose Request has already ended (the caller ends the Request first, in the same
-- transaction). A Hold past its deadline is expired instead. Outcomes: released, already_ended, request_open,
-- not_found.
create function public.scheduling_release_hold(p_hold_id uuid)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_hold public.slot_holds;
  v_request_state text;
begin
  select h.attorney_id into v_attorney from public.slot_holds as h where h.id = p_hold_id;
  if not found then
    return 'not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_attorney::text), 7007);
  select h.* into v_hold from public.slot_holds as h where h.id = p_hold_id for update;
  if v_hold.released_at is not null then
    return 'already_ended';
  end if;
  if v_hold.expires_at <= clock_timestamp() then
    perform public.scheduling_expire_hold_if_due(p_hold_id, false);
    return 'already_ended';
  end if;
  select r.state into v_request_state
  from public.consultation_requests as r
  where r.id = v_hold.consultation_request_id
  for share;
  if v_request_state not in ('accepted', 'declined', 'expired', 'cancelled') then
    return 'request_open';
  end if;
  update public.slot_holds as h
  set released_at = clock_timestamp(),
      release_reason = 'released'
  where h.id = p_hold_id;
  return 'released';
end;
$function$;

-- Converts one active Hold into the confirmed Booking of the Consultation created from its (accepted) Request, with
-- the Hold's times. A Hold past its deadline is expired and refused. Outcomes: booked (with the Booking id),
-- expired, already_ended, not_found, conflict (an overlapping or second current Booking, or a Request no longer
-- accepted).
create function public.scheduling_convert_hold_to_booking(p_hold_id uuid, p_consultation_id uuid)
returns table (outcome text, booking_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_hold public.slot_holds;
  v_consultation public.consultations;
  v_id uuid;
begin
  if p_hold_id is null or p_consultation_id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select h.attorney_id into v_attorney from public.slot_holds as h where h.id = p_hold_id;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext(v_attorney::text), 7007);
  select h.* into v_hold from public.slot_holds as h where h.id = p_hold_id for update;
  select c.* into v_consultation
  from public.consultations as c
  where c.id = p_consultation_id
    and c.consultation_request_id = v_hold.consultation_request_id
  for share;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_hold.released_at is not null then
    return query select 'already_ended'::text, null::uuid;
    return;
  end if;
  if v_hold.expires_at <= clock_timestamp() then
    perform public.scheduling_expire_hold_if_due(p_hold_id, false);
    return query select 'expired'::text, null::uuid;
    return;
  end if;
  begin
    update public.slot_holds as h
    set released_at = clock_timestamp(),
        release_reason = 'converted'
    where h.id = p_hold_id;
    insert into public.bookings (consultation_id, attorney_id, client_id, starts_at, ends_at, status)
    values (
      v_consultation.id, v_consultation.attorney_id, v_consultation.client_id,
      v_hold.slot_start_at, v_hold.slot_end_at, 'confirmed'
    )
    returning id into v_id;
  exception
    when exclusion_violation or unique_violation or check_violation then
      return query select 'conflict'::text, null::uuid;
      return;
  end;
  return query select 'booked'::text, v_id;
end;
$function$;

-- The database-only sweep (no API role; pg_cron runs it as the owner). It expires at most 500 due Holds per run,
-- skipping any attorney or Hold another transaction holds; the next run, or the next command, continues.
create function public.scheduling_expiry_sweep()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_id uuid;
  v_answer text;
  v_expired integer := 0;
  v_busy integer := 0;
begin
  for v_id in
    select h.id
    from public.slot_holds as h
    where h.released_at is null
      and h.expires_at <= clock_timestamp()
    order by h.expires_at, h.id
    limit 500
  loop
    v_answer := public.scheduling_expire_hold_if_due(v_id, true);
    if v_answer = 'expired' then
      v_expired := v_expired + 1;
    elsif v_answer = 'busy' then
      v_busy := v_busy + 1;
    end if;
  end loop;
  return jsonb_build_object('expired', v_expired, 'busy', v_busy);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.scheduling_slot_problem(uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_lock_attorney(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_evaluate_bookability(uuid, uuid, text, uuid, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_expire_hold_if_due(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_acquire_hold(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_release_hold(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_convert_hold_to_booking(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_expiry_sweep()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.scheduling_slot_problem(uuid, timestamptz, timestamptz, uuid) is
  'MVP-001 S4 (internal): null when the slot can be held for the attorney now under the jurisdiction''s scheduling policy, otherwise invalid, policy_unavailable, notice, outside_availability, blackout, booking_conflict or hold_conflict.';
comment on function public.scheduling_lock_attorney(uuid) is
  'MVP-001 S4 (internal): takes the per-attorney scheduling lock (the P1 conflict trigger key); every command changing a scheduled Request, Hold or Booking of the attorney takes it before any row lock.';
comment on function public.scheduling_evaluate_bookability(uuid, uuid, text, uuid, text, timestamptz, timestamptz) is
  'MVP-001 S4 (internal): appends one immutable Bookability Evaluation recording each factor and its reason (instant: eligibility, intent, presence, not in a consultation; scheduled: eligibility and the slot) and answers bookable or not_bookable with its id, or invalid.';
comment on function public.scheduling_expire_hold_if_due(uuid, boolean) is
  'MVP-001 S4 (internal): expires a Hold past its server deadline and its open scheduled Request in the same transaction, audited as a system action. Outcomes: expired, active, ended, not_found, busy.';
comment on function public.scheduling_acquire_hold(uuid, timestamptz, timestamptz) is
  'MVP-001 S4 (internal): acquires the Hold of an open scheduled Request under the per-attorney lock, with its expiry from the jurisdiction''s scheduling policy. Outcomes: held, invalid, not_found, not_available (with the problem), cap_reached, policy_unavailable, too_late.';
comment on function public.scheduling_release_hold(uuid) is
  'MVP-001 S4 (internal): releases an active Hold whose Request has ended. Outcomes: released, already_ended, request_open, not_found.';
comment on function public.scheduling_convert_hold_to_booking(uuid, uuid) is
  'MVP-001 S4 (internal): converts an active Hold into the confirmed Booking of its accepted Request''s Consultation under the per-attorney lock; a due Hold is expired and refused. Outcomes: booked, expired, already_ended, not_found, conflict.';
comment on function public.scheduling_expiry_sweep() is
  'MVP-001 S4 (internal): the database-only Hold expiry sweep (at most 500 per run, skipping busy attorneys and rows).';

-- ---------------------------------------------------------------------------
-- The database-only schedule (same pattern as 20261118020000).
-- ---------------------------------------------------------------------------

do $scheduler$
begin
  if not exists (
    select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice 'pg_cron is not available: no schedule registered (commands still expire due Holds)';
    return;
  end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute $unschedule$
    select cron.unschedule(j.jobid)
    from cron.job as j
    where j.jobname = 'rosuno_scheduling_expiry_sweep'
  $unschedule$;
  execute $schedule$
    select cron.schedule(
      'rosuno_scheduling_expiry_sweep',
      '* * * * *',
      'select public.scheduling_expiry_sweep();'
    )
  $schedule$;
end;
$scheduler$;
