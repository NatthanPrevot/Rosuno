-- MVP-001 S6 (3 of 3): Consultation Request creation, withdrawal and expiry, and the client's request reads (MVP-001
-- Packet S6 "request creation with fresh evaluations", "atomic scheduled request + hold", "instant request",
-- "immutable fee calculation", "quote validity and expiry", "request withdrawal"; MBS section 11 deliverables,
-- mandatory decision-point evidence, financial invariants, scheduled request boundary and failure tests; DM sections
-- 2.5, 2.6, 8 and 9; PS sections 15.1, 22.1 and 35; PM sections 1, 3 and 4 (INV-2, INV-5, INV-6, INV-7, INV-9,
-- INV-12; rows 4, 5, 9 and 10); TA sections 6, 24, 58 and 59; ROS sections 8.1 and 14.1-14.2; Packet section 2 rule
-- 13; Packet section 4 "fresh evaluations" and "concurrency").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). No message, voice
-- memo, duration or price is stored on a Request: those wait for PS-A3 (Packet section 3). The chosen duration is an
-- input recorded in the Fee Calculation snapshot, and a scheduled Request's slot is its Hold's.
--
-- request_create (EXECUTE for authenticated only): for the caller's own Client Profile (lock_current_client), the
-- caller's own Intake (FOR UPDATE; its expiry evaluated first; submitted or active) and one of its Referrals (FOR
-- UPDATE; no Request yet, the P1 unique key backing it; no recorded outcome), with the path the Referral's bookable
-- evaluation recorded, it takes the attorney's scheduling lock (S4 order: the attorney lock before any Request or
-- Hold row) and then, in one exception-guarded block, so that any refusal leaves nothing of the attempt (no Request,
-- evaluation, Fee Calculation, Hold or audit event):
-- 1. the referral policy the environment-anchored resolver selects for the Referral's jurisdiction becomes the
--    Request's referral_policy_version_id (none: policy_unavailable);
-- 2. the response deadline is now plus the jurisdiction 'scheduling' policy's instant_request_response_window_seconds
--    or scheduled_request_response_window_seconds (an integer 1..2592000, required with the complete S4 scheduling
--    policy; DM section 2.6: a stored server deadline, policy-driven and different per path; unset or malformed:
--    policy_unavailable);
-- 3. the Request is created in state created, for the Referral's attorney, with the chosen modality;
-- 4. Eligibility is evaluated afresh in the jurisdiction context and, when the client filtered by a practice area
--    when the attorney was presented, also in that practice-area context (MBS section 11: a prior Referral
--    evaluation does not satisfy the Request decision point; PM INV-12); not eligible: not_available;
-- 5. Bookability is evaluated afresh for the Request (context consultation_request): instant with no slot (Instant
--    intent, Presence, not in a Consultation), scheduled for the chosen slot (slot start plus the chosen duration);
--    not bookable: not_available with the first failed factor's reason;
-- 6. the quote engine (20261122020000) prices the attorney's offer under the Fee Policy and the Fee Calculation is
--    recorded (calculated now, quote valid until now plus the policy's quote validity); its refusals answer
--    price_unavailable, price_not_permitted, duration_not_permitted, modality_not_permitted or policy_unavailable
--    (MB section 152: never a zero or fallback price);
-- 7. scheduled: the Hold is acquired (S4 scheduling_acquire_hold, whose expiry now also never passes the quote's
--    validity, below) and the Request moves to slot_held; a refusal answers not_available (with the slot problem),
--    cap_reached, too_late or policy_unavailable;
-- 8. one audit event (client actor; identifiers, path, modality, duration, amounts, currency and the quote
--    validity; no free text) with the eligibility, referral, fee and scheduling policy references.
-- Outcomes: created (with the Request id), invalid, not_found (no Client Profile, or not the caller's own Referral:
-- answered alike), intake_not_ready, already_requested, not_available (with the problem), price_unavailable,
-- price_not_permitted, duration_not_permitted, modality_not_permitted, policy_unavailable, cap_reached, too_late.
-- With the shipped price-source seam every otherwise valid attempt answers price_unavailable.
--
-- Hold expiry and the quote (DM sections 2.5 and 8; PM INV-6: a hold never outlives the request it serves):
-- scheduling_acquire_hold (20261120030000) is replaced so a Hold's expires_at is also never later than its
-- Request's current Fee Calculation's quote_valid_until; nothing else in it changes. Quote expiry therefore ends the
-- Hold at the latest when the quote ends, and the Hold's expiry expires its open Request (S4).
--
-- Expiry (TA section 24; Packet section 2 rule 13; PM INV-5): request_expire_if_due (internal) expires an undecided
-- Request (created, payment_authorized, slot_held, awaiting_attorney) whose quote validity, response deadline or
-- Hold expiry has passed, and ends its Hold in the same transaction (released, or expired when the Hold's own
-- deadline has passed), with one system audit event whose reason is the earliest passed of quote_expired,
-- response_deadline_reached and hold_expired. An expired Request (or quote) is never revived (the S6 guard): a new
-- attempt needs a new Referral and Request. request_expiry_sweep is database-only, bounded (at most 500 per run,
-- skipping busy attorneys and rows) and registered with pg_cron every minute where pg_cron is available; correctness
-- never depends on it: every S6 command evaluates expiry itself, and every read reports expired_due when a deadline
-- has passed before the sweep ran. Lock order everywhere: the attorney's scheduling lock, then the Hold, then the
-- Request (S4).
--
-- request_withdraw (EXECUTE for authenticated only): the caller's own undecided Request (after its expiry is
-- evaluated) moves to cancelled and its Hold is released (after the state change), with one client audit event.
-- Outcomes: withdrawn, invalid, not_found (another client's and an unknown Request alike), expired,
-- not_withdrawable. Referral outcomes are not recorded here: the outcome taxonomy is gated configuration (S5).
--
-- Client reads (EXECUTE for authenticated only; stable security definer): client_request (one of the caller's own
-- Requests: state, expired_due, path, the attorney's presentable display name, modality, duration (from the Fee
-- Calculation snapshot), slot (from the Hold), response deadline, creation time, the client's quote amounts,
-- currency and quote validity; never the attorney-side platform fee, the snapshot or the policies) and
-- client_intake_requests (the attempts of one of the caller's own Intakes: ordinal, Referral, Request, state,
-- expired_due and whether a Request can be made from it now). Another client's or an unknown id answers no row.
-- Attorneys read nothing of Requests or Intakes in S6.

