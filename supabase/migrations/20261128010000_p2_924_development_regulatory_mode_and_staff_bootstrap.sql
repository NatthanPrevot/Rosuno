-- P2-924: development regulatory mode and the audited bootstrap of the first two staff administrators, both for
-- non-production databases only.
--
-- Functions only. No relation, column, policy type, lifecycle state, constraint, seed or default is added or changed
-- (PS section 53; PS-A2 section 7).
--
-- Protections common to both functions:
-- - Non-production only: they act only where the recorded class is 'development' or 'staging'. Production answers
--   'environment_not_permitted' and writes nothing.
-- - Environment read only through the PS-A2 section 5 accessors: public.deployment_environment_identity() gives the
--   class and project reference, or 'unrecorded'. The relation itself is never read here.
-- - Privilege: executable only by the database owner role. Execute is revoked from public, anon, authenticated and
--   service_role, so neither function is reachable through the Data API. Both are security invoker with a pinned
--   search_path, use no dynamic SQL, and name every relation by schema.
-- - Target confirmation: the caller states the expected class and project reference; both must equal the accessor's.
--   'unrecorded' answers 'environment_unrecorded'; any difference answers 'environment_mismatch'.
-- - Authorization trail: a non-empty authorization reference (at most 200 characters) is recorded in append-only audit
--   events in the same transaction, with the executing session role, the transaction id and the environment.
-- - Concurrency: every lock is taken before any precondition is read.
--   - Activation locks regulatory_modes and jurisdiction_regulatory_modes in SHARE ROW EXCLUSIVE mode and the
--     jurisdiction row FOR SHARE.
--   - The bootstrap locks capability_grants and staff_profiles in SHARE ROW EXCLUSIVE mode. That blocks concurrent
--     grants, revocations, staff-profile inserts and staff-state changes until it commits. It also locks FOR SHARE the
--     user rows of both grantees, of the authorizing user, and of every holder of a manage_staff_capabilities grant,
--     which blocks concurrent account-state changes. Both modes conflict with themselves, so calls serialize.
--
-- 1. public.activate_development_regulatory_mode(expected class, expected project ref, jurisdiction, authorization)
--    Development configuration for the payment-path functions that need exactly one temporally active Regulatory
--    Mode mapping (FP-1 section 5). It is not M14: it activates no approved regulatory mode of any launch jurisdiction.
--    - The mapping establishes nothing beyond structural and temporal validity: no counsel, regulatory, production,
--      policy or launch approval, and no jurisdiction LIVE status.
--    - 'development_configuration' is written to regulatory_modes.status and jurisdiction_regulatory_modes.
--      approval_status as a descriptive label only. No function reads or branches on either value, and no
--      approval_status vocabulary, meaning, transition model or production-approval predicate is defined (FP-1).
--    - Eligibility selection requires a mode-less version, so the mode never affects eligibility.
--    - One mapping per jurisdiction.
--
-- 2. public.bootstrap_staff_administrators(expected class, expected project ref, first user, second user,
--    authorizing user, grant expiry, authorization)
--    The first two staff administrators of a non-production database, whom no function can otherwise create.
--    - Truthful attribution (PS section 5.2 requires granted_by_user_id NOT NULL referencing users): both grants name
--      the authorizing user. That user must be active and distinct from both grantees, and is the real person who
--      authorized the bootstrap. Nothing records a grant as issued by a user who did not authorize it.
--    - Permitted only while no active administrator exists: no unrevoked, unexpired, in-force global
--      manage_staff_capabilities grant held by an active staff member of an active user.
--    - Both grantees must be distinct, active and not yet staff.
--    - It grants only manage_staff_capabilities (no universal capability). Every other capability is then granted
--      through the audited staff_grant_capability.
--    - An optional grant expiry must lie in the future.

