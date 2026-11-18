-- MVP-001 S8 (2 of 3): the attorney decision boundary: request queue and detail, acceptance with mandatory
-- revalidation, decline, Booking and Hold conversion, the configured payment and Engagement transitions, Consultation
-- creation per the G-5 configuration, and the client's view of the outcome (MVP-001 Packet S8 capability list; MBS
-- section 13 objective, mandatory acceptance revalidation, technical-complete configuration, deliverables, state rules,
-- side-effect rule and failure tests; IMP sections 11 and 24; TA sections 6, 7, 13, 14, 55, 60 and 63; PS sections 17
-- and 36; DM sections 2.4-2.7, 9 and 10; PM sections 1-4 (INV-1, INV-4, INV-6, INV-7, INV-8, INV-9, INV-11, INV-12,
-- INV-14; rows 1-10, 26, 27, 37 and 38); FP-1 sections 8-10; Packet section 3 gate "intake visibility to an attorney
-- before acceptance: nothing shown").
--
-- No relation, column or policy type is added (Packet rules 8 and 16); nothing settles G-1 to G-5, a refund or
-- cancellation entitlement, a referral outcome code or any legal text. Every value comes from configuration and unset
-- configuration fails closed.
--
-- Configuration seam (G-5 and G-1; PM section 2; DM sections 2.4 and 9; FP-1 sections 9-10): the engagement policy
-- version that governs a Request holds exactly
--   {"consultation_creation": C, "engagement_effective": E}
-- with C in attorney_acceptance | attorney_acceptance_and_payment_authorized | attorney_acceptance_and_payment_captured
-- | attorney_acceptance_and_engagement_effective (G-5: the Consultation is created at the attorney's acceptance alone,
-- or only once an authorized payment, a captured payment or an effective Engagement also exists) and E in at_request |
-- at_attorney_acceptance | at_payment_capture | at_consultation_start (G-1, the four moments PM section 2 lists).
-- Readers validate it (engagement_parameters_valid; anything else is policy_incomplete) and staff approval validates it
-- (policy_parameters_approvable replaced forward, PS section 8.4). No value is a default. The governing version is the
-- one the Request already records, else the one its live payment attempt recorded (TA section 63: a newly active
-- policy never applies retroactively to a transaction), else the one the environment-anchored resolver selects for the
-- Request's jurisdiction and its single active Regulatory Mode now (as S7 selects it); the acceptance records it on the
-- Request (set once) unless an earlier payment attempt recorded another version, and on the Consultation.
--
-- attorney_accept_request (EXECUTE for authenticated only; the caller's own approved Attorney Profile at aal2 through
-- lock_current_attorney_profile; another attorney's Request, an unknown id and a Request never offered to the attorney
-- answer alike, not_found). Lock order (the S6/S7 canonical order; the ids are derived first): the attorney's own User
-- and Attorney Profile (FOR SHARE, as every attorney command and the eligibility recorder take them) -> the attorney's
-- scheduling lock -> the Request's expiry (S6: Hold, then Request) -> the Hold and the Request (FOR UPDATE) -> the live
-- payment attempt (FOR UPDATE). Client, Intake and Referral rows are never locked here: acceptance changes none of
-- them. In order (TA section 60 rejection list):
-- 1. expiry is evaluated first (request_expire_if_due); expired, withdrawn (cancelled) and already decided Requests
--    answer expired, withdrawn and already_decided (with the state), the deterministic losers of every race; nothing
--    changes;
-- 2. configuration: the payment flow (the live attempt's recorded payment_flow version, else the one selected now),
--    the governing engagement version and its parameters; in a production-class database the engagement and flow
--    versions the decision uses (recorded or freshly selected) must not be development configuration, and the
--    four-way production gate must hold for the Request's jurisdiction now for both policy types, because the
--    acceptance can request a capture and creates the Consultation (MBS section 19; TA section 32 F2: a jurisdiction
--    that stopped being live, or whose launch authorization was revoked, after the payment was authorized is refused
--    here; the jurisdiction change itself is routed to review by 20261124030000). Missing, conflicting or malformed,
--    or the gate closed: configuration_unavailable with the missing piece, and nothing changes;
-- 3. payment readiness: with authorization before the attorney decision the live attempt must be authorized (or, with
--    capture at_authorization, capture_pending or captured); otherwise payment_not_ready and nothing changes;
-- 4. G-5 satisfiability: a creation condition that can never hold at or after this decision for this path (an
--    Engagement effective only at consultation start; an authorization that only follows acceptance; for a scheduled
--    Request any capture that is not already confirmed, because its Hold must become a Booking, which needs the
--    Consultation, in this transaction: DM section 2.7, MBS section 9 invariant 4) answers configuration_unavailable
--    (consultation_creation_unsatisfiable); a scheduled capture still pending answers payment_not_ready;
-- 5. mandatory revalidation (MBS section 13; TA section 55; PM INV-12), in one exception-guarded block: a fresh
--    Eligibility Evaluation (S5 recorder; jurisdiction context, and the practice-area context the client filtered by)
--    and, when eligible, a fresh Bookability Evaluation (instant: S4 with no slot: eligibility, Instant intent, Presence,
--    not in a Consultation; scheduled: eligibility and the held slot: the scheduling policy, the Request's own Hold
--    still active, inside an availability window, no Blackout, no confirmed Booking and no other active Hold; the
--    minimum-notice rule governs new requests only, the Hold's own server expiry bounds the decision, DM section 8),
--    both persisted as new decision-point records;
--    - not eligible (PM row 38, settled; the engine's result not_eligible only): the Request cannot proceed: it ends
--      cancelled (system actor, reason attorney_not_eligible), its Hold is released after the state change and the S7
--      release trigger releases any authorization (captured funds take S7's critical funds_retained_after_request_end
--      path); not_eligible;
--    - the eligibility could not be evaluated (the recorder refused) or could not be determined (the engine's result
--      undetermined: no applicable or conflicting eligibility policy, unverified authority, unreadable parameters or
--      facts, an undetermined Regulatory Mode): a configuration or data gap is never treated as the attorney being
--      not eligible; eligibility_unavailable, the block is rolled back (no evaluation or audit event is kept) and
--      nothing changes (fail closed; the Request still awaits and expires at its server deadline);
--    - not bookable (MBS section 13 failure test "acceptance after bookability changes is revalidated"): the
--      acceptance is refused with the first failed factor's reason, the evaluations and one audit event stay, and the
--      Request is unchanged (the attorney may decline; the Request expires at its server deadline);
-- 6. the acceptance: awaiting_attorney -> accepted (DM section 9); the governing engagement version is recorded; with
--    capture at_attorney_acceptance (and authorization before the decision) payment_request_capture (S7) records
--    capture_pending and enqueues the capture job in this transaction (the provider call runs after commit through
--    the S2 job protocol: the side-effect rule); with authorization at_attorney_acceptance nothing is captured or
--    authorized here: the client's authorization step opens (client_authorize_payment and client_request_payment,
--    replaced below); with any other moment the payment waits for its own later slice;
-- 7. the Consultation (G-5): when the configured condition holds now, exactly one Consultation (state created, the
--    Request's provenance) is created; scheduled: S4 scheduling_convert_hold_to_booking turns the Hold into the one
--    confirmed Booking and the Consultation moves to scheduled (PM row 7); instant: it moves to ready (PM row 2); the
--    live payment attempt is associated with it. On the instant path a condition that needs a captured payment is met
--    later: the Consultation is created when the capture is confirmed (decision_payment_captured, below). The
--    Engagement (G-1): version 1 is recorded, effective, when its configured moment has been reached (at_request: the
--    Request's creation instant; at_attorney_acceptance: the acceptance instant; at_payment_capture: the capture
--    instant, when confirmed); otherwise none is recorded yet (at_consultation_start belongs to S9). Acceptance alone
--    never makes the Engagement effective or the payment financially active unless configuration says so (MBS section
--    13 state rules; PM INV-8, INV-14);
-- 8. audit: one attorney event for the acceptance (identifiers, path, states, evaluations, Hold, Booking, payment and
--    Engagement facts, and the eligibility, engagement and payment_flow policy references), one for the Consultation
--    and one for an Engagement made effective; never free text, a client identity or Intake content.
-- An unexpected conversion or capture refusal inside the block rolls the whole decision back (conflict). Outcomes:
-- accepted (with the Consultation id, null while its creation waits for the capture), invalid, denied, not_found,
-- expired, withdrawn, already_decided, configuration_unavailable, payment_not_ready, not_eligible,
-- eligibility_unavailable, not_bookable, conflict.
--
-- attorney_decline_request (EXECUTE for authenticated only; same caller, lookup and lock order): after expiry, an
-- awaiting Request moves awaiting_attorney -> declined (DM section 9: decline and expiry stay distinct), its Hold is
-- released after the state change (TA section 14 B3; PM INV-6), the S7 release trigger releases any authorization and
-- surfaces captured funds (PM rows 3 and 8), with one attorney audit event. The Intake is untouched: the client may
-- select again, which is a new Referral and a new Request (TA section 7; S5). No referral outcome is recorded (the
-- outcome taxonomy is gated configuration, S5). Outcomes: declined, invalid, denied, not_found, expired, withdrawn,
-- already_decided.
--
-- Attorney reads (EXECUTE for authenticated only; stable security definer; an approved Attorney Profile of an active
-- User at aal2; own Requests only): attorney_requests (the queue: the Requests awaiting the attorney) and
-- attorney_request (one Request the attorney has been offered, with its outcome). Before acceptance the attorney sees
-- only the path, modality, duration, the held slot, the attorney-side quote amounts (listed price, platform fee) and
-- currency, the server deadlines and the server-derived expiry flag; never the client's identity, message, Intake or
-- voice memo (Packet section 3: counsel gate, nothing shown; PS-A3 section 5). After acceptance the attorney also sees
-- the Consultation's state and the Booking's times.
--
-- Client read (EXECUTE for authenticated only): client_request_decision (one of the caller's own Requests: the
-- decision instant, why it ended, the Consultation's state, the Booking's times and the Intake id, so the client can
-- select again after a decline). Never the attorney's contact details.
--
-- S7 functions replaced forward (unchanged otherwise): client_authorize_payment and client_request_payment admit the
-- authorization step of an accepted Request whose payment flow authorizes at the attorney's acceptance (payment step
-- authorization_after_acceptance; the attempt records the Consultation's engagement version and is associated with
-- the Consultation); payment_confirm_authorization also requests the capture of a confirmed authorization of an
-- accepted Request whose flow captures at the attorney's acceptance (the decision moment has passed, so the capture
-- follows the authorization). decision_payment_captured (trigger on payment_transactions) applies the configured
-- consequences of a confirmed capture of an accepted Request: the deferred instant Consultation, and an Engagement
-- effective at_payment_capture.

-- ---------------------------------------------------------------------------
-- The engagement parameter schema and approval validation.
-- ---------------------------------------------------------------------------

create function public.engagement_parameters_valid(p_parameters jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if jsonb_typeof(p_parameters) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p_parameters)) <> 2
     or not (p_parameters ?& array['consultation_creation', 'engagement_effective']) then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'consultation_creation') is distinct from 'string'
     or (p_parameters ->> 'consultation_creation') not in (
       'attorney_acceptance',
       'attorney_acceptance_and_payment_authorized',
       'attorney_acceptance_and_payment_captured',
       'attorney_acceptance_and_engagement_effective'
     ) then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'engagement_effective') is distinct from 'string'
     or (p_parameters ->> 'engagement_effective') not in (
       'at_request', 'at_attorney_acceptance', 'at_payment_capture', 'at_consultation_start'
     ) then
    return false;
  end if;
  return true;
