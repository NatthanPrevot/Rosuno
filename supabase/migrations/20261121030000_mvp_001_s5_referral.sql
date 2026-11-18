-- MVP-001 S5 (3 of 3): client selection and Referral creation, the outcome seam and the client's attempt list
-- (MVP-001 Packet S5 "client selection", "referral with fresh evaluations, pool snapshot, presented set, attempt
-- ordinal and outcome"; MBS section 10 deliverables and failure tests; DM section 7; PS section 14; TA sections 8
-- and 58; Packet section 3 gates "referral outcome taxonomy" and "intake visibility to an attorney before
-- acceptance: nothing shown"; Packet section 4 "fresh evaluations").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16).
--
-- referral_create (EXECUTE for authenticated only): the client chooses; Rosuno never selects for the client and
-- never silently replaces the client's choice. For the caller's own Client Profile (lock_current_client: User FOR
-- SHARE, Client Profile FOR NO KEY UPDATE) and one of its own Intakes (FOR UPDATE, after which its expiry is
-- evaluated as every client command does), in state submitted or active, in one transaction:
-- 1. the attempt ordinal is the Intake's highest plus one (the Intake lock serializes attempts; the P1 unique key
--    backs it), at most 50 attempts per Intake (a fixed abuse bound, not a policy value);
-- 2. the Referral is created (attorney = the client's choice, allocation_method client_selected, the
--    jurisdiction the client searched);
-- 3. the eligible-pool snapshot: every candidate (an approved Attorney Profile of an active User with a licence
--    row in the jurisdiction; at most 500, lowest ids first, the directory's own candidate bound) is evaluated
--    afresh by the decision-point recorder in the jurisdiction context, and each one evaluated eligible becomes a
--    pool entry (eligible_as_of = that evaluation's as_of instant);
-- 4. the presented set is re-derived authoritatively at selection (TA section 58: the page the client saw is
--    never trusted) from the pool with the client's own filters (practice area, availability) and page, in the
--    directory's neutral order display_name_then_id, and written as presentation rows: display position, the
--    client filters with what remained after each (per-filter attribution), the platform's own presentation rules
--    (eligible pool, approved profile, active account, presentable display name, the order, page and page size),
--    narrowing actor client when the client applied a filter beyond the jurisdiction (else platform), shown_at the
--    selection instant;
-- 5. the selected attorney must be in that presented page; then eligibility is evaluated afresh for the selected
--    scope (the pool evaluation in the jurisdiction context, or a new practice-area-context evaluation when a
--    practice area is filtered), and Bookability afresh for the chosen path: instant through S4's
--    scheduling_evaluate_bookability with no slot (eligibility, Instant intent, Presence, not in a
--    Consultation), scheduled through scheduling_evaluate_scheduled_availability (eligibility, scheduling policy,
--    an offered window). The modality is not chosen at referral time (modalities are PS-A3-gated and chosen with
--    the S6 request), so both evaluations record the literal modality 'unselected';
-- 6. anything not eligible, not bookable or not presented answers not_available and the transaction leaves
--    nothing of the attempt (the evaluations included); otherwise one audit event (client actor; identifiers and
--    counts only, no free text) and created.
-- The Intake's state is not changed (whether a Referral moves a submitted Intake to active is an open owner
-- question). Outcomes: created (with the Referral id), invalid, not_found (no Client Profile, or not the caller's
-- own Intake: answered alike), intake_not_ready, not_available, rate_limited.
--
-- referral_record_outcome (internal; for S6 and S8): the referral outcome taxonomy is regulatory-gated (Packet
-- section 3), so a code is recorded only when the 'referral' policy the environment-anchored resolver selects for
-- the Referral's jurisdiction (no regulatory mode) lists it in its parameters key outcome_codes (an array of 1..100
-- lower-snake codes). Unset, unselectable or malformed configuration answers not_configured; a code not listed
-- answers invalid; an outcome is recorded once (already_recorded). The calling command audits its own decision.
--
-- client_referrals (EXECUTE for authenticated only): the caller's own Intake's attempts, in order: ordinal,
-- creation time, the attorney's presentable display name, the chosen path and the recorded outcome code. Nothing
-- else; another client's or an unknown Intake answers no row. Attorneys see nothing of Referrals or Intakes in S5
-- (no grant or policy on the referral relations; nothing of an Intake before acceptance).

