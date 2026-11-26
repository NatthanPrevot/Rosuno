-- DEV-001 engineering program (WI-P2-DEV-001-ENGINEERING-PROGRAM, DEC-20261125-DEV-001-ENGINEERING-PROGRAM): four
-- workspace reads for the product integration: the client's own Requests across Intakes, the parties of the client's
-- own Consultations, the attorney's own activity counts for a period, and one payment's dispute events for finance
-- staff.
--
-- Functions only. No relation, column, policy type, policy, capability code, lifecycle state, constraint, index, seed,
-- default or grant on a relation is added or changed, and no existing function is replaced, dropped or altered.
--
-- Protections common to the four reads:
-- - Each answers only what the closest existing read already shows the same caller, under exactly that read's
--   authorization, and nothing of anyone else. Each reuses that read's own rules (its joins, its name rule, its state
--   sets, its outcome functions); nothing here decides a business rule anew.
-- - Each is language sql, stable, security definer with the pinned search_path pg_catalog, pg_temp, names every
--   relation by schema, and is executable by authenticated only (anon, service_role and public hold nothing).
-- - An unknown caller, a User that is not active, a caller without the profile or capability the read serves, an
--   attorney or staff session at aal1 and an argument outside its bounds all answer the same empty result.
-- - The participant reads take no User, profile, Request, Consultation or record id, so a guessed identifier can never
--   name someone else's record. The staff read takes only the payment it is asked about.
--
-- 1. public.client_requests(p_segment, p_offset)
--    One page (25 rows, plus one) of the caller's own Requests across all their Intakes, newest first. Columns: the
--    Request and Intake ids, the state, expired_due, the path, the attorney display name, the modality, the duration,
--    the held slot, the response deadline, the creation instant and the Consultation id once one exists.
--    - Authorization and values: exactly those of client_request and client_request_decision for the same Request (an
--      active User holding the Client Profile the Request belongs to; aal1 suffices, as for every client read). The
--      attorney name goes through discovery_presentable_text; the duration keeps client_request's fallback to the
--      current Fee Calculation snapshot for a Request recorded without one.
--    - Left out: every amount, the currency, the quote validity and the client's message (client_request keeps them).
--    - p_segment 'open' answers the undecided states (created, payment_authorized, slot_held, awaiting_attorney);
--      'all' answers every state; any other value answers nothing. Offsets 0 to 100000.
--
-- 2. public.client_consultation_parties()
--    For exactly the Consultations client_consultations lists the caller (the same rows, order and bound of 200):
--    the Consultation, Request and Intake ids, the attorney display name and the name of the practice area of the
--    caller's latest revision of that Intake.
--    - Authorization: that of client_consultations (an active User holding the Client Profile), with the Request
--      also the caller's own.
--    - The attorney name follows client_request's rule (discovery_presentable_text, so a refused name answers null).
--      The practice area is the client's own answer: the latest revision (by revision number) of the caller's own
--      Intake, whose area name client_intake_practice_areas already answers the caller; null when the revision names
--      none. Nothing else of the attorney (no id, contact, licence or authorization) is answered.
--
-- 3. public.attorney_activity_counts(p_from, p_until)
--    Counts only, for the caller's approved Attorney Profile at aal2, of nine fixed dimensions in a fixed order, each
--    answered even when zero:
--    - requests: accepted, declined, expired, withdrawn, could_not_proceed. The Requests are exactly those
--      attorney_request answers the caller (selected for the caller and offered: decision_request_offered), ended in
--      one of those outcomes (accepted, or decision_ended_reason), and counted by their creation instant, the one
--      instant attorney_request answers for every Request; no other instant of a Request is revealed.
--    - consultations: completed, cancelled, no_show, technical_failure. The Consultations are exactly those
--      attorney_consultation_history answers the caller, counted by their end instant, which that read answers.
--    The authorization is exactly that of attorney_requests, attorney_request and attorney_consultation_history. The
--    period is [p_from, p_until): both given, p_until after p_from and at most 366 days of 86400 seconds long (the
--    rule of staff_finance_summary); any other period, an infinite bound included, answers nothing instead of an
--    error.
--
-- 4. public.staff_payment_dispute_events(p_payment_id)
--    The dispute review items of one payment, oldest first, at most 200: the exception id, type, severity, status,
--    detection instant, evidence, resolution instant and resolution notes.
--    - Authorization, family and columns: those of staff_finance_exceptions (a global manage_financial_operations grant
--      at aal2, the financial family only), restricted to one payment's own items (canonical type payment_transaction)
--      of the three provider dispute types the payment engine opens (dispute_opened, dispute_updated, dispute_closed),
--      and to a subset of that read's columns (no source, canonical or assignee column). An unknown payment answers
--      nothing.

