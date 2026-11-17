-- MVP-001 S4 (2 of 3): scheduling policy, availability expansion, the attorney's schedule management, the
-- application session and Instant mode (MVP-001 Packet S4; Packet section 3 gate "hold duration and caps; instant
-- countdown; presence trust (DM section 13)"; DM section 8; PS sections 2.3, 6, 16 and 34; TA sections 10, 11 and
-- 24; MB sections 31-34 and 41-44).
--
-- No relation, column, policy type, capability or seed is added (Packet rules 8, 10 and 16).
--
-- Policy values are configuration only (Packet rule 6; MBS sections 2.5 and 2.10). scheduling_policy reads them
-- from the one policy version the environment-anchored resolver selects (policy_select_version, PS-A2 section 5)
-- for the 'scheduling' or 'bookability' type and an exact jurisdiction scope (null = the jurisdiction-neutral
-- scope), with no regulatory mode, exactly as eligibility selection does. Required integer keys:
-- - 'scheduling': hold_response_window_seconds (1..2592000), hold_pre_slot_interval_seconds (0..2592000),
--   pending_hold_cap (1..10000) and minimum_notice_seconds (0..31536000);
-- - 'bookability': presence_window_seconds (1..86400).
-- The ranges are wide sanity bounds, not values. A missing, malformed or out-of-range key answers
-- policy_incomplete; an unrecorded or mismatched environment, no applicable version or a conflict answers that
-- resolver outcome. Nothing in this migration supplies a value, a default or a fallback.
--
-- Availability (DM section 8; PS sections 2.3 and 34): instants are stored and returned as timestamptz (UTC); each
-- rule keeps its IANA time zone and local times. scheduling_expand_availability turns the active rules into UTC
-- windows for a range of local dates (recurring rules by ISO weekday inside their effective dates; one-time rules
-- on their date). A window whose local start or end does not exist on that date (a daylight-saving gap) or occurs
-- twice (a daylight-saving overlap) is not offered on that date, so no stored or derived instant is ambiguous.
--
-- Attorney schedule management (EXECUTE for authenticated only): the caller's own Attorney Profile, at aal2
-- (lock_current_attorney_profile, MVP-001 S2); every change is audited in the same transaction; a rule or Blackout
-- of another attorney answers exactly as an unknown one (not_found). Rules and Blackouts are refused for a
-- suspended or removed profile. Fixed abuse bounds (not policy values): at most 200 active rules and 500 Blackouts
-- not yet ended per attorney; rule dates within one day before and 3653 days after today; a Blackout ends in the
-- future, spans at most 366 days and starts within 3653 days; a reason code is null or a short lower-snake code;
-- the calendar covers 1..31 local days starting within 31 days before and 3653 days after today.
--
-- The application session and Instant mode (PS section 6; TA sections 10 and 11; DM section 8; MB sections 31-34):
-- - The server observes an attorney's authenticated session from the verified Supabase Auth JWT it receives (the
--   session_id and exp claims, read defensively like current_session_aal2). One application_sessions row exists per
--   provider session; its auth_session_reference is the hex SHA-256 of the session_id claim (never the token), its
--   started_at the first server observation, its expires_at the latest token expiry observed (forward only). A
--   session that has ended, been revoked or expired is final; a new sign-in is a new provider session and a new row.
-- - An Instant Availability Intent is manual and bound to one application session (P1 unique key). Enabling binds it
--   to the caller's current session only; a new session therefore starts with Instant mode off. Signing out
--   (scheduling_end_session) ends the session and revokes its intent, so Instant mode is still off at the next
--   sign-in. Disabling revokes every unrevoked intent of the attorney.
-- - Presence is the server's determination that the attorney is reachable (DM section 8); the browser can never
--   declare it (TA section 10). application_sessions has no observation column (P1-007 kept Presence ephemeral and
--   20260901012518 removed updated_at), so the server's observation is carried by the intent's own server expiry:
--   every enabling and every verified touch (scheduling_touch_session) sets expires_at to the earlier of the
--   session's expiry and the observation time plus presence_window_seconds of the jurisdiction-neutral
--   'bookability' policy, moving forward only. An intent that is not observed within that window expires and stays
--   off until the attorney enables it again; an interrupted session therefore never leaves Instant mode on. With
--   no complete policy, Instant mode cannot be enabled and an existing intent is not renewed. Touches renew a
--   lease and are not audited individually; a session's first observation, enabling, disabling and sign-out are.

-- ---------------------------------------------------------------------------
-- Policy selection (internal; executable by no API role).
-- ---------------------------------------------------------------------------