-- ---------------------------------------------------------------------------
-- Hold expiry never passes the quote's validity (replaces the S4 function; DM sections 2.5 and 8).
-- ---------------------------------------------------------------------------

create or replace function public.scheduling_acquire_hold(
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
  v_quote_until timestamptz;
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
  -- MVP-001 S6: the Request's current Fee Calculation's quote validity (none: no bound from it).
  select c.quote_valid_until into v_quote_until
  from public.fee_calculations as c
  where c.consultation_request_id = p_request_id
    and not exists (
      select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = c.id
    );
  v_now := clock_timestamp();
  v_expires := least(
    v_now + make_interval(secs => (v_parameters ->> 'hold_response_window_seconds')::bigint),
    p_slot_start - make_interval(secs => (v_parameters ->> 'hold_pre_slot_interval_seconds')::bigint),
    coalesce(v_request.response_deadline_at, 'infinity'::timestamptz),
    coalesce(v_quote_until, 'infinity'::timestamptz)
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

-- ---------------------------------------------------------------------------
-- Internal building blocks.
-- ---------------------------------------------------------------------------

-- The response window for a path from the jurisdiction's complete scheduling policy: ('selected', version,
-- seconds), the scheduling policy's own refusal, ('policy_incomplete', version, null) or ('invalid', null, null).
create function public.request_response_window(p_jurisdiction uuid, p_path text, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, window_seconds integer)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_outcome text;
  v_id uuid;
  v_key text;
  v_value jsonb;
begin
  v_key := case p_path
    when 'instant' then 'instant_request_response_window_seconds'
    when 'scheduled' then 'scheduled_request_response_window_seconds'
  end;
  if p_jurisdiction is null or v_key is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  select p.outcome, p.policy_version_id
  into v_outcome, v_id
  from public.scheduling_policy('scheduling', p_jurisdiction, p_as_of) as p;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::integer;
    return;
  end if;
  select v.parameters -> v_key into v_value from public.policy_versions as v where v.id = v_id;
  if not public.pricing_integer_within(v_value, 1, 2592000) then
    return query select 'policy_incomplete'::text, v_id, null::integer;
    return;
  end if;
  return query select 'selected'::text, v_id, (v_value #>> '{}')::integer;
end;
$function$;

-- Whether an undecided Request's quote validity, response deadline or Hold expiry has passed (the sweep may not
-- have run yet). False for a decided or terminal Request; null for an unknown one.
create function public.request_expired_due(p_request uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
    and (
      coalesce(r.response_deadline_at <= clock_timestamp(), false)
      or exists (
        select 1
        from public.fee_calculations as c
        where c.consultation_request_id = r.id
          and c.quote_valid_until <= clock_timestamp()
          and not exists (
            select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = c.id
          )
      )
      or exists (
        select 1
        from public.slot_holds as h
        where h.consultation_request_id = r.id
          and h.released_at is null
          and h.expires_at <= clock_timestamp()
      )
    )
  from public.consultation_requests as r
  where r.id = p_request;
$function$;

-- The Request's state after evaluating its expiry, null when it does not exist, or busy (p_skip_busy only: the
-- attorney's lock or a row is held by another transaction). An undecided Request whose quote validity, response
-- deadline or Hold expiry has passed is expired, its Hold ended in the same transaction, with one system audit
-- event; anything else is left as it is.
create function public.request_expire_if_due(p_request_id uuid, p_skip_busy boolean default false)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_hold public.slot_holds;
  v_request public.consultation_requests;
  v_quote_until timestamptz;
  v_now timestamptz;
  v_reason text;
  v_hold_answer text;
  v_jurisdiction uuid;
begin
  select r.selected_attorney_id into v_attorney
  from public.consultation_requests as r
  where r.id = p_request_id;
  if not found then
    return null;
  end if;
  if coalesce(p_skip_busy, false) then
    if not pg_try_advisory_xact_lock(hashtext(v_attorney::text), 7007) then
      return 'busy';
    end if;
    select h.* into v_hold
    from public.slot_holds as h
    where h.consultation_request_id = p_request_id
    for update skip locked;
    if not found and exists (
      select 1 from public.slot_holds as h where h.consultation_request_id = p_request_id
    ) then
      return 'busy';
    end if;
    select r.* into v_request
    from public.consultation_requests as r
    where r.id = p_request_id
    for update skip locked;
    if not found then
      return 'busy';
    end if;
  else
    perform public.scheduling_lock_attorney(v_attorney);
    select h.* into v_hold
    from public.slot_holds as h
    where h.consultation_request_id = p_request_id
    for update;
    select r.* into v_request
    from public.consultation_requests as r
    where r.id = p_request_id
    for update;
  end if;
  if v_request.state not in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney') then
    return v_request.state;
  end if;
  v_now := clock_timestamp();
  select c.quote_valid_until into v_quote_until
  from public.fee_calculations as c
  where c.consultation_request_id = p_request_id
    and not exists (
      select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = c.id
    );
  select x.reason into v_reason
  from (
    values
      ('quote_expired', v_quote_until, 1),
      ('response_deadline_reached', v_request.response_deadline_at, 2),
      ('hold_expired', case when v_hold.id is not null and v_hold.released_at is null then v_hold.expires_at end, 3)
  ) as x(reason, due_at, rank)
  where x.due_at is not null and x.due_at <= v_now
  order by x.due_at, x.rank
  limit 1;
  if v_reason is null then
    return v_request.state;
  end if;
  update public.consultation_requests as r
  set state = 'expired',
      expired_at = v_now
  where r.id = p_request_id;
  if v_hold.id is not null and v_hold.released_at is null then
    v_hold_answer := public.scheduling_release_hold(v_hold.id);
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'consultation_request.expired', 'consultation_request', p_request_id,
    jsonb_build_object('state', v_request.state),
    jsonb_build_object(
      'state', 'expired',
      'hold_id', v_hold.id,
      'hold_ended', v_hold_answer is not null
    ),
    v_reason, null, v_jurisdiction, clock_timestamp()
  );
  return 'expired';
end;
$function$;

-- The database-only sweep (no API role; pg_cron runs it as the owner). It expires at most 500 due Requests per run,
-- skipping any attorney or row another transaction holds; the next run, or the next command, continues.
create function public.request_expiry_sweep()
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
    select r.id
    from public.consultation_requests as r
    where r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
      and public.request_expired_due(r.id)
    order by r.response_deadline_at nulls last, r.id
    limit 500
  loop
    v_answer := public.request_expire_if_due(v_id, true);
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
-- Request creation (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.request_create(
  p_referral_id uuid,
  p_path text,
  p_modality text,
  p_duration_minutes integer,
  p_slot_start timestamptz
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
begin
  if p_referral_id is null
     or p_path is null
     or p_path not in ('instant', 'scheduled')
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440
     or (p_path = 'scheduled' and p_slot_start is null)
     or (p_path = 'instant' and p_slot_start is not null) then
    return query select 'invalid'::text, null::uuid, null::text;
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

    -- 2. The response window for the path.
    select w.outcome, w.policy_version_id, w.window_seconds
    into v_window
    from public.request_response_window(v_referral.jurisdiction_id, p_path, v_now) as w;
    if v_window.outcome is distinct from 'selected' then
      v_refusal := 'policy_unavailable';
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 3. The Request.
    insert into public.consultation_requests (
      intake_id, client_id, selected_attorney_id, referral_id, request_path,
      referral_policy_version_id, requested_modality, state, response_deadline_at
    ) values (
      v_intake, v_client, v_referral.attorney_id, p_referral_id, p_path,
      v_referral_policy, p_modality, 'created',
      clock_timestamp() + make_interval(secs => v_window.window_seconds)
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

    -- 6. The quote and the Fee Calculation.
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

    -- 7. Scheduled: the Hold, then slot_held.
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

    -- 8. One audit event.
    select case when jsonb_typeof(e.policy_references) = 'array' then e.policy_references else '[]'::jsonb end
    into v_policy_references
    from public.eligibility_evaluations as e
    where e.id = v_evaluation;
    v_policy_references := coalesce(v_policy_references, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('policy_type_code', 'referral', 'policy_version_id', v_referral_policy),
      jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', v_quote.fee_policy_version_id),
      jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_window.policy_version_id)
    );
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
-- Request withdrawal (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.request_withdraw(p_request_id uuid)
returns table (outcome text)
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
  v_attorney uuid;
  v_state text;
  v_hold public.slot_holds;
  v_request public.consultation_requests;
  v_hold_answer text;
  v_jurisdiction uuid;
begin
  if p_request_id is null then
    return query select 'invalid'::text;
    return;
  end if;
  select l.user_id, l.client_id into v_user, v_client from public.lock_current_client() as l;
  if v_client is null then
    return query select 'not_found'::text;
    return;
  end if;
  select r.selected_attorney_id into v_attorney
  from public.consultation_requests as r
  where r.id = p_request_id
    and r.client_id = v_client;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;
  -- S4 lock order: the attorney's scheduling lock, then the Hold, then the Request.
  perform public.scheduling_lock_attorney(v_attorney);
  v_state := public.request_expire_if_due(p_request_id, false);
  if v_state = 'expired' then
    return query select 'expired'::text;
    return;
  end if;
  if v_state is null
     or v_state not in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney') then
    return query select 'not_withdrawable'::text;
    return;
  end if;
  select h.* into v_hold
  from public.slot_holds as h
  where h.consultation_request_id = p_request_id
  for update;
  select r.* into v_request
  from public.consultation_requests as r
  where r.id = p_request_id
  for update;
  update public.consultation_requests as r
  set state = 'cancelled',
      cancelled_at = clock_timestamp()
  where r.id = p_request_id;
  if v_hold.id is not null and v_hold.released_at is null then
    v_hold_answer := public.scheduling_release_hold(v_hold.id);
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'consultation_request.withdrawn', 'consultation_request', p_request_id,
    jsonb_build_object('state', v_request.state),
    jsonb_build_object(
      'state', 'cancelled',
      'hold_id', v_hold.id,
      'hold_ended', v_hold_answer is not null
    ),
    'client_withdrawal', null, v_jurisdiction, clock_timestamp()
  );
  return query select 'withdrawn'::text;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Client reads (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.client_request(p_request_id uuid)
returns table (
  request_id uuid,
  state text,
  expired_due boolean,
  request_path text,
  attorney_display_name text,
  requested_modality text,
  duration_minutes integer,
  slot_start_at timestamptz,
  slot_end_at timestamptz,
  response_deadline_at timestamptz,
  created_at timestamptz,
  attorney_listed_price_minor bigint,
  client_fee_minor bigint,
  tax_or_other_required_fee_minor bigint,
  total_client_amount_minor bigint,
  currency_code text,
  quote_valid_until timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    r.id,
    r.state,
    coalesce(public.request_expired_due(r.id), false),
    r.request_path,
    public.discovery_presentable_text(p.display_name),
    r.requested_modality,
    case
      when public.pricing_integer_within(c.calculation_snapshot -> 'inputs' -> 'duration_minutes', 1, 1440)
        then (c.calculation_snapshot -> 'inputs' ->> 'duration_minutes')::integer
    end,
    h.slot_start_at,
    h.slot_end_at,
    r.response_deadline_at,
    r.created_at,
    c.attorney_listed_price_minor,
    c.client_fee_minor,
    c.tax_or_other_required_fee_minor,
    c.total_client_amount_minor,
    c.currency_code::text,
    c.quote_valid_until
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id and r.id = p_request_id
  left join public.attorney_profiles as p on p.id = r.selected_attorney_id
  left join public.slot_holds as h on h.consultation_request_id = r.id
  left join lateral (
    select x.*
    from public.fee_calculations as x
    where x.consultation_request_id = r.id
      and not exists (
        select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = x.id
      )
    limit 1
  ) as c on true
  where p_request_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

create function public.client_intake_requests(p_intake_id uuid)
returns table (
  attempt_ordinal integer,
  referral_id uuid,
  request_id uuid,
  state text,
  expired_due boolean,
  requestable boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    f.attempt_ordinal,
    f.id,
    r.id,
    r.state,
    case when r.id is null then null else coalesce(public.request_expired_due(r.id), false) end,
    r.id is null
      and f.outcome_code is null
      and f.attorney_id is not null
      and i.state in ('submitted', 'active')
      and (i.expires_at is null or i.expires_at > clock_timestamp())
      and public.request_referral_path(f.id) is not null
  from public.users as u
  join public.client_profiles as c on c.user_id = u.id
  join public.intakes as i on i.client_id = c.id and i.id = p_intake_id
  join public.referrals as f on f.intake_id = i.id
  left join public.consultation_requests as r on r.referral_id = f.id
  where p_intake_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active'
  order by f.attempt_ordinal
  limit 50;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.scheduling_acquire_hold(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.request_response_window(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.request_expired_due(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_expire_if_due(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.request_expiry_sweep()
  from public, anon, authenticated, service_role;

revoke all on function public.request_create(uuid, text, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.request_create(uuid, text, text, integer, timestamptz) to authenticated;
revoke all on function public.request_withdraw(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_withdraw(uuid) to authenticated;
revoke all on function public.client_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request(uuid) to authenticated;
revoke all on function public.client_intake_requests(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_intake_requests(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.scheduling_acquire_hold(uuid, timestamptz, timestamptz) is
  'MVP-001 S4 (internal; MVP-001 S6: the expiry also never passes the Request''s quote validity): acquires the Hold of an open scheduled Request under the per-attorney lock, with its expiry from the jurisdiction''s scheduling policy, the Request''s response deadline and its current Fee Calculation''s quote validity. Outcomes: held, invalid, not_found, not_available (with the problem), cap_reached, policy_unavailable, too_late.';
comment on function public.request_response_window(uuid, text, timestamptz) is
  'MVP-001 S6 (internal): the response window seconds for a path from the jurisdiction''s complete scheduling policy (instant_request_response_window_seconds or scheduled_request_response_window_seconds), or its refusal.';
comment on function public.request_expired_due(uuid) is
  'MVP-001 S6 (internal): whether an undecided Request''s quote validity, response deadline or Hold expiry has passed.';
comment on function public.request_expire_if_due(uuid, boolean) is
  'MVP-001 S6 (internal): expires an undecided Request whose quote validity, response deadline or Hold expiry has passed and ends its Hold in the same transaction, audited as a system action with the reason; answers the state after, null when unknown, or busy (skip mode).';
comment on function public.request_expiry_sweep() is
  'MVP-001 S6 (internal): the database-only Request expiry sweep (at most 500 per run, skipping busy attorneys and rows).';
comment on function public.request_create(uuid, text, text, integer, timestamptz) is
  'MVP-001 S6: the client''s Consultation Request from one of their own Referrals, with fresh eligibility and Bookability, the immutable Fee Calculation from the attorney''s offer and the Fee Policy, the Hold for a scheduled Request, and one audit event; any refusal leaves nothing. Outcomes: created, invalid, not_found, intake_not_ready, already_requested, not_available, price_unavailable, price_not_permitted, duration_not_permitted, modality_not_permitted, policy_unavailable, cap_reached, too_late.';
comment on function public.request_withdraw(uuid) is
  'MVP-001 S6: the client withdraws one of their own undecided Requests (cancelled) and its Hold is released; audited. Outcomes: withdrawn, invalid, not_found, expired, not_withdrawable.';
comment on function public.client_request(uuid) is
  'MVP-001 S6: one of the caller''s own Requests: state, expired_due, path, attorney display name, modality, duration, slot, response deadline, creation time, the client''s quote amounts, currency and quote validity; nothing else.';
comment on function public.client_intake_requests(uuid) is
  'MVP-001 S6: the attempts of one of the caller''s own Intakes with their Referral, Request, state, expired_due and whether a Request can be made now.';

-- ---------------------------------------------------------------------------
-- The database-only schedule (same pattern as 20261120030000).
-- ---------------------------------------------------------------------------

do $scheduler$
begin
  if not exists (
    select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice 'pg_cron is not available: no schedule registered (commands and reads still evaluate request expiry)';
    return;
  end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute $unschedule$
    select cron.unschedule(j.jobid)
    from cron.job as j
    where j.jobname = 'rosuno_request_expiry_sweep'
  $unschedule$;
  execute $schedule$
    select cron.schedule(
      'rosuno_request_expiry_sweep',
      '* * * * *',
      'select public.request_expiry_sweep();'
    )
  $schedule$;
end;
$scheduler$;
