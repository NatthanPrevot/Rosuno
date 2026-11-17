-- MVP-001 S1 (1 of 4): deployment environment identity and development-configuration designation.
--
-- Implements Physical Specification bounded amendment PS-A2, referenced by identifier and SHA-256 only
-- (PHYSICAL-SPECIFICATION-AMENDMENT-PS-A2-LOCKED, sha256
-- 599c2235f540233c7475dd28799bfb2bb201c09cf88e53d2461b35099a42a1ba), together with:
-- - immutable policy history once a version is approved (MBS section 6; PS section 32);
-- - the stable policy-type catalog of PS section 8.3 plus the FP-1 payment types, as reference data
--   (PS section 45);
-- - one environment-anchored policy resolver used by every policy-driven database function.
--
-- Nothing here records an environment, creates a policy version, grants a capability or inserts any business
-- row. Each database records its own environment once, through record_deployment_environment, under separate
-- owner authorization (PS-A2 section 4). Until then every policy-driven function refuses with
-- environment_unrecorded.

-- ---------------------------------------------------------------------------
-- PS-A2 section 2: deployment_environment (one immutable row per database).
-- ---------------------------------------------------------------------------

create table public.deployment_environment (
  id uuid primary key default gen_random_uuid(),
  environment_class text not null,
  project_ref text,
  created_at timestamptz not null default statement_timestamp(),
  constraint deployment_environment_class_check
    check (environment_class in ('development', 'staging', 'production')),
  constraint deployment_environment_project_ref_format_check
    check (project_ref is null or project_ref collate "C" ~ '^[a-z]{20}$'),
  constraint deployment_environment_project_ref_presence_check
    check (
      (environment_class = 'development' and project_ref is null)
      or (environment_class in ('staging', 'production') and project_ref is not null)
    )
);

create unique index deployment_environment_single_row
  on public.deployment_environment ((true));

alter table public.deployment_environment enable row level security;

revoke all on table public.deployment_environment from public;
revoke all on table public.deployment_environment from anon;
revoke all on table public.deployment_environment from authenticated;
revoke all on table public.deployment_environment from service_role;

create function public.deployment_environment_reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  raise exception '% is immutable', tg_table_name
    using errcode = '55000';
end;
$function$;

create trigger deployment_environment_immutable
before update or delete on public.deployment_environment
for each row
execute function public.deployment_environment_reject_mutation();

create trigger deployment_environment_no_truncate
before truncate on public.deployment_environment
for each statement
execute function public.deployment_environment_reject_mutation();

-- ---------------------------------------------------------------------------
-- PS-A2 section 4: initialization (database owner role only, once, audited).
-- ---------------------------------------------------------------------------

create function public.record_deployment_environment(
  p_environment_class text,
  p_project_ref text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_id uuid;
begin
  if p_environment_class is null
     or p_environment_class not in ('development', 'staging', 'production') then
    raise exception 'unknown environment class'
      using errcode = '22023';
  end if;
  if p_environment_class = 'development' then
    if p_project_ref is not null then
      raise exception 'a development environment has no project reference'
        using errcode = '22023';
    end if;
  elsif p_project_ref is null or not (p_project_ref collate "C" ~ '^[a-z]{20}$') then
    raise exception 'a hosted environment needs a 20-letter project reference'
      using errcode = '22023';
  end if;
  lock table public.deployment_environment in share row exclusive mode;
  if exists (select 1 from public.deployment_environment) then
    raise exception 'the deployment environment is already recorded'
      using errcode = '55000';
  end if;
  insert into public.deployment_environment (environment_class, project_ref)
  values (p_environment_class, p_project_ref)
  returning id into v_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'database_owner', 'deployment_environment.recorded',
    'deployment_environment', v_id, null,
    jsonb_build_object(
      'environment_class', p_environment_class,
      'project_ref', p_project_ref
    ),
    null, null, null, clock_timestamp()
  );
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- PS-A2 section 5: accessors and the environment guard.
-- ---------------------------------------------------------------------------

-- Internal: the recorded class, or 'unrecorded'.
create function public.rosuno_environment_class()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce(
    (select d.environment_class from public.deployment_environment as d limit 1),
    'unrecorded'
  );
$function$;

-- Internal: 'ok', 'environment_unrecorded' or 'environment_mismatch'. A request whose
-- Supabase Auth JWT issuer is https://<20 lowercase letters>.supabase.co/auth/v1 must name
-- the recorded project; an issuer of any other form is not used; unreadable claims fail closed.
create function public.rosuno_environment_status()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_class text;
  v_ref text;
  v_raw text;
  v_claims jsonb;
  v_jwt_ref text;
