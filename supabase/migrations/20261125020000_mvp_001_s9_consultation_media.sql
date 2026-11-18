-- MVP-001 S9 (2 of 3): the Consultation state machine from ready to completion, server-controlled timing, the one
-- Media Room per Consultation and the participants' media authorization (MVP-001 Packet S9 capability list; MBS
-- section 14 rules, deliverables and failure tests; IMP section 25; TA sections 16.2, 46, 48 and 66; PS sections 17,
-- 18 and 23; DM section 2.4; PM section 1 INV-1, INV-8, INV-11, INV-12, INV-13 and INV-14, rows 19 and 20; MB sections
-- 32 and 33 "busy").
--
-- No relation, column or policy type is added (Packet rules 8 and 16); nothing settles G-1 to G-5, a completion type
-- other than the attorney's declared normal completion, a refund or any legal text. Every value comes from
-- configuration and unset configuration fails closed.
--
-- Configuration seam (Packet rule 6; no new policy type, rule 8): two optional keys of the existing scheduling policy
-- version that S4 selects for the Consultation's jurisdiction (its Referral's; scheduling_policy, the
-- environment-anchored resolver, PS-A2):
--   consultation_join_window_seconds (0..86400): how long before a scheduled start the Consultation becomes ready and
--     its participants may join;
--   consultation_overrun_seconds (0..86400): how long after the permitted end (the Booking's end, or the start plus
--     the requested duration) participants may still join or rejoin.
-- The ranges are wide sanity bounds, not values. Both are required by every S9 timing decision
-- (consultation_timing_policy); a version without them, or with a malformed one, answers policy_incomplete, so a
-- scheduled Consultation never becomes ready, no media access is granted and no start is accepted (fail closed).
-- Existing scheduling versions without the keys stay valid for every S4 to S8 use and stay approvable;
-- policy_parameters_approvable (replaced forward) refuses approval only of a version carrying a malformed one.
--
-- Permitted window (server-controlled timing, TA section 48; MBS section 2.8: browser timers only display):
-- - scheduled: from the confirmed Booking's start minus the join window until the Booking's end plus the overrun,
--   whether or not the Consultation has started (a start is accepted only inside this window, and a late start never
--   lengthens it). The window stays inside the booked slot plus the configured overrun: MBS section 9 allows no
--   overlapping confirmed Bookings, and a window running past the slot could overlap the attorney's next Booking and
--   block its start through the attorney's busy check (MB sections 32-33);
-- - instant: from the Consultation's creation (an instant Consultation is created and made ready in one transaction,
--   S8) until its start (or creation, before it starts) plus the requested duration plus the overrun.
-- The window is evaluated from the governing scheduling version selected at each decision, which each audit event
-- records among its policy references.
--
-- Lifecycle (DM section 2.4; the S8 guard enforces the vocabulary and the forward-only transitions):
-- - scheduled -> ready (consultation_ready_if_due): lazily, by every S9 command, and by the database-only sweep,
--   once the window has opened and while it has not closed, with the timing configuration present and, in a
--   production-class database, the four-way production gate holding for the jurisdiction (scheduling policy type;
--   MBS section 19). Audited as a system action;
-- - ready -> live (consultation_start, the attorney only, below);
-- - live -> completed with completion reason normal (consultation_end, the attorney only: the attorney's explicit
--   declaration of normal completion, PM row 20). Early completion, cancellation, no-show and technical failure and
--   every financial consequence other than the configured capture are S11 or counsel-gated (PM rows 14-18, 21-22) and
--   are not implemented. A provider "room ended" observation, or everyone leaving, never changes the Consultation (PM
--   row 19: a brief drop leaves it live; MBS section 14: Daily does not determine canonical completion).
--
-- Media Room (MBS section 14: it exists only when business state permits, exactly one per Consultation; TA section
-- 16.2): created exactly once, pending, when the Consultation enters ready (a trigger on consultations covers S8's
-- instant creation at acceptance, S8's creation deferred to the confirmed capture and S9's scheduled -> ready), with one
-- media.room_create job (S2 job protocol; the provider call happens after commit in the worker, 20261125030000). The
-- provider room name is derived from the Media Room id (media_room_provider_name: "r" and its 32 hexadecimal digits;
-- no column). When the Consultation becomes terminal, by any path, its Media Room moves to closing in the same
-- transaction with one media.room_delete job (deleting the provider room ejects every participant: TA section 46) and
-- one final media.observe job; the delete job's recorded result closes it (20261125030000).
--
-- Media authorization (consultation_media_access; TA section 46: scoped to one Consultation, one participant, one role
-- and one permitted window): EXECUTE for authenticated only. The Consultation's client (an active User, any aal) or its
-- attorney (an approved Attorney Profile of an active User at aal2, through lock_current_attorney_profile); everyone
-- else, an attorney at aal1 and an unknown id answer alike, not_found. In order: the environment record; the caller's
-- own rows (client: lock_current_client; attorney: lock_current_attorney_profile), then the Consultation
-- (consultation_ready_if_due, FOR UPDATE) and its Media Room (FOR SHARE); terminal -> ended; the timing configuration
-- and, in a production-class database, the production gate -> configuration_unavailable; not yet ready or before the
-- window -> not_open_yet (with opens_at); past the window -> ended; ready (the attorney has not started) -> waiting,
-- for both participants, with no grant: the start's checks (eligibility, payment readiness, busy) gate the meeting
-- itself, so an attorney whose start is refused never meets the client in the room (the Media Room is prepared
-- meanwhile); live with the Media Room pending (its creation job is re-enqueued idempotently) -> preparing; live with
-- it open -> granted, audited (role, Consultation, Media Room, not-before and
-- expiry; never a token), answering the provider room name, the participant role and User id, the not-before (the
-- window start) and the expiry: the earlier of now plus 600 seconds (a fixed technical bound, not a policy value) and
-- the window end. The application then asks the provider adapter for one meeting token with exactly these facts; the
-- token is never stored, logged or audited. A reconnect asks again: the same Consultation, the same Media Room.
--
-- consultation_start (EXECUTE for authenticated only; the Consultation's own attorney at aal2). Lock order (the
-- canonical order of S4 to S8: client -> Intake -> Referral -> attorney scheduling lock -> Hold -> Request -> payment;
-- the Consultation and its Media Room sit after the Hold and Request and before the payment): the attorney's own User
-- and Attorney Profile (FOR SHARE) -> the attorney's scheduling lock -> the Request's Hold and the Request
-- (request_expire_if_due, FOR UPDATE) -> the Consultation (FOR UPDATE) -> its Media Room (FOR UPDATE) -> the live
-- payment attempt (FOR UPDATE). payment_request_capture (S7), called inside, takes the same locks in the same order.
-- Checks in order, each refusing with a fixed outcome and nothing changed:
-- 1. state (after consultation_ready_if_due): terminal -> ended; live -> already_started; not ready -> not_ready;
-- 2. the timing configuration and, in a production-class database, the four-way gate for the jurisdiction for the
--    scheduling policy type -> configuration_unavailable;
-- 3. inside the permitted window -> not_open_yet | window_passed;
-- 4. the payment flow (the live attempt's recorded payment_flow version, TA section 63) and the Consultation's
--    engagement version must be readable -> payment_not_ready (no payment) | configuration_unavailable;
-- 5. in a production-class database: no development version and the four-way gate for the jurisdiction for the
--    payment_flow and engagement policy types -> configuration_unavailable;
-- 6. the attorney is not already in another live Consultation (MB sections 32-33 "busy"; serialized by the
--    attorney's scheduling lock, so two simultaneous starts of two ready Consultations cannot both win) ->
--    attorney_in_consultation;
-- 7. payment readiness per the configured capture moment of the Request's path: at_authorization or
--    at_attorney_acceptance need a captured payment; at_consultation_start and at_consultation_completion need an
--    authorized one; any other state (capture pending or failed, refund, chargeback, release, failure) ->
--    payment_not_ready (with the state);
-- 8. a decision-point fresh Eligibility Evaluation, persisted through the S5 recorder (PM INV-12; the practice-area
--    context the client filtered by too): not_eligible keeps the evaluation and one audit event and refuses the
--    start, leaving the Consultation, payment and Engagement unchanged (PM rows 39-41 are counsel-gated; the S8 review
--    routing surfaces the change); undetermined or unevaluable -> eligibility_unavailable with nothing kept;
-- then ready -> live with started_at, the capture requested in the same transaction when the flow captures
-- at_consultation_start (payment_request_capture: the provider call follows commit through the job protocol), Engagement
-- version 1 recorded effective at the start instant only when the governing engagement version says
-- at_consultation_start (decision_record_engagement_if_due, replaced forward: S8 left this moment to S9; an Engagement
-- due at an earlier moment is never backfilled at the start with a past effective time), the provider room's expiry
-- update enqueued when the Media Room is open (a room still pending gets it when its creation is recorded with an
-- expiry other than the window end, 20261125030000), and one audit event with the eligibility, scheduling,
-- payment_flow and engagement policy references.
-- Whether the client must already be connected is not required (runtime presence is not evidence): an owner
-- question. The client can neither start nor end.
--
-- consultation_end (EXECUTE for authenticated only; the Consultation's own attorney at aal2; the same lock order):
-- live -> completed with ended_at and completion reason normal. Ending is protective (it closes media access), so it
-- needs no timing configuration and is accepted whenever the Consultation is live, inside or after its window; in a
-- production-class database the four-way gate is checked only for the payment_flow version and only when the
-- governing flow captures at_consultation_completion (otherwise nothing financial happens at the end). The capture is
-- requested when the flow captures at_consultation_completion (an attempt not in a capturable state is never silently
-- absorbed: a high capture_unavailable_at_completion Reconciliation Exception, PM INV-11); the Media Room to closing
-- (trigger); one audit event. Outcomes: completed, invalid, denied, not_found, not_started, ended, configuration_unavailable,
-- conflict.
--
-- The database-only sweep (consultation_media_sweep, pg_cron where available, as S2, S4 and S6): scheduled ->
-- ready for due Consultations (due is decided without a lock first; each due one is then locked with SKIP LOCKED,
-- busy ones counted and skipped, at most 500 per run, as the S6 sweep does); one media.observe job per open Media
-- Room of a ready or live Consultation whose permitted window has not ended or ended less than 600 seconds ago (a
-- fixed technical grace, not a policy value), newest first, at most 500 (no-shows are S11, so observation must not
-- run forever on stale rooms); and the delete job of a closing Media Room re-enqueued idempotently. Correctness never
-- depends on it: every S9 command and read evaluates the window itself.

-- ---------------------------------------------------------------------------
-- Configuration: the two optional scheduling keys and their approval validation.
-- ---------------------------------------------------------------------------

-- The S9 timing keys of the governing scheduling version for a jurisdiction at an instant: ('selected', version, join
-- window, overrun), the scheduling policy's own refusal, or ('policy_incomplete', version, null, null) when either key is
-- absent or malformed.
create function public.consultation_timing_policy(p_jurisdiction uuid, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, join_window_seconds integer, overrun_seconds integer)
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
  if p_jurisdiction is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::integer, null::integer;
    return;
  end if;
  select p.outcome, p.policy_version_id into v_outcome, v_id
  from public.scheduling_policy('scheduling', p_jurisdiction, p_as_of) as p;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::integer, null::integer;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  if not public.pricing_integer_within(v_raw -> 'consultation_join_window_seconds', 0, 86400)
     or not public.pricing_integer_within(v_raw -> 'consultation_overrun_seconds', 0, 86400) then
    return query select 'policy_incomplete'::text, v_id, null::integer, null::integer;
    return;
  end if;
  return query select
    'selected'::text,
    v_id,
    (v_raw ->> 'consultation_join_window_seconds')::integer,
    (v_raw ->> 'consultation_overrun_seconds')::integer;
end;
$function$;

-- Approval validation (PS section 8.4): the S8 function with the two S9 scheduling keys added (unchanged otherwise): a
-- scheduling version may be approved without them; one carrying either must carry an integer within 0..86400.
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
    when 'engagement' then public.engagement_parameters_valid(p_parameters)
    when 'scheduling' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or (
          (
            not (p_parameters ? 'consultation_join_window_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_join_window_seconds', 0, 86400)
          )
          and (
            not (p_parameters ? 'consultation_overrun_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_overrun_seconds', 0, 86400)
          )
        ),
        false)
    else true
  end;
$function$;

-- ---------------------------------------------------------------------------
-- Internal helpers.
-- ---------------------------------------------------------------------------

-- The provider room name of a Media Room: "r" and the 32 lower-case hexadecimal digits of its id (derived; no column).
create function public.media_room_provider_name(p_media_room_id uuid)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select 'r' || replace(p_media_room_id::text, '-', '');
$function$;

-- The Media Room a provider room name names, or null for any other name.
create function public.media_room_of_provider_name(p_name text)
returns uuid
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_name collate "C" ~ '^r[0-9a-f]{32}$' then
      (substr(p_name, 2, 8) || '-' || substr(p_name, 10, 4) || '-' || substr(p_name, 14, 4) || '-'
       || substr(p_name, 18, 4) || '-' || substr(p_name, 22, 12))::uuid
  end;
$function$;

-- The facts of one Consultation every S9 decision reads: its Request, the Referral's jurisdiction, the participants'
-- User ids, the path, modality and requested duration, its state and times, the confirmed Booking's times, its
-- engagement version and its Media Room.
create function public.consultation_context(p_consultation_id uuid)
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
    where k.consultation_id = c.id and k.status = 'confirmed'
    order by k.created_at, k.id
    limit 1
  ) as b on true
  left join public.media_rooms as m on m.consultation_id = c.id
  where c.id = p_consultation_id;
$function$;

-- The permitted window of a Consultation from its facts and the two timing keys (see the header).
create function public.consultation_window(
  p_path text,
  p_created_at timestamptz,
  p_started_at timestamptz,
  p_duration_minutes integer,
  p_slot_start timestamptz,
  p_slot_end timestamptz,
  p_join_window_seconds integer,
  p_overrun_seconds integer
)
returns table (opens_at timestamptz, closes_at timestamptz)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    case p_path
      when 'scheduled' then p_slot_start - make_interval(secs => p_join_window_seconds)
      when 'instant' then p_created_at
    end,
    case p_path
      when 'scheduled' then p_slot_end + make_interval(secs => p_overrun_seconds)
      when 'instant' then
        coalesce(p_started_at, p_created_at) + make_interval(mins => p_duration_minutes)
        + make_interval(secs => p_overrun_seconds)
    end;
$function$;

-- The timing of one Consultation at an instant: ('selected', scheduling version, opens, closes), the configuration's
-- refusal, ('window_unavailable', version, null, null) without a confirmed Booking or a requested duration, or
-- ('not_found', ...).
create function public.consultation_timing(p_consultation_id uuid, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, opens_at timestamptz, closes_at timestamptz)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_context record;
  v_policy record;
  v_window record;
begin
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  if v_context.consultation_id is null then
    return query select 'not_found'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  select p.* into v_policy from public.consultation_timing_policy(v_context.jurisdiction_id, p_as_of) as p;
  if v_policy.outcome is distinct from 'selected' then
    return query select v_policy.outcome, v_policy.policy_version_id, null::timestamptz, null::timestamptz;
    return;
  end if;
  select w.* into v_window
  from public.consultation_window(
    v_context.request_path, v_context.created_at, v_context.started_at, v_context.duration_minutes,
    v_context.slot_start_at, v_context.slot_end_at, v_policy.join_window_seconds, v_policy.overrun_seconds
  ) as w;
  if v_window.opens_at is null or v_window.closes_at is null then
    return query select 'window_unavailable'::text, v_policy.policy_version_id, null::timestamptz, null::timestamptz;
    return;
  end if;
  return query select 'selected'::text, v_policy.policy_version_id, v_window.opens_at, v_window.closes_at;
end;
$function$;

-- The four-way production gate for the media decisions (MBS section 19; TA section 32 F1-F2): null when the database
-- is not production-class or every listed version passes; otherwise development_policy (a development-only version)
-- or production_gate_closed (the gate does not hold for that policy type in the jurisdiction now). p_checks is an array
-- of {policy_type_code, policy_version_id, regulatory_mode_id}.
create function public.media_production_problem(p_jurisdiction uuid, p_checks jsonb, p_as_of timestamptz)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_check jsonb;
  v_development boolean;
  v_gate record;
begin
  if public.rosuno_environment_class() is distinct from 'production' then
    return null;
  end if;
  for v_check in select x from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) as x loop
    select v.development_only into v_development
    from public.policy_versions as v
    where v.id = (v_check ->> 'policy_version_id')::uuid;
    if v_development is distinct from false then
      return 'development_policy';
    end if;
    select g.permitted, g.reason into v_gate
    from public.production_financial_gate(
      p_jurisdiction, v_check ->> 'policy_type_code', (v_check ->> 'regulatory_mode_id')::uuid, p_as_of
    ) as g;
    if v_gate.permitted is distinct from true then
      return 'production_gate_closed';
    end if;
  end loop;
  return null;
