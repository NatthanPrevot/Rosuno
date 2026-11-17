-- MVP-001 S2 (3 of 3): session assurance for staff and attorney authority (MVP-001 Packet S2 "MFA step-up for
-- attorney and staff sessions (Supabase Auth)"; MBS section 5: stronger authentication for staff, higher-trust
-- controls for attorneys, and the suspicious-session boundary).
--
-- The browser-facing step-up (enrolment, challenge and verification of a second factor through Supabase Auth)
-- is the application's. The database is defense in depth: a staff operation, a staff row read and an attorney
-- professional write are decided only for a request whose verified Supabase Auth JWT carries "aal": "aal2". A
-- session at aal1, or a request without readable claims, is refused exactly as an unauthorized caller is: the
-- lock helpers answer null (the all-null profile for the attorney helper) and the read predicates answer false,
-- so every calling function keeps its existing outcome vocabulary ('denied', 'forbidden') and every row policy
-- shows nothing.
--
-- Each helper below is replaced with its existing definition and only the assurance condition added: the same
-- signature, parameter names, return type, volatility, security mode, search_path, lock order and privileges.
-- Client functions and attorney_start_application are unchanged (they decide on lock_current_active_user and
-- lock_current_client, which are not changed).

-- ---------------------------------------------------------------------------
-- The assurance predicate.
-- ---------------------------------------------------------------------------

-- True only when request.jwt.claims (set by PostgREST from the verified JWT) parses to a JSON object whose
-- "aal" member is exactly the string "aal2". Missing, empty, malformed or non-object claims are false.
create function public.current_session_aal2()
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_raw text;
  v_claims jsonb;
begin
  v_raw := nullif(current_setting('request.jwt.claims', true), '');
  if v_raw is null then
    return false;
  end if;
  begin
    v_claims := v_raw::jsonb;
  exception
    when others then
      return false;
  end;
  if jsonb_typeof(v_claims) is distinct from 'object'
     or jsonb_typeof(v_claims -> 'aal') is distinct from 'string' then
    return false;
  end if;
  return (v_claims ->> 'aal') = 'aal2';
end;
$function$;

revoke all on function public.current_session_aal2()
  from public, anon, authenticated, service_role;

comment on function public.current_session_aal2() is
  'Internal: true only when the request JWT claims are a JSON object with "aal" exactly "aal2" (Supabase Auth MFA). Missing or malformed claims are false. Executable by no API role.';

-- ---------------------------------------------------------------------------
-- Staff read predicates (row policies): aal2 required.
-- ---------------------------------------------------------------------------

create or replace function public.has_manage_attorney_verification_scope(
  required_jurisdiction uuid, allow_any_jurisdiction boolean
) returns boolean
language sql stable security definer
set search_path = pg_catalog
as $function$
  select public.current_session_aal2() is true and exists (
    select 1
    from public.users as u
    join public.staff_profiles as s on s.user_id = u.id
    join public.capability_grants as g on g.user_id = u.id
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
      and s.staff_state = 'active'
      and g.capability_code = 'manage_attorney_verification'
      and g.granted_at <= statement_timestamp()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > statement_timestamp())
      and g.resource_scope is null
      and (allow_any_jurisdiction is true or g.jurisdiction_id is null
           or g.jurisdiction_id = required_jurisdiction)
  );
$function$;