-- ---------------------------------------------------------------------------
-- Referral creation (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.referral_create(
  p_intake_id uuid,
  p_attorney_id uuid,
  p_jurisdiction_id uuid,
  p_practice_area_id uuid,
  p_path text,
  p_availability_filter text,
  p_page integer
)
returns table (outcome text, referral_id uuid)
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
  v_state text;
  v_attempts integer;
  v_ordinal integer;
  v_now timestamptz;
  v_referral uuid;
  v_candidate uuid;
  v_evaluation uuid;
  v_result text;
  v_evaluated integer := 0;
  v_pool integer := 0;
  v_pool_evaluation uuid;
  v_set jsonb;
  v_counts jsonb;
  v_client_context jsonb;
  v_platform_context jsonb;
  v_actor text;
  v_presented integer;
  v_selected_evaluation uuid;
  v_bookability_result text;
  v_bookability uuid;
  v_policy_references jsonb;
begin
  if p_intake_id is null
     or p_attorney_id is null
     or p_jurisdiction_id is null
     or p_path is null
     or p_path not in ('instant', 'scheduled')
     or p_availability_filter is null
     or p_availability_filter not in ('any', 'instant', 'scheduled')
     or p_page is null
     or p_page not between 1 and 25 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select l.user_id, l.client_id into v_user, v_client from public.lock_current_client() as l;
  if v_client is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  perform 1
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  v_state := public.intake_expire_if_due(p_intake_id);
  if v_state is null or v_state not in ('submitted', 'active') then
    return query select 'intake_not_ready'::text, null::uuid;
    return;
  end if;
  select count(*)::integer, coalesce(max(r.attempt_ordinal), 0)
  into v_attempts, v_ordinal
  from public.referrals as r
  where r.intake_id = p_intake_id;
  if v_attempts >= 50 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  if not exists (select 1 from public.jurisdictions as j where j.id = p_jurisdiction_id)
     or (p_practice_area_id is not null
         and not exists (
           select 1 from public.practice_areas as a where a.id = p_practice_area_id and a.active
         ))
     or exists (
       select 1 from public.attorney_profiles as p
       where p.id = p_attorney_id and p.user_id = v_user
     ) then
    return query select 'not_available'::text, null::uuid;
    return;
  end if;
  begin
    v_now := clock_timestamp();
    v_ordinal := v_ordinal + 1;
    insert into public.referrals (
      intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method
    ) values (
      p_intake_id, p_attorney_id, p_jurisdiction_id, v_ordinal, 'client_selected'
    )
    returning id into v_referral;

    -- The eligible-pool snapshot, from fresh decision-point evaluations.
    for v_candidate in
      select p.id
      from public.attorney_profiles as p
      join public.users as u on u.id = p.user_id
      where p.profile_state = 'approved'
        and u.account_state = 'active'
        and exists (
          select 1 from public.licenses as l
          where l.attorney_id = p.id and l.jurisdiction_id = p_jurisdiction_id
        )
      order by p.id
      limit 500
    loop
      select d.evaluation_id, d.result
      into v_evaluation, v_result
      from public.eligibility_record_decision_point(v_candidate, p_jurisdiction_id, null, v_now) as d;
      v_evaluated := v_evaluated + 1;
      if v_result = 'eligible' then
        insert into public.referral_eligible_pool_entries (
          referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of, pool_reason
        ) values (
          v_referral, v_candidate, v_evaluation, v_now,
          jsonb_build_object('basis', 'eligible_at_selection', 'context', 'jurisdiction')
        );
        v_pool := v_pool + 1;
        if v_candidate = p_attorney_id then
          v_pool_evaluation := v_evaluation;
        end if;
      end if;
    end loop;

    -- The presented set, re-derived at selection from the pool and the client's filters.
    select coalesce(
             jsonb_agg(to_jsonb(s) order by s.display_position nulls last, s.attorney_id),
             '[]'::jsonb)
    into v_set
    from public.discovery_presented_set(
      p_jurisdiction_id, p_practice_area_id, p_availability_filter, v_referral
    ) as s;
    select jsonb_build_object(
             'presentable', count(*) filter (where (e ->> 'presentable')::boolean),
             'practice_area', count(*) filter (
               where (e ->> 'presentable')::boolean and (e ->> 'passes_practice_area')::boolean),
             'availability', count(*) filter (
               where (e ->> 'presentable')::boolean
                 and (e ->> 'passes_practice_area')::boolean
                 and (e ->> 'passes_availability')::boolean),
             'listed', count(*) filter (where e ->> 'display_position' is not null))
    into v_counts
    from jsonb_array_elements(v_set) as e;
    v_client_context := jsonb_build_object(
      'jurisdiction_id', p_jurisdiction_id,
      'practice_area_id', p_practice_area_id,
      'availability', p_availability_filter,
      'remaining_after', jsonb_build_object(
        'practice_area', v_counts -> 'practice_area',
        'availability', v_counts -> 'availability'
      )
    );
    v_platform_context := jsonb_build_object(
      'derivation', 'rederived_at_selection',
      'eligibility', 'pool_eligible_at_selection',
      'profile_state', 'approved',
      'account_state', 'active',
      'display_name', 'presentable',
      'order', 'display_name_then_id',
      'page', p_page,
      'page_size', 20,
      'candidate_bound', 500,
      'evaluated', v_evaluated,
      'pool_size', v_pool,
      'presentable', v_counts -> 'presentable',
      'listed', v_counts -> 'listed'
    );
    v_actor := case
      when p_practice_area_id is not null or p_availability_filter <> 'any' then 'client'
      else 'platform'
    end;
    insert into public.referral_presentations (
      referral_id, attorney_id, display_position, client_filter_context,
      platform_presentation_filter_context, narrowing_actor, shown_at
    )
    select
      v_referral,
      (e ->> 'attorney_id')::uuid,
      (e ->> 'display_position')::integer,
      v_client_context,
      v_platform_context,
      v_actor,
      v_now
    from jsonb_array_elements(v_set) as e
    where e ->> 'display_position' is not null
      and (e ->> 'display_position')::integer between (p_page - 1) * 20 + 1 and p_page * 20;
    get diagnostics v_presented = row_count;
    if v_pool_evaluation is null or not exists (
      select 1
      from public.referral_presentations as rp
      where rp.referral_id = v_referral
        and rp.attorney_id = p_attorney_id
    ) then
      raise exception 'referral not available' using errcode = 'RS501';
    end if;

    -- Fresh eligibility for the selected scope and fresh Bookability for the chosen path.
    if p_practice_area_id is null then
      v_selected_evaluation := v_pool_evaluation;
    else
      select d.evaluation_id, d.result
      into v_selected_evaluation, v_result
      from public.eligibility_record_decision_point(
        p_attorney_id, p_jurisdiction_id, p_practice_area_id, v_now
      ) as d;
      if v_result is distinct from 'eligible' then
        raise exception 'referral not available' using errcode = 'RS501';
      end if;
    end if;
    if p_path = 'instant' then
      select b.result, b.evaluation_id
      into v_bookability_result, v_bookability
      from public.scheduling_evaluate_bookability(
        p_attorney_id, v_selected_evaluation, 'referral', v_referral, 'unselected', null, null
      ) as b;
    else
      select b.result, b.evaluation_id
      into v_bookability_result, v_bookability
      from public.scheduling_evaluate_scheduled_availability(
        p_attorney_id, v_selected_evaluation, 'referral', v_referral, 'unselected'
      ) as b;
    end if;
    if v_bookability_result is distinct from 'bookable' then
      raise exception 'referral not available' using errcode = 'RS501';
    end if;

    select e.policy_references into v_policy_references
    from public.eligibility_evaluations as e
    where e.id = v_selected_evaluation;
    insert into public.audit_events (
      actor_user_id, actor_type, action_code, resource_type, resource_id,
      before_snapshot, after_snapshot, reason_code, policy_references,
      jurisdiction_id, occurred_at
    ) values (
      v_user, 'client', 'referral.created', 'referral', v_referral,
      null,
      jsonb_build_object(
        'intake_id', p_intake_id,
        'attempt_ordinal', v_ordinal,
        'allocation_method', 'client_selected',
        'attorney_id', p_attorney_id,
        'request_path', p_path,
        'pool_size', v_pool,
        'presented', v_presented,
        'eligibility_evaluation_id', v_selected_evaluation,
        'bookability_evaluation_id', v_bookability
      ),
      null, v_policy_references, p_jurisdiction_id, clock_timestamp()
    );
  exception
    when sqlstate 'RS501' or foreign_key_violation then
      return query select 'not_available'::text, null::uuid;
      return;
  end;
  return query select 'created'::text, v_referral;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The outcome seam (internal; for S6 and S8).
-- ---------------------------------------------------------------------------

-- Outcomes: recorded (with the policy version that lists the code), invalid, not_found, already_recorded,
-- not_configured.
create function public.referral_record_outcome(p_referral_id uuid, p_outcome_code text)
returns table (outcome text, policy_version_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_referral public.referrals;
  v_selection text;
  v_policy uuid;
  v_codes jsonb;
begin
  if p_referral_id is null
     or p_outcome_code is null
     or p_outcome_code !~ '^[a-z][a-z0-9_]{1,63}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select r.* into v_referral
  from public.referrals as r
  where r.id = p_referral_id
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_referral.outcome_code is not null then
    return query select 'already_recorded'::text, null::uuid;
    return;
  end if;
  select s.outcome, s.policy_version_id
  into v_selection, v_policy
  from public.policy_select_version('referral', v_referral.jurisdiction_id, null, clock_timestamp()) as s;
  if v_selection is distinct from 'selected' or v_policy is null then
    return query select 'not_configured'::text, null::uuid;
    return;
  end if;
  select v.parameters -> 'outcome_codes' into v_codes
  from public.policy_versions as v
  where v.id = v_policy;
  if jsonb_typeof(v_codes) is distinct from 'array'
     or jsonb_array_length(v_codes) not between 1 and 100
     or exists (
       select 1 from jsonb_array_elements(v_codes) as c
       where jsonb_typeof(c) <> 'string' or (c #>> '{}') !~ '^[a-z][a-z0-9_]{1,63}$'
     ) then
    return query select 'not_configured'::text, null::uuid;
    return;
  end if;
  if not (v_codes ? p_outcome_code) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  update public.referrals as r
  set outcome_code = p_outcome_code,
      outcome_recorded_at = clock_timestamp()
  where r.id = p_referral_id;
  return query select 'recorded'::text, v_policy;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The client's attempt list (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.client_referrals(p_intake_id uuid)
returns table (
  attempt_ordinal integer,
  created_at timestamptz,
  attorney_display_name text,
  request_path text,
  outcome_code text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    r.attempt_ordinal,
    r.created_at,
    public.discovery_presentable_text(p.display_name),
    b.request_path,
    r.outcome_code
  from public.users as u
  join public.client_profiles as c on c.user_id = u.id
  join public.intakes as i on i.client_id = c.id and i.id = p_intake_id
  join public.referrals as r on r.intake_id = i.id
  left join public.attorney_profiles as p on p.id = r.attorney_id
  left join lateral (
    select case
      when e.availability_basis ? 'request_path' then e.availability_basis ->> 'request_path'
      when e.presence_observed is not null then 'instant'
    end as request_path
    from public.bookability_evaluations as e
    where e.context_type = 'referral'
      and e.context_id = r.id
      and e.attorney_id = r.attorney_id
      and e.result = 'bookable'
    order by e.evaluated_at, e.id
    limit 1
  ) as b on true
  where p_intake_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active'
  order by r.attempt_ordinal
  limit 50;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.referral_create(uuid, uuid, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.referral_create(uuid, uuid, uuid, uuid, text, text, integer) to authenticated;
revoke all on function public.referral_record_outcome(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.client_referrals(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_referrals(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.referral_create(uuid, uuid, uuid, uuid, text, text, integer) is
  'MVP-001 S5: the client''s selection becomes a client_selected Referral of the caller''s own submitted or active Intake with its attempt ordinal, the eligible-pool snapshot from fresh decision-point evaluations, the presented set re-derived at selection with per-filter attribution and order, and fresh eligibility and Bookability for the chosen path; anything not eligible, bookable or presented leaves nothing. Audited. Outcomes: created, invalid, not_found, intake_not_ready, not_available, rate_limited.';
comment on function public.referral_record_outcome(uuid, text) is
  'MVP-001 S5 (internal; S6 and S8): records a Referral outcome once, only a code the selected referral policy lists in outcome_codes for the Referral''s jurisdiction. Outcomes: recorded, invalid, not_found, already_recorded, not_configured.';
comment on function public.client_referrals(uuid) is
  'MVP-001 S5: the caller''s own Intake''s Referral attempts (ordinal, creation time, attorney display name, path, outcome code); nothing else.';
comment on table public.referrals is
  'Durable Referral attempt context (attempt sequence per Intake; client_selected or allocated). Attorney acceptance belongs to Consultation Request and is not a Referral lifecycle state. Written only by the MVP-001 S5 functions; never deleted; only its outcome is recorded once.';