end;
$function$;

-- scheduled -> ready when due (see the header). Locks the Consultation (FOR UPDATE; with p_skip_busy, only once it is
-- due, SKIP LOCKED, answering busy). Answers the state after the call, or null for an unknown Consultation.
create function public.consultation_ready_if_due(p_consultation_id uuid, p_skip_busy boolean default false)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_consultation public.consultations;
  v_state text;
  v_timing record;
  v_jurisdiction uuid;
  v_now timestamptz;
begin
  if coalesce(p_skip_busy, false) then
    -- The sweep: whether the Consultation is due is decided first without a lock, so a Consultation that is not due
    -- is never locked; a due one is locked with SKIP LOCKED (busy when another transaction holds it) and decided again.
    select c.state into v_state from public.consultations as c where c.id = p_consultation_id;
    if not found then
      return null;
    end if;
    if v_state is distinct from 'scheduled' then
      return v_state;
    end if;
    v_now := clock_timestamp();
    select t.* into v_timing from public.consultation_timing(p_consultation_id, v_now) as t;
    if v_timing.outcome is distinct from 'selected'
       or not (v_timing.opens_at <= v_now and v_now < v_timing.closes_at) then
      return 'scheduled';
    end if;
    select c.* into v_consultation from public.consultations as c where c.id = p_consultation_id for update skip locked;
    if not found then
      return 'busy';
    end if;
  else
    select c.* into v_consultation from public.consultations as c where c.id = p_consultation_id for update;
    if not found then
      return null;
    end if;
  end if;
  if v_consultation.state is distinct from 'scheduled' then
    return v_consultation.state;
  end if;
  v_now := clock_timestamp();
  select t.* into v_timing from public.consultation_timing(p_consultation_id, v_now) as t;
  if v_timing.outcome is distinct from 'selected'
     or not (v_timing.opens_at <= v_now and v_now < v_timing.closes_at) then
    return 'scheduled';
  end if;
  select f.jurisdiction_id into v_jurisdiction
  from public.consultation_requests as r
  join public.referrals as f on f.id = r.referral_id
  where r.id = v_consultation.consultation_request_id;
  if public.media_production_problem(
       v_jurisdiction,
       jsonb_build_array(jsonb_build_object(
         'policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id, 'regulatory_mode_id', null
       )),
       v_now
     ) is not null then
    return 'scheduled';
  end if;
  update public.consultations as c set state = 'ready' where c.id = p_consultation_id;
  perform public.decision_audit(
    null, 'system', 'consultation.ready', 'consultation', p_consultation_id,
    jsonb_build_object('state', 'scheduled'),
    jsonb_build_object('state', 'ready', 'opens_at', v_timing.opens_at, 'closes_at', v_timing.closes_at),
    'join_window_open',
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id)
    ),
    v_jurisdiction
  );
  return 'ready';