revoke all on function public.has_manage_attorney_verification_scope(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.has_manage_attorney_verification_scope(uuid, boolean)
  to authenticated;

comment on function public.has_manage_attorney_verification_scope(uuid, boolean) is
  'Read-only current-caller verification capability predicate. Requires an aal2 session (MVP-001 S2) and an authenticated caller whose Rosuno User and Staff Profile are both active and who holds a granted, unrevoked, unexpired, non-resource-scoped manage_attorney_verification grant. Any-jurisdiction mode is used only for inactive Practice Area reads. No caller identity or capability parameter.';

create or replace function public.has_staff_capability(
  p_capability text,
  p_jurisdiction uuid,
  p_any_jurisdiction boolean
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select public.current_session_aal2() is true and exists (
    select 1
    from public.users as u
    join public.staff_profiles as s on s.user_id = u.id
    join public.capability_grants as g on g.user_id = u.id
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
      and s.staff_state = 'active'
      and g.capability_code = p_capability
      and g.granted_at <= statement_timestamp()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > statement_timestamp())
      and g.resource_scope is null
      and (p_any_jurisdiction is true or g.jurisdiction_id is null
           or g.jurisdiction_id = p_jurisdiction)
  );
$function$;

revoke all on function public.has_staff_capability(text, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.has_staff_capability(text, uuid, boolean) to authenticated;

comment on function public.has_staff_capability(text, uuid, boolean) is
  'Read-only current-caller capability predicate for row policies: an aal2 session (MVP-001 S2), active User and Staff Profile and one granted, unrevoked, unexpired, non-resource-scoped grant of the capability covering the jurisdiction (null needs a global grant). No caller identity parameter.';

-- ---------------------------------------------------------------------------
-- Staff write locks: aal2 required before any lock is taken.
-- ---------------------------------------------------------------------------

create or replace function public.lock_current_verification_staff(required_jurisdiction uuid)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_staff_state text;
  v_expires timestamptz;
  v_decided timestamptz;
begin
  if public.current_session_aal2() is not true then
    return null;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return null;
  end if;
  select s.staff_state
  into v_staff_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for share;
  if not found or v_staff_state is distinct from 'active' then
    return null;
  end if;
  v_decided := clock_timestamp();
  select g.expires_at
  into v_expires
  from public.capability_grants as g
  where g.user_id = v_user
    and g.capability_code = 'manage_attorney_verification'
    and g.granted_at <= v_decided
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > v_decided)
    and g.resource_scope is null
    and (g.jurisdiction_id is null or g.jurisdiction_id = required_jurisdiction)
  order by g.id
  limit 1
  for share;
  if not found then
    return null;
  end if;
  if v_expires is not null and v_expires <= clock_timestamp() then
    return null;
  end if;
  return v_user;
end;
$function$;

revoke all on function public.lock_current_verification_staff(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.lock_current_capability_staff(
  p_capability text,
  p_jurisdiction uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_staff_state text;
  v_expires timestamptz;
  v_decided timestamptz;
begin
  if public.current_session_aal2() is not true then
    return null;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return null;
  end if;
  select s.staff_state
  into v_staff_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for share;
  if not found or v_staff_state is distinct from 'active' then
    return null;
  end if;
  v_decided := clock_timestamp();
  select g.expires_at
  into v_expires
  from public.capability_grants as g
  where g.user_id = v_user
    and g.capability_code = p_capability
    and g.granted_at <= v_decided
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > v_decided)
    and g.resource_scope is null
    and (g.jurisdiction_id is null or g.jurisdiction_id = p_jurisdiction)
  order by g.id
  limit 1
  for share;
  if not found then
    return null;
  end if;
  if v_expires is not null and v_expires <= clock_timestamp() then
    return null;
  end if;
  return v_user;
end;
$function$;

revoke all on function public.lock_current_capability_staff(text, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.lock_current_intake_configuration_staff()
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_staff_state text;
  v_expires timestamptz;
  v_decided timestamptz;
begin
  if public.current_session_aal2() is not true then
    return null;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return null;
  end if;
  select s.staff_state
  into v_staff_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for share;
  if not found or v_staff_state is distinct from 'active' then
    return null;
  end if;
  v_decided := clock_timestamp();
  select g.expires_at
  into v_expires
  from public.capability_grants as g
  where g.user_id = v_user
    and g.capability_code = 'manage_intake_configuration'
    and g.granted_at <= v_decided
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > v_decided)
    and g.resource_scope is null
    and g.jurisdiction_id is null
  order by g.id
  limit 1
  for share;
  if not found then
    return null;
  end if;
  if v_expires is not null and v_expires <= clock_timestamp() then
    return null;
  end if;
  return v_user;
end;
$function$;

revoke all on function public.lock_current_intake_configuration_staff()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Attorney professional writes: aal2 required before any lock is taken.
-- ---------------------------------------------------------------------------

create or replace function public.lock_current_attorney_profile(for_change boolean)
returns public.attorney_profiles
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_profile public.attorney_profiles;
begin
  if public.current_session_aal2() is not true then
    return v_profile;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return v_profile;
  end if;
  if for_change then
    select p.* into v_profile
    from public.attorney_profiles as p
    where p.user_id = v_user
    for no key update;
  else
    select p.* into v_profile
    from public.attorney_profiles as p
    where p.user_id = v_user
    for share;
  end if;
  return v_profile;
end;
$function$;

revoke all on function public.lock_current_attorney_profile(boolean)
  from public, anon, authenticated, service_role;