create function public.activate_development_regulatory_mode(
  p_expected_environment_class text,
  p_expected_project_ref text,
  p_jurisdiction_id uuid,
  p_authorization_reference text
)
returns table (outcome text, regulatory_mode_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_class text;
  v_ref text;
  v_code text;
  v_mode uuid;
begin
  select i.environment_class, i.project_ref into v_class, v_ref
  from public.deployment_environment_identity() as i;
  if v_class is null or v_class = 'unrecorded' then
    return query select 'environment_unrecorded'::text, null::uuid;
    return;
  end if;
  if p_expected_environment_class is distinct from v_class or p_expected_project_ref is distinct from v_ref then
    return query select 'environment_mismatch'::text, null::uuid;
    return;
  end if;
  if v_class not in ('development', 'staging') then
    return query select 'environment_not_permitted'::text, null::uuid;
    return;
  end if;
  if p_jurisdiction_id is null
     or p_authorization_reference is null
     or btrim(p_authorization_reference) = ''
     or char_length(p_authorization_reference) > 200 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  lock table public.regulatory_modes, public.jurisdiction_regulatory_modes in share row exclusive mode;
  select j.code into v_code from public.jurisdictions as j where j.id = p_jurisdiction_id for share;
  if v_code is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if exists (
    select 1
    from public.jurisdiction_regulatory_modes as m
    where m.jurisdiction_id = p_jurisdiction_id
      and (m.active_until is null or m.active_until > v_now)
  ) then
    return query select 'already_active'::text, null::uuid;
    return;
  end if;
  if exists (select 1 from public.regulatory_modes as r where r.code = 'DEV_' || v_code) then
    return query select 'already_exists'::text, null::uuid;
    return;
  end if;
  insert into public.regulatory_modes (code, name, description, status)
  values (
    'DEV_' || v_code,
    'Development configuration (not a regulatory approval)',
    'Non-production development configuration (P2-924). It establishes no counsel, regulatory, production, '
      || 'policy or launch approval and no jurisdiction LIVE status.',
    'development_configuration'
  )
  returning id into v_mode;
  insert into public.jurisdiction_regulatory_modes (
    jurisdiction_id, regulatory_mode_id, active_from, active_until, approval_status
  ) values (
    p_jurisdiction_id, v_mode, v_now, null, 'development_configuration'
  );
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'regulatory_mode.development_activated', 'regulatory_mode', v_mode,
    null,
    jsonb_build_object(
      'environment_class', v_class,
      'project_ref', v_ref,
      'jurisdiction_id', p_jurisdiction_id,
      'regulatory_mode_code', 'DEV_' || v_code,
      'active_from', v_now,
      'authorization_reference', p_authorization_reference,
      'executed_by_role', session_user,
      'transaction_id', pg_catalog.txid_current()
    ),
    'owner_authorized_operation', null, p_jurisdiction_id, v_now
  );
  return query select 'activated'::text, v_mode;
end;
$function$;