end;
$function$;

-- The Media Room lifecycle (trigger on consultations): entering ready creates the one Media Room (pending) with its
-- creation job; becoming terminal moves it to closing with its delete job and one final observation job. Audited as
-- system actions.
create function public.consultation_media_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_room public.media_rooms;
  v_id uuid;
  v_jurisdiction uuid;
begin
  select f.jurisdiction_id into v_jurisdiction
  from public.consultation_requests as r
  join public.referrals as f on f.id = r.referral_id
  where r.id = new.consultation_request_id;
  if new.state = 'ready' then
    insert into public.media_rooms (consultation_id, modality, state)
    values (new.id, new.modality, 'pending')
    on conflict (consultation_id) do nothing
    returning id into v_id;
    if v_id is not null then
      perform public.job_enqueue('media.room_create', 'media_room', v_id, clock_timestamp(), 8);
      perform public.decision_audit(
        null, 'system', 'media_room.created', 'media_room', v_id,
        null,
        jsonb_build_object('consultation_id', new.id, 'state', 'pending', 'modality', new.modality),
        'consultation_ready', null, v_jurisdiction
      );
    end if;
  elsif new.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    select m.* into v_room from public.media_rooms as m where m.consultation_id = new.id for update;
    if v_room.id is not null and v_room.state in ('pending', 'open') then
      update public.media_rooms as m set state = 'closing' where m.id = v_room.id;
      perform public.job_enqueue('media.room_delete', 'media_room', v_room.id, clock_timestamp(), 8);
      perform public.job_enqueue('media.observe', 'media_room', v_room.id, clock_timestamp(), 3);
      perform public.decision_audit(
        null, 'system', 'media_room.closing', 'media_room', v_room.id,
        jsonb_build_object('state', v_room.state),
        jsonb_build_object('state', 'closing', 'consultation_id', new.id, 'consultation_state', new.state),
        'consultation_' || new.state, null, v_jurisdiction
      );
    end if;
  end if;
  return null;