-- ---------------------------------------------------------------------------
-- Client reads.
-- ---------------------------------------------------------------------------

create function public.client_requests(p_segment text, p_offset integer)
returns table (
  request_id uuid,
  intake_id uuid,
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
  consultation_id uuid
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    r.id,
    r.intake_id,
    r.state,
    coalesce(public.request_expired_due(r.id), false),
    r.request_path,
    public.discovery_presentable_text(p.display_name),
    r.requested_modality,
    coalesce(
      r.requested_duration_minutes,
      (
        select case
          when public.pricing_integer_within(x.calculation_snapshot -> 'inputs' -> 'duration_minutes', 1, 1440)
            then (x.calculation_snapshot -> 'inputs' ->> 'duration_minutes')::integer
        end
        from public.fee_calculations as x
        where x.consultation_request_id = r.id
          and not exists (
            select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = x.id
          )
        limit 1
      )
    ),
    h.slot_start_at,
    h.slot_end_at,
    r.response_deadline_at,
    r.created_at,
    k.id
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id
  left join public.attorney_profiles as p on p.id = r.selected_attorney_id
  left join public.slot_holds as h on h.consultation_request_id = r.id
  left join public.consultations as k on k.consultation_request_id = r.id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and p_segment in ('open', 'all')
    and (
      p_segment = 'all'
      or r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
    )
    and p_offset between 0 and 100000
  order by r.created_at desc, r.id desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

create function public.client_consultation_parties()
returns table (
  consultation_id uuid,
  consultation_request_id uuid,
  intake_id uuid,
  attorney_display_name text,
  practice_area_name text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    c.id,
    r.id,
    r.intake_id,
    public.discovery_presentable_text(p.display_name),
    pa.name
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultations as c on c.client_id = cp.id
  join public.consultation_requests as r on r.id = c.consultation_request_id and r.client_id = cp.id
  cross join lateral public.consultation_view(c.id) as v
  left join public.attorney_profiles as p on p.id = r.selected_attorney_id
  left join lateral (
    select x.practice_area_id
    from public.intake_revisions as x
    join public.intakes as i on i.id = x.intake_id
    where x.intake_id = r.intake_id
      and i.client_id = cp.id
    order by x.revision_number desc
    limit 1
  ) as l on true
  left join public.practice_areas as pa on pa.id = l.practice_area_id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
  -- client_consultations' own order and bound, so both reads list the same Consultations.
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

-- ---------------------------------------------------------------------------
-- Attorney read.
-- ---------------------------------------------------------------------------

create function public.attorney_activity_counts(p_from timestamptz, p_until timestamptz)
returns table (
  metric text,
  dimension text,
  value bigint
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
  ),
  period as (
    select me.id
    from me
    where p_from is not null
      and p_until is not null
      and p_until > p_from
      and extract(epoch from p_until) - extract(epoch from p_from) <= 31622400
  ),
  ended_requests as (
    select case when r.state = 'accepted' then 'accepted' else public.decision_ended_reason(r.id) end as outcome
    from period
    join public.consultation_requests as r
      on r.selected_attorney_id = period.id
     and r.state in ('accepted', 'declined', 'expired', 'cancelled')
    where r.created_at >= p_from
      and r.created_at < p_until
      and coalesce(public.decision_request_offered(r.id), false)
  ),
  ended_consultations as (
    select c.state as outcome
    from period
    join public.consultations as c
      on c.attorney_id = period.id
     and c.state in ('completed', 'cancelled', 'no_show', 'technical_failure')
    where c.ended_at >= p_from
      and c.ended_at < p_until
  )
  select
    d.metric,
    d.dimension,
    case d.metric
      when 'requests' then (select count(*) from ended_requests as x where x.outcome = d.dimension)
      else (select count(*) from ended_consultations as x where x.outcome = d.dimension)
    end
  from period
  cross join (
    values
      (1, 'requests', 'accepted'),
      (2, 'requests', 'declined'),
      (3, 'requests', 'expired'),
      (4, 'requests', 'withdrawn'),
      (5, 'requests', 'could_not_proceed'),
      (6, 'consultations', 'completed'),
      (7, 'consultations', 'cancelled'),
      (8, 'consultations', 'no_show'),
      (9, 'consultations', 'technical_failure')
  ) as d(n, metric, dimension)
  order by d.n;
$function$;

-- ---------------------------------------------------------------------------
-- Staff read.
-- ---------------------------------------------------------------------------

create function public.staff_payment_dispute_events(p_payment_id uuid)
returns table (
  exception_id uuid,
  exception_type text,
  severity text,
  status text,
  detected_at timestamptz,
  evidence_reference jsonb,
  resolved_at timestamptz,
  resolution_notes text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    e.id, e.exception_type, e.severity, e.status, e.detected_at, e.evidence_reference, e.resolved_at,
    e.resolution_notes
  from public.reconciliation_exceptions as e
  where public.has_staff_capability('manage_financial_operations', null, false)
    and public.exception_family(e.exception_type) = 'financial'
    and p_payment_id is not null
    and e.canonical_type = 'payment_transaction'
    and e.canonical_id = p_payment_id
    and e.exception_type in ('dispute_opened', 'dispute_updated', 'dispute_closed')
  order by e.detected_at, e.id
  limit 200;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.client_requests(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.client_requests(text, integer) to authenticated;
revoke all on function public.client_consultation_parties()
  from public, anon, authenticated, service_role;
grant execute on function public.client_consultation_parties() to authenticated;
revoke all on function public.attorney_activity_counts(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_activity_counts(timestamptz, timestamptz) to authenticated;
revoke all on function public.staff_payment_dispute_events(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_payment_dispute_events(uuid) to authenticated;

comment on function public.client_requests(text, integer) is
  'DEV-001 client workspace: one page (25 rows, plus one) of the caller''s own Requests across their Intakes, newest first (Request and Intake ids, state, expired_due, path, presentable attorney name, modality, duration, slot, response deadline, creation, Consultation id), with the values of client_request and client_request_decision; no amount, quote or message; segment open (undecided states) or all; offsets 0 to 100000; an active User with a Client Profile only.';
comment on function public.client_consultation_parties() is
  'DEV-001 client workspace: for exactly the Consultations client_consultations lists the caller (same order, at most 200): the Consultation, Request and Intake ids, the presentable attorney name (client_request''s rule) and the practice area name of the caller''s latest revision of that Intake; nothing else of the attorney; an active User with a Client Profile only.';
comment on function public.attorney_activity_counts(timestamptz, timestamptz) is
  'DEV-001 attorney workspace: counts only, for a period [from, until) of at most 366 days: the Requests attorney_request answers the caller by outcome (accepted, declined, expired, withdrawn, could_not_proceed; by creation instant) and the Consultations attorney_consultation_history answers by end state (completed, cancelled, no_show, technical_failure; by end instant); every dimension answered, zero included; an approved Attorney Profile at aal2 only.';
comment on function public.staff_payment_dispute_events(uuid) is
  'DEV-001 finance workspace: one payment''s provider dispute review items (dispute_opened, dispute_updated, dispute_closed), oldest first, at most 200, with a subset of staff_finance_exceptions'' columns (id, type, severity, status, detection, evidence, resolution); a global manage_financial_operations grant at aal2 only, the financial family only.';