create function public.bootstrap_staff_administrators(
  p_expected_environment_class text,
  p_expected_project_ref text,
  p_first_user_id uuid,
  p_second_user_id uuid,
  p_authorizing_user_id uuid,
  p_grant_expires_at timestamptz,
  p_authorization_reference text
)
returns table (outcome text, first_grant_id uuid, second_grant_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_class text;
  v_ref text;
  v_active integer;
  v_first_profile uuid;
  v_second_profile uuid;
  v_first_grant uuid;
  v_second_grant uuid;
  v_trail jsonb;
begin
  select i.environment_class, i.project_ref into v_class, v_ref
  from public.deployment_environment_identity() as i;
  if v_class is null or v_class = 'unrecorded' then
    return query select 'environment_unrecorded'::text, null::uuid, null::uuid;
    return;
  end if;
  if p_expected_environment_class is distinct from v_class or p_expected_project_ref is distinct from v_ref then
    return query select 'environment_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_class not in ('development', 'staging') then
    return query select 'environment_not_permitted'::text, null::uuid, null::uuid;
    return;
  end if;
  if p_first_user_id is null
     or p_second_user_id is null
     or p_authorizing_user_id is null
     or p_first_user_id = p_second_user_id
     or p_authorizing_user_id in (p_first_user_id, p_second_user_id)
     or (p_grant_expires_at is not null and p_grant_expires_at <= v_now)
     or p_authorization_reference is null
     or btrim(p_authorization_reference) = ''
     or char_length(p_authorization_reference) > 200 then
    return query select 'invalid'::text, null::uuid, null::uuid;
    return;
  end if;
  -- Every lock before any precondition is read.
  lock table public.capability_grants, public.staff_profiles in share row exclusive mode;
  perform 1
  from public.users as u
  where u.id in (p_first_user_id, p_second_user_id, p_authorizing_user_id)
     or u.id in (
       select g.user_id from public.capability_grants as g
       where g.capability_code = 'manage_staff_capabilities'
     )
  order by u.id
  for share;
  if exists (
    select 1
    from public.capability_grants as g
    join public.staff_profiles as s on s.user_id = g.user_id
    join public.users as u on u.id = g.user_id
    where g.capability_code = 'manage_staff_capabilities'
      and g.jurisdiction_id is null
      and g.resource_scope is null
      and g.revoked_at is null
      and g.granted_at <= v_now
      and (g.expires_at is null or g.expires_at > v_now)
      and s.staff_state = 'active'
      and u.account_state = 'active'
  ) then
    return query select 'administrator_exists'::text, null::uuid, null::uuid;
    return;
  end if;
  if not exists (
    select 1 from public.users as u where u.id = p_authorizing_user_id and u.account_state = 'active'
  ) then
    return query select 'authorizer_not_active'::text, null::uuid, null::uuid;
    return;
  end if;
  select count(*)::integer into v_active
  from public.users as u
  where u.id in (p_first_user_id, p_second_user_id) and u.account_state = 'active';
  if v_active <> 2 then
    return query select 'user_not_active'::text, null::uuid, null::uuid;
    return;
  end if;
  if exists (
    select 1 from public.staff_profiles as s where s.user_id in (p_first_user_id, p_second_user_id)
  ) then
    return query select 'already_staff'::text, null::uuid, null::uuid;
    return;
  end if;
  insert into public.staff_profiles (user_id, staff_state)
  values (p_first_user_id, 'active')
  returning id into v_first_profile;
  insert into public.staff_profiles (user_id, staff_state)
  values (p_second_user_id, 'active')
  returning id into v_second_profile;
  insert into public.capability_grants (
    user_id, capability_code, jurisdiction_id, granted_at, expires_at, resource_scope, granted_by_user_id
  ) values (
    p_first_user_id, 'manage_staff_capabilities', null, v_now, p_grant_expires_at, null, p_authorizing_user_id
  )
  returning id into v_first_grant;
  insert into public.capability_grants (
    user_id, capability_code, jurisdiction_id, granted_at, expires_at, resource_scope, granted_by_user_id
  ) values (
    p_second_user_id, 'manage_staff_capabilities', null, v_now, p_grant_expires_at, null, p_authorizing_user_id
  )
  returning id into v_second_grant;
  v_trail := jsonb_build_object(
    'environment_class', v_class,
    'project_ref', v_ref,
    'authorized_by_user_id', p_authorizing_user_id,
    'authorization_reference', p_authorization_reference,
    'executed_by_role', session_user,
    'transaction_id', pg_catalog.txid_current()
  );
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values
    (null, 'system', 'staff_profile.bootstrapped', 'staff_profile', v_first_profile, null,
     v_trail || jsonb_build_object('user_id', p_first_user_id, 'staff_state', 'active'),
     'owner_authorized_operation', null, null, v_now),
    (null, 'system', 'staff_profile.bootstrapped', 'staff_profile', v_second_profile, null,
     v_trail || jsonb_build_object('user_id', p_second_user_id, 'staff_state', 'active'),
     'owner_authorized_operation', null, null, v_now),
    (null, 'system', 'capability_grant.bootstrapped', 'capability_grant', v_first_grant, null,
     v_trail || jsonb_build_object('user_id', p_first_user_id, 'capability_code', 'manage_staff_capabilities',
                                   'jurisdiction_id', null, 'expires_at', p_grant_expires_at,
                                   'granted_by_user_id', p_authorizing_user_id),
     'owner_authorized_operation', null, null, v_now),
    (null, 'system', 'capability_grant.bootstrapped', 'capability_grant', v_second_grant, null,
     v_trail || jsonb_build_object('user_id', p_second_user_id, 'capability_code', 'manage_staff_capabilities',
                                   'jurisdiction_id', null, 'expires_at', p_grant_expires_at,
                                   'granted_by_user_id', p_authorizing_user_id),
     'owner_authorized_operation', null, null, v_now);
  return query select 'bootstrapped'::text, v_first_grant, v_second_grant;
end;
$function$;

revoke all on function public.activate_development_regulatory_mode(text, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.bootstrap_staff_administrators(text, text, uuid, uuid, uuid, timestamptz, text)
  from public, anon, authenticated, service_role;