end;
$function$;

create trigger consultations_media_lifecycle
after update of state on public.consultations
for each row
when (
  old.state is distinct from new.state
  and new.state in ('ready', 'completed', 'cancelled', 'no_show', 'technical_failure')
)
execute function public.consultation_media_lifecycle();

-- Records Engagement version 1 of a Consultation, effective, when its configured G-1 moment has been reached
-- (at_request: the Request's creation; at_attorney_acceptance: the acceptance; at_payment_capture: the confirmed
-- capture, when p_captured_at is given; MVP-001 S9: at_consultation_start: the Consultation's recorded start, so
-- nothing before it starts), with one system audit event. Answers the Engagement id, or null when none is due or one
-- already exists. (The S8 function replaced forward under its own signature; every S8 call passes a Consultation
-- that has not started, so S8 behaviour is unchanged.)
create or replace function public.decision_record_engagement_if_due(
  p_consultation public.consultations,
  p_parameters jsonb,
  p_request public.consultation_requests,
  p_captured_at timestamptz,
  p_jurisdiction uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_moment timestamptz;
  v_id uuid;
begin
  if p_consultation.id is null
     or p_consultation.engagement_policy_version_id is null
     or exists (select 1 from public.engagements as g where g.consultation_id = p_consultation.id) then
    return null;
  end if;
  v_moment := case p_parameters ->> 'engagement_effective'
    when 'at_request' then p_request.created_at
    when 'at_attorney_acceptance' then p_request.accepted_at
    when 'at_payment_capture' then p_captured_at
    when 'at_consultation_start' then p_consultation.started_at
  end;
  if v_moment is null then
    return null;
  end if;
  insert into public.engagements (
    consultation_id, engagement_policy_version_id, version_number, state, effective_at
  ) values (
    p_consultation.id, p_consultation.engagement_policy_version_id, 1, 'effective', v_moment
  )
  returning id into v_id;
  perform public.decision_audit(
    null, 'system', 'engagement.effective', 'engagement', v_id,
    null,
    jsonb_build_object(
      'consultation_id', p_consultation.id,
      'version_number', 1,
      'state', 'effective',
      'effective_at', v_moment
    ),
    p_parameters ->> 'engagement_effective',
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'engagement', 'policy_version_id', p_consultation.engagement_policy_version_id)
    ),
    p_jurisdiction
  );
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Media authorization (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.consultation_media_access(p_consultation_id uuid)
returns table (
  outcome text,
  room_name text,
  participant_role text,
  participant_user_id uuid,
  not_before timestamptz,
  expires_at timestamptz,
  opens_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_locked uuid;
  v_context record;
  v_profile public.attorney_profiles;
  v_role text;
  v_room public.media_rooms;
  v_timing record;
  v_now timestamptz;
  v_expires timestamptz;
begin
  if p_consultation_id is null then
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  if public.rosuno_environment_status() <> 'ok' then
    return query select 'configuration_unavailable'::text, null::text, null::text, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  select u.id into v_user
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  if v_user is null or v_context.consultation_id is null then
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  -- The caller's own rows first (the canonical order starts with the participant), then the Consultation.
  if v_user = v_context.client_user_id then
    select l.user_id into v_locked from public.lock_current_client() as l;
    if v_locked is distinct from v_user then
      return query select 'not_found'::text, null::text, null::text, null::uuid, null::timestamptz,
        null::timestamptz, null::timestamptz;
      return;
    end if;
    v_role := 'client';
  elsif v_user = v_context.attorney_user_id then
    v_profile := public.lock_current_attorney_profile(false);
    if v_profile.id is distinct from v_context.attorney_id then
      return query select 'not_found'::text, null::text, null::text, null::uuid, null::timestamptz,
        null::timestamptz, null::timestamptz;
      return;
    end if;
    if v_profile.profile_state is distinct from 'approved' then
      return query select 'denied'::text, null::text, null::text, null::uuid, null::timestamptz, null::timestamptz,
        null::timestamptz;
      return;
    end if;
    v_role := 'attorney';
  else
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  perform public.consultation_ready_if_due(p_consultation_id, false);
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  select m.* into v_room from public.media_rooms as m where m.consultation_id = p_consultation_id for share;
  if v_context.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return query select 'ended'::text, null::text, v_role, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  v_now := clock_timestamp();
  select t.* into v_timing from public.consultation_timing(p_consultation_id, v_now) as t;
  if v_timing.outcome is distinct from 'selected'
     or public.media_production_problem(
          v_context.jurisdiction_id,
          jsonb_build_array(jsonb_build_object(
            'policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id, 'regulatory_mode_id', null
          )),
          v_now
        ) is not null then
    return query select 'configuration_unavailable'::text, null::text, v_role, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_context.state not in ('ready', 'live') or v_now < v_timing.opens_at then
    return query select 'not_open_yet'::text, null::text, v_role, null::uuid, null::timestamptz, null::timestamptz,
      v_timing.opens_at;
    return;
  end if;
  if v_now >= v_timing.closes_at then
    return query select 'ended'::text, null::text, v_role, null::uuid, null::timestamptz, null::timestamptz,
      v_timing.opens_at;
    return;
  end if;
  if v_context.state = 'ready' then
    -- The waiting room: nothing is granted to either participant until the attorney's start has passed its checks
    -- (eligibility, payment readiness, busy), so an attorney whose start is refused never meets the client in the
    -- room. The Media Room is prepared meanwhile (its creation job re-enqueued idempotently while it is pending).
    if v_room.id is not null and v_room.state = 'pending' then
      perform public.job_enqueue('media.room_create', 'media_room', v_room.id, v_now, 8);
    end if;
    return query select 'waiting'::text, null::text, v_role, null::uuid, null::timestamptz, null::timestamptz,
      v_timing.opens_at;
    return;
  end if;
  if v_room.id is null or v_room.state = 'pending' then
    if v_room.id is not null then
      perform public.job_enqueue('media.room_create', 'media_room', v_room.id, v_now, 8);
    end if;
    return query select 'preparing'::text, null::text, v_role, null::uuid, null::timestamptz, null::timestamptz,
      v_timing.opens_at;
    return;
  end if;
  if v_room.state is distinct from 'open' then
    return query select 'ended'::text, null::text, v_role, null::uuid, null::timestamptz, null::timestamptz,
      v_timing.opens_at;
    return;
  end if;
  v_expires := least(v_now + interval '600 seconds', v_timing.closes_at);
  perform public.decision_audit(
    v_user, v_role, 'consultation.media_access_granted', 'consultation', p_consultation_id,
    null,
    jsonb_build_object(
      'participant_role', v_role,
      'media_room_id', v_room.id,
      'consultation_state', v_context.state,
      'not_before', v_timing.opens_at,
      'expires_at', v_expires
    ),
    'media_access',
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id)
    ),
    v_context.jurisdiction_id
  );
  return query select
    'granted'::text,
    public.media_room_provider_name(v_room.id),
    v_role,
    v_user,
    v_timing.opens_at,
    v_expires,
    v_timing.opens_at;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The attorney's start and end (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.consultation_start(p_consultation_id uuid)