end;
$function$;

-- Approval validation (PS section 8.4): the S7 function with the engagement schema added (unchanged otherwise).
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
    else true
  end;
$function$;

-- The validated parameters of one engagement version, or null (unknown, another type, or outside the schema).
create function public.decision_engagement_parameters(p_version uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case when public.engagement_parameters_valid(v.parameters) then v.parameters end
  from public.policy_versions as v
  where v.id = p_version
    and v.policy_type_code = 'engagement';
$function$;

-- ---------------------------------------------------------------------------
-- Internal helpers.
-- ---------------------------------------------------------------------------

-- One audit event (PM INV-9: actor, action, before/after, reason and the policy versions).
create function public.decision_audit(
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text,
  p_policy_references jsonb,
  p_jurisdiction uuid
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
    p_actor, p_actor_type, p_action, p_resource_type, p_resource_id,
    p_before, p_after, p_reason, p_policy_references, p_jurisdiction, clock_timestamp()
  );
$function$;

-- Whether a Request has been offered to its attorney: it awaits the attorney or was decided, or an audit event
-- recorded it entering awaiting_attorney (request_create, payment_advance_request) before it expired or was withdrawn.
-- A Request still waiting for its payment step was never offered. Null for an unknown Request.
create function public.decision_request_offered(p_request uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select r.state in ('awaiting_attorney', 'accepted', 'declined')
    or exists (
      select 1
      from public.audit_events as a
      where a.resource_type = 'consultation_request'
        and a.resource_id = r.id
        and a.after_snapshot ->> 'state' = 'awaiting_attorney'
    )
  from public.consultation_requests as r
  where r.id = p_request;
$function$;

-- How one Request ended, for its participants: declined, expired, withdrawn (the client), could_not_proceed (PM row
-- 38: the attorney was not eligible at the decision point), or null while it has not ended.
create function public.decision_ended_reason(p_request uuid)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case r.state
    when 'declined' then 'declined'
    when 'expired' then 'expired'
    when 'cancelled' then
      case
        when exists (
          select 1
          from public.audit_events as a
          where a.resource_type = 'consultation_request'
            and a.resource_id = r.id
            and a.action_code = 'consultation_request.ended_not_eligible'
        ) then 'could_not_proceed'
        else 'withdrawn'
      end
  end
  from public.consultation_requests as r
  where r.id = p_request;
$function$;

-- The latest time an undecided Request can still be decided: the earliest of its response deadline, its current
-- quote's validity and its active Hold's expiry (DM sections 2.5, 2.6 and 8). Null for a decided Request.
create function public.decision_deadline(p_request uuid)
returns timestamptz
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case when r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney') then
    least(
      r.response_deadline_at,
      (public.payment_current_fee_calculation(r.id)).quote_valid_until,
      (select h.expires_at from public.slot_holds as h where h.consultation_request_id = r.id and h.released_at is null)
    )
  end
  from public.consultation_requests as r
  where r.id = p_request;
$function$;

-- Null when the held slot can still be committed for its Request now, otherwise the first problem, in this order:
-- policy_unavailable, hold_inactive (the Request's own Hold ended or reached its server expiry), outside_availability,
-- blackout, booking_conflict, hold_conflict (another active Hold). The Request's own Hold never conflicts with itself;
-- the minimum-notice rule is a rule for new requests and is not applied again at the decision.
create function public.decision_slot_problem(p_hold public.slot_holds, p_jurisdiction uuid)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_outcome text;
begin
  select p.outcome into v_outcome
  from public.scheduling_policy('scheduling', p_jurisdiction, clock_timestamp()) as p;
  if v_outcome is distinct from 'selected' then
    return 'policy_unavailable';
  end if;
  if p_hold.id is null or p_hold.released_at is not null or p_hold.expires_at <= clock_timestamp() then
    return 'hold_inactive';
  end if;
  if not exists (
    select 1
    from public.scheduling_expand_availability(
      p_hold.attorney_id,
      (p_hold.slot_start_at at time zone 'UTC')::date - 1,
      (p_hold.slot_end_at at time zone 'UTC')::date + 1
    ) as w
    where w.window_start <= p_hold.slot_start_at
      and w.window_end >= p_hold.slot_end_at
  ) then
    return 'outside_availability';
  end if;
  if exists (
    select 1
    from public.blackouts as b
    where b.attorney_id = p_hold.attorney_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_hold.slot_start_at, p_hold.slot_end_at, '[)')
  ) then
    return 'blackout';
  end if;
  if exists (
    select 1
    from public.bookings as b
    where b.attorney_id = p_hold.attorney_id
      and b.status = 'confirmed'
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_hold.slot_start_at, p_hold.slot_end_at, '[)')
  ) then
    return 'booking_conflict';
  end if;
  if exists (
    select 1
    from public.slot_holds as h
    where h.attorney_id = p_hold.attorney_id
      and h.id <> p_hold.id
      and h.released_at is null
      and h.expires_at > clock_timestamp()
      and tstzrange(h.slot_start_at, h.slot_end_at, '[)') && tstzrange(p_hold.slot_start_at, p_hold.slot_end_at, '[)')
  ) then
    return 'hold_conflict';
  end if;
  return null;
end;
$function$;

-- Appends the decision-point Bookability Evaluation of one Request (context consultation_request) and answers its
-- result and id. Instant: S4's evaluation with no slot. Scheduled: one immutable row recording the eligibility factor
-- and the held slot's factor (decision_slot_problem) with their reasons, the slot and the availability window.
create function public.decision_evaluate_bookability(
  p_request public.consultation_requests,
  p_hold public.slot_holds,
  p_eligibility_evaluation_id uuid,
  p_jurisdiction uuid
)
returns table (result text, evaluation_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_eligibility record;
  v_problem text;
  v_policy uuid;
  v_basis jsonb;
  v_bookable boolean;
  v_id uuid;
begin
  if p_request.request_path = 'instant' then
    return query
    select b.result, b.evaluation_id
    from public.scheduling_evaluate_bookability(
      p_request.selected_attorney_id, p_eligibility_evaluation_id, 'consultation_request', p_request.id,
      p_request.requested_modality, null, null
    ) as b;
    return;
  end if;
  select e.result, e.as_of into v_eligibility
  from public.eligibility_evaluations as e
  where e.id = p_eligibility_evaluation_id
    and e.attorney_id = p_request.selected_attorney_id;
  v_problem := public.decision_slot_problem(p_hold, p_jurisdiction);
  select p.policy_version_id into v_policy
  from public.scheduling_policy('scheduling', p_jurisdiction, v_now) as p;
  select jsonb_build_object(
           'rule_id', w.rule_id,
           'timezone_name', w.timezone_name,
           'local_date', w.local_date,
           'window_start', w.window_start,
           'window_end', w.window_end
         )
  into v_basis
  from public.scheduling_expand_availability(
    p_hold.attorney_id,
    (p_hold.slot_start_at at time zone 'UTC')::date - 1,
    (p_hold.slot_end_at at time zone 'UTC')::date + 1
  ) as w
  where w.window_start <= p_hold.slot_start_at
    and w.window_end >= p_hold.slot_end_at
  order by w.window_start, w.rule_id
  limit 1;
  v_bookable := v_eligibility.result = 'eligible' and v_problem is null;
  insert into public.bookability_evaluations (
    attorney_id, eligibility_evaluation_id, context_type, context_id,
    evaluated_at, as_of, modality, presence_observed, presence_trust_method,
    instant_intent_observed, slot_start_at, slot_end_at, availability_basis,
    constraint_results, result
  ) values (
    p_request.selected_attorney_id, p_eligibility_evaluation_id, 'consultation_request', p_request.id,
    v_now, v_now, p_request.requested_modality, null, null, null,
    p_hold.slot_start_at, p_hold.slot_end_at, v_basis,
    jsonb_build_array(
      jsonb_build_object(
        'factor', 'eligibility',
        'passed', v_eligibility.result = 'eligible',
        'reason', case when v_eligibility.result = 'eligible' then 'eligible' else 'eligibility_' || v_eligibility.result end,
        'eligibility_evaluation_id', p_eligibility_evaluation_id,
        'eligibility_as_of', v_eligibility.as_of
      ),
      jsonb_build_object(
        'factor', 'slot',
        'passed', v_problem is null,
        'reason', coalesce(v_problem, 'slot_available'),
        'policy_version_id', v_policy,
        'hold_id', p_hold.id
      )
    ),
    case when v_bookable then 'bookable' else 'not_bookable' end
  )
  returning id into v_id;
  return query select case when v_bookable then 'bookable' else 'not_bookable' end, v_id;
end;
$function$;

-- Records Engagement version 1 of a Consultation, effective, when its configured G-1 moment has been reached
-- (at_request: the Request's creation; at_attorney_acceptance: the acceptance; at_payment_capture: the confirmed
-- capture, when p_captured_at is given; at_consultation_start: never here), with one system audit event. Answers the
-- Engagement id, or null when none is due or one already exists.
create function public.decision_record_engagement_if_due(
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

-- Creates the one Consultation of an accepted Request (the caller holds the attorney lock, the Request, the Hold and
-- the payment): state created with the Request's provenance (referral policy; the current Fee Calculation's fee
-- policy; the governing engagement version; the live attempt's cancellation version, when one exists); scheduled: the
-- Hold becomes its one confirmed Booking (S4) and the Consultation moves to scheduled; instant: it moves to ready. The
-- live attempt is associated with it and an Engagement is recorded when its moment has been reached; one audit event.
-- Answers created (with the ids), or exists (the Request already has its Consultation: nothing is created). A refused
-- conversion raises RS801 so the caller rolls the decision back.
create function public.decision_create_consultation(
  p_request_id uuid,
  p_engagement_version uuid,
  p_parameters jsonb,
  p_actor uuid,
  p_actor_type text,
  p_reason text
)
returns table (outcome text, consultation_id uuid, booking_id uuid, engagement_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_request public.consultation_requests;
  v_existing public.consultations;
  v_consultation public.consultations;
  v_fee public.fee_calculations;
  v_payment public.payment_transactions;
  v_hold public.slot_holds;
  v_jurisdiction uuid;
  v_convert record;
  v_booking uuid;
  v_engagement uuid;
begin
  select r.* into v_request from public.consultation_requests as r where r.id = p_request_id;
  select c.* into v_existing from public.consultations as c where c.consultation_request_id = p_request_id;
  if v_existing.id is not null then
    select k.id into v_booking
    from public.bookings as k
    where k.consultation_id = v_existing.id and k.status = 'confirmed';
    return query select 'exists'::text, v_existing.id, v_booking, null::uuid;
    return;
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  v_fee := public.payment_current_fee_calculation(p_request_id);
  select pt.* into v_payment
  from public.payment_transactions as pt
  where pt.consultation_request_id = p_request_id
    and pt.state not in ('failed', 'cancelled', 'authorization_released')
  order by pt.created_at desc, pt.id desc
  limit 1;
  insert into public.consultations (
    consultation_request_id, client_id, attorney_id, request_path, referral_policy_version_id,
    fee_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, modality, state
  ) values (
    v_request.id, v_request.client_id, v_request.selected_attorney_id, v_request.request_path,
    v_request.referral_policy_version_id, v_fee.fee_policy_version_id, p_engagement_version,
    v_payment.cancellation_policy_version_id, v_request.requested_modality, 'created'
  )
  returning * into v_consultation;
  if v_request.request_path = 'scheduled' then
    select h.* into v_hold from public.slot_holds as h where h.consultation_request_id = p_request_id;
    select x.outcome, x.booking_id into v_convert
    from public.scheduling_convert_hold_to_booking(v_hold.id, v_consultation.id) as x;
    if v_convert.outcome is distinct from 'booked' then
      raise exception 'the hold could not be converted' using errcode = 'RS801';
    end if;
    v_booking := v_convert.booking_id;
    update public.consultations as c set state = 'scheduled' where c.id = v_consultation.id
    returning * into v_consultation;
  else
    update public.consultations as c set state = 'ready' where c.id = v_consultation.id
    returning * into v_consultation;
  end if;
  if v_payment.id is not null and v_payment.consultation_id is null then
    update public.payment_transactions as pt
    set consultation_id = v_consultation.id
    where pt.id = v_payment.id;
  end if;
  v_engagement := public.decision_record_engagement_if_due(
    v_consultation, p_parameters, v_request, v_payment.captured_at, v_jurisdiction
  );
  perform public.decision_audit(
    p_actor, p_actor_type, 'consultation.created', 'consultation', v_consultation.id,
    null,
    jsonb_build_object(
      'consultation_request_id', v_request.id,
      'request_path', v_request.request_path,
      'state', v_consultation.state,
      'booking_id', v_booking,
      'hold_id', v_hold.id,
      'payment_transaction_id', v_payment.id,
      'engagement_id', v_engagement
    ),
    p_reason,
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'referral', 'policy_version_id', v_consultation.referral_policy_version_id),
      jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', v_consultation.fee_policy_version_id),
      jsonb_build_object('policy_type_code', 'engagement', 'policy_version_id', v_consultation.engagement_policy_version_id),
      jsonb_build_object('policy_type_code', 'cancellation', 'policy_version_id', v_consultation.cancellation_policy_version_id)
    ),
    v_jurisdiction
  );
  return query select 'created'::text, v_consultation.id, v_booking, v_engagement;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The attorney's decision (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.attorney_accept_request(p_request_id uuid)
returns table (outcome text, consultation_id uuid, problem text)
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
  v_state text;
  v_hold public.slot_holds;
  v_request public.consultation_requests;
  v_payment public.payment_transactions;
  v_jurisdiction uuid;
  v_now timestamptz;
  v_flow record;
  v_flow_parameters jsonb;
  v_flow_version uuid;
  v_mode uuid;
  v_authorization text;
  v_capture text;
  v_engagement uuid;
  v_selection record;
  v_parameters jsonb;
  v_check record;
  v_development boolean;
  v_gate record;
  v_creation text;
  v_needs text;
  v_when text := 'now';
  v_area uuid;
  v_evaluation uuid;
  v_area_evaluation uuid;
  v_result text;
  v_bookability uuid;
  v_bookability_result text;
  v_problem text;
  v_outcome text;
  v_hold_answer text;
  v_capture_answer text;
  v_created record;
  v_consultation uuid;
  v_booking uuid;
  v_engagement_id uuid;
  v_pin boolean;
  v_policy_references jsonb;
begin
  if p_request_id is null then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select 'configuration_unavailable'::text, null::uuid, v_environment;
    return;
  end if;
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null or v_profile.profile_state is distinct from 'approved' then
    return query select 'denied'::text, null::uuid, null::text;
    return;
  end if;
  if not exists (
    select 1 from public.consultation_requests as r
    where r.id = p_request_id and r.selected_attorney_id = v_profile.id
  ) then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- Lock order: the attorney's scheduling lock, the Request's expiry (Hold, then Request), the Hold and the Request,
  -- then the payment.
  perform public.scheduling_lock_attorney(v_profile.id);
  v_state := public.request_expire_if_due(p_request_id, false);
  select h.* into v_hold from public.slot_holds as h where h.consultation_request_id = p_request_id for update;
  select r.* into v_request from public.consultation_requests as r where r.id = p_request_id for update;
  if not coalesce(public.decision_request_offered(p_request_id), false) then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if v_state = 'expired' or v_request.state = 'expired' then
    return query select 'expired'::text, null::uuid, null::text;
    return;
  end if;
  if v_request.state = 'cancelled' then
    return query select 'withdrawn'::text, null::uuid, null::text;
    return;
  end if;
  if v_request.state in ('accepted', 'declined') then
    select c.id into v_consultation from public.consultations as c where c.consultation_request_id = p_request_id;
    return query select 'already_decided'::text, v_consultation, v_request.state;
    return;
  end if;
  if v_request.state is distinct from 'awaiting_attorney' then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  select pt.* into v_payment
  from public.payment_transactions as pt
  where pt.consultation_request_id = p_request_id
    and pt.state not in ('failed', 'cancelled', 'authorization_released')
  order by pt.created_at desc, pt.id desc
  limit 1
  for update;
  v_now := clock_timestamp();

  -- Configuration: the payment flow and the governing engagement version (TA section 63: a live attempt keeps the
  -- versions it recorded).
  if v_payment.id is not null then
    select v.parameters into v_flow_parameters
    from public.policy_versions as v
    where v.id = v_payment.payment_flow_policy_version_id;
    if not public.payment_flow_parameters_valid(v_flow_parameters) then
      return query select 'configuration_unavailable'::text, null::uuid, 'payment_flow_policy_incomplete'::text;
      return;
    end if;
    v_flow_version := v_payment.payment_flow_policy_version_id;
    v_mode := v_payment.regulatory_mode_id;
    v_authorization := v_flow_parameters -> v_request.request_path ->> 'authorization';
    v_capture := v_flow_parameters -> v_request.request_path ->> 'capture';
  else
    select f.* into v_flow from public.payment_flow_for_path(v_jurisdiction, v_request.request_path, v_now) as f;
    if v_flow.outcome is distinct from 'selected' then
      return query select 'configuration_unavailable'::text, null::uuid,
        case
          when v_flow.outcome like 'regulatory_mode_%' then v_flow.outcome
          else 'payment_flow_' || coalesce(v_flow.outcome, 'no_applicable_policy')
        end;
      return;
    end if;
    v_flow_version := v_flow.policy_version_id;
    v_mode := v_flow.regulatory_mode_id;
    v_authorization := v_flow.authorization_timing;
    v_capture := v_flow.capture_timing;
  end if;
  v_engagement := coalesce(v_request.engagement_policy_version_id, v_payment.engagement_policy_version_id);
  if v_engagement is null then
    select s.outcome, s.policy_version_id into v_selection
    from public.policy_select_version('engagement', v_jurisdiction, v_mode, v_now) as s;
    if v_selection.outcome is distinct from 'selected' or v_selection.policy_version_id is null then
      return query select 'configuration_unavailable'::text, null::uuid,
        'engagement_' || coalesce(v_selection.outcome, 'no_applicable_policy');
      return;
    end if;
    v_engagement := v_selection.policy_version_id;
  end if;
  v_parameters := public.decision_engagement_parameters(v_engagement);
  if v_parameters is null then
    return query select 'configuration_unavailable'::text, null::uuid, 'engagement_policy_incomplete'::text;
    return;
  end if;
  -- The four-way production gate (MBS sections 13 and 19; TA section 32 F1-F2): a production-class database uses no
  -- development-only version, and the gate must hold now for the Request's jurisdiction for both policy types the
  -- decision uses, whether the version was recorded by the payment attempt or selected here (the acceptance can
  -- request a capture and creates the Consultation; a jurisdiction no longer live or launch-authorized is refused).
  if public.rosuno_environment_class() = 'production' then
    for v_check in
      select x.policy_type_code, x.policy_version_id
      from (
        values
          ('engagement'::text, v_engagement),
          ('payment_flow'::text, v_flow_version)
      ) as x(policy_type_code, policy_version_id)
    loop
      select v.development_only into v_development from public.policy_versions as v where v.id = v_check.policy_version_id;
      if v_development is distinct from false then
        return query select 'configuration_unavailable'::text, null::uuid, 'development_policy'::text;
        return;
      end if;
      select g.permitted, g.reason into v_gate
      from public.production_financial_gate(v_jurisdiction, v_check.policy_type_code, v_mode, v_now) as g;
      if v_gate.permitted is distinct from true then
        return query select 'configuration_unavailable'::text, null::uuid, 'production_gate_closed'::text;
        return;
      end if;
    end loop;
  end if;

  -- Payment readiness (TA section 60 "required payment state is invalid").
  if v_authorization = 'before_attorney_decision' and (
       v_payment.id is null
       or not (
         v_payment.state = 'authorized'
         or (v_capture = 'at_authorization' and v_payment.state in ('capture_pending', 'captured'))
       )
     ) then
    return query select 'payment_not_ready'::text, null::uuid, coalesce(v_payment.state, 'no_payment');
    return;
  end if;

  -- G-5 satisfiability for this path and flow.
  v_creation := v_parameters ->> 'consultation_creation';
  v_needs := case v_creation
    when 'attorney_acceptance' then 'none'
    when 'attorney_acceptance_and_payment_authorized' then 'authorization'
    when 'attorney_acceptance_and_payment_captured' then 'capture'
    when 'attorney_acceptance_and_engagement_effective' then
      case v_parameters ->> 'engagement_effective'
        when 'at_request' then 'none'
        when 'at_attorney_acceptance' then 'none'
        when 'at_payment_capture' then 'capture'
        else 'impossible'
      end
  end;
  if v_needs = 'impossible'
     or (v_needs in ('authorization', 'capture') and v_authorization is distinct from 'before_attorney_decision') then
    return query select 'configuration_unavailable'::text, null::uuid, 'consultation_creation_unsatisfiable'::text;
    return;
  end if;
  if v_needs = 'capture' and v_payment.state is distinct from 'captured' then
    if v_request.request_path = 'instant'
       and (v_capture = 'at_attorney_acceptance'
            or (v_capture = 'at_authorization' and v_payment.state = 'capture_pending')) then
      v_when := 'on_capture';
    elsif v_request.request_path = 'scheduled' and v_capture = 'at_authorization' and v_payment.state = 'capture_pending' then
      return query select 'payment_not_ready'::text, null::uuid, 'capture_pending'::text;
      return;
    else
      return query select 'configuration_unavailable'::text, null::uuid, 'consultation_creation_unsatisfiable'::text;
      return;
    end if;
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
    -- Mandatory revalidation: fresh Eligibility, persisted.
    select d.evaluation_id, d.result into v_evaluation, v_result
    from public.eligibility_record_decision_point(v_request.selected_attorney_id, v_jurisdiction, null, v_now) as d;
    if v_evaluation is null then
      raise exception 'eligibility unavailable' using errcode = 'RS802';
    end if;
    if v_result = 'eligible' and v_area is not null then
      select d.evaluation_id, d.result into v_area_evaluation, v_result
      from public.eligibility_record_decision_point(v_request.selected_attorney_id, v_jurisdiction, v_area, v_now) as d;
      if v_area_evaluation is null then
        raise exception 'eligibility unavailable' using errcode = 'RS802';
      end if;
      v_evaluation := v_area_evaluation;
    end if;
    select case when jsonb_typeof(e.policy_references) = 'array' then e.policy_references else '[]'::jsonb end
    into v_policy_references
    from public.eligibility_evaluations as e
    where e.id = v_evaluation;
    v_policy_references := coalesce(v_policy_references, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('policy_type_code', 'engagement', 'policy_version_id', v_engagement),
      jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', v_flow_version)
    );
    -- Only the engine's not_eligible ends the Request (PM row 38); an undetermined result (a configuration or data
    -- gap) refuses and rolls the block back: nothing changes (fail closed).
    if v_result is distinct from 'eligible' and v_result is distinct from 'not_eligible' then
      raise exception 'eligibility undetermined' using errcode = 'RS802';
    end if;

    if v_result = 'not_eligible' then
      -- PM row 38 (settled): the Request cannot proceed. The Hold is released after the state change and the S7
      -- release trigger releases any authorization in this transaction.
      update public.consultation_requests as r
      set state = 'cancelled',
          cancelled_at = clock_timestamp()
      where r.id = p_request_id;
      if v_hold.id is not null and v_hold.released_at is null then
        v_hold_answer := public.scheduling_release_hold(v_hold.id);
      end if;
      perform public.decision_audit(
        null, 'system', 'consultation_request.ended_not_eligible', 'consultation_request', p_request_id,
        jsonb_build_object('state', v_request.state),
        jsonb_build_object(
          'state', 'cancelled',
          'eligibility_evaluation_id', v_evaluation,
          'eligibility_result', v_result,
          'hold_id', v_hold.id,
          'hold_ended', v_hold_answer is not null,
          'payment_transaction_id', v_payment.id
        ),
        'attorney_not_eligible', v_policy_references, v_jurisdiction
      );
      v_outcome := 'not_eligible';
      v_problem := v_result;
    else
      -- Mandatory revalidation: fresh Bookability, persisted.
      select b.result, b.evaluation_id into v_bookability_result, v_bookability
      from public.decision_evaluate_bookability(v_request, v_hold, v_evaluation, v_jurisdiction) as b;
      if v_bookability_result is distinct from 'bookable' then
        select f ->> 'reason' into v_problem
        from public.bookability_evaluations as e
        cross join lateral jsonb_array_elements(e.constraint_results) with ordinality as x(f, n)
        where e.id = v_bookability
          and (f ->> 'passed') is distinct from 'true'
        order by x.n
        limit 1;
        v_problem := coalesce(v_problem, 'not_bookable');
        perform public.decision_audit(
          v_profile.user_id, 'attorney', 'consultation_request.acceptance_refused', 'consultation_request',
          p_request_id,
          jsonb_build_object('state', v_request.state),
          jsonb_build_object(
            'state', v_request.state,
            'eligibility_evaluation_id', v_evaluation,
            'bookability_evaluation_id', v_bookability,
            'problem', v_problem
          ),
          'not_bookable', v_policy_references, v_jurisdiction
        );
        v_outcome := 'not_bookable';
      else
        -- The acceptance (DM section 9). The governing engagement version is recorded on the Request unless an
        -- earlier payment attempt recorded another one (P1 provenance consistency).
        v_pin := v_request.engagement_policy_version_id is null and not exists (
          select 1 from public.payment_transactions as pt
          where pt.consultation_request_id = p_request_id
            and pt.engagement_policy_version_id is distinct from v_engagement
        );
        update public.consultation_requests as r
        set state = 'accepted',
            accepted_at = clock_timestamp(),
            engagement_policy_version_id = case when v_pin then v_engagement else r.engagement_policy_version_id end
        where r.id = p_request_id
        returning r.* into v_request;
        -- The configured payment transition (G-2/G-3; S7): only the capture moment at the acceptance is applied here;
        -- the provider call follows commit through the job protocol.
        if v_authorization = 'before_attorney_decision' and v_capture = 'at_attorney_acceptance' then
          v_capture_answer := public.payment_request_capture(v_payment.id);
          if v_capture_answer is distinct from 'capture_requested' then
            raise exception 'the capture could not be requested' using errcode = 'RS801';
          end if;
        end if;
        -- The Consultation (G-5).
        if v_when = 'now' then
          select x.outcome, x.consultation_id, x.booking_id, x.engagement_id into v_created
          from public.decision_create_consultation(
            p_request_id, v_engagement, v_parameters, v_profile.user_id, 'attorney', 'attorney_accepted'
          ) as x;
          if v_created.outcome is distinct from 'created' then
            raise exception 'the consultation could not be created' using errcode = 'RS801';
          end if;
          v_consultation := v_created.consultation_id;
          v_booking := v_created.booking_id;
          v_engagement_id := v_created.engagement_id;
        end if;
        select pt.* into v_payment from public.payment_transactions as pt where pt.id = v_payment.id;
        perform public.decision_audit(
          v_profile.user_id, 'attorney', 'consultation_request.accepted', 'consultation_request', p_request_id,
          jsonb_build_object('state', 'awaiting_attorney'),
          jsonb_build_object(
            'state', 'accepted',
            'eligibility_evaluation_id', v_evaluation,
            'bookability_evaluation_id', v_bookability,
            'hold_id', v_hold.id,
            'consultation_id', v_consultation,
            'consultation_creation', v_creation,
            'consultation_created', v_consultation is not null,
            'booking_id', v_booking,
            'payment_transaction_id', v_payment.id,
            'payment_state', v_payment.state,
            'capture_requested', v_capture_answer is not null,
            'authorization_timing', v_authorization,
            'capture_timing', v_capture,
            'engagement_id', v_engagement_id,
            'engagement_effective', v_parameters ->> 'engagement_effective'
          ),
          'attorney_accepted', v_policy_references, v_jurisdiction
        );
        v_outcome := 'accepted';
        v_problem := null;
      end if;
    end if;
  exception
    when sqlstate 'RS801' then
      return query select 'conflict'::text, null::uuid, null::text;
      return;
    when sqlstate 'RS802' then
      return query select 'eligibility_unavailable'::text, null::uuid, null::text;
      return;
  end;
  return query select v_outcome, v_consultation, v_problem;
end;
$function$;

create function public.attorney_decline_request(p_request_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_profile public.attorney_profiles;
  v_state text;
  v_hold public.slot_holds;
  v_request public.consultation_requests;
  v_payment public.payment_transactions;
  v_after public.payment_transactions;
  v_jurisdiction uuid;
  v_hold_answer text;
begin
  if p_request_id is null then
    return query select 'invalid'::text;
    return;
  end if;
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null or v_profile.profile_state is distinct from 'approved' then
    return query select 'denied'::text;
    return;
  end if;
  if not exists (
    select 1 from public.consultation_requests as r
    where r.id = p_request_id and r.selected_attorney_id = v_profile.id
  ) then
    return query select 'not_found'::text;
    return;
  end if;
  perform public.scheduling_lock_attorney(v_profile.id);
  v_state := public.request_expire_if_due(p_request_id, false);
  select h.* into v_hold from public.slot_holds as h where h.consultation_request_id = p_request_id for update;
  select r.* into v_request from public.consultation_requests as r where r.id = p_request_id for update;
  if not coalesce(public.decision_request_offered(p_request_id), false) then
    return query select 'not_found'::text;
    return;
  end if;
  if v_state = 'expired' or v_request.state = 'expired' then
    return query select 'expired'::text;
    return;
  end if;
  if v_request.state = 'cancelled' then
    return query select 'withdrawn'::text;
    return;
  end if;
  if v_request.state in ('accepted', 'declined') then
    return query select 'already_decided'::text;
    return;
  end if;
  if v_request.state is distinct from 'awaiting_attorney' then
    return query select 'not_found'::text;
    return;
  end if;
  select pt.* into v_payment
  from public.payment_transactions as pt
  where pt.consultation_request_id = p_request_id
    and pt.state not in ('failed', 'cancelled', 'authorization_released')
  order by pt.created_at desc, pt.id desc
  limit 1
  for update;
  update public.consultation_requests as r
  set state = 'declined',
      declined_at = clock_timestamp()
  where r.id = p_request_id;
  if v_hold.id is not null and v_hold.released_at is null then
    v_hold_answer := public.scheduling_release_hold(v_hold.id);
  end if;
  select pt.* into v_after from public.payment_transactions as pt where pt.id = v_payment.id;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  perform public.decision_audit(
    v_profile.user_id, 'attorney', 'consultation_request.declined', 'consultation_request', p_request_id,
    jsonb_build_object('state', v_request.state),
    jsonb_build_object(
      'state', 'declined',
      'hold_id', v_hold.id,
      'hold_ended', v_hold_answer is not null,
      'payment_transaction_id', v_payment.id,
      'payment_state', v_after.state
    ),
    'attorney_declined', null, v_jurisdiction
  );
  return query select 'declined'::text;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Attorney reads (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.attorney_requests()
returns table (
  request_id uuid,
  request_path text,
  requested_modality text,
  duration_minutes integer,
  slot_start_at timestamptz,
  slot_end_at timestamptz,
  attorney_listed_price_minor bigint,
  platform_fee_minor bigint,
  currency_code text,
  response_deadline_at timestamptz,
  decide_by timestamptz,
  expired_due boolean,
  created_at timestamptz
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
    r.id,
    r.request_path,
    r.requested_modality,
    r.requested_duration_minutes,
    h.slot_start_at,
    h.slot_end_at,
    c.attorney_listed_price_minor,
    c.platform_fee_minor,
    c.currency_code::text,
    r.response_deadline_at,
    public.decision_deadline(r.id),
    coalesce(public.request_expired_due(r.id), false),
    r.created_at
  from me
  join public.consultation_requests as r on r.selected_attorney_id = me.id and r.state = 'awaiting_attorney'
  left join public.slot_holds as h on h.consultation_request_id = r.id
  left join lateral public.payment_current_fee_calculation(r.id) as c on true
  order by public.decision_deadline(r.id) nulls last, r.id
  limit 200;
$function$;

create function public.attorney_request(p_request_id uuid)
returns table (
  request_id uuid,
  state text,
  expired_due boolean,
  request_path text,
  requested_modality text,
  duration_minutes integer,
  slot_start_at timestamptz,
  slot_end_at timestamptz,
  attorney_listed_price_minor bigint,
  platform_fee_minor bigint,
  currency_code text,
  response_deadline_at timestamptz,
  decide_by timestamptz,
  created_at timestamptz,
  decided_at timestamptz,
  ended_reason text,
  consultation_id uuid,
  consultation_state text,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz
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
    r.id,
    r.state,
    coalesce(public.request_expired_due(r.id), false),
    r.request_path,
    r.requested_modality,
    r.requested_duration_minutes,
    h.slot_start_at,
    h.slot_end_at,
    c.attorney_listed_price_minor,
    c.platform_fee_minor,
    c.currency_code::text,
    r.response_deadline_at,
    public.decision_deadline(r.id),
    r.created_at,
    coalesce(r.accepted_at, r.declined_at),
    public.decision_ended_reason(r.id),
    k.id,
    k.state,
    b.starts_at,
    b.ends_at
  from me
  join public.consultation_requests as r on r.selected_attorney_id = me.id and r.id = p_request_id
  left join public.slot_holds as h on h.consultation_request_id = r.id
  left join lateral public.payment_current_fee_calculation(r.id) as c on true
  left join public.consultations as k on k.consultation_request_id = r.id
  left join public.bookings as b on b.consultation_id = k.id and b.status = 'confirmed'
  where p_request_id is not null
    and coalesce(public.decision_request_offered(r.id), false);
$function$;

-- ---------------------------------------------------------------------------
-- The client's view of the decision (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.client_request_decision(p_request_id uuid)
returns table (
  request_id uuid,
  state text,
  decided_at timestamptz,
  ended_reason text,
  consultation_id uuid,
  consultation_state text,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  intake_id uuid
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    r.id,
    r.state,
    coalesce(r.accepted_at, r.declined_at),
    public.decision_ended_reason(r.id),
    k.id,
    k.state,
    b.starts_at,
    b.ends_at,
    r.intake_id
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id and r.id = p_request_id
  left join public.consultations as k on k.consultation_request_id = r.id
  left join public.bookings as b on b.consultation_id = k.id and b.status = 'confirmed'
  where p_request_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

-- ---------------------------------------------------------------------------
-- S7 replaced forward: the authorization step of an accepted Request (authorization at the attorney's acceptance).
-- ---------------------------------------------------------------------------

-- Creates the payment attempt for one of the caller's own Requests: an undecided Request in its pre-decision state
-- whose flow requires authorization before the attorney decision (S7, unchanged), or (MVP-001 S8) an accepted Request
-- whose flow authorizes at the attorney's acceptance, with complete FP-1 provenance, one audit event and the enqueued
-- hosted checkout; an accepted Request's attempt records the Request's (or its Consultation's) engagement version and
-- is associated with the Consultation. Outcomes: created (payment id), pending (the live attempt's id), invalid,
-- not_found (another client's Request and an unknown one alike), expired, not_payable (with the live attempt's state,
-- or none), not_required (the flow authorizes at the attorney's acceptance and the Request is not accepted yet),
-- policy_unavailable (with the missing piece), production_gate_closed (with the gate's reason). Any refusal writes
-- nothing.
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

-- The payment step of one of the caller's own Requests and its latest attempt: authorization_required (the flow asks
-- for authorization before the attorney decision and the Request waits for it), authorization_after_acceptance
-- (MVP-001 S8: the Request is accepted and its flow authorizes at the attorney's acceptance), not_required_now (the
-- flow authorizes at the attorney's acceptance and the Request is not accepted yet), unavailable (no selectable flow)
-- or not_applicable (no payment step now, or due to expire). payable: an attempt can be started or continued now.
-- Another client's or an unknown Request answers no row. Never a provider reference, a policy or the attorney-side fee.
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

-- Records a confirmed authorization on a locked pending payment: exactly the current Fee Calculation total in the
-- payment's currency moves it to authorized (and the Request along DM section 9; capture at_authorization requested,
-- and, MVP-001 S8, capture at_attorney_acceptance requested when the Request is already accepted); any other amount
-- or currency records the facts, releases the attempt and opens a critical exception.
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
     and (
       (v_parameters -> v_request.request_path ->> 'capture') = 'at_authorization'
       or (v_request.state = 'accepted' and (v_parameters -> v_request.request_path ->> 'capture') = 'at_attorney_acceptance')
     ) then
    perform public.payment_request_capture(v_after.id);
  end if;
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- The configured consequences of a confirmed capture of an accepted Request (trigger on payment_transactions).
-- ---------------------------------------------------------------------------

-- When the capture of an accepted Request's payment is confirmed (payment captured; the S7 recording functions hold
-- the attorney lock, the Request and the payment): on the instant path, the Consultation whose configured creation
-- condition is a captured payment (directly, or through an Engagement effective at capture) is created now (once:
-- the P1 unique key backs it); and the Consultation's Engagement is recorded effective when its G-1 moment is
-- at_payment_capture. Nothing happens for a Request that is not accepted, or with an invalid engagement version.
create function public.decision_payment_captured()
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
  if (v_parameters ->> 'engagement_effective') = 'at_payment_capture' then
    select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
    perform public.decision_record_engagement_if_due(
      v_consultation, v_parameters, v_request, new.captured_at, v_jurisdiction
    );
  end if;
  return null;
end;
$function$;

create trigger payment_transactions_decision_capture
after update of state on public.payment_transactions
for each row
when (new.state = 'captured' and old.state is distinct from 'captured')
execute function public.decision_payment_captured();

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.engagement_parameters_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.policy_parameters_approvable(text, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_engagement_parameters(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_audit(uuid, text, text, text, uuid, jsonb, jsonb, text, jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_request_offered(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_ended_reason(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_deadline(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_slot_problem(public.slot_holds, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_evaluate_bookability(public.consultation_requests, public.slot_holds, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_record_engagement_if_due(
  public.consultations, jsonb, public.consultation_requests, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.decision_create_consultation(uuid, uuid, jsonb, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_payment_captured()
  from public, anon, authenticated, service_role;
revoke all on function public.payment_confirm_authorization(
  public.payment_transactions, text, bigint, text, text, uuid, text
) from public, anon, authenticated, service_role;

revoke all on function public.attorney_accept_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_accept_request(uuid) to authenticated;
revoke all on function public.attorney_decline_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_decline_request(uuid) to authenticated;
revoke all on function public.attorney_requests()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_requests() to authenticated;
revoke all on function public.attorney_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_request(uuid) to authenticated;
revoke all on function public.client_request_decision(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request_decision(uuid) to authenticated;
revoke all on function public.client_authorize_payment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_authorize_payment(uuid) to authenticated;
revoke all on function public.client_request_payment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request_payment(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.engagement_parameters_valid(jsonb) is
  'MVP-001 S8 (internal): whether engagement policy parameters are exactly consultation_creation (attorney_acceptance | attorney_acceptance_and_payment_authorized | attorney_acceptance_and_payment_captured | attorney_acceptance_and_engagement_effective; G-5) and engagement_effective (at_request | at_attorney_acceptance | at_payment_capture | at_consultation_start; G-1). No default.';
comment on function public.policy_parameters_approvable(text, uuid, jsonb) is
  'MVP-001 S6 PS-A3 (internal; MVP-001 S7: payment_flow; MVP-001 S8: engagement): whether parameters may be approved: fee versions match their scope''s schema, referral versions carry a well-formed message maximum or none, payment_flow versions match the payment_flow schema and engagement versions match the engagement schema; other types are not checked here.';
comment on function public.decision_engagement_parameters(uuid) is
  'MVP-001 S8 (internal): the validated parameters of one engagement policy version, or null.';
comment on function public.decision_audit(uuid, text, text, text, uuid, jsonb, jsonb, text, jsonb, uuid) is
  'MVP-001 S8 (internal): one audit event with actor, action, before/after, reason, policy references and jurisdiction.';
comment on function public.decision_request_offered(uuid) is
  'MVP-001 S8 (internal): whether a Request has been offered to its attorney (awaiting, decided, or recorded entering awaiting_attorney).';
comment on function public.decision_ended_reason(uuid) is
  'MVP-001 S8 (internal): how a Request ended for its participants: declined, expired, withdrawn, could_not_proceed (PM row 38), or null.';
comment on function public.decision_deadline(uuid) is
  'MVP-001 S8 (internal): the earliest of an undecided Request''s response deadline, quote validity and active Hold expiry.';
comment on function public.decision_slot_problem(public.slot_holds, uuid) is
  'MVP-001 S8 (internal): null when a held slot can still be committed for its Request, otherwise policy_unavailable, hold_inactive, outside_availability, blackout, booking_conflict or hold_conflict.';
comment on function public.decision_evaluate_bookability(public.consultation_requests, public.slot_holds, uuid, uuid) is
  'MVP-001 S8 (internal): appends the decision-point Bookability Evaluation of a Request (instant: S4 with no slot; scheduled: eligibility and the held slot) and answers its result and id.';
comment on function public.decision_record_engagement_if_due(public.consultations, jsonb, public.consultation_requests, timestamptz, uuid) is
  'MVP-001 S8 (internal): records Engagement version 1, effective, when the configured G-1 moment has been reached (at_request, at_attorney_acceptance, at_payment_capture once confirmed), audited; otherwise nothing.';
comment on function public.decision_create_consultation(uuid, uuid, jsonb, uuid, text, text) is
  'MVP-001 S8 (internal): creates the one Consultation of an accepted Request with its provenance, converts the scheduled Hold into its Booking (S4), moves it to scheduled or ready, associates the live payment, records a due Engagement and audits; answers created or exists.';
comment on function public.attorney_accept_request(uuid) is
  'MVP-001 S8: the attorney accepts one of their own offered Requests after expiry, configuration, payment readiness and G-5 checks, with fresh persisted Eligibility and Bookability Evaluations; not eligible ends the Request (PM row 38), an undetermined eligibility refuses with nothing changed (eligibility_unavailable), not bookable refuses; on acceptance the configured capture, the Consultation, the Booking conversion and a due Engagement follow in the same transaction; audited. Outcomes: accepted, invalid, denied, not_found, expired, withdrawn, already_decided, configuration_unavailable, payment_not_ready, not_eligible, eligibility_unavailable, not_bookable, conflict.';
comment on function public.attorney_decline_request(uuid) is
  'MVP-001 S8: the attorney declines one of their own awaiting Requests (declined); its Hold is released and the S7 trigger releases any authorization; audited. Outcomes: declined, invalid, denied, not_found, expired, withdrawn, already_decided.';
comment on function public.attorney_requests() is
  'MVP-001 S8: the caller''s Requests awaiting their decision (approved attorney at aal2): path, modality, duration, held slot, attorney-side quote amounts and currency, deadlines and the expiry flag; nothing of the client, the message or the Intake.';
comment on function public.attorney_request(uuid) is
  'MVP-001 S8: one Request offered to the caller (approved attorney at aal2) with the queue facts, its outcome, the Consultation''s state and the Booking''s times; nothing of the client, the message or the Intake.';
comment on function public.client_request_decision(uuid) is
  'MVP-001 S8: the decision on one of the caller''s own Requests: decision instant, how it ended, the Consultation''s state, the Booking''s times and the Intake id; nothing of the attorney''s contact details.';
comment on function public.client_authorize_payment(uuid) is
  'MVP-001 S7 (MVP-001 S8: also an accepted Request whose flow authorizes at the attorney''s acceptance): creates the client''s payment attempt with complete FP-1 provenance, one audit event and the enqueued hosted checkout; any refusal writes nothing.';
comment on function public.client_request_payment(uuid) is
  'MVP-001 S7 (MVP-001 S8: authorization_after_acceptance): the payment step of one of the caller''s own Requests and its latest attempt; never a provider reference, a policy or the attorney-side fee.';
comment on function public.payment_confirm_authorization(public.payment_transactions, text, bigint, text, text, uuid, text) is
  'MVP-001 S7 (internal; MVP-001 S8: an accepted Request whose flow captures at the attorney''s acceptance is captured once its authorization is confirmed): records a confirmed authorization of exactly the quoted total, or releases a mismatched one with a critical exception.';
comment on function public.decision_payment_captured() is
  'MVP-001 S8 (trigger): on a confirmed capture of an accepted Request, creates the deferred instant Consultation its configuration conditions on a captured payment and records an Engagement effective at_payment_capture.';