begin
  select d.environment_class, d.project_ref
  into v_class, v_ref
  from public.deployment_environment as d
  limit 1;
  if not found then
    return 'environment_unrecorded';
  end if;
  v_raw := nullif(current_setting('request.jwt.claims', true), '');
  if v_raw is null then
    return 'ok';
  end if;
  begin
    v_claims := v_raw::jsonb;
  exception
    when others then
      return 'environment_mismatch';
  end;
  if jsonb_typeof(v_claims) <> 'object' then
    return 'environment_mismatch';
  end if;
  if jsonb_typeof(v_claims -> 'iss') = 'string' then
    v_jwt_ref := substring(
      (v_claims ->> 'iss') collate "C"
      from '^https://([a-z]{20})\.supabase\.co/auth/v1$'
    );
    if v_jwt_ref is not null and v_jwt_ref is distinct from v_ref then
      return 'environment_mismatch';
    end if;
  end if;
  return 'ok';
end;
$function$;

-- API: the recorded class (or 'unrecorded') and project reference only.
create function public.deployment_environment_identity()
returns table (environment_class text, project_ref text)
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce(d.environment_class, 'unrecorded'), d.project_ref
  from (select 1) as one
  left join public.deployment_environment as d on true
  limit 1;
$function$;

-- ---------------------------------------------------------------------------
-- PS-A2 section 3: policy_versions.development_only.
-- ---------------------------------------------------------------------------

alter table public.policy_versions
  add column development_only boolean not null default false;

alter table public.policy_versions
  add constraint policy_versions_development_configuration_check
    check (
      not development_only
      or (
        status = 'draft'
        and approved_at is null
        and approved_by_user_id is null
        and effective_from is not null
      )
    );

-- Creation rules for development configuration (PS-A2 section 3), and the immutable policy history:
-- - a development configuration is fixed at creation except one closing of effective_until;
-- - an approved-family version keeps its content; only the DM lifecycle moves its status, and
--   effective_until may be set once to end it;
-- - a draft-family version moves only along draft -> internal_review -> counsel_review -> approved
--   (or back within the draft family) and may be revised while in the draft family;
-- - every version is created as a draft;
-- - no version is ever deleted.
create function public.policy_version_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  v_class text;
begin
  if tg_op = 'DELETE' then
    raise exception 'policy versions are never deleted'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    -- Every version enters the DM lifecycle as a draft; approval is reached only by transition.
    if new.status is distinct from 'draft' then
      raise exception 'a policy version is created as a draft'
        using errcode = '23514';
    end if;
    if new.development_only then
      v_class := public.rosuno_environment_class();
      if v_class not in ('development', 'staging') then
        raise exception
          'development configuration cannot be created in a % environment', v_class
          using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or new.development_only is distinct from old.development_only then
    raise exception 'policy version identity is fixed'
      using errcode = '55000';
  end if;

  if old.development_only
     or old.status in ('approved', 'scheduled', 'active', 'suspended', 'retired') then
    if new.policy_type_code is distinct from old.policy_type_code
       or new.jurisdiction_id is distinct from old.jurisdiction_id
       or new.regulatory_mode_id is distinct from old.regulatory_mode_id
       or new.version_label is distinct from old.version_label
       or new.parameters is distinct from old.parameters
       or new.effective_from is distinct from old.effective_from
       or new.approved_at is distinct from old.approved_at
       or new.approved_by_user_id is distinct from old.approved_by_user_id
       or new.supersedes_policy_version_id is distinct from old.supersedes_policy_version_id then
      raise exception 'an approved or development policy version is immutable'
        using errcode = '55000';
    end if;
    if new.effective_until is distinct from old.effective_until
       and (old.effective_until is not null
            or new.effective_until is null
            or new.effective_until < statement_timestamp()) then
      raise exception 'effective_until may only be set once, to end the version'
        using errcode = '55000';
    end if;
    if old.development_only then
      if new.status is distinct from old.status then
        raise exception 'a development configuration has no status transition'
          using errcode = '55000';
      end if;
      return new;
    end if;
    if new.status is distinct from old.status
       and not (
         (old.status = 'approved' and new.status in ('scheduled', 'active', 'retired'))
         or (old.status = 'scheduled' and new.status in ('active', 'retired'))
         or (old.status = 'active' and new.status in ('suspended', 'retired'))
         or (old.status = 'suspended' and new.status in ('active', 'retired'))
       ) then
      raise exception 'policy status transition % -> % is not permitted', old.status, new.status
        using errcode = '55000';
    end if;
    return new;
  end if;

  -- Draft family (not development configuration).
  if new.status is distinct from old.status
     and not (
       (old.status = 'draft' and new.status = 'internal_review')
       or (old.status = 'internal_review' and new.status in ('draft', 'counsel_review'))
       or (old.status = 'counsel_review' and new.status in ('draft', 'internal_review', 'approved'))
     ) then
    raise exception 'policy status transition % -> % is not permitted', old.status, new.status
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger policy_versions_integrity
before insert or update or delete on public.policy_versions
for each row
execute function public.policy_version_integrity();

create trigger policy_versions_no_truncate
before truncate on public.policy_versions
for each statement
execute function public.deployment_environment_reject_mutation();