returns table (outcome text, problem text, started_at timestamptz)
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
  v_latest_state text;
  v_jurisdiction uuid;
  v_now timestamptz;
  v_timing record;
  v_flow jsonb;
  v_capture text;
  v_engagement jsonb;
  v_problem text;
  v_area uuid;
  v_evaluation uuid;
  v_area_evaluation uuid;
  v_result text;
  v_policy_references jsonb;
  v_capture_answer text;
  v_engagement_id uuid;
  v_outcome text;
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
  -- Lock order: the attorney's scheduling lock, the Hold and the Request, the Consultation, its Media Room, the payment.
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
  if v_payment.id is null then
    select pt.state into v_latest_state
    from public.payment_transactions as pt
    where pt.consultation_request_id = v_request_id
    order by pt.created_at desc, pt.id desc
    limit 1;
  end if;
  select r.* into v_request from public.consultation_requests as r where r.id = v_request_id;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;

  -- 1. State.
  if v_consultation.state in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return query select 'ended'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  if v_consultation.state = 'live' then
    return query select 'already_started'::text, null::text, v_consultation.started_at;
    return;
  end if;
  if v_consultation.state is distinct from 'ready' then
    return query select 'not_ready'::text, v_consultation.state, null::timestamptz;
    return;
  end if;
  -- 2. The timing configuration; 3. the permitted window.
  v_now := clock_timestamp();
  select t.* into v_timing from public.consultation_timing(p_consultation_id, v_now) as t;
  if v_timing.outcome is distinct from 'selected' then
    return query select 'configuration_unavailable'::text,
      case
        when v_timing.outcome like 'environment_%' then v_timing.outcome
        else 'timing_' || coalesce(v_timing.outcome, 'no_applicable_policy')
      end,
      null::timestamptz;
    return;
  end if;
  v_problem := public.media_production_problem(
    v_jurisdiction,
    jsonb_build_array(jsonb_build_object(
      'policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id, 'regulatory_mode_id', null
    )),
    v_now
  );
  if v_problem is not null then
    return query select 'configuration_unavailable'::text, v_problem, null::timestamptz;
    return;
  end if;
  if v_now < v_timing.opens_at then
    return query select 'not_open_yet'::text, null::text, null::timestamptz;
    return;
  end if;
  if v_now >= v_timing.closes_at then
    return query select 'window_passed'::text, null::text, null::timestamptz;
    return;
  end if;
  -- 4. The payment flow (the live attempt's recorded version, TA section 63) and the engagement version.
  if v_payment.id is null then
    return query select 'payment_not_ready'::text, coalesce(v_latest_state, 'no_payment'), null::timestamptz;
    return;
  end if;
  select v.parameters into v_flow from public.policy_versions as v where v.id = v_payment.payment_flow_policy_version_id;
  if not public.payment_flow_parameters_valid(v_flow) then
    return query select 'configuration_unavailable'::text, 'payment_flow_policy_incomplete'::text, null::timestamptz;
    return;
  end if;
  v_capture := v_flow -> v_consultation.request_path ->> 'capture';
  if v_consultation.engagement_policy_version_id is not null then
    v_engagement := public.decision_engagement_parameters(v_consultation.engagement_policy_version_id);
    if v_engagement is null then
      return query select 'configuration_unavailable'::text, 'engagement_policy_incomplete'::text, null::timestamptz;
      return;
    end if;
  end if;
  -- 5. The four-way production gate for the payment_flow and engagement versions (production-class databases only;
  -- the scheduling version passed it with the timing configuration).
  v_problem := public.media_production_problem(
    v_jurisdiction,
    jsonb_build_array(
      jsonb_build_object(
        'policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id,
        'regulatory_mode_id', v_payment.regulatory_mode_id
      )
    ) || case
      when v_consultation.engagement_policy_version_id is null then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object(
        'policy_type_code', 'engagement', 'policy_version_id', v_consultation.engagement_policy_version_id,
        'regulatory_mode_id', v_payment.regulatory_mode_id
      ))
    end,
    v_now
  );
  if v_problem is not null then
    return query select 'configuration_unavailable'::text, v_problem, null::timestamptz;
    return;
  end if;
  -- 6. Not already in another Consultation (MB sections 32-33).
  if exists (
    select 1
    from public.consultations as c
    where c.attorney_id = v_profile.id
      and c.state = 'live'
      and c.id <> p_consultation_id
  ) then
    return query select 'attorney_in_consultation'::text, null::text, null::timestamptz;
    return;
  end if;
  -- 7. Payment readiness per the configured capture moment.
  if not (
    (v_capture in ('at_authorization', 'at_attorney_acceptance') and v_payment.state = 'captured')
    or (v_capture in ('at_consultation_start', 'at_consultation_completion') and v_payment.state = 'authorized')
  ) then
    return query select 'payment_not_ready'::text, v_payment.state, null::timestamptz;
    return;
  end if;
  select case
    when p.client_filter_context ->> 'practice_area_id'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (p.client_filter_context ->> 'practice_area_id')::uuid
  end
  into v_area
  from public.referral_presentations as p
  where p.referral_id = v_request.referral_id
    and p.attorney_id = v_request.selected_attorney_id
  limit 1;

  begin
    -- 8. The decision-point Eligibility Evaluation, persisted (PM INV-12).
    select d.evaluation_id, d.result into v_evaluation, v_result
    from public.eligibility_record_decision_point(v_profile.id, v_jurisdiction, null, v_now) as d;
    if v_evaluation is null then
      raise exception 'eligibility unavailable' using errcode = 'RS902';
    end if;
    if v_result = 'eligible' and v_area is not null then
      select d.evaluation_id, d.result into v_area_evaluation, v_result
      from public.eligibility_record_decision_point(v_profile.id, v_jurisdiction, v_area, v_now) as d;
      if v_area_evaluation is null then
        raise exception 'eligibility unavailable' using errcode = 'RS902';
      end if;
      v_evaluation := v_area_evaluation;
    end if;
    if v_result is distinct from 'eligible' and v_result is distinct from 'not_eligible' then
      raise exception 'eligibility undetermined' using errcode = 'RS902';
    end if;
    select case when jsonb_typeof(e.policy_references) = 'array' then e.policy_references else '[]'::jsonb end
    into v_policy_references
    from public.eligibility_evaluations as e
    where e.id = v_evaluation;
    v_policy_references := coalesce(v_policy_references, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id),
      jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', v_payment.payment_flow_policy_version_id),
      jsonb_build_object('policy_type_code', 'engagement', 'policy_version_id', v_consultation.engagement_policy_version_id)
    );
    if v_result = 'not_eligible' then
      perform public.decision_audit(
        v_profile.user_id, 'attorney', 'consultation.start_refused', 'consultation', p_consultation_id,
        jsonb_build_object('state', v_consultation.state),
        jsonb_build_object(
          'state', v_consultation.state,
          'eligibility_evaluation_id', v_evaluation,
          'eligibility_result', v_result
        ),
        'attorney_not_eligible', v_policy_references, v_jurisdiction
      );
      v_outcome := 'not_eligible';
    else
      update public.consultations as c
      set state = 'live',
          started_at = clock_timestamp()
      where c.id = p_consultation_id
      returning c.* into v_consultation;
      if v_capture = 'at_consultation_start' then
        v_capture_answer := public.payment_request_capture(v_payment.id);
        if v_capture_answer is distinct from 'capture_requested' then
          raise exception 'the capture could not be requested' using errcode = 'RS901';
        end if;
      end if;
      -- Only an Engagement whose governing version takes effect at the start is recorded here, effective at the start
      -- instant; an Engagement due at an earlier moment (at_request, at_attorney_acceptance, at_payment_capture) is
      -- never backfilled at the start with a past effective time.
      if v_engagement ->> 'engagement_effective' = 'at_consultation_start' then
        v_engagement_id := public.decision_record_engagement_if_due(
          v_consultation, v_engagement, v_request, null, v_jurisdiction
        );
      end if;
      if v_room.state = 'open' then
        perform public.job_enqueue('media.room_update', 'media_room', v_room.id, clock_timestamp(), 8);
      end if;
      select pt.* into v_payment from public.payment_transactions as pt where pt.id = v_payment.id;
      perform public.decision_audit(
        v_profile.user_id, 'attorney', 'consultation.started', 'consultation', p_consultation_id,
        jsonb_build_object('state', 'ready'),
        jsonb_build_object(
          'state', 'live',
          'started_at', v_consultation.started_at,
          'eligibility_evaluation_id', v_evaluation,
          'payment_transaction_id', v_payment.id,
          'payment_state', v_payment.state,
          'capture_timing', v_capture,
          'capture_requested', v_capture_answer is not null,
          'engagement_id', v_engagement_id,
          'engagement_effective', v_engagement ->> 'engagement_effective',
          'media_room_id', v_room.id
        ),
        'attorney_started', v_policy_references, v_jurisdiction
      );
      v_outcome := 'started';
    end if;
  exception
    when sqlstate 'RS901' then
      return query select 'conflict'::text, null::text, null::timestamptz;
      return;
    when sqlstate 'RS902' then
      return query select 'eligibility_unavailable'::text, null::text, null::timestamptz;
      return;
  end;
  return query select
    v_outcome,
    case when v_outcome = 'not_eligible' then v_result end,
    case when v_outcome = 'started' then v_consultation.started_at end;
