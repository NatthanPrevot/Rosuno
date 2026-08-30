-- WI-P1-003-JURISDICTION-POLICY-LAUNCH-FOUNDATION
-- Physical migration 3 / implementation slice 1C.
-- Jurisdiction-neutral policy provenance and launch-control foundation only.

create table public.jurisdictions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  region_type text not null,
  lifecycle_state text not null default 'unsupported',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint jurisdictions_code_key unique (code),
  constraint jurisdictions_code_check
    check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  constraint jurisdictions_lifecycle_state_check
    check (
      lifecycle_state in (
        'unsupported',
        'waitlist',
        'staged',
        'ready',
        'live',
        'restricted',
        'suspended'
      )
    )
);

create table public.service_areas (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null,
  code text not null,
  name text not null,
  active_from timestamptz not null,
  active_until timestamptz,
  constraint service_areas_jurisdiction_id_code_key
    unique (jurisdiction_id, code),
  constraint service_areas_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint service_areas_code_check
    check (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  constraint service_areas_effective_period_check
    check (active_until is null or active_until > active_from)
);

create table public.regulatory_modes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text,
  status text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint regulatory_modes_code_key unique (code),
  constraint regulatory_modes_code_check
    check (code ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

create table public.jurisdiction_regulatory_modes (
  jurisdiction_id uuid not null,
  regulatory_mode_id uuid not null,
  active_from timestamptz not null,
  active_until timestamptz,
  approval_status text not null,
  constraint jurisdiction_regulatory_modes_pkey
    primary key (jurisdiction_id, regulatory_mode_id, active_from),
  constraint jurisdiction_regulatory_modes_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint jurisdiction_regulatory_modes_regulatory_mode_id_fkey
    foreign key (regulatory_mode_id)
    references public.regulatory_modes (id)
    on update restrict
    on delete restrict,
  constraint jurisdiction_regulatory_modes_effective_period_check
    check (active_until is null or active_until > active_from)
);

create table public.policy_types (
  code text primary key,
  name text not null,
  description text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint policy_types_code_check
    check (code ~ '^[a-z][a-z0-9_]{2,63}$')
);

create table public.policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_type_code text not null,
  jurisdiction_id uuid,
  regulatory_mode_id uuid,
  version_label text not null,
  parameters jsonb not null,
  status text not null default 'draft',
  effective_from timestamptz,
  effective_until timestamptz,
  approved_at timestamptz,
  approved_by_user_id uuid,
  supersedes_policy_version_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint policy_versions_scope_version_key
    unique nulls not distinct (
      policy_type_code,
      jurisdiction_id,
      regulatory_mode_id,
      version_label
    ),
  constraint policy_versions_policy_type_code_fkey
    foreign key (policy_type_code)
    references public.policy_types (code)
    on update restrict
    on delete restrict,
  constraint policy_versions_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint policy_versions_regulatory_mode_id_fkey
    foreign key (regulatory_mode_id)
    references public.regulatory_modes (id)
    on update restrict
    on delete restrict,
  constraint policy_versions_approved_by_user_id_fkey
    foreign key (approved_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint policy_versions_supersedes_policy_version_id_fkey
    foreign key (supersedes_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint policy_versions_parameters_check
    check (jsonb_typeof(parameters) = 'object'),
  constraint policy_versions_status_check
    check (
      status in (
        'draft',
        'internal_review',
        'counsel_review',
        'approved',
        'scheduled',
        'active',
        'suspended',
        'retired'
      )
    ),
  constraint policy_versions_effective_period_check
    check (effective_until is null or effective_until > effective_from),
  constraint policy_versions_approval_pair_check
    check ((approved_at is null) = (approved_by_user_id is null)),
  constraint policy_versions_approval_state_check
    check (
      (
        status in ('draft', 'internal_review', 'counsel_review')
        and approved_at is null
      )
      or
      (
        status in ('approved', 'scheduled', 'active', 'suspended', 'retired')
        and approved_at is not null
      )
    ),
  constraint policy_versions_effective_state_check
    check (
      status not in ('scheduled', 'active', 'suspended', 'retired')
      or effective_from is not null
    ),
  constraint policy_versions_not_self_superseding_check
    check (supersedes_policy_version_id is null or supersedes_policy_version_id <> id)
);

create table public.policy_authority_references (
  id uuid primary key default gen_random_uuid(),
  policy_version_id uuid not null,
  authority_type text not null,
  citation_text text not null,
  source_uri text,
  source_title text not null,
  retrieved_at timestamptz not null,
  verified_by_user_id uuid,
  verification_status text not null,
  notes text,
  created_at timestamptz not null default statement_timestamp(),
  constraint policy_authority_references_policy_version_id_fkey
    foreign key (policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint policy_authority_references_verified_by_user_id_fkey
    foreign key (verified_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint policy_authority_references_verified_actor_check
    check (verification_status <> 'verified' or verified_by_user_id is not null)
);

create table public.launch_gates (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null,
  gate_code text not null,
  required boolean not null,
  description text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint launch_gates_jurisdiction_id_gate_code_key
    unique (jurisdiction_id, gate_code),
  constraint launch_gates_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint launch_gates_gate_code_check
    check (gate_code ~ '^[a-z][a-z0-9_]{2,63}$')
);

create table public.launch_gate_evaluations (
  id uuid primary key default gen_random_uuid(),
  launch_gate_id uuid not null,
  evaluation_status text not null,
  evaluated_at timestamptz not null,
  evidence_reference jsonb,
  evaluated_by_user_id uuid,
  reason text,
  created_at timestamptz not null default statement_timestamp(),
  constraint launch_gate_evaluations_launch_gate_id_fkey
    foreign key (launch_gate_id)
    references public.launch_gates (id)
    on update restrict
    on delete restrict,
  constraint launch_gate_evaluations_evaluated_by_user_id_fkey
    foreign key (evaluated_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint launch_gate_evaluations_evidence_reference_check
    check (evidence_reference is null or jsonb_typeof(evidence_reference) = 'object')
);

create table public.launch_authorizations (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null,
  authorized_at timestamptz not null,
  authorized_by_user_id uuid not null,
  revoked_at timestamptz,
  reason text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint launch_authorizations_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint launch_authorizations_authorized_by_user_id_fkey
    foreign key (authorized_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint launch_authorizations_reason_check
    check (char_length(btrim(reason)) > 0),
  constraint launch_authorizations_revoked_at_check
    check (revoked_at is null or revoked_at >= authorized_at)
);

alter table public.capability_grants
  add constraint capability_grants_jurisdiction_id_fkey
  foreign key (jurisdiction_id)
  references public.jurisdictions (id)
  on update restrict
  on delete restrict;

comment on table public.jurisdictions is
  'Jurisdiction-neutral operating context; LIVE remains distinct from readiness and explicit launch authorization.';
comment on table public.service_areas is
  'Jurisdiction operating boundary; never an attorney physical-location inference.';
comment on table public.regulatory_modes is
  'Stable regulatory-mode configuration; no jurisdiction-specific mode is seeded by this migration.';
comment on table public.jurisdiction_regulatory_modes is
  'Effective-dated jurisdiction and regulatory-mode relationship history.';
comment on table public.policy_types is
  'Stable policy-type catalog; this migration intentionally creates no policy-type rows.';
comment on table public.policy_versions is
  'Versioned policy configuration selected by explicit context, status, and effective period; no universal latest policy exists.';
comment on column public.policy_versions.parameters is
  'Structured policy configuration; policy-type-specific validation remains required before approval.';
comment on table public.policy_authority_references is
  'Human-verifiable authority provenance supporting a policy version; AI output alone is not legal verification.';
comment on table public.launch_gates is
  'Jurisdiction launch requirements; satisfied prerequisites do not themselves grant launch authorization.';
comment on table public.launch_gate_evaluations is
  'Historical gate-evaluation evidence; evaluation does not itself make a jurisdiction LIVE.';
comment on table public.launch_authorizations is
  'Explicit human launch authorization history, separate from jurisdiction readiness and gate evaluation.';
comment on column public.capability_grants.jurisdiction_id is
  'Optional jurisdiction scope enforced by locked physical Migration 3.';

create function public.enforce_policy_authority_provenance()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  affected_policy_version_id uuid;
begin
  for affected_policy_version_id in
    select distinct candidate_id
    from unnest(
      case
        when tg_table_name = 'policy_versions' then
          array[
            nullif(to_jsonb(new) ->> 'id', '')::uuid,
            nullif(to_jsonb(old) ->> 'id', '')::uuid
          ]::uuid[]
        else
          array[
            nullif(to_jsonb(new) ->> 'policy_version_id', '')::uuid,
            nullif(to_jsonb(old) ->> 'policy_version_id', '')::uuid
          ]::uuid[]
      end
    ) candidate_id
    where candidate_id is not null
  loop
    if exists (
      select 1
      from public.policy_versions
      where id = affected_policy_version_id
        and status in ('approved', 'scheduled', 'active', 'suspended', 'retired')
    ) and not exists (
      select 1
      from public.policy_authority_references
      where policy_version_id = affected_policy_version_id
        and verification_status = 'verified'
        and verified_by_user_id is not null
    ) then
      raise exception using
        errcode = '23514',
        message = 'approved policy version requires verified authority provenance';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function public.enforce_jurisdiction_live_authorization()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  affected_jurisdiction_id uuid;
begin
  for affected_jurisdiction_id in
    select distinct candidate_id
    from unnest(
      case
        when tg_table_name = 'jurisdictions' then
          array[
            nullif(to_jsonb(new) ->> 'id', '')::uuid,
            nullif(to_jsonb(old) ->> 'id', '')::uuid
          ]::uuid[]
        else
          array[
            nullif(to_jsonb(new) ->> 'jurisdiction_id', '')::uuid,
            nullif(to_jsonb(old) ->> 'jurisdiction_id', '')::uuid
          ]::uuid[]
      end
    ) candidate_id
    where candidate_id is not null
  loop
    if exists (
      select 1
      from public.jurisdictions
      where id = affected_jurisdiction_id
        and lifecycle_state = 'live'
    ) and not exists (
      select 1
      from public.launch_authorizations
      where jurisdiction_id = affected_jurisdiction_id
        and revoked_at is null
    ) then
      raise exception using
        errcode = '23514',
        message = 'live jurisdiction requires explicit active launch authorization';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_policy_authority_provenance() from public;
revoke execute on function public.enforce_policy_authority_provenance() from anon;
revoke execute on function public.enforce_policy_authority_provenance() from authenticated;
grant execute on function public.enforce_policy_authority_provenance() to postgres;
grant execute on function public.enforce_policy_authority_provenance() to service_role;

revoke execute on function public.enforce_jurisdiction_live_authorization() from public;
revoke execute on function public.enforce_jurisdiction_live_authorization() from anon;
revoke execute on function public.enforce_jurisdiction_live_authorization() from authenticated;
grant execute on function public.enforce_jurisdiction_live_authorization() to postgres;
grant execute on function public.enforce_jurisdiction_live_authorization() to service_role;

alter table public.jurisdictions enable row level security;
alter table public.service_areas enable row level security;
alter table public.regulatory_modes enable row level security;
alter table public.jurisdiction_regulatory_modes enable row level security;
alter table public.policy_types enable row level security;
alter table public.policy_versions enable row level security;
alter table public.policy_authority_references enable row level security;
alter table public.launch_gates enable row level security;
alter table public.launch_gate_evaluations enable row level security;
alter table public.launch_authorizations enable row level security;

revoke all on table public.jurisdictions from public;
revoke all on table public.jurisdictions from anon;
revoke all on table public.jurisdictions from authenticated;
revoke all on table public.jurisdictions from service_role;
grant select, insert, update on table public.jurisdictions to service_role;

revoke all on table public.service_areas from public;
revoke all on table public.service_areas from anon;
revoke all on table public.service_areas from authenticated;
revoke all on table public.service_areas from service_role;
grant select, insert, update on table public.service_areas to service_role;

revoke all on table public.regulatory_modes from public;
revoke all on table public.regulatory_modes from anon;
revoke all on table public.regulatory_modes from authenticated;
revoke all on table public.regulatory_modes from service_role;
grant select, insert, update on table public.regulatory_modes to service_role;

revoke all on table public.jurisdiction_regulatory_modes from public;
revoke all on table public.jurisdiction_regulatory_modes from anon;
revoke all on table public.jurisdiction_regulatory_modes from authenticated;
revoke all on table public.jurisdiction_regulatory_modes from service_role;
grant select, insert, update on table public.jurisdiction_regulatory_modes to service_role;

revoke all on table public.policy_types from public;
revoke all on table public.policy_types from anon;
revoke all on table public.policy_types from authenticated;
revoke all on table public.policy_types from service_role;
grant select, insert, update on table public.policy_types to service_role;

revoke all on table public.policy_versions from public;
revoke all on table public.policy_versions from anon;
revoke all on table public.policy_versions from authenticated;
revoke all on table public.policy_versions from service_role;
grant select, insert, update on table public.policy_versions to service_role;

revoke all on table public.policy_authority_references from public;
revoke all on table public.policy_authority_references from anon;
revoke all on table public.policy_authority_references from authenticated;
revoke all on table public.policy_authority_references from service_role;
grant select, insert, update on table public.policy_authority_references to service_role;

revoke all on table public.launch_gates from public;
revoke all on table public.launch_gates from anon;
revoke all on table public.launch_gates from authenticated;
revoke all on table public.launch_gates from service_role;
grant select, insert, update on table public.launch_gates to service_role;

revoke all on table public.launch_gate_evaluations from public;
revoke all on table public.launch_gate_evaluations from anon;
revoke all on table public.launch_gate_evaluations from authenticated;
revoke all on table public.launch_gate_evaluations from service_role;
grant select, insert, update on table public.launch_gate_evaluations to service_role;

revoke all on table public.launch_authorizations from public;
revoke all on table public.launch_authorizations from anon;
revoke all on table public.launch_authorizations from authenticated;
revoke all on table public.launch_authorizations from service_role;
grant select, insert, update on table public.launch_authorizations to service_role;

create trigger jurisdictions_set_updated_at
before update on public.jurisdictions
for each row
execute function public.set_updated_at();

create trigger regulatory_modes_set_updated_at
before update on public.regulatory_modes
for each row
execute function public.set_updated_at();

create trigger policy_types_set_updated_at
before update on public.policy_types
for each row
execute function public.set_updated_at();

create trigger policy_versions_set_updated_at
before update on public.policy_versions
for each row
execute function public.set_updated_at();

create trigger launch_gates_set_updated_at
before update on public.launch_gates
for each row
execute function public.set_updated_at();

create constraint trigger policy_versions_require_authority
after insert or update on public.policy_versions
for each row
execute function public.enforce_policy_authority_provenance();

create constraint trigger policy_authority_references_preserve_approval
after insert or update or delete on public.policy_authority_references
for each row
execute function public.enforce_policy_authority_provenance();

create constraint trigger jurisdictions_require_launch_authorization
after insert or update on public.jurisdictions
for each row
execute function public.enforce_jurisdiction_live_authorization();

create constraint trigger launch_authorizations_preserve_live_boundary
after insert or update or delete on public.launch_authorizations
for each row
execute function public.enforce_jurisdiction_live_authorization();