-- Authority references are fixed once their version is approved (MBS section 20: policy authority references
-- after use): they may not be changed, moved between versions or deleted. Further references may still be
-- added to any version.
create function public.policy_authority_reference_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  v_version uuid;
begin
  if tg_op = 'INSERT' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.policy_version_id is distinct from old.policy_version_id then
    raise exception 'an authority reference cannot move between policy versions'
      using errcode = '55000';
  end if;
  v_version := old.policy_version_id;
  if exists (
    select 1 from public.policy_versions as v
    where v.id = v_version
      and v.status in ('approved', 'scheduled', 'active', 'suspended', 'retired')
  ) then
    raise exception 'authority references of an approved policy version are fixed'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create trigger policy_authority_references_integrity
before update or delete on public.policy_authority_references
for each row
execute function public.policy_authority_reference_integrity();

-- ---------------------------------------------------------------------------
-- Stable policy-type catalog (PS section 8.3 plus FP-1 section 1), reference data (PS section 45).
-- ---------------------------------------------------------------------------

insert into public.policy_types (code, name)
values
  ('referral', 'Referral'),
  ('fee', 'Fee'),
  ('engagement', 'Engagement'),
  ('cancellation', 'Cancellation'),
  ('refund', 'Refund'),
  ('retention', 'Retention'),
  ('notification', 'Notification'),
  ('eligibility', 'Eligibility'),
  ('bookability', 'Bookability'),
  ('scheduling', 'Scheduling'),
  ('reporting', 'Reporting'),
  ('governance', 'Governance'),
  ('automated_referral_quality', 'Automated referral quality'),
  ('payment', 'Payment'),
  ('payment_flow', 'Payment flow')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- PS-A2 section 5: the environment-anchored resolver (TA section 31: fail honestly when nothing applies,
-- block when two apply; DM: selection by jurisdiction, scope, type, effective date and status).
-- ---------------------------------------------------------------------------

create function public.policy_select_version(
  p_policy_type_code text,
  p_jurisdiction_id uuid,
  p_regulatory_mode_id uuid,
  p_as_of timestamptz
)
returns table (outcome text, policy_version_id uuid, development_only boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_status text;
  v_class text;
  v_count integer;
  v_id uuid;
  v_dev boolean;
begin
  v_status := public.rosuno_environment_status();
  if v_status <> 'ok' then
    return query select v_status, null::uuid, null::boolean;
    return;
  end if;
  if p_policy_type_code is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::boolean;
    return;
  end if;
  v_class := public.rosuno_environment_class();
  select count(*), (array_agg(v.id order by v.id))[1], bool_or(v.development_only)
  into v_count, v_id, v_dev
  from public.policy_versions as v
  where v.policy_type_code = p_policy_type_code
    and v.jurisdiction_id is not distinct from p_jurisdiction_id
    and v.regulatory_mode_id is not distinct from p_regulatory_mode_id
    and v.effective_from is not null
    and v.effective_from <= p_as_of
    and (v.effective_until is null or v.effective_until > p_as_of)
    and (
      (
        not v.development_only
        and v.status = 'active'
        and v.approved_at is not null
        and v.approved_by_user_id is not null
        and exists (
          select 1 from public.policy_authority_references as r
          where r.policy_version_id = v.id
            and r.verification_status = 'verified'
            and r.verified_by_user_id is not null
        )
      )
      or (
        v.development_only
        and v.status = 'draft'
        and v_class in ('development', 'staging')
      )
    );
  if v_count = 0 then
    return query select 'no_applicable_policy'::text, null::uuid, null::boolean;
  elsif v_count > 1 then
    return query select 'policy_conflict'::text, null::uuid, null::boolean;
  else
    return query select 'selected'::text, v_id, v_dev;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Privileges. Policy relations are written only through operation-specific functions from now on.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on table public.policy_versions from service_role;
revoke insert, update, delete, truncate on table public.policy_authority_references from service_role;
revoke insert, update, delete, truncate on table public.policy_types from service_role;

revoke all on function public.deployment_environment_reject_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.record_deployment_environment(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.rosuno_environment_class()
  from public, anon, authenticated, service_role;
revoke all on function public.rosuno_environment_status()
  from public, anon, authenticated, service_role;
revoke all on function public.policy_version_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.policy_authority_reference_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.policy_select_version(text, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.deployment_environment_identity()
  from public, anon, authenticated, service_role;
grant execute on function public.deployment_environment_identity()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on table public.deployment_environment is
  'PS-A2: the database''s own environment class and, for hosted databases, its project reference. One immutable row, recorded once by the database owner role through record_deployment_environment. Absence means unrecorded and is never treated as any environment.';
comment on column public.policy_versions.development_only is
  'PS-A2: true marks executable development configuration (TA section 32 F1): always draft, never approved, fixed at creation except one closing of effective_until, created and selectable only in development or staging databases.';
comment on function public.policy_select_version(text, uuid, uuid, timestamptz) is
  'PS-A2 section 5: the single applicable policy version for an exact type, jurisdiction and regulatory-mode scope at an instant, or environment_unrecorded, environment_mismatch, no_applicable_policy or policy_conflict.';