end;
$function$;

create function public.consultation_end(p_consultation_id uuid)
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
-- The database-only sweep (owner only; pg_cron where available).
-- ---------------------------------------------------------------------------

create function public.consultation_media_sweep()
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
  v_now timestamptz := clock_timestamp();
  v_ready integer := 0;
  v_busy integer := 0;
  v_observe integer := 0;
  v_delete integer := 0;
begin
  -- Due scheduled Consultations, decided without a lock (the keys' own 86400-second bounds as a cheap prefilter, then
  -- the exact window); each is then locked with SKIP LOCKED and decided again (consultation_ready_if_due), so the sweep
  -- never locks a Consultation that is not due and never waits for a busy one.
  for v_id in
    select c.id
    from public.consultations as c
    join public.bookings as k on k.consultation_id = c.id and k.status = 'confirmed'
    cross join lateral public.consultation_timing(c.id, v_now) as t
    where c.state = 'scheduled'
      and k.starts_at <= v_now + interval '86400 seconds'
      and k.ends_at + interval '86400 seconds' > v_now
      and t.outcome = 'selected'
      and t.opens_at <= v_now
      and v_now < t.closes_at
    order by k.starts_at, c.id
    limit 500
  loop
    v_answer := public.consultation_ready_if_due(v_id, true);
    if v_answer = 'ready' then
      v_ready := v_ready + 1;
    elsif v_answer = 'busy' then
      v_busy := v_busy + 1;
    end if;
  end loop;
  -- Observation is bounded (no-shows are S11, so a ready Consultation's room may stay open): only open rooms whose
  -- permitted window has not ended, or ended less than 600 seconds ago (a fixed technical grace so the last
  -- participation is still read; not a policy value), newest first. The prefilter is the window's upper bound under
  -- the keys' own 86400-second overrun bound.
  for v_id in
    select m.id
    from public.media_rooms as m
    join public.consultations as c on c.id = m.consultation_id
    join public.consultation_requests as r on r.id = c.consultation_request_id
    left join public.bookings as k on k.consultation_id = c.id and k.status = 'confirmed'
    cross join lateral public.consultation_timing(c.id, v_now) as t
    where m.state = 'open'
      and c.state in ('ready', 'live')
      and case c.request_path
        when 'scheduled' then k.ends_at
        else coalesce(c.started_at, c.created_at) + make_interval(mins => coalesce(r.requested_duration_minutes, 0))
      end + interval '87000 seconds' > v_now
      and t.outcome = 'selected'
      and t.closes_at + interval '600 seconds' > v_now
    order by m.created_at desc, m.id desc
    limit 500
  loop
    perform public.job_enqueue('media.observe', 'media_room', v_id, clock_timestamp(), 3);
    v_observe := v_observe + 1;
  end loop;
  for v_id in
    select m.id
    from public.media_rooms as m
    where m.state = 'closing'
    order by m.created_at, m.id
    limit 500
  loop
    perform public.job_enqueue('media.room_delete', 'media_room', v_id, clock_timestamp(), 8);
    v_delete := v_delete + 1;
  end loop;
  return jsonb_build_object('ready', v_ready, 'busy', v_busy, 'observe', v_observe, 'delete', v_delete);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.consultation_timing_policy(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.policy_parameters_approvable(text, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.media_room_provider_name(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.media_room_of_provider_name(text)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_context(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_window(text, timestamptz, timestamptz, integer, timestamptz, timestamptz, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_timing(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.media_production_problem(uuid, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_ready_if_due(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_media_lifecycle()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_record_engagement_if_due(
  public.consultations, jsonb, public.consultation_requests, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.consultation_media_sweep()
  from public, anon, authenticated, service_role;

revoke all on function public.consultation_media_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.consultation_media_access(uuid) to authenticated;
revoke all on function public.consultation_start(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.consultation_start(uuid) to authenticated;
revoke all on function public.consultation_end(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.consultation_end(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.consultation_timing_policy(uuid, timestamptz) is
  'MVP-001 S9 (internal): the consultation_join_window_seconds and consultation_overrun_seconds keys (0..86400 each) of the scheduling version selected for a jurisdiction, or the scheduling policy''s refusal, or policy_incomplete. No default.';
comment on function public.policy_parameters_approvable(text, uuid, jsonb) is
  'MVP-001 S6 PS-A3 (internal; MVP-001 S7: payment_flow; MVP-001 S8: engagement; MVP-001 S9: scheduling): whether parameters may be approved: fee versions match their scope''s schema, referral versions carry a well-formed message maximum or none, payment_flow and engagement versions match their schemas, and scheduling versions carry well-formed S9 timing keys (0..86400) or none; other types are not checked here.';
comment on function public.media_room_provider_name(uuid) is
  'MVP-001 S9 (internal): the provider room name of a Media Room ("r" and the 32 hexadecimal digits of its id).';
comment on function public.media_room_of_provider_name(text) is
  'MVP-001 S9 (internal): the Media Room id a provider room name names, or null.';
comment on function public.consultation_context(uuid) is
  'MVP-001 S9 (internal): the facts of one Consultation the S9 decisions read (Request, jurisdiction, participants, path, duration, state and times, confirmed Booking, engagement version, Media Room).';
comment on function public.consultation_window(text, timestamptz, timestamptz, integer, timestamptz, timestamptz, integer, integer) is
  'MVP-001 S9 (internal): the permitted window of a Consultation (scheduled: Booking start minus the join window to the Booking end plus the overrun, started or not; instant: creation to the start or creation plus the duration plus the overrun).';
comment on function public.consultation_timing(uuid, timestamptz) is
  'MVP-001 S9 (internal): the governing scheduling version and the permitted window of a Consultation at an instant, or the configuration''s refusal.';
comment on function public.media_production_problem(uuid, jsonb, timestamptz) is
  'MVP-001 S9 (internal): in a production-class database, development_policy or production_gate_closed for the first listed version that fails the four-way gate; null otherwise.';
comment on function public.consultation_ready_if_due(uuid, boolean) is
  'MVP-001 S9 (internal): moves a scheduled Consultation to ready once its window has opened (and while it is open) with the timing configuration present and, in production, the gate holding; audited. With p_skip_busy (the sweep) it locks only a due Consultation, SKIP LOCKED. Answers the state after the call, busy, or null.';
comment on function public.consultation_media_lifecycle() is
  'MVP-001 S9 (trigger): a Consultation entering ready gets its one Media Room (pending) and the creation job; a terminal Consultation''s Media Room moves to closing with the delete job and a final observation job; audited.';
comment on function public.decision_record_engagement_if_due(public.consultations, jsonb, public.consultation_requests, timestamptz, uuid) is
  'MVP-001 S8 (internal; MVP-001 S9: at_consultation_start at the recorded start): records Engagement version 1, effective, when the configured G-1 moment has been reached (at_request, at_attorney_acceptance, at_payment_capture once confirmed, at_consultation_start once started), audited; otherwise nothing.';
comment on function public.consultation_media_access(uuid) is
  'MVP-001 S9: media authorization for the Consultation''s own client (any aal) or attorney (approved, aal2): granted only while live (provider room name, role, User id, not-before, expiry at most 600 seconds and never past the window), waiting while ready (no grant before the start), preparing, not_open_yet, ended, configuration_unavailable, denied, or not_found for everyone else alike; audited without any token.';
comment on function public.consultation_start(uuid) is
  'MVP-001 S9: the attorney starts one of their own ready Consultations inside its window after the configuration, production gate, busy, payment readiness and fresh persisted eligibility checks; live with started_at, the configured capture, an Engagement only when it takes effect at_consultation_start (never a backfill) and the room expiry update; audited. Outcomes: started, invalid, denied, not_found, ended, already_started, not_ready, configuration_unavailable, not_open_yet, window_passed, attorney_in_consultation, payment_not_ready, not_eligible, eligibility_unavailable, conflict.';
comment on function public.consultation_end(uuid) is
  'MVP-001 S9: the attorney declares normal completion of one of their own live Consultations (completed, completion reason normal, PM row 20); no timing configuration needed; the production gate (payment_flow) only when the flow captures at completion; the configured capture at completion; the Media Room closes; audited. Outcomes: completed, invalid, denied, not_found, not_started, ended, configuration_unavailable, conflict.';
comment on function public.consultation_media_sweep() is
  'MVP-001 S9 (internal): the database-only sweep: due scheduled Consultations to ready (due decided before locking, SKIP LOCKED, busy counted, at most 500), one observation job per open Media Room of a ready or live Consultation whose window has not ended or ended less than 600 seconds ago (newest first, at most 500), delete jobs of closing Media Rooms re-enqueued idempotently.';

-- ---------------------------------------------------------------------------
-- The database-only schedule (same pattern as 20261122030000).
-- ---------------------------------------------------------------------------

do $scheduler$
begin
  if not exists (
    select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice 'pg_cron is not available: no schedule registered (commands and reads still evaluate consultation timing)';
    return;
  end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute $unschedule$
    select cron.unschedule(j.jobid)
    from cron.job as j
    where j.jobname = 'rosuno_consultation_media_sweep'
  $unschedule$;
  execute $schedule$
    select cron.schedule(
      'rosuno_consultation_media_sweep',
      '* * * * *',
      'select public.consultation_media_sweep();'
    )
  $schedule$;
end;
$scheduler$;