create function public.scheduling_policy(
  p_type text,
  p_jurisdiction uuid,
  p_as_of timestamptz
)
returns table (outcome text, policy_version_id uuid, parameters jsonb)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_outcome text;
  v_id uuid;
  v_raw jsonb;
  v_bounds jsonb;
  v_key text;
  v_value jsonb;
  v_number numeric;
  v_result jsonb := '{}'::jsonb;
begin
  if p_type is null or p_type not in ('scheduling', 'bookability') or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::jsonb;
    return;
  end if;
  select s.outcome, s.policy_version_id
  into v_outcome, v_id
  from public.policy_select_version(p_type, p_jurisdiction, null, p_as_of) as s;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::jsonb;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  v_bounds := case p_type
    when 'scheduling' then jsonb_build_object(
      'hold_response_window_seconds', jsonb_build_array(1, 2592000),
      'hold_pre_slot_interval_seconds', jsonb_build_array(0, 2592000),
      'pending_hold_cap', jsonb_build_array(1, 10000),
      'minimum_notice_seconds', jsonb_build_array(0, 31536000))
    else jsonb_build_object(
      'presence_window_seconds', jsonb_build_array(1, 86400))
  end;
  if jsonb_typeof(v_raw) is distinct from 'object' then
    return query select 'policy_incomplete'::text, v_id, null::jsonb;
    return;
  end if;
  for v_key in select k from jsonb_object_keys(v_bounds) as k loop
    v_value := v_raw -> v_key;
    if jsonb_typeof(v_value) is distinct from 'number' then
      return query select 'policy_incomplete'::text, v_id, null::jsonb;
      return;
    end if;
    v_number := (v_value #>> '{}')::numeric;
    if v_number <> trunc(v_number)
       or v_number < (v_bounds -> v_key ->> 0)::numeric
       or v_number > (v_bounds -> v_key ->> 1)::numeric then
      return query select 'policy_incomplete'::text, v_id, null::jsonb;
      return;
    end if;
    v_result := v_result || jsonb_build_object(v_key, v_number::bigint);
  end loop;
  return query select 'selected'::text, v_id, v_result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Availability expansion (internal).
-- ---------------------------------------------------------------------------

-- The one instant at which a local date-time occurs in a time zone, or null when it does not occur there (a
-- daylight-saving gap) or occurs twice (an overlap). The two offsets in force a day before and a day after are the
-- candidates; a candidate counts only when it converts back to the same local date-time.
create function public.scheduling_local_instant(p_local timestamp, p_zone text)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_probe timestamptz;
  v_before interval;
  v_after interval;
  v_first timestamptz;
  v_second timestamptz;
  v_first_ok boolean;
  v_second_ok boolean;
begin
  if p_local is null or p_zone is null then
    return null;
  end if;
  v_probe := p_local at time zone 'UTC';
  v_before := ((v_probe - interval '1 day') at time zone p_zone)
              - ((v_probe - interval '1 day') at time zone 'UTC');
  v_after := ((v_probe + interval '1 day') at time zone p_zone)
             - ((v_probe + interval '1 day') at time zone 'UTC');
  v_first := (p_local - v_before) at time zone 'UTC';
  v_second := (p_local - v_after) at time zone 'UTC';
  v_first_ok := (v_first at time zone p_zone) = p_local;
  v_second_ok := (v_second at time zone p_zone) = p_local;
  if v_first_ok and v_second_ok then
    return case when v_first = v_second then v_first end;
  elsif v_first_ok then
    return v_first;
  elsif v_second_ok then
    return v_second;
  end if;
  return null;
end;
$function$;

-- The UTC windows of an attorney's active rules for the local dates p_from..p_to (at most 63 dates), each with its
-- rule, local date and time zone. Windows with a nonexistent or ambiguous local start or end are left out.
create function public.scheduling_expand_availability(
  p_attorney uuid,
  p_from date,
  p_to date
)
returns table (
  rule_id uuid,
  local_date date,
  timezone_name text,
  window_start timestamptz,
  window_end timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select w.rule_id, w.local_date, w.timezone_name, w.window_start, w.window_end
  from (
    select
      r.id as rule_id,
      d.day as local_date,
      r.timezone_name,
      public.scheduling_local_instant(d.day + r.local_start_time, r.timezone_name) as window_start,
      public.scheduling_local_instant(d.day + r.local_end_time, r.timezone_name) as window_end
    from public.availability_rules as r
    cross join lateral (
      select g::date as day
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g
    ) as d
    where p_attorney is not null
      and p_from is not null
      and p_to is not null
      and p_to >= p_from
      and p_to - p_from <= 62
      and r.attorney_id = p_attorney
      and r.active
      and (
        (r.rule_kind = 'recurring'
         and r.weekday = extract(isodow from d.day)::integer
         and d.day >= r.effective_from
         and (r.effective_until is null or d.day <= r.effective_until))
        or (r.rule_kind = 'one_time' and r.specific_date = d.day)
      )
  ) as w
  where w.window_start is not null
    and w.window_end is not null
    and w.window_start < w.window_end
  order by w.window_start, w.rule_id;
$function$;

-- ---------------------------------------------------------------------------
-- Audit and the observed application session (internal).
-- ---------------------------------------------------------------------------

create function public.scheduling_audit(
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_before jsonb,
  p_after jsonb,
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
    p_actor, p_actor_type, p_action, p_resource_type, p_resource_id,
    p_before, p_after, p_reason, null, null, clock_timestamp()
  );
$function$;

-- The current request's provider session, from the verified JWT claims PostgREST sets: the hex SHA-256 of the
-- session_id claim and the token expiry (exp). No row when the claims are missing, malformed or out of range.
create function public.scheduling_session_claims()
returns table (session_reference text, token_expires_at timestamptz)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_raw text;
  v_claims jsonb;
  v_session text;
  v_exp numeric;
begin
  v_raw := nullif(current_setting('request.jwt.claims', true), '');
  if v_raw is null then
    return;
  end if;
  begin
    v_claims := v_raw::jsonb;
  exception
    when others then
      return;
  end;
  if jsonb_typeof(v_claims) is distinct from 'object'
     or jsonb_typeof(v_claims -> 'session_id') is distinct from 'string'
     or jsonb_typeof(v_claims -> 'exp') is distinct from 'number' then
    return;
  end if;
  v_session := v_claims ->> 'session_id';
  v_exp := (v_claims ->> 'exp')::numeric;
  if char_length(v_session) not between 1 and 128
     or v_session ~ '[^A-Za-z0-9-]'
     or v_exp <> trunc(v_exp)
     or v_exp < 1
     or v_exp > 32503680000 then
    return;
  end if;
  return query
    select encode(sha256(convert_to(v_session, 'UTF8')), 'hex'),
           to_timestamp(v_exp::double precision);
end;
$function$;

-- Records the server's observation of the current request's provider session for the given User: creates its
-- application session (audited) or moves its expiry forward to the token's. Outcomes: observed (with the session
-- id and expiry), no_session (no readable session claims, an expired token, or a session that has ended, been
-- revoked or expired) or denied (the reference belongs to another User). The session row is locked FOR UPDATE.
create function public.scheduling_observe_session(p_user uuid)
returns table (outcome text, session_id uuid, session_expires_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_reference text;
  v_token_expiry timestamptz;
  v_now timestamptz := clock_timestamp();
  v_session public.application_sessions;
  v_id uuid;
begin
  select c.session_reference, c.token_expires_at
  into v_reference, v_token_expiry
  from public.scheduling_session_claims() as c;
  if p_user is null or v_reference is null or v_token_expiry <= v_now then
    return query select 'no_session'::text, null::uuid, null::timestamptz;
    return;
  end if;
  insert into public.application_sessions (user_id, auth_session_reference, started_at, expires_at)
  values (p_user, v_reference, v_now, v_token_expiry)
  on conflict (auth_session_reference) do nothing
  returning id into v_id;
  if v_id is not null then
    perform public.scheduling_audit(
      p_user, 'attorney', 'application_session.started', 'application_session', v_id,
      null, jsonb_build_object('expires_at', v_token_expiry), null
    );
  end if;
  select s.* into v_session
  from public.application_sessions as s
  where s.auth_session_reference = v_reference
  for update;
  if v_session.user_id is distinct from p_user then
    return query select 'denied'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if v_session.ended_at is not null
     or v_session.revoked_at is not null
     or v_session.expires_at <= clock_timestamp() then
    return query select 'no_session'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if v_token_expiry > v_session.expires_at then
    update public.application_sessions as s
    set expires_at = v_token_expiry
    where s.id = v_session.id;
    v_session.expires_at := v_token_expiry;
  end if;
  return query select 'observed'::text, v_session.id, v_session.expires_at;
end;
$function$;

-- Presence (DM section 8): observed when the attorney holds an Instant Availability Intent whose server expiry,
-- renewed only by server observations within presence_window_seconds of the jurisdiction-neutral 'bookability'
-- policy, has not passed, on a live application session. No complete policy: not observed.
create function public.scheduling_presence(p_attorney uuid)
returns table (observed boolean, trust_method text, reason text, policy_version_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_outcome text;
  v_policy uuid;
  v_now timestamptz := clock_timestamp();
begin
  select p.outcome, p.policy_version_id
  into v_outcome, v_policy
  from public.scheduling_policy('bookability', null, v_now) as p;
  if v_outcome is distinct from 'selected' then
    return query select false, 'server_session_observation'::text, 'presence_policy_unavailable'::text, null::uuid;
    return;
  end if;
  if exists (
    select 1
    from public.instant_availability_intents as i
    join public.application_sessions as s on s.id = i.application_session_id
    where i.attorney_id = p_attorney
      and i.revoked_at is null
      and i.enabled_at <= v_now
      and i.expires_at > v_now
      and s.ended_at is null
      and s.revoked_at is null
      and s.expires_at > v_now
  ) then
    return query select true, 'server_session_observation'::text, 'presence_observed'::text, v_policy;
  else
    return query select false, 'server_session_observation'::text, 'presence_not_observed'::text, v_policy;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Attorney schedule management (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Outcomes: created (with the new rule id), invalid, denied, rate_limited.
create function public.attorney_create_availability_rule(
  p_rule_kind text,
  p_timezone_name text,
  p_weekday integer,
  p_specific_date date,
  p_local_start_time time,
  p_local_end_time time,
  p_effective_from date,
  p_effective_until date
)
returns table (outcome text, rule_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_today date := (clock_timestamp() at time zone 'UTC')::date;
  v_id uuid;
begin
  if p_rule_kind is null
     or p_rule_kind not in ('recurring', 'one_time')
     or p_timezone_name is null
     or char_length(p_timezone_name) not between 1 and 64
     or p_local_start_time is null
     or p_local_end_time is null
     or p_local_start_time >= p_local_end_time
     or (p_rule_kind = 'recurring' and (
           p_weekday is null or p_weekday not between 1 and 7
           or p_specific_date is not null
           or p_effective_from is null
           or p_effective_from not between v_today - 1 and v_today + 3653
           or (p_effective_until is not null
               and p_effective_until not between p_effective_from and v_today + 3653)))
     or (p_rule_kind = 'one_time' and (
           p_weekday is not null
           or p_specific_date is null
           or p_specific_date not between v_today - 1 and v_today + 3653
           or p_effective_from is not null
           or p_effective_until is not null))
     or not exists (
       select 1 from pg_catalog.pg_timezone_names as z where z.name = p_timezone_name
     ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null or v_profile.profile_state in ('suspended', 'removed') then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if (select count(*) from public.availability_rules as r
      where r.attorney_id = v_profile.id and r.active) >= 200 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  begin
    insert into public.availability_rules (
      attorney_id, rule_kind, timezone_name, weekday, specific_date,
      local_start_time, local_end_time, effective_from, effective_until, active
    ) values (
      v_profile.id, p_rule_kind, p_timezone_name, p_weekday, p_specific_date,
      p_local_start_time, p_local_end_time, p_effective_from, p_effective_until, true
    )
    returning id into v_id;
  exception
    when check_violation then
      return query select 'invalid'::text, null::uuid;
      return;
  end;
  perform public.scheduling_audit(
    v_profile.user_id, 'attorney', 'availability_rule.created', 'availability_rule', v_id,
    null,
    jsonb_build_object(
      'rule_kind', p_rule_kind,
      'timezone_name', p_timezone_name,
      'weekday', p_weekday,
      'specific_date', p_specific_date,
      'local_start_time', p_local_start_time,
      'local_end_time', p_local_end_time,
      'effective_from', p_effective_from,
      'effective_until', p_effective_until
    ),
    null
  );
  return query select 'created'::text, v_id;
end;
$function$;

-- Outcomes: deactivated, already_inactive, not_found, denied.
create function public.attorney_deactivate_availability_rule(p_rule_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_active boolean;
begin
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if p_rule_id is null then
    return 'not_found';
  end if;
  select r.active into v_active
  from public.availability_rules as r
  where r.id = p_rule_id
    and r.attorney_id = v_profile.id
  for update;
  if not found then
    return 'not_found';
  end if;
  if not v_active then
    return 'already_inactive';
  end if;
  update public.availability_rules as r
  set active = false
  where r.id = p_rule_id;
  perform public.scheduling_audit(
    v_profile.user_id, 'attorney', 'availability_rule.deactivated', 'availability_rule', p_rule_id,
    jsonb_build_object('active', true), jsonb_build_object('active', false), null
  );
  return 'deactivated';
end;
$function$;

-- Outcomes: created (with the new Blackout id), invalid, denied, rate_limited.
create function public.attorney_create_blackout(
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason_code text
)
returns table (outcome text, blackout_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_now timestamptz := clock_timestamp();
  v_id uuid;
begin
  if p_starts_at is null
     or p_ends_at is null
     or p_starts_at >= p_ends_at
     or p_ends_at <= v_now
     or p_ends_at - p_starts_at > interval '366 days'
     or p_starts_at > v_now + interval '3653 days'
     or (p_reason_code is not null and p_reason_code !~ '^[a-z][a-z0-9_]{1,39}$') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null or v_profile.profile_state in ('suspended', 'removed') then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if (select count(*) from public.blackouts as b
      where b.attorney_id = v_profile.id and b.ends_at > v_now) >= 500 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  insert into public.blackouts (attorney_id, starts_at, ends_at, reason_code)
  values (v_profile.id, p_starts_at, p_ends_at, p_reason_code)
  returning id into v_id;
  perform public.scheduling_audit(
    v_profile.user_id, 'attorney', 'blackout.created', 'blackout', v_id,
    null,
    jsonb_build_object('starts_at', p_starts_at, 'ends_at', p_ends_at, 'reason_code', p_reason_code),
    null
  );
  return query select 'created'::text, v_id;
end;
$function$;

-- Outcomes: removed, not_removable (it has started), not_found, denied.
create function public.attorney_remove_blackout(p_blackout_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_blackout public.blackouts;
begin
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if p_blackout_id is null then
    return 'not_found';
  end if;
  select b.* into v_blackout
  from public.blackouts as b
  where b.id = p_blackout_id
    and b.attorney_id = v_profile.id
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_blackout.starts_at <= clock_timestamp() then
    return 'not_removable';
  end if;
  delete from public.blackouts as b where b.id = p_blackout_id;
  perform public.scheduling_audit(
    v_profile.user_id, 'attorney', 'blackout.removed', 'blackout', p_blackout_id,
    jsonb_build_object(
      'starts_at', v_blackout.starts_at,
      'ends_at', v_blackout.ends_at,
      'reason_code', v_blackout.reason_code
    ),
    null, null
  );
  return 'removed';
end;
$function$;

-- The caller's own calendar for p_day_count (1..31) local days from p_from_date: availability windows (UTC, with the
-- rule's time zone and local date), Blackouts, active Holds and confirmed Bookings around that span, ordered by
-- start. Nothing of a client, a Request or an Intake is disclosed (counsel gate: nothing of an Intake before
-- acceptance). Requires an aal2 session and an active User; anything else answers no rows. At most 2000 rows.
create function public.attorney_schedule_calendar(p_from_date date, p_day_count integer)
returns table (
  entry_kind text,
  entry_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone_name text,
  local_date date,
  entry_state text,
  reason_code text
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
      and public.current_session_aal2() is true
      and p_from_date is not null
      and p_day_count between 1 and 31
      and p_from_date between (statement_timestamp() at time zone 'UTC')::date - 31
                          and (statement_timestamp() at time zone 'UTC')::date + 3653
  ),
  span as (
    select
      (p_from_date - 1)::timestamp at time zone 'UTC' as lo,
      (p_from_date + p_day_count + 1)::timestamp at time zone 'UTC' as hi
  ),
  entries as (
    select 'window'::text as kind, w.rule_id as id, w.window_start as s, w.window_end as e,
           w.timezone_name as zone, w.local_date as day, 'available'::text as state, null::text as reason
    from me
    cross join lateral public.scheduling_expand_availability(
      me.id, p_from_date, p_from_date + p_day_count - 1
    ) as w
    union all
    select 'blackout', b.id, b.starts_at, b.ends_at, null, null,
           case when b.starts_at > statement_timestamp() then 'removable' else 'started' end,
           b.reason_code
    from me
    cross join span
    join public.blackouts as b on b.attorney_id = me.id
    where b.starts_at < span.hi and b.ends_at > span.lo
    union all
    select 'hold', h.id, h.slot_start_at, h.slot_end_at, null, null, 'held', null
    from me
    cross join span
    join public.slot_holds as h on h.attorney_id = me.id
    where h.released_at is null
      and h.expires_at > statement_timestamp()
      and h.slot_start_at < span.hi and h.slot_end_at > span.lo
    union all
    select 'booking', b.id, b.starts_at, b.ends_at, null, null, 'confirmed', null
    from me
    cross join span
    join public.bookings as b on b.attorney_id = me.id
    where b.status = 'confirmed'
      and b.starts_at < span.hi and b.ends_at > span.lo
  )
  select e.kind, e.id, e.s, e.e, e.zone, e.day, e.state, e.reason
  from entries as e
  order by e.s, e.kind, e.id
  limit 2000;
$function$;

-- ---------------------------------------------------------------------------
-- The application session and Instant mode (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Renews the Instant intent lease of one live session: the earlier of the session's expiry and now plus the
-- presence window, moving forward only. Nothing happens without a complete 'bookability' policy, or when the
-- intent is revoked or has already expired (it then stays off until enabled again).
create function public.scheduling_renew_instant_lease(p_session_id uuid, p_session_expires_at timestamptz)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_outcome text;
  v_parameters jsonb;
  v_now timestamptz := clock_timestamp();
  v_lease timestamptz;
begin
  select p.outcome, p.parameters
  into v_outcome, v_parameters
  from public.scheduling_policy('bookability', null, v_now) as p;
  if v_outcome is distinct from 'selected' then
    return;
  end if;
  v_lease := least(
    p_session_expires_at,
    v_now + make_interval(secs => (v_parameters ->> 'presence_window_seconds')::bigint)
  );
  update public.instant_availability_intents as i
  set expires_at = v_lease
  where i.application_session_id = p_session_id
    and i.revoked_at is null
    and i.expires_at > v_now
    and i.expires_at < v_lease;
end;
$function$;

-- The heartbeat's server side: for an active User holding an Attorney Profile that is not suspended or removed, at
-- aal2, records the observation of the current provider session and renews its Instant lease. Outcomes: observed,
-- no_session, denied. The browser only asks; the server decides from the verified token.
create function public.scheduling_touch_session()
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_outcome text;
  v_session uuid;
  v_expires timestamptz;
begin
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  select o.outcome, o.session_id, o.session_expires_at
  into v_outcome, v_session, v_expires
  from public.scheduling_observe_session(v_profile.user_id) as o;
  if v_outcome is distinct from 'observed' then
    return v_outcome;
  end if;
  perform public.scheduling_renew_instant_lease(v_session, v_expires);
  return 'observed';
end;
$function$;

-- Switches Instant mode for the caller. Enabling (approved profile only) binds an intent to the caller's current
-- application session with a server lease; disabling revokes every unrevoked intent of the attorney. Outcomes:
-- enabled, disabled, unchanged, no_session, denied, unavailable (no complete 'bookability' policy), invalid.
create function public.attorney_set_instant_intent(p_enabled boolean)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_outcome text;
  v_parameters jsonb;
  v_policy uuid;
  v_session uuid;
  v_session_expires timestamptz;
  v_intent public.instant_availability_intents;
  v_now timestamptz;
  v_lease timestamptz;
  v_id uuid;
  v_count integer;
begin
  if p_enabled is null then
    return 'invalid';
  end if;
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null then
    return 'denied';
  end if;
  if not p_enabled then
    update public.instant_availability_intents as i
    set revoked_at = clock_timestamp()
    where i.attorney_id = v_profile.id
      and i.revoked_at is null;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      return 'unchanged';
    end if;
    perform public.scheduling_audit(
      v_profile.user_id, 'attorney', 'instant_intent.disabled', 'attorney_profile', v_profile.id,
      null, jsonb_build_object('revoked_intents', v_count), null
    );
    return 'disabled';
  end if;
  if v_profile.profile_state is distinct from 'approved' then
    return 'denied';
  end if;
  select p.outcome, p.parameters, p.policy_version_id
  into v_outcome, v_parameters, v_policy
  from public.scheduling_policy('bookability', null, clock_timestamp()) as p;
  if v_outcome is distinct from 'selected' then
    return 'unavailable';
  end if;
  select o.outcome, o.session_id, o.session_expires_at
  into v_outcome, v_session, v_session_expires
  from public.scheduling_observe_session(v_profile.user_id) as o;
  if v_outcome is distinct from 'observed' then
    return v_outcome;
  end if;
  select i.* into v_intent
  from public.instant_availability_intents as i
  where i.application_session_id = v_session
  for update;
  v_now := clock_timestamp();
  if v_intent.id is not null and v_intent.revoked_at is null and v_intent.expires_at > v_now then
    return 'unchanged';
  end if;
  v_lease := least(
    v_session_expires,
    v_now + make_interval(secs => (v_parameters ->> 'presence_window_seconds')::bigint)
  );
  if v_intent.id is null then
    insert into public.instant_availability_intents (
      attorney_id, application_session_id, enabled_at, expires_at
    ) values (v_profile.id, v_session, v_now, v_lease)
    returning id into v_id;
  else
    v_id := v_intent.id;
    v_lease := greatest(v_lease, v_intent.expires_at);
    update public.instant_availability_intents as i
    set enabled_at = v_now,
        revoked_at = null,
        expires_at = v_lease
    where i.id = v_id;
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney', 'instant_intent.enabled', 'instant_availability_intent', v_id,
    null, jsonb_build_object('expires_at', v_lease), null,
    jsonb_build_array(jsonb_build_object('policy_version_id', v_policy)), null, clock_timestamp()
  );
  return 'enabled';
end;
$function$;

-- Sign-out's server side: ends the caller's current application session and revokes its Instant intent, whatever
-- the account or profile state. Outcomes: ended, no_session.
create function public.scheduling_end_session()
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_reference text;
  v_user uuid;
  v_session public.application_sessions;
  v_count integer;
begin
  select c.session_reference into v_reference from public.scheduling_session_claims() as c;
  if v_reference is null or auth.uid() is null then
    return 'no_session';
  end if;
  select u.id into v_user from public.users as u where u.auth_user_id = auth.uid();
  if v_user is null then
    return 'no_session';
  end if;
  select s.* into v_session
  from public.application_sessions as s
  where s.auth_session_reference = v_reference
    and s.user_id = v_user
  for update;
  if not found or v_session.ended_at is not null or v_session.revoked_at is not null then
    return 'no_session';
  end if;
  update public.application_sessions as s
  set ended_at = clock_timestamp()
  where s.id = v_session.id;
  update public.instant_availability_intents as i
  set revoked_at = clock_timestamp()
  where i.application_session_id = v_session.id
    and i.revoked_at is null;
  get diagnostics v_count = row_count;
  perform public.scheduling_audit(
    v_user, 'attorney', 'application_session.ended', 'application_session', v_session.id,
    null, jsonb_build_object('revoked_intents', v_count), 'sign_out'
  );
  return 'ended';
end;
$function$;

-- The caller's Instant mode as the server sees it, for an aal2 session of an active User with an Attorney Profile
-- (otherwise no row): whether the current session's intent is on and its server expiry, whether the current
-- session is live and its expiry, whether a complete 'bookability' policy is selectable, and how many other live
-- sessions of the attorney hold an intent that is on.
create function public.attorney_instant_status()
returns table (
  instant_on boolean,
  intent_expires_at timestamptz,
  session_active boolean,
  session_expires_at timestamptz,
  presence_configured boolean,
  other_sessions_on integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_user uuid;
  v_reference text;
  v_now timestamptz := clock_timestamp();
  v_session public.application_sessions;
  v_live boolean := false;
  v_on boolean := false;
  v_expires timestamptz;
  v_configured boolean;
  v_others integer;
begin
  if public.current_session_aal2() is not true then
    return;
  end if;
  select p.id, u.id into v_attorney, v_user
  from public.attorney_profiles as p
  join public.users as u on u.id = p.user_id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
  if v_attorney is null then
    return;
  end if;
  select c.session_reference into v_reference from public.scheduling_session_claims() as c;
  if v_reference is not null then
    select s.* into v_session
    from public.application_sessions as s
    where s.auth_session_reference = v_reference
      and s.user_id = v_user;
    v_live := v_session.id is not null
      and v_session.ended_at is null
      and v_session.revoked_at is null
      and v_session.expires_at > v_now;
  end if;
  if v_live then
    select i.expires_at into v_expires
    from public.instant_availability_intents as i
    where i.application_session_id = v_session.id
      and i.revoked_at is null
      and i.expires_at > v_now;
    v_on := v_expires is not null;
  end if;
  select p.outcome = 'selected' into v_configured
  from public.scheduling_policy('bookability', null, v_now) as p;
  select count(*)::integer into v_others
  from public.instant_availability_intents as i
  join public.application_sessions as s on s.id = i.application_session_id
  where i.attorney_id = v_attorney
    and (v_session.id is null or s.id <> v_session.id)
    and i.revoked_at is null
    and i.expires_at > v_now
    and s.ended_at is null
    and s.revoked_at is null
    and s.expires_at > v_now;
  return query select
    v_on,
    case when v_on then v_expires end,
    v_live,
    case when v_live then v_session.expires_at end,
    coalesce(v_configured, false),
    v_others;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.scheduling_policy(text, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_local_instant(timestamp, text)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_expand_availability(uuid, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_audit(uuid, text, text, text, uuid, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_session_claims()
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_observe_session(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_presence(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.scheduling_renew_instant_lease(uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.attorney_create_availability_rule(text, text, integer, date, time, time, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_create_availability_rule(text, text, integer, date, time, time, date, date)
  to authenticated;
revoke all on function public.attorney_deactivate_availability_rule(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_deactivate_availability_rule(uuid) to authenticated;
revoke all on function public.attorney_create_blackout(timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_create_blackout(timestamptz, timestamptz, text) to authenticated;
revoke all on function public.attorney_remove_blackout(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_remove_blackout(uuid) to authenticated;
revoke all on function public.attorney_schedule_calendar(date, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_schedule_calendar(date, integer) to authenticated;
revoke all on function public.scheduling_touch_session()
  from public, anon, authenticated, service_role;
grant execute on function public.scheduling_touch_session() to authenticated;
revoke all on function public.attorney_set_instant_intent(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_set_instant_intent(boolean) to authenticated;
revoke all on function public.scheduling_end_session()
  from public, anon, authenticated, service_role;
grant execute on function public.scheduling_end_session() to authenticated;
revoke all on function public.attorney_instant_status()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_instant_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.scheduling_policy(text, uuid, timestamptz) is
  'MVP-001 S4 (internal): the selected scheduling or bookability policy version for an exact jurisdiction scope (null = jurisdiction-neutral) and its required integer parameters, or the resolver outcome, or policy_incomplete. No value has a default.';
comment on function public.scheduling_local_instant(timestamp, text) is
  'MVP-001 S4 (internal): the one instant at which a local date-time occurs in an IANA time zone, or null in a daylight-saving gap or overlap.';
comment on function public.scheduling_expand_availability(uuid, date, date) is
  'MVP-001 S4 (internal): UTC availability windows of an attorney''s active rules for up to 63 local dates; windows with a nonexistent or ambiguous local start or end are not offered that date.';
comment on function public.scheduling_audit(uuid, text, text, text, uuid, jsonb, jsonb, text) is
  'MVP-001 S4 (internal): one scheduling audit event.';
comment on function public.scheduling_session_claims() is
  'MVP-001 S4 (internal): the current request''s provider session reference (hex SHA-256 of the verified session_id claim) and token expiry, or no row.';
comment on function public.scheduling_observe_session(uuid) is
  'MVP-001 S4 (internal): records the server''s observation of the current provider session for a User (creating its application session, audited, or moving its expiry forward). Outcomes: observed, no_session, denied.';
comment on function public.scheduling_presence(uuid) is
  'MVP-001 S4 (internal): Presence as the server determines it (server_session_observation): an unrevoked Instant intent whose server lease, renewed only by observations within the jurisdiction-neutral bookability presence window, has not passed, on a live session. No complete policy: not observed.';
comment on function public.scheduling_renew_instant_lease(uuid, timestamptz) is
  'MVP-001 S4 (internal): moves a live, unrevoked, unexpired Instant intent lease forward to the earlier of the session expiry and now plus the presence window; nothing without a complete bookability policy.';
comment on function public.attorney_create_availability_rule(text, text, integer, date, time, time, date, date) is
  'MVP-001 S4: creates a recurring (ISO weekday, effective dates) or one-time availability rule in an IANA time zone for the caller''s own Attorney Profile at aal2. Audited. Outcomes: created, invalid, denied, rate_limited.';
comment on function public.attorney_deactivate_availability_rule(uuid) is
  'MVP-001 S4: deactivates one of the caller''s own availability rules at aal2. Audited. Outcomes: deactivated, already_inactive, not_found, denied.';
comment on function public.attorney_create_blackout(timestamptz, timestamptz, text) is
  'MVP-001 S4: records a Blackout range for the caller''s own Attorney Profile at aal2. Audited. Outcomes: created, invalid, denied, rate_limited.';
comment on function public.attorney_remove_blackout(uuid) is
  'MVP-001 S4: removes one of the caller''s own Blackouts before it starts, at aal2. Audited. Outcomes: removed, not_removable, not_found, denied.';
comment on function public.attorney_schedule_calendar(date, integer) is
  'MVP-001 S4: the caller''s own calendar (availability windows, Blackouts, active Holds, confirmed Bookings) for 1..31 local days, at aal2. No client, Request or Intake detail.';
comment on function public.scheduling_touch_session() is
  'MVP-001 S4: the server observation of the caller''s current provider session (attorney, aal2), renewing its Instant lease. The browser cannot declare availability. Outcomes: observed, no_session, denied.';
comment on function public.attorney_set_instant_intent(boolean) is
  'MVP-001 S4: Instant mode on (approved profile, aal2, bound to the current application session with a server lease from the bookability presence window) or off (every intent of the attorney revoked). Audited. Outcomes: enabled, disabled, unchanged, no_session, denied, unavailable, invalid.';
comment on function public.scheduling_end_session() is
  'MVP-001 S4: sign-out''s server side: ends the caller''s current application session and revokes its Instant intent. Audited. Outcomes: ended, no_session.';
comment on function public.attorney_instant_status() is
  'MVP-001 S4: the caller''s Instant mode as the server sees it (aal2): current-session intent and its server expiry, session liveness and expiry, policy configured, other live sessions with Instant mode on.';
comment on table public.application_sessions is
  'Server-observed application sessions, one per authentication-provider session (auth_session_reference: hex SHA-256 of the verified session_id claim; never a token). Written only by the MVP-001 S4 session functions; never deleted.';
comment on table public.instant_availability_intents is
  'Session-bound, manual attorney Instant intent with a server-controlled expiry renewed only by server observations within the configured presence window. Written only by the MVP-001 S4 functions; never deleted.';
