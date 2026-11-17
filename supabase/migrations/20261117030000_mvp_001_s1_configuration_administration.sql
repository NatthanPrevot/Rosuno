-- MVP-001 S1 (3 of 4): configuration administration (M3 machinery, core M14 machinery, M2 capability
-- administration).
--
-- Staff operate policy versions and their authority references, jurisdictions, service areas, practice areas,
-- launch gates, gate evaluations, human launch authorizations and capability grants only through
-- operation-specific SECURITY DEFINER functions. Each function derives the actor from auth.uid(), locks
-- User -> Staff Profile -> grant, checks one capability for the exact jurisdiction scope, writes its change and
-- one audit event in one transaction, and answers a fixed outcome. Staff read these relations through row
-- policies decided by has_staff_capability. The four-way production financial gate (MBS sections 6 and 19)
-- is one internal function. No catalog, grant, gate or authorization row is inserted here, no jurisdiction
-- becomes live, and no regulatory-mode activation is written (M14).

-- ---------------------------------------------------------------------------
-- Capability catalog (no universal capability; grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values
  ('manage_policy_configuration'),
  ('manage_jurisdiction_configuration'),
  ('authorize_jurisdiction_launch'),
  ('manage_staff_capabilities');

-- ---------------------------------------------------------------------------
-- Capability decision for the current caller.
-- ---------------------------------------------------------------------------

-- Read predicate for row policies: the caller's User and Staff Profile are active and one granted, unrevoked,
-- unexpired, non-resource-scoped grant of p_capability covers p_jurisdiction (a null jurisdiction needs a
-- global grant; p_any_jurisdiction accepts any grant of the capability).
create function public.has_staff_capability(
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
  select exists (
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

-- Read predicate for the users row policy: the caller may administer capabilities and the row belongs to a
-- staff User. Decided as the definer so the predicate never re-enters the users or staff_profiles row policies.
create function public.capability_admin_may_read_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select public.has_staff_capability('manage_staff_capabilities', null, false)
    and exists (select 1 from public.staff_profiles as s where s.user_id = p_user_id);
$function$;

-- Write lock: the caller's staff User when, on rows locked FOR SHARE in the order User -> Staff Profile ->
-- grant, both are active and one grant of p_capability is currently valid for exactly this scope (null: the
-- global scope). Otherwise null.
create function public.lock_current_capability_staff(
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

create function public.configuration_audit(
  p_actor uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_jurisdiction uuid
)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    p_actor, 'staff', p_action, p_resource_type, p_resource_id,
    p_before, p_after, null, null, p_jurisdiction, clock_timestamp()
  );
$function$;

-- ---------------------------------------------------------------------------
-- History protection: gate evaluations are append-only; a launch authorization or a capability grant changes
-- only by recording its revocation once.
-- ---------------------------------------------------------------------------

create function public.configuration_history_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if tg_op = 'DELETE' or tg_table_name = 'launch_gate_evaluations' then
    raise exception '% history is append-only', tg_table_name
      using errcode = '55000';
  end if;
  if old.revoked_at is not null
     or new.revoked_at is null
     or (to_jsonb(new) - 'revoked_at' - 'updated_at')
        is distinct from (to_jsonb(old) - 'revoked_at' - 'updated_at') then
    raise exception '% changes only by recording its revocation once', tg_table_name
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger launch_gate_evaluations_append_only
before update or delete on public.launch_gate_evaluations
for each row
execute function public.configuration_history_integrity();

create trigger launch_authorizations_history
before update or delete on public.launch_authorizations
for each row
execute function public.configuration_history_integrity();

create trigger capability_grants_history
before update or delete on public.capability_grants
for each row
execute function public.configuration_history_integrity();

-- ---------------------------------------------------------------------------
-- Policy versions and authority references (manage_policy_configuration).
-- ---------------------------------------------------------------------------

create function public.staff_create_policy_version(
  p_policy_type_code text,
  p_jurisdiction_id uuid,
  p_regulatory_mode_id uuid,
  p_version_label text,
  p_parameters jsonb,
  p_effective_from timestamptz,
  p_effective_until timestamptz,
  p_supersedes_policy_version_id uuid,
  p_development_only boolean
)
returns table (outcome text, policy_version_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_id uuid;
begin
  if p_policy_type_code is null
     or p_version_label is null
     or not public.professional_text_within(p_version_label, 80)
     or p_parameters is null
     or jsonb_typeof(p_parameters) <> 'object'
     or octet_length(p_parameters::text) > 65536
     or p_development_only is null
     or (p_effective_until is not null
         and (p_effective_from is null or p_effective_until <= p_effective_from))
     or (p_development_only and p_effective_from is null) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select v_environment, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', p_jurisdiction_id);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if p_development_only
     and public.rosuno_environment_class() not in ('development', 'staging') then
    return query select 'environment_refused'::text, null::uuid;
    return;
  end if;
  if p_supersedes_policy_version_id is not null and not exists (
    select 1 from public.policy_versions as v
    where v.id = p_supersedes_policy_version_id
      and v.policy_type_code = p_policy_type_code
      and v.jurisdiction_id is not distinct from p_jurisdiction_id
      and v.regulatory_mode_id is not distinct from p_regulatory_mode_id
  ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  begin
    insert into public.policy_versions (
      policy_type_code, jurisdiction_id, regulatory_mode_id, version_label,
      parameters, status, effective_from, effective_until,
      supersedes_policy_version_id, development_only
    ) values (
      p_policy_type_code, p_jurisdiction_id, p_regulatory_mode_id, p_version_label,
      p_parameters, 'draft', p_effective_from, p_effective_until,
      p_supersedes_policy_version_id, p_development_only
    )
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
    when foreign_key_violation or check_violation then
      return query select 'invalid'::text, null::uuid;
      return;
  end;
  perform public.configuration_audit(
    v_staff, 'policy_version.created', 'policy_version', v_id, null,
    jsonb_build_object(
      'policy_type_code', p_policy_type_code,
      'version_label', p_version_label,
      'development_only', p_development_only,
      'parameters_sha256', encode(sha256(convert_to(p_parameters::text, 'UTF8')), 'hex'),
      'effective_from', p_effective_from,
      'effective_until', p_effective_until,
      'supersedes_policy_version_id', p_supersedes_policy_version_id
    ),
    p_jurisdiction_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

-- Revises an authority-path draft (draft, internal_review or counsel_review) at exactly the version the caller saw.
create function public.staff_revise_policy_draft(
  p_policy_version_id uuid,
  p_expected_updated_at timestamptz,
  p_version_label text,
  p_parameters jsonb,
  p_effective_from timestamptz,
  p_effective_until timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_jurisdiction uuid;
  v_before public.policy_versions;
begin
  if p_policy_version_id is null
     or p_expected_updated_at is null
     or p_version_label is null
     or not public.professional_text_within(p_version_label, 80)
     or p_parameters is null
     or jsonb_typeof(p_parameters) <> 'object'
     or octet_length(p_parameters::text) > 65536
     or (p_effective_until is not null
         and (p_effective_from is null or p_effective_until <= p_effective_from)) then
    return 'invalid';
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return v_environment;
  end if;
  select v.jurisdiction_id into v_jurisdiction
  from public.policy_versions as v where v.id = p_policy_version_id;
  if not found then
    return 'not_found';
  end if;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', v_jurisdiction);
  if v_staff is null then
    return 'denied';
  end if;
  select v.* into v_before
  from public.policy_versions as v
  where v.id = p_policy_version_id
  for no key update;
  if v_before.development_only
     or v_before.status not in ('draft', 'internal_review', 'counsel_review') then
    return 'locked';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  begin
    update public.policy_versions as v
    set version_label = p_version_label,
        parameters = p_parameters,
        effective_from = p_effective_from,
        effective_until = p_effective_until
    where v.id = v_before.id;
  exception
    when unique_violation then
      return 'conflict';
    when check_violation then
      return 'invalid';
  end;
  perform public.configuration_audit(
    v_staff, 'policy_version.revised', 'policy_version', v_before.id,
    jsonb_build_object(
      'version_label', v_before.version_label,
      'parameters_sha256', encode(sha256(convert_to(v_before.parameters::text, 'UTF8')), 'hex'),
      'effective_from', v_before.effective_from,
      'effective_until', v_before.effective_until
    ),
    jsonb_build_object(
      'version_label', p_version_label,
      'parameters_sha256', encode(sha256(convert_to(p_parameters::text, 'UTF8')), 'hex'),
      'effective_from', p_effective_from,
      'effective_until', p_effective_until
    ),
    v_jurisdiction
  );
  return 'applied';
end;
$function$;

-- Moves a version along the DM lifecycle. Approval needs a verified authority reference and records the
-- approving staff User; scheduled and active need an effective start (future or reached, respectively).
create function public.staff_transition_policy_version(
  p_policy_version_id uuid,
  p_expected_updated_at timestamptz,
  p_target_status text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_jurisdiction uuid;
  v_before public.policy_versions;
  v_now timestamptz;
begin
  if p_policy_version_id is null
     or p_expected_updated_at is null
     or p_target_status is null
     or p_target_status not in (
       'draft', 'internal_review', 'counsel_review', 'approved',
       'scheduled', 'active', 'suspended', 'retired'
     ) then
    return 'invalid';
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return v_environment;
  end if;
  select v.jurisdiction_id into v_jurisdiction
  from public.policy_versions as v where v.id = p_policy_version_id;
  if not found then
    return 'not_found';
  end if;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', v_jurisdiction);
  if v_staff is null then
    return 'denied';
  end if;
  select v.* into v_before
  from public.policy_versions as v
  where v.id = p_policy_version_id
  for no key update;
  if v_before.development_only then
    return 'locked';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  if not (
    (v_before.status = 'draft' and p_target_status = 'internal_review')
    or (v_before.status = 'internal_review' and p_target_status in ('draft', 'counsel_review'))
    or (v_before.status = 'counsel_review' and p_target_status in ('draft', 'internal_review', 'approved'))
    or (v_before.status = 'approved' and p_target_status in ('scheduled', 'active', 'retired'))
    or (v_before.status = 'scheduled' and p_target_status in ('active', 'retired'))
    or (v_before.status = 'active' and p_target_status in ('suspended', 'retired'))
    or (v_before.status = 'suspended' and p_target_status in ('active', 'retired'))
  ) then
    return 'invalid_transition';
  end if;
  v_now := statement_timestamp();
  if p_target_status = 'approved' and not exists (
    select 1 from public.policy_authority_references as r
    where r.policy_version_id = v_before.id
      and r.verification_status = 'verified'
      and r.verified_by_user_id is not null
  ) then
    return 'authority_unverified';
  end if;
  -- effective_from is fixed once a version is approved, so approval needs it set.
  if (p_target_status = 'approved' and v_before.effective_from is null)
     or (p_target_status = 'scheduled'
      and (v_before.effective_from is null or v_before.effective_from <= v_now))
     or (p_target_status = 'active'
         and (v_before.effective_from is null or v_before.effective_from > v_now
              or (v_before.effective_until is not null and v_before.effective_until <= v_now))) then
    return 'effective_period_required';
  end if;
  update public.policy_versions as v
  set status = p_target_status,
      approved_at = case when p_target_status = 'approved' then v_now else v.approved_at end,
      approved_by_user_id = case when p_target_status = 'approved' then v_staff else v.approved_by_user_id end
  where v.id = v_before.id;
  perform public.configuration_audit(
    v_staff, 'policy_version.transitioned', 'policy_version', v_before.id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', p_target_status),
    v_jurisdiction
  );
  return 'applied';
end;
$function$;

-- Ends an approved-family version or a development configuration by setting effective_until once.
create function public.staff_end_policy_version(
  p_policy_version_id uuid,
  p_effective_until timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_jurisdiction uuid;
  v_before public.policy_versions;
begin
  if p_policy_version_id is null or p_effective_until is null then
    return 'invalid';
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return v_environment;
  end if;
  select v.jurisdiction_id into v_jurisdiction
  from public.policy_versions as v where v.id = p_policy_version_id;
  if not found then
    return 'not_found';
  end if;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', v_jurisdiction);
  if v_staff is null then
    return 'denied';
  end if;
  select v.* into v_before
  from public.policy_versions as v
  where v.id = p_policy_version_id
  for no key update;
  if not (v_before.development_only
          or v_before.status in ('approved', 'scheduled', 'active', 'suspended')) then
    return 'locked';
  end if;
  if v_before.effective_until is not null then
    return 'already_ended';
  end if;
  if p_effective_until < statement_timestamp()
     or (v_before.effective_from is not null and p_effective_until <= v_before.effective_from) then
    return 'invalid';
  end if;
  update public.policy_versions as v
  set effective_until = p_effective_until
  where v.id = v_before.id;
  perform public.configuration_audit(
    v_staff, 'policy_version.ended', 'policy_version', v_before.id,
    jsonb_build_object('effective_until', null),
    jsonb_build_object('effective_until', p_effective_until),
    v_jurisdiction
  );
  return 'applied';
end;
$function$;

create function public.staff_add_policy_authority_reference(
  p_policy_version_id uuid,
  p_authority_type text,
  p_citation_text text,
  p_source_uri text,
  p_source_title text,
  p_retrieved_at timestamptz
)
returns table (outcome text, reference_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_version public.policy_versions;
  v_id uuid;
begin
  if p_policy_version_id is null
     or p_authority_type is null
     or not public.professional_text_within(p_authority_type, 80)
     or p_citation_text is null
     or not public.professional_text_within(p_citation_text, 1000)
     or not public.professional_text_within(p_source_uri, 2048)
     or (p_source_uri is not null and p_source_uri !~ '^https://')
     or p_source_title is null
     or not public.professional_text_within(p_source_title, 300)
     or p_retrieved_at is null
     or p_retrieved_at > statement_timestamp() then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select v_environment, null::uuid;
    return;
  end if;
  select v.* into v_version
  from public.policy_versions as v where v.id = p_policy_version_id;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', v_version.jurisdiction_id);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  select v.* into v_version
  from public.policy_versions as v
  where v.id = p_policy_version_id
  for share;
  if v_version.development_only
     or v_version.status not in ('draft', 'internal_review', 'counsel_review') then
    return query select 'locked'::text, null::uuid;
    return;
  end if;
  insert into public.policy_authority_references (
    policy_version_id, authority_type, citation_text, source_uri, source_title,
    retrieved_at, verified_by_user_id, verification_status
  ) values (
    v_version.id, p_authority_type, p_citation_text, p_source_uri, p_source_title,
    p_retrieved_at, null, 'unverified'
  )
  returning id into v_id;
  perform public.configuration_audit(
    v_staff, 'policy_authority_reference.added', 'policy_authority_reference', v_id, null,
    jsonb_build_object(
      'policy_version_id', v_version.id,
      'authority_type', p_authority_type,
      'source_title', p_source_title
    ),
    v_version.jurisdiction_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

-- Records a human verification decision on an authority reference of a draft-family version. The verifier is
-- the calling staff User; AI output alone is never verification (RMS section 39).
create function public.staff_decide_policy_authority_reference(
  p_reference_id uuid,
  p_decision text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_reference public.policy_authority_references;
  v_version public.policy_versions;
begin
  if p_reference_id is null
     or p_decision is null
     or p_decision not in ('verified', 'rejected') then
    return 'invalid';
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return v_environment;
  end if;
  select r.* into v_reference
  from public.policy_authority_references as r where r.id = p_reference_id;
  if not found then
    return 'not_found';
  end if;
  select v.* into v_version
  from public.policy_versions as v where v.id = v_reference.policy_version_id;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', v_version.jurisdiction_id);
  if v_staff is null then
    return 'denied';
  end if;
  select v.* into v_version
  from public.policy_versions as v
  where v.id = v_reference.policy_version_id
  for share;
  select r.* into v_reference
  from public.policy_authority_references as r
  where r.id = p_reference_id
  for no key update;
  if v_version.development_only
     or v_version.status not in ('draft', 'internal_review', 'counsel_review') then
    return 'locked';
  end if;
  if v_reference.verification_status is not distinct from p_decision then
    return 'unchanged';
  end if;
  update public.policy_authority_references as r
  set verification_status = p_decision,
      verified_by_user_id = case when p_decision = 'verified' then v_staff end
  where r.id = v_reference.id;
  perform public.configuration_audit(
    v_staff, 'policy_authority_reference.decided', 'policy_authority_reference', v_reference.id,
    jsonb_build_object('verification_status', v_reference.verification_status),
    jsonb_build_object('verification_status', p_decision),
    v_version.jurisdiction_id
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Jurisdictions, service areas and practice areas (manage_jurisdiction_configuration).
-- ---------------------------------------------------------------------------

create function public.staff_create_jurisdiction(
  p_code text,
  p_name text,
  p_region_type text
)
returns table (outcome text, jurisdiction_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_id uuid;
begin
  if p_code is null
     or not (p_code collate "C" ~ '^[A-Z][A-Z0-9_]{1,31}$')
     or p_name is null
     or not public.professional_text_within(p_name, 120)
     or p_region_type is null
     or not public.professional_text_within(p_region_type, 40) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  begin
    insert into public.jurisdictions (code, name, region_type, lifecycle_state)
    values (p_code, p_name, p_region_type, 'unsupported')
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
  end;
  perform public.configuration_audit(
    v_staff, 'jurisdiction.created', 'jurisdiction', v_id, null,
    jsonb_build_object('code', p_code, 'name', p_name, 'region_type', p_region_type,
                       'lifecycle_state', 'unsupported'),
    v_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

-- Changes a jurisdiction's lifecycle state. LIVE needs every required launch gate's latest evaluation to have
-- passed and an active launch authorization (MBS section 6: no arbitrary manual LIVE).
create function public.staff_change_jurisdiction_lifecycle(
  p_jurisdiction_id uuid,
  p_expected_updated_at timestamptz,
  p_target_state text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.jurisdictions;
begin
  if p_jurisdiction_id is null
     or p_expected_updated_at is null
     or p_target_state is null
     or p_target_state not in (
       'unsupported', 'waitlist', 'staged', 'ready', 'live', 'restricted', 'suspended'
     ) then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', p_jurisdiction_id);
  if v_staff is null then
    return 'denied';
  end if;
  select j.* into v_before
  from public.jurisdictions as j
  where j.id = p_jurisdiction_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  if v_before.lifecycle_state = p_target_state then
    return 'unchanged';
  end if;
  if p_target_state = 'live' then
    if not public.launch_gates_passed(p_jurisdiction_id) then
      return 'launch_gates_unmet';
    end if;
    if not exists (
      select 1 from public.launch_authorizations as a
      where a.jurisdiction_id = p_jurisdiction_id and a.revoked_at is null
    ) then
      return 'launch_authorization_required';
    end if;
  end if;
  update public.jurisdictions as j
  set lifecycle_state = p_target_state
  where j.id = v_before.id;
  perform public.configuration_audit(
    v_staff, 'jurisdiction.lifecycle_changed', 'jurisdiction', v_before.id,
    jsonb_build_object('lifecycle_state', v_before.lifecycle_state),
    jsonb_build_object('lifecycle_state', p_target_state),
    v_before.id
  );
  return 'applied';
end;
$function$;

create function public.staff_create_service_area(
  p_jurisdiction_id uuid,
  p_code text,
  p_name text,
  p_active_from timestamptz,
  p_active_until timestamptz
)
returns table (outcome text, service_area_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_id uuid;
begin
  if p_jurisdiction_id is null
     or p_code is null
     or not (p_code collate "C" ~ '^[A-Z][A-Z0-9_]{1,63}$')
     or p_name is null
     or not public.professional_text_within(p_name, 120)
     or p_active_from is null
     or (p_active_until is not null and p_active_until <= p_active_from) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', p_jurisdiction_id);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  begin
    insert into public.service_areas (jurisdiction_id, code, name, active_from, active_until)
    values (p_jurisdiction_id, p_code, p_name, p_active_from, p_active_until)
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
    when foreign_key_violation then
      return query select 'invalid'::text, null::uuid;
      return;
  end;
  perform public.configuration_audit(
    v_staff, 'service_area.created', 'service_area', v_id, null,
    jsonb_build_object('code', p_code, 'name', p_name, 'active_from', p_active_from,
                       'active_until', p_active_until),
    p_jurisdiction_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

create function public.staff_create_practice_area(
  p_code text,
  p_name text
)
returns table (outcome text, practice_area_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_id uuid;
begin
  if p_code is null
     or not (p_code collate "C" ~ '^[a-z][a-z0-9_]{1,63}$')
     or p_name is null
     or not public.professional_text_within(p_name, 120) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  begin
    insert into public.practice_areas (code, name, active)
    values (p_code, p_name, true)
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
  end;
  perform public.configuration_audit(
    v_staff, 'practice_area.created', 'practice_area', v_id, null,
    jsonb_build_object('code', p_code, 'name', p_name, 'active', true),
    null
  );
  return query select 'created'::text, v_id;
end;
$function$;

create function public.staff_set_practice_area_active(
  p_practice_area_id uuid,
  p_active boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before boolean;
begin
  if p_practice_area_id is null or p_active is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', null);
  if v_staff is null then
    return 'denied';
  end if;
  select a.active into v_before
  from public.practice_areas as a
  where a.id = p_practice_area_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  if v_before = p_active then
    return 'unchanged';
  end if;
  update public.practice_areas as a set active = p_active where a.id = p_practice_area_id;
  perform public.configuration_audit(
    v_staff, 'practice_area.activity_changed', 'practice_area', p_practice_area_id,
    jsonb_build_object('active', v_before), jsonb_build_object('active', p_active), null
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Launch gates, evaluations and human launch authorization.
-- ---------------------------------------------------------------------------

-- True when the jurisdiction has at least one required gate and the latest evaluation of every required gate
-- passed.
create function public.launch_gates_passed(p_jurisdiction_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select exists (
      select 1 from public.launch_gates as g
      where g.jurisdiction_id = p_jurisdiction_id and g.required
    )
    and not exists (
      select 1 from public.launch_gates as g
      where g.jurisdiction_id = p_jurisdiction_id
        and g.required
        and coalesce((
          select e.evaluation_status
          from public.launch_gate_evaluations as e
          where e.launch_gate_id = g.id
          order by e.evaluated_at desc, e.id desc
          limit 1
        ), 'none') <> 'passed'
    );
$function$;

create function public.staff_define_launch_gate(
  p_jurisdiction_id uuid,
  p_gate_code text,
  p_required boolean,
  p_description text
)
returns table (outcome text, launch_gate_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_id uuid;
begin
  if p_jurisdiction_id is null
     or p_gate_code is null
     or not (p_gate_code collate "C" ~ '^[a-z][a-z0-9_]{2,63}$')
     or p_required is null
     or not public.professional_text_within(p_description, 500) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', p_jurisdiction_id);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  perform 1 from public.jurisdictions as j where j.id = p_jurisdiction_id for share;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  begin
    insert into public.launch_gates (jurisdiction_id, gate_code, required, description)
    values (p_jurisdiction_id, p_gate_code, p_required, p_description)
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
  end;
  perform public.configuration_audit(
    v_staff, 'launch_gate.defined', 'launch_gate', v_id, null,
    jsonb_build_object('gate_code', p_gate_code, 'required', p_required),
    p_jurisdiction_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

create function public.staff_record_launch_gate_evaluation(
  p_launch_gate_id uuid,
  p_evaluation_status text,
  p_evidence_reference jsonb,
  p_reason text
)
returns table (outcome text, evaluation_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_jurisdiction uuid;
  v_id uuid;
begin
  if p_launch_gate_id is null
     or p_evaluation_status is null
     or p_evaluation_status not in ('passed', 'failed')
     or (p_evidence_reference is not null and jsonb_typeof(p_evidence_reference) <> 'object')
     or (p_evidence_reference is not null and octet_length(p_evidence_reference::text) > 8192)
     or p_reason is null
     or not public.professional_text_within(p_reason, 500) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select g.jurisdiction_id into v_jurisdiction
  from public.launch_gates as g where g.id = p_launch_gate_id;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_jurisdiction_configuration', v_jurisdiction);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  perform 1 from public.launch_gates as g where g.id = p_launch_gate_id for share;
  insert into public.launch_gate_evaluations (
    launch_gate_id, evaluation_status, evaluated_at, evidence_reference,
    evaluated_by_user_id, reason
  ) values (
    p_launch_gate_id, p_evaluation_status, clock_timestamp(), p_evidence_reference,
    v_staff, p_reason
  )
  returning id into v_id;
  perform public.configuration_audit(
    v_staff, 'launch_gate.evaluated', 'launch_gate_evaluation', v_id, null,
    jsonb_build_object('launch_gate_id', p_launch_gate_id, 'evaluation_status', p_evaluation_status),
    v_jurisdiction
  );
  return query select 'created'::text, v_id;
end;
$function$;

create function public.staff_grant_launch_authorization(
  p_jurisdiction_id uuid,
  p_reason text
)
returns table (outcome text, launch_authorization_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_id uuid;
begin
  if p_jurisdiction_id is null
     or p_reason is null
     or not public.professional_text_within(p_reason, 500) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('authorize_jurisdiction_launch', p_jurisdiction_id);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  perform 1 from public.jurisdictions as j where j.id = p_jurisdiction_id for no key update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if exists (
    select 1 from public.launch_authorizations as a
    where a.jurisdiction_id = p_jurisdiction_id and a.revoked_at is null
  ) then
    return query select 'already_authorized'::text, null::uuid;
    return;
  end if;
  if not public.launch_gates_passed(p_jurisdiction_id) then
    return query select 'launch_gates_unmet'::text, null::uuid;
    return;
  end if;
  insert into public.launch_authorizations (jurisdiction_id, authorized_at, authorized_by_user_id, reason)
  values (p_jurisdiction_id, clock_timestamp(), v_staff, p_reason)
  returning id into v_id;
  perform public.configuration_audit(
    v_staff, 'launch_authorization.granted', 'launch_authorization', v_id, null,
    jsonb_build_object('jurisdiction_id', p_jurisdiction_id), p_jurisdiction_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

create function public.staff_revoke_launch_authorization(
  p_launch_authorization_id uuid,
  p_reason text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.launch_authorizations;
  v_state text;
begin
  if p_launch_authorization_id is null
     or p_reason is null
     or not public.professional_text_within(p_reason, 500) then
    return 'invalid';
  end if;
  select a.* into v_before
  from public.launch_authorizations as a where a.id = p_launch_authorization_id;
  if not found then
    return 'not_found';
  end if;
  v_staff := public.lock_current_capability_staff('authorize_jurisdiction_launch', v_before.jurisdiction_id);
  if v_staff is null then
    return 'denied';
  end if;
  select j.lifecycle_state into v_state
  from public.jurisdictions as j where j.id = v_before.jurisdiction_id for no key update;
  select a.* into v_before
  from public.launch_authorizations as a
  where a.id = p_launch_authorization_id
  for no key update;
  if v_before.revoked_at is not null then
    return 'already_revoked';
  end if;
  if v_state = 'live' and not exists (
    select 1 from public.launch_authorizations as a
    where a.jurisdiction_id = v_before.jurisdiction_id
      and a.revoked_at is null
      and a.id <> v_before.id
  ) then
    return 'jurisdiction_live';
  end if;
  update public.launch_authorizations as a
  set revoked_at = clock_timestamp()
  where a.id = v_before.id;
  perform public.configuration_audit(
    v_staff, 'launch_authorization.revoked', 'launch_authorization', v_before.id,
    jsonb_build_object('revoked_at', null),
    jsonb_build_object('revoked', true, 'reason', p_reason),
    v_before.jurisdiction_id
  );
  return 'applied';
end;
$function$;

-- MBS sections 6 and 19; TA section 32 F2: production financial activity only when the recorded environment is
-- production, the jurisdiction is live, an approved authority policy (never development configuration) is
-- selected, and an unrevoked launch authorization exists. Three of four is not enough.
create function public.production_financial_gate(
  p_jurisdiction_id uuid,
  p_policy_type_code text,
  p_regulatory_mode_id uuid,
  p_as_of timestamptz
)
returns table (permitted boolean, reason text)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_environment text;
  v_selection record;
begin
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return query select false, v_environment;
    return;
  end if;
  if public.rosuno_environment_class() <> 'production' then
    return query select false, 'environment_not_production'::text;
    return;
  end if;
  if not exists (
    select 1 from public.jurisdictions as j
    where j.id = p_jurisdiction_id and j.lifecycle_state = 'live'
  ) then
    return query select false, 'jurisdiction_not_live'::text;
    return;
  end if;
  select * into v_selection
  from public.policy_select_version(p_policy_type_code, p_jurisdiction_id, p_regulatory_mode_id, p_as_of);
  if v_selection.outcome is distinct from 'selected' or v_selection.development_only then
    return query select false, 'policy_not_approved'::text;
    return;
  end if;
  if not exists (
    select 1 from public.launch_authorizations as a
    where a.jurisdiction_id = p_jurisdiction_id and a.revoked_at is null
  ) then
    return query select false, 'launch_authorization_missing'::text;
    return;
  end if;
  return query select true, 'permitted'::text;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Capability grants (manage_staff_capabilities, global scope only).
-- ---------------------------------------------------------------------------

create function public.staff_grant_capability(
  p_user_id uuid,
  p_capability_code text,
  p_jurisdiction_id uuid,
  p_expires_at timestamptz
)
returns table (outcome text, grant_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_target_state text;
  v_target_staff text;
  v_id uuid;
begin
  if p_user_id is null
     or p_capability_code is null
     or (p_expires_at is not null and p_expires_at <= statement_timestamp()) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_staff_capabilities', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if p_user_id = v_staff then
    return query select 'self_grant_refused'::text, null::uuid;
    return;
  end if;
  if not exists (
    select 1 from public.capability_definitions as c where c.capability_code = p_capability_code
  ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select u.account_state into v_target_state
  from public.users as u where u.id = p_user_id for share;
  select s.staff_state into v_target_staff
  from public.staff_profiles as s where s.user_id = p_user_id for share;
  if v_target_state is distinct from 'active' or v_target_staff is distinct from 'active' then
    return query select 'target_not_active_staff'::text, null::uuid;
    return;
  end if;
  if p_jurisdiction_id is not null and not exists (
    select 1 from public.jurisdictions as j where j.id = p_jurisdiction_id
  ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  insert into public.capability_grants (
    user_id, capability_code, jurisdiction_id, granted_at, expires_at, resource_scope,
    granted_by_user_id
  ) values (
    p_user_id, p_capability_code, p_jurisdiction_id, clock_timestamp(), p_expires_at, null,
    v_staff
  )
  returning id into v_id;
  perform public.configuration_audit(
    v_staff, 'capability_grant.granted', 'capability_grant', v_id, null,
    jsonb_build_object('user_id', p_user_id, 'capability_code', p_capability_code,
                       'jurisdiction_id', p_jurisdiction_id, 'expires_at', p_expires_at),
    p_jurisdiction_id
  );
  return query select 'created'::text, v_id;
end;
$function$;

create function public.staff_revoke_capability(
  p_grant_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.capability_grants;
begin
  if p_grant_id is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_staff_capabilities', null);
  if v_staff is null then
    return 'denied';
  end if;
  select g.* into v_before
  from public.capability_grants as g
  where g.id = p_grant_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  if v_before.revoked_at is not null then
    return 'already_revoked';
  end if;
  update public.capability_grants as g
  set revoked_at = clock_timestamp()
  where g.id = v_before.id;
  perform public.configuration_audit(
    v_staff, 'capability_grant.revoked', 'capability_grant', v_before.id,
    jsonb_build_object('revoked_at', null),
    jsonb_build_object('user_id', v_before.user_id, 'capability_code', v_before.capability_code,
                       'revoked', true),
    v_before.jurisdiction_id
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Staff read policies (request-scoped, unprivileged reads).
-- ---------------------------------------------------------------------------

create policy policy_versions_staff_read on public.policy_versions
  for select to authenticated
  using (public.has_staff_capability('manage_policy_configuration', jurisdiction_id, false));
create policy policy_authority_references_staff_read on public.policy_authority_references
  for select to authenticated
  using (exists (
    select 1 from public.policy_versions as v
    where v.id = policy_version_id
      and public.has_staff_capability('manage_policy_configuration', v.jurisdiction_id, false)
  ));
create policy policy_types_staff_read on public.policy_types
  for select to authenticated
  using (public.has_staff_capability('manage_policy_configuration', null, true));
create policy jurisdictions_staff_read on public.jurisdictions
  for select to authenticated
  using (
    public.has_staff_capability('manage_jurisdiction_configuration', id, false)
    or public.has_staff_capability('manage_policy_configuration', id, false)
    or public.has_staff_capability('authorize_jurisdiction_launch', id, false)
    or public.has_staff_capability('manage_staff_capabilities', null, false)
  );
create policy service_areas_staff_read on public.service_areas
  for select to authenticated
  using (public.has_staff_capability('manage_jurisdiction_configuration', jurisdiction_id, false));
create policy launch_gates_staff_read on public.launch_gates
  for select to authenticated
  using (
    public.has_staff_capability('manage_jurisdiction_configuration', jurisdiction_id, false)
    or public.has_staff_capability('authorize_jurisdiction_launch', jurisdiction_id, false)
  );
create policy launch_gate_evaluations_staff_read on public.launch_gate_evaluations
  for select to authenticated
  using (exists (
    select 1 from public.launch_gates as g
    where g.id = launch_gate_id
      and (public.has_staff_capability('manage_jurisdiction_configuration', g.jurisdiction_id, false)
           or public.has_staff_capability('authorize_jurisdiction_launch', g.jurisdiction_id, false))
  ));
create policy launch_authorizations_staff_read on public.launch_authorizations
  for select to authenticated
  using (
    public.has_staff_capability('manage_jurisdiction_configuration', jurisdiction_id, false)
    or public.has_staff_capability('authorize_jurisdiction_launch', jurisdiction_id, false)
  );
create policy practice_areas_configuration_staff_read on public.practice_areas
  for select to authenticated
  using (public.has_staff_capability('manage_jurisdiction_configuration', null, false));
create policy capability_definitions_staff_read on public.capability_definitions
  for select to authenticated
  using (public.has_staff_capability('manage_staff_capabilities', null, false));
create policy capability_grants_staff_read on public.capability_grants
  for select to authenticated
  using (public.has_staff_capability('manage_staff_capabilities', null, false));
create policy staff_profiles_capability_admin_read on public.staff_profiles
  for select to authenticated
  using (public.has_staff_capability('manage_staff_capabilities', null, false));
create policy users_capability_admin_read on public.users
  for select to authenticated
  using (public.capability_admin_may_read_user(id));

grant select on table public.policy_versions to authenticated;
grant select on table public.policy_authority_references to authenticated;
grant select on table public.policy_types to authenticated;
grant select on table public.jurisdictions to authenticated;
grant select on table public.service_areas to authenticated;
grant select on table public.launch_gates to authenticated;
grant select on table public.launch_gate_evaluations to authenticated;
grant select on table public.launch_authorizations to authenticated;
grant select on table public.capability_definitions to authenticated;
grant select on table public.capability_grants to authenticated;

-- ---------------------------------------------------------------------------
-- Direct writes on configuration relations are retired for service_role; staff write through the functions
-- above, and regulatory-mode rows are written only by reviewed migrations until M14.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on table public.jurisdictions from service_role;
revoke insert, update, delete, truncate on table public.service_areas from service_role;
revoke insert, update, delete, truncate on table public.regulatory_modes from service_role;
revoke insert, update, delete, truncate on table public.jurisdiction_regulatory_modes from service_role;
revoke insert, update, delete, truncate on table public.launch_gates from service_role;
revoke insert, update, delete, truncate on table public.launch_gate_evaluations from service_role;
revoke insert, update, delete, truncate on table public.launch_authorizations from service_role;
revoke insert, update, delete, truncate on table public.practice_areas from service_role;
revoke insert, update, delete, truncate on table public.capability_grants from service_role;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.lock_current_capability_staff(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.configuration_audit(uuid, text, text, uuid, jsonb, jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.configuration_history_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.launch_gates_passed(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.production_financial_gate(uuid, text, uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.has_staff_capability(text, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.has_staff_capability(text, uuid, boolean) to authenticated;
revoke all on function public.capability_admin_may_read_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.capability_admin_may_read_user(uuid) to authenticated;

do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.staff_create_policy_version(text, uuid, uuid, text, jsonb, timestamptz, timestamptz, uuid, boolean)',
    'public.staff_revise_policy_draft(uuid, timestamptz, text, jsonb, timestamptz, timestamptz)',
    'public.staff_transition_policy_version(uuid, timestamptz, text)',
    'public.staff_end_policy_version(uuid, timestamptz)',
    'public.staff_add_policy_authority_reference(uuid, text, text, text, text, timestamptz)',
    'public.staff_decide_policy_authority_reference(uuid, text)',
    'public.staff_create_jurisdiction(text, text, text)',
    'public.staff_change_jurisdiction_lifecycle(uuid, timestamptz, text)',
    'public.staff_create_service_area(uuid, text, text, timestamptz, timestamptz)',
    'public.staff_create_practice_area(text, text)',
    'public.staff_set_practice_area_active(uuid, boolean)',
    'public.staff_define_launch_gate(uuid, text, boolean, text)',
    'public.staff_record_launch_gate_evaluation(uuid, text, jsonb, text)',
    'public.staff_grant_launch_authorization(uuid, text)',
    'public.staff_revoke_launch_authorization(uuid, text)',
    'public.staff_grant_capability(uuid, text, uuid, timestamptz)',
    'public.staff_revoke_capability(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$grants$;

comment on function public.production_financial_gate(uuid, text, uuid, timestamptz) is
  'MBS sections 6 and 19: production financial activity is permitted only when the recorded environment is production, the jurisdiction is live, an approved authority policy is selected, and an unrevoked launch authorization exists.';
comment on function public.has_staff_capability(text, uuid, boolean) is
  'Read-only current-caller capability predicate for row policies: active User and Staff Profile and one granted, unrevoked, unexpired, non-resource-scoped grant of the capability covering the jurisdiction (null needs a global grant). No caller identity parameter.';
