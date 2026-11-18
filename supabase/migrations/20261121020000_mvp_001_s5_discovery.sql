-- MVP-001 S5 (2 of 3): discovery (MVP-001 Packet S5 "a decision-point eligibility recorder for the referral,
-- request and acceptance contexts", "public attorney profiles with a field allowlist", "search with objective
-- filters and sorting", "presentation with ordering"; MBS sections 10, 17, 18.1 and 18.6; TA sections 8, 28, 29,
-- 55 and 58; PS sections 4.4 and 14; MB sections 24, 28-30 and 123-125; Packet section 3 gates "public content,
-- Privacy, Terms, disclosures; filters and ranking" and PS-A3 "public profile fields beyond PS").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). Nothing here
-- stores a search result: listability, Available Now and scheduled availability are derived on every read from
-- canonical rows and are never persisted (TA sections 28 and 55: search and caches are never authority; directory
-- renders persist nothing). Only a decision point persists evaluations (TA section 58; MBS section 2.4), through
-- eligibility_record_decision_point and scheduling_evaluate_scheduled_availability below and S4's
-- scheduling_evaluate_bookability, each called inside a command's own transaction (S5 referral_create; later the
-- S6 request and S8 acceptance commands).
--
-- Decision-point eligibility (internal): eligibility_record_decision_point evaluates one attorney in one
-- jurisdiction (practice_area_id null: the jurisdiction context) or practice-area context with the adopted engine
-- (eligibility_assessment, 20261117020000), on canonical rows locked FOR SHARE in the order the staff recorder
-- uses (User -> Attorney Profile -> licences -> insurance -> discipline -> practice-area authorisations ->
-- eligibility policy versions -> their authority references), and appends exactly one eligibility_evaluations row
-- with the derived result, factors, policy and evidence references, as the staff recorder does. It does not
-- audit: the command that calls it records its own audit event for what it decides.
--
-- Listability (derived; never stored): an attorney is publicly listed in a jurisdiction when the Attorney Profile
-- is approved, the User is active, the attorney holds at least one licence row there, the display name is present
-- and carries no banned claim (below), and the adopted engine says eligible now in the jurisdiction context (and in
-- the practice-area context when a practice area is filtered). The engine already decides account, profile,
-- policy, licence, insurance, discipline and practice-area factors; it does not read the jurisdiction's
-- lifecycle_state, and nothing here adds a jurisdiction-state rule (with no applicable eligibility policy nobody
-- is eligible, so nobody is listed). A practice area shown for an attorney is an active one the attorney holds an
-- authorised authorisation for in that jurisdiction and is eligible for in that practice-area context.
--
-- Banned claims (MBS section 10; MB section 28): a display name, headline or bio containing best match,
-- recommended attorney, perfect attorney, AI-selected attorney, right lawyer for you, best attorney or Rosuno
-- recommends (any case, any punctuation between the words) is never shown: the field is withheld (null), never
-- rewritten; an attorney whose display name is withheld is not listed.
--
-- Objective filters and order (Packet section 3: "objective filters only"; TA section 29: sort options are
-- policy-driven and no sort policy is configured, so the one order is neutral): jurisdiction (required), practice
-- area (optional) and availability (any, instant: Available Now, scheduled: an offered window in the horizon).
-- Order 'display_name_then_id': case-folded display name, then display name, then the profile id, all in the "C"
-- collation. No ranking, recommendation or paid placement exists. Fixed technical bounds (not policy values): at
-- most 500 candidate attorneys per jurisdiction (lowest profile ids first), 20 per page, 25 pages, 100 listed
-- jurisdictions, 200 practice areas, 20 jurisdictions and 50 practice areas on a profile.
--
-- Availability (derived; MBS section 9; DM section 8): Available Now is S4 Presence (scheduling_presence: a live,
-- unrevoked Instant intent renewed by server observation within the bookability policy's presence window) and the
-- attorney not being in a Consultation that has started and not ended: the same factors the instant Bookability
-- Evaluation records, and it is shown only for an attorney listed as eligible. An offered window is a part of the
-- attorney's S4 availability windows (scheduling_expand_availability) inside the discovery horizon, starting no
-- earlier than now plus the jurisdiction's scheduling policy minimum_notice_seconds, and not overlapping a
-- Blackout, an active Hold or a confirmed Booking. The discovery horizon is the next 14 days: a fixed technical
-- display bound within S4's 63-date expansion bound, not a booking-window policy. No scheduling policy for the
-- jurisdiction: no offered window. No duration-based slot is offered (durations are PS-A3-gated); any non-empty
-- free part counts.
--
-- Public reads (EXECUTE for anon and authenticated; stable security definer; strict column allowlist; nothing
-- persisted): public_discovery_filters, public_attorney_directory and public_attorney_profile. They expose only an
-- Attorney Profile id, the PS section 4.4 public fields (display name, headline, bio, years of experience;
-- PS-A3's further public fields are not adopted), jurisdiction and practice-area catalog entries, and the derived
-- availability above. Never verification evidence, licence numbers, contact details, user ids, emails, audit or
-- internal referral data. An attorney who is not listed and an unknown id answer identically: no row.
--
-- Scheduled availability at a decision point (internal): scheduling_evaluate_scheduled_availability appends one
-- Bookability Evaluation for the scheduled path before a slot is chosen (slot null): bookable when the given
-- Eligibility Evaluation is eligible and an offered window exists; each factor is recorded with its reason, and
-- the first offered window and the request path are the availability basis. The instant path uses S4's
-- scheduling_evaluate_bookability with a null slot.

-- ---------------------------------------------------------------------------
-- Decision-point eligibility (internal; executable by no API role).
-- ---------------------------------------------------------------------------

-- Appends one Eligibility Evaluation derived by the adopted engine and answers (evaluation_id, result). Answers
-- (null, 'invalid') for a malformed call (as_of more than 15 minutes before or 1 minute after now, or an unknown
-- practice area) and (null, 'unverifiable') when the engine cannot verify the facts (an unknown attorney or a
-- refused bounded read); nothing is written then.
create function public.eligibility_record_decision_point(
  p_attorney_id uuid,
  p_jurisdiction_id uuid,
  p_practice_area_id uuid,
  p_as_of timestamptz
)
returns table (evaluation_id uuid, result text)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_time timestamptz := clock_timestamp();
  v_user uuid;
  v_derived jsonb;
  v_id uuid;
begin
  if p_attorney_id is null
     or p_jurisdiction_id is null
     or p_as_of is null
     or p_as_of > v_time + interval '1 minute'
     or p_as_of < v_time - interval '15 minutes'
     or (p_practice_area_id is not null
         and not exists (select 1 from public.practice_areas as a where a.id = p_practice_area_id))
     or not exists (select 1 from public.jurisdictions as j where j.id = p_jurisdiction_id) then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;
  select p.user_id into v_user from public.attorney_profiles as p where p.id = p_attorney_id;
  if not found then
    return query select null::uuid, 'unverifiable'::text;
    return;
  end if;
  perform 1 from public.users as u where u.id = v_user for share;
  perform 1 from public.attorney_profiles as p where p.id = p_attorney_id for share;
  perform 1 from public.licenses as l
  where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id
  order by l.id for share;
  perform 1 from public.insurance_records as i
  where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id
  order by i.id for share;
  perform 1 from public.discipline_records as d
  where d.attorney_id = p_attorney_id and d.jurisdiction_id = p_jurisdiction_id
  order by d.id for share;
  perform 1 from public.practice_area_authorisations as a
  where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id
  order by a.id for share;
  perform 1 from public.policy_versions as v
  where v.policy_type_code = 'eligibility'
    and v.jurisdiction_id = p_jurisdiction_id
  order by v.id for share;
  perform 1 from public.policy_authority_references as r
  where r.policy_version_id in (
    select v.id from public.policy_versions as v
    where v.policy_type_code = 'eligibility'
      and v.jurisdiction_id = p_jurisdiction_id)
  order by r.id for share of r;
  v_derived := public.eligibility_assessment(p_attorney_id, p_jurisdiction_id, p_practice_area_id, p_as_of);
  if not coalesce((v_derived ->> 'verifiable')::boolean, false)
     or (v_derived ->> 'result') not in ('eligible', 'not_eligible', 'undetermined') then
    return query select null::uuid, 'unverifiable'::text;
    return;
  end if;
  insert into public.eligibility_evaluations (
    attorney_id, jurisdiction_id, context_type, context_id,
    evaluated_at, policy_references, result, factor_results,
    evidence_references, as_of
  ) values (
    p_attorney_id, p_jurisdiction_id,
    case when p_practice_area_id is null then 'jurisdiction' else 'practice_area' end,
    p_practice_area_id,
    clock_timestamp(), v_derived -> 'policy_references', v_derived ->> 'result',
    public.eligibility_normalized_factors(v_derived -> 'factor_results'),
    v_derived -> 'evidence_references', p_as_of
  )
  returning id into v_id;
  return query select v_id, v_derived ->> 'result';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Derived discovery views (internal; executable by no API role; persist nothing).
-- ---------------------------------------------------------------------------

-- The text as given, or null when it is blank or carries a banned claim (MBS section 10).
create function public.discovery_presentable_text(p_text text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_text is null or btrim(p_text) = '' then null
    when ' ' || regexp_replace(lower(p_text), '[^a-z0-9]+', ' ', 'g') || ' '
         ~ ' (best match|recommended attorney|perfect attorney|ai selected attorney|right lawyer for you|best attorney|rosuno recommends) '
      then null
    else p_text
  end;
$function$;

-- Available Now: S4 Presence observed and not in a Consultation that has started and not ended (the instant
-- Bookability Evaluation's own factors besides eligibility, which the caller has established).
create function public.discovery_available_now(p_attorney uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_observed boolean;
begin
  if p_attorney is null then
    return false;
  end if;
  select pr.observed into v_observed from public.scheduling_presence(p_attorney) as pr;
  return coalesce(v_observed, false) and not exists (
    select 1
    from public.consultations as c
    where c.attorney_id = p_attorney
      and c.started_at is not null
      and c.ended_at is null
  );
end;
$function$;

-- The attorney's offered windows in the 14-day discovery horizon for a jurisdiction, earliest first, at most
-- p_limit (1..20): availability windows from now plus the jurisdiction scheduling policy's minimum notice, minus
-- Blackouts, active Holds and confirmed Bookings. No complete scheduling policy for the jurisdiction: no row.
create function public.scheduling_offered_windows(
  p_attorney uuid,
  p_jurisdiction uuid,
  p_limit integer
)
returns table (window_start timestamptz, window_end timestamptz, policy_version_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_outcome text;
  v_policy uuid;
  v_parameters jsonb;
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_attorney is null or p_jurisdiction is null or p_limit is null or p_limit not between 1 and 20 then
    return;
  end if;
  select p.outcome, p.policy_version_id, p.parameters
  into v_outcome, v_policy, v_parameters
  from public.scheduling_policy('scheduling', p_jurisdiction, v_now) as p;
  if v_outcome is distinct from 'selected' then
    return;
  end if;
  v_from := v_now + make_interval(secs => (v_parameters ->> 'minimum_notice_seconds')::bigint);
  v_to := v_now + interval '14 days';
  if v_from >= v_to then
    return;
  end if;
  return query
  with offered as (
    select range_agg(tstzrange(greatest(w.window_start, v_from), least(w.window_end, v_to), '[)')) as ranges
    from public.scheduling_expand_availability(
      p_attorney,
      (v_now at time zone 'UTC')::date - 1,
      (v_to at time zone 'UTC')::date + 1
    ) as w
    where w.window_end > v_from
      and w.window_start < v_to
  ),
  busy as (
    select range_agg(tstzrange(x.s, x.e, '[)')) as ranges
    from (
      select b.starts_at as s, b.ends_at as e
      from public.blackouts as b
      where b.attorney_id = p_attorney
        and b.starts_at < v_to
        and b.ends_at > v_from
      union all
      select h.slot_start_at, h.slot_end_at
      from public.slot_holds as h
      where h.attorney_id = p_attorney
        and h.released_at is null
        and h.expires_at > v_now
        and h.slot_start_at < v_to
        and h.slot_end_at > v_from
      union all
      select k.starts_at, k.ends_at
      from public.bookings as k
      where k.attorney_id = p_attorney
        and k.status = 'confirmed'
        and k.starts_at < v_to
        and k.ends_at > v_from
    ) as x
  ),
  open_parts as (
    select f.segment
    from offered
    cross join busy
    cross join lateral unnest(
      coalesce(offered.ranges, '{}'::tstzmultirange) - coalesce(busy.ranges, '{}'::tstzmultirange)
    ) as f(segment)
    where not isempty(f.segment)
  )
  select lower(o.segment), upper(o.segment), v_policy
  from open_parts as o
  order by lower(o.segment)
  limit p_limit;
end;
$function$;

-- The candidates and the presented order for one jurisdiction and the client's filters. Each candidate is an
-- approved Attorney Profile of an active User holding a licence row in the jurisdiction (at most 500, lowest ids
-- first) that is eligible in the jurisdiction context: per the adopted engine now (p_referral null, the public
-- directory) or by its pool entry in that Referral (p_referral set: the presented set re-derived at selection from
-- the Referral's fresh evaluations, TA section 58). For each: whether its display name is presentable, whether it
-- passes the practice-area filter (eligible in that practice-area context now; true without a filter), Available
-- Now, whether an offered window exists, whether it passes the availability filter, and its display position
-- (1-based, order display_name_then_id) when it passes every filter, else null. No row for a malformed call.
create function public.discovery_presented_set(
  p_jurisdiction uuid,
  p_practice_area uuid,
  p_availability text,
  p_referral uuid
)
returns table (
  attorney_id uuid,
  display_name text,
  headline text,
  years_experience smallint,
  presentable boolean,
  passes_practice_area boolean,
  available_now boolean,
  has_scheduled_availability boolean,
  passes_availability boolean,
  display_position integer
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_jurisdiction is null
     or p_availability is null
     or p_availability not in ('any', 'instant', 'scheduled')
     or (p_practice_area is not null
         and not exists (
           select 1 from public.practice_areas as a where a.id = p_practice_area and a.active
         )) then
    return;
  end if;
  return query
  with candidates as (
    select p.id, p.display_name, p.headline, p.years_experience
    from public.attorney_profiles as p
    join public.users as u on u.id = p.user_id
    where p.profile_state = 'approved'
      and u.account_state = 'active'
      and exists (
        select 1 from public.licenses as l
        where l.attorney_id = p.id and l.jurisdiction_id = p_jurisdiction
      )
    order by p.id
    limit 500
  ),
  eligible as (
    select c.*
    from candidates as c
    where case
      when p_referral is null then
        (public.eligibility_assessment(c.id, p_jurisdiction, null, v_now) ->> 'result') = 'eligible'
      else exists (
        select 1 from public.referral_eligible_pool_entries as e
        where e.referral_id = p_referral and e.attorney_id = c.id
      )
    end
  ),
  flagged as (
    select
      e.id,
      e.display_name,
      e.headline,
      e.years_experience,
      public.discovery_presentable_text(e.display_name) is not null as presentable,
      (p_practice_area is null
       or (public.eligibility_assessment(e.id, p_jurisdiction, p_practice_area, v_now) ->> 'result')
          = 'eligible') as passes_practice_area,
      public.discovery_available_now(e.id) as available_now,
      exists (select 1 from public.scheduling_offered_windows(e.id, p_jurisdiction, 1)) as has_scheduled
    from eligible as e
  ),
  judged as (
    select
      f.*,
      (p_availability = 'any'
       or (p_availability = 'instant' and f.available_now)
       or (p_availability = 'scheduled' and f.has_scheduled)) as passes_availability
    from flagged as f
  ),
  ordered as (
    select
      j.id,
      row_number() over (
        order by lower(j.display_name) collate "C", j.display_name collate "C", j.id
      )::integer as position
    from judged as j
    where j.presentable and j.passes_practice_area and j.passes_availability
  )
  select
    j.id,
    j.display_name,
    j.headline,
    j.years_experience,
    j.presentable,
    j.passes_practice_area,
    j.available_now,
    j.has_scheduled,
    j.passes_availability,
    o.position
  from judged as j
  left join ordered as o on o.id = j.id
  order by o.position nulls last, j.id;
end;
$function$;

-- The names of the active practice areas the attorney holds an authorised authorisation for in the jurisdiction
-- and is eligible for now in that practice-area context, by name (at most 50).
create function public.discovery_practice_area_names(p_attorney uuid, p_jurisdiction uuid)
returns text[]
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(array_agg(x.name order by x.name collate "C", x.code collate "C"), array[]::text[])
  from (
    select a.name, a.code
    from public.practice_areas as a
    join public.practice_area_authorisations as z
      on z.practice_area_id = a.id
     and z.attorney_id = p_attorney
     and z.jurisdiction_id = p_jurisdiction
     and z.status = 'authorised'
    where a.active
      and (public.eligibility_assessment(p_attorney, p_jurisdiction, a.id, clock_timestamp()) ->> 'result')
          = 'eligible'
    order by a.name collate "C", a.code collate "C"
    limit 50
  ) as x;
$function$;

-- Whether at least one attorney is listed in the jurisdiction now (stops at the first).
create function public.discovery_jurisdiction_listed(p_jurisdiction uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select exists (
    select 1
    from (
      select p.id, p.display_name
      from public.attorney_profiles as p
      join public.users as u on u.id = p.user_id
      where p.profile_state = 'approved'
        and u.account_state = 'active'
        and exists (
          select 1 from public.licenses as l
          where l.attorney_id = p.id and l.jurisdiction_id = p_jurisdiction
        )
      order by p.id
      limit 500
    ) as c
    where public.discovery_presentable_text(c.display_name) is not null
      and (public.eligibility_assessment(c.id, p_jurisdiction, null, clock_timestamp()) ->> 'result')
          = 'eligible'
  );
$function$;

-- ---------------------------------------------------------------------------
-- Public reads (EXECUTE for anon and authenticated).
-- ---------------------------------------------------------------------------

-- The filter catalog: the jurisdictions in which at least one attorney is listed now (at most 100, by name) and
-- the active practice areas (at most 200, by name).
create function public.public_discovery_filters()
returns table (filter_kind text, id uuid, code text, name text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
begin
  return query
  select 'jurisdiction'::text, j.id, j.code, j.name
  from (
    select x.id, x.code, x.name
    from public.jurisdictions as x
    where exists (
      select 1
      from public.licenses as l
      join public.attorney_profiles as p on p.id = l.attorney_id
      where l.jurisdiction_id = x.id
        and p.profile_state = 'approved'
    )
    order by x.name collate "C", x.code collate "C"
    limit 100
  ) as j
  where public.discovery_jurisdiction_listed(j.id)
  order by j.name collate "C", j.code collate "C";
  return query
  select 'practice_area'::text, a.id, a.code, a.name
  from public.practice_areas as a
  where a.active
  order by a.name collate "C", a.code collate "C"
  limit 200;
end;
$function$;

-- One page (1..25, 20 per page) of the attorneys listed in a jurisdiction under the client's objective filters,
-- in order display_name_then_id: display position, Attorney Profile id, the presentable public fields, the
-- practice areas shown for the attorney there, Available Now, whether an offered window exists in the horizon, and
-- whether a further page exists. No row for a malformed call or an empty page.
create function public.public_attorney_directory(
  p_jurisdiction_id uuid,
  p_practice_area_id uuid,
  p_availability text,
  p_page integer
)
returns table (
  display_position integer,
  attorney_id uuid,
  display_name text,
  headline text,
  years_experience smallint,
  practice_areas text[],
  available_now boolean,
  has_scheduled_availability boolean,
  more_after boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
begin
  if p_page is null or p_page not between 1 and 25 then
    return;
  end if;
  return query
  with listed as (
    select s.*
    from public.discovery_presented_set(p_jurisdiction_id, p_practice_area_id, p_availability, null) as s
    where s.display_position is not null
  ),
  shown as (
    select l.*
    from listed as l
    where l.display_position > (p_page - 1) * 20
      and l.display_position <= p_page * 20
  )
  select
    s.display_position,
    s.attorney_id,
    s.display_name,
    public.discovery_presentable_text(s.headline),
    s.years_experience,
    public.discovery_practice_area_names(s.attorney_id, p_jurisdiction_id),
    s.available_now,
    s.has_scheduled_availability,
    exists (select 1 from listed as m where m.display_position > p_page * 20)
  from shown as s
  order by s.display_position;
end;
$function$;

-- One listed attorney's public profile: the presentable public fields, the jurisdictions where the attorney is
-- listed now (at most 20, by name), the practice areas shown (for p_jurisdiction_id when given, else across those
-- jurisdictions), Available Now and, for a given jurisdiction, up to 5 offered windows in the horizon (UTC
-- instants). With p_jurisdiction_id set, the attorney must be listed there. An attorney who is not listed and an
-- unknown id answer identically: no row.
create function public.public_attorney_profile(p_attorney_id uuid, p_jurisdiction_id uuid)
returns table (
  attorney_id uuid,
  display_name text,
  headline text,
  bio text,
  years_experience smallint,
  jurisdictions jsonb,
  practice_areas text[],
  available_now boolean,
  upcoming_windows jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_profile public.attorney_profiles;
  v_listed jsonb;
  v_areas text[];
  v_windows jsonb := '[]'::jsonb;
begin
  if p_attorney_id is null then
    return;
  end if;
  select p.* into v_profile
  from public.attorney_profiles as p
  join public.users as u on u.id = p.user_id
  where p.id = p_attorney_id
    and p.profile_state = 'approved'
    and u.account_state = 'active';
  if not found or public.discovery_presentable_text(v_profile.display_name) is null then
    return;
  end if;
  select coalesce(
           jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code, 'name', x.name)
                     order by x.name collate "C", x.code collate "C"),
           '[]'::jsonb)
  into v_listed
  from (
    select j.id, j.code, j.name
    from public.jurisdictions as j
    where exists (
        select 1 from public.licenses as l
        where l.attorney_id = p_attorney_id and l.jurisdiction_id = j.id
      )
      and (public.eligibility_assessment(p_attorney_id, j.id, null, clock_timestamp()) ->> 'result')
          = 'eligible'
    order by j.name collate "C", j.code collate "C"
    limit 20
  ) as x;
  if jsonb_array_length(v_listed) = 0
     or (p_jurisdiction_id is not null
         and not exists (
           select 1 from jsonb_array_elements(v_listed) as e
           where e ->> 'id' = p_jurisdiction_id::text
         )) then
    return;
  end if;
  if p_jurisdiction_id is not null then
    v_areas := public.discovery_practice_area_names(p_attorney_id, p_jurisdiction_id);
    select coalesce(
             jsonb_agg(jsonb_build_object('starts_at', w.window_start, 'ends_at', w.window_end)
                       order by w.window_start),
             '[]'::jsonb)
    into v_windows
    from public.scheduling_offered_windows(p_attorney_id, p_jurisdiction_id, 5) as w;
  else
    select coalesce(array_agg(distinct n.name order by n.name), array[]::text[])
    into v_areas
    from jsonb_array_elements(v_listed) as e
    cross join lateral unnest(
      public.discovery_practice_area_names(p_attorney_id, (e ->> 'id')::uuid)
    ) as n(name);
  end if;
  return query select
    v_profile.id,
    v_profile.display_name,
    public.discovery_presentable_text(v_profile.headline),
    public.discovery_presentable_text(v_profile.bio),
    v_profile.years_experience,
    v_listed,
    v_areas,
    public.discovery_available_now(v_profile.id),
    v_windows;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Scheduled availability at a decision point (internal).
-- ---------------------------------------------------------------------------

-- Appends one Bookability Evaluation for the scheduled path before a slot is chosen and answers its result and id,
-- or ('invalid', null) for a malformed call or an Eligibility Evaluation that is unknown or of another attorney.
create function public.scheduling_evaluate_scheduled_availability(
  p_attorney uuid,
  p_eligibility_evaluation_id uuid,
  p_context_type text,
  p_context_id uuid,
  p_modality text
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
  v_eligible boolean;
  v_policy_outcome text;
  v_policy uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_bookable boolean;
  v_factors jsonb;
  v_basis jsonb;
  v_id uuid;
begin
  if p_attorney is null
     or p_eligibility_evaluation_id is null
     or p_context_type is null
     or p_context_type not in ('referral', 'consultation_request')
     or p_context_id is null
     or p_modality is null
     or btrim(p_modality) = ''
     or char_length(p_modality) > 64 then
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
  v_eligible := v_eligibility.result = 'eligible';
  select p.outcome, p.policy_version_id
  into v_policy_outcome, v_policy
  from public.scheduling_policy('scheduling', v_eligibility.jurisdiction_id, v_now) as p;
  select w.window_start, w.window_end
  into v_start, v_end
  from public.scheduling_offered_windows(p_attorney, v_eligibility.jurisdiction_id, 1) as w;
  v_bookable := v_eligible and v_start is not null;
  v_factors := jsonb_build_array(
    jsonb_build_object(
      'factor', 'eligibility',
      'passed', v_eligible,
      'reason', case when v_eligible then 'eligible' else 'eligibility_' || v_eligibility.result end,
      'eligibility_evaluation_id', p_eligibility_evaluation_id,
      'eligibility_as_of', v_eligibility.as_of
    ),
    jsonb_build_object(
      'factor', 'scheduling_policy',
      'passed', v_policy_outcome = 'selected',
      'reason', case when v_policy_outcome = 'selected' then 'policy_selected'
                     else 'policy_unavailable' end,
      'policy_version_id', v_policy
    ),
    jsonb_build_object(
      'factor', 'offered_window',
      'passed', v_start is not null,
      'reason', case when v_start is not null then 'window_offered' else 'no_window_offered' end,
      'horizon_days', 14
    )
  );
  v_basis := jsonb_build_object('request_path', 'scheduled')
    || case when v_start is not null
         then jsonb_build_object('window_start', v_start, 'window_end', v_end, 'policy_version_id', v_policy)
         else '{}'::jsonb
       end;
  insert into public.bookability_evaluations (
    attorney_id, eligibility_evaluation_id, context_type, context_id,
    evaluated_at, as_of, modality, presence_observed, presence_trust_method,
    instant_intent_observed, slot_start_at, slot_end_at, availability_basis,
    constraint_results, result
  ) values (
    p_attorney, p_eligibility_evaluation_id, p_context_type, p_context_id,
    v_now, v_now, p_modality, null, null,
    null, null, null, v_basis,
    v_factors,
    case when v_bookable then 'bookable' else 'not_bookable' end
  )
  returning id into v_id;
  return query select case when v_bookable then 'bookable' else 'not_bookable' end, v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.eligibility_record_decision_point(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.discovery_presentable_text(text)
  from public, anon, authenticated, service_role;
revoke all on function public.discovery_available_now(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_offered_windows(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.discovery_presented_set(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.discovery_practice_area_names(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.discovery_jurisdiction_listed(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_evaluate_scheduled_availability(uuid, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.public_discovery_filters()
  from public, anon, authenticated, service_role;
grant execute on function public.public_discovery_filters() to anon, authenticated;
revoke all on function public.public_attorney_directory(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.public_attorney_directory(uuid, uuid, text, integer) to anon, authenticated;
revoke all on function public.public_attorney_profile(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.public_attorney_profile(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.eligibility_record_decision_point(uuid, uuid, uuid, timestamptz) is
  'MVP-001 S5 (internal): the decision-point eligibility recorder for the referral, request and acceptance contexts: the adopted engine on rows locked FOR SHARE, one appended Eligibility Evaluation (jurisdiction or practice_area context). Answers (evaluation_id, result), (null, invalid) or (null, unverifiable).';
comment on function public.discovery_presentable_text(text) is
  'MVP-001 S5 (internal): the text, or null when blank or carrying a banned recommendation claim (withheld, never rewritten).';
comment on function public.discovery_available_now(uuid) is
  'MVP-001 S5 (internal): derived Available Now: S4 Presence observed and not in a started, unended Consultation.';
comment on function public.scheduling_offered_windows(uuid, uuid, integer) is
  'MVP-001 S5 (internal): derived offered windows in the 14-day discovery horizon: availability from now plus the jurisdiction''s minimum notice, minus Blackouts, active Holds and confirmed Bookings; none without a complete scheduling policy.';
comment on function public.discovery_presented_set(uuid, uuid, text, uuid) is
  'MVP-001 S5 (internal): derived candidates, filter attribution and display positions (order display_name_then_id) for a jurisdiction and the client''s objective filters, eligibility from the engine now or from a Referral''s pool. Persists nothing.';
comment on function public.discovery_practice_area_names(uuid, uuid) is
  'MVP-001 S5 (internal): active practice areas the attorney holds an authorised authorisation for in the jurisdiction and is eligible for now in that context.';
comment on function public.discovery_jurisdiction_listed(uuid) is
  'MVP-001 S5 (internal): whether any attorney is listed in the jurisdiction now.';
comment on function public.public_discovery_filters() is
  'MVP-001 S5 (public): jurisdictions with at least one listed attorney and active practice areas (id, code, name). Persists nothing.';
comment on function public.public_attorney_directory(uuid, uuid, text, integer) is
  'MVP-001 S5 (public): one page (20) of listed attorneys under objective filters (jurisdiction, practice area, availability any|instant|scheduled) in order display_name_then_id, allowlisted fields only. Persists nothing.';
comment on function public.public_attorney_profile(uuid, uuid) is
  'MVP-001 S5 (public): one listed attorney''s allowlisted public profile with listed jurisdictions, practice areas, Available Now and up to 5 offered windows; an unlisted and an unknown id answer identically (no row). Persists nothing.';
comment on function public.scheduling_evaluate_scheduled_availability(uuid, uuid, text, uuid, text) is
  'MVP-001 S5 (internal): appends one Bookability Evaluation for the scheduled path before a slot is chosen (eligibility, scheduling policy, an offered window in the horizon; the first window is the basis). Answers bookable or not_bookable with its id, or invalid.';
