-- WI-P1-002-AUTHORIZATION-SCOPE-CORRECTION
-- Forward-only correction of the P1-002 authorization surface.

do $$
declare
  target_table regclass;
  target_name text;
  row_count bigint;
  unexpected_dependents text[];
begin
  foreach target_name in array array['attorney_profiles', 'client_profiles']
  loop
    target_table := format('public.%I', target_name)::regclass;

    execute format('select count(*) from %s', target_table)
      into row_count;
    if row_count <> 0 then
      raise exception
        'authorization scope correction requires public.% to contain zero rows; found %',
        target_name,
        row_count;
    end if;

    select array_agg(
      pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid)
      order by pg_describe_object(
        dependency.classid,
        dependency.objid,
        dependency.objsubid
      )
    )
      into unexpected_dependents
    from pg_depend as dependency
    where dependency.refclassid = 'pg_class'::regclass
      and dependency.refobjid = target_table
      and dependency.refobjsubid = 0
      and dependency.deptype = 'n';

    if coalesce(cardinality(unexpected_dependents), 0) <> 0 then
      raise exception
        'authorization scope correction found unexpected dependents for public.%: %',
        target_name,
        unexpected_dependents;
    end if;
  end loop;
end
$$;

drop table public.attorney_profiles;
drop table public.client_profiles;

drop trigger capability_definitions_set_updated_at
  on public.capability_definitions;
drop trigger capability_grants_set_updated_at
  on public.capability_grants;
drop trigger application_sessions_set_updated_at
  on public.application_sessions;

alter table public.staff_profiles
  drop constraint staff_profiles_lifecycle_state_check,
  drop constraint staff_profiles_years_experience_check;

alter table public.staff_profiles
  rename column lifecycle_state to staff_state;

alter table public.staff_profiles
  alter column staff_state drop default,
  drop column years_experience,
  add constraint staff_profiles_staff_state_check
    check (
      staff_state in (
        'invited',
        'active',
        'suspended',
        'disabled'
      )
    );

drop index public.capability_grants_user_capability_idx;

alter table public.capability_grants
  drop constraint capability_grants_capability_definition_id_fkey,
  drop constraint capability_grants_validity_check,
  drop constraint capability_grants_granted_at_check,
  drop constraint capability_grants_revoked_at_check,
  add column capability_code text not null,
  add column granted_by_user_id uuid not null,
  add column resource_scope jsonb,
  drop column capability_definition_id,
  drop column valid_from;

alter table public.capability_definitions
  drop constraint capability_definitions_pkey,
  drop constraint capability_definitions_capability_code_check,
  drop column id,
  drop column description,
  drop column created_at,
  drop column updated_at;

alter table public.capability_grants
  add constraint capability_grants_staff_profile_user_id_fkey
    foreign key (user_id)
    references public.staff_profiles (user_id)
    on update restrict
    on delete restrict,
  add constraint capability_grants_capability_code_fkey
    foreign key (capability_code)
    references public.capability_definitions (capability_code)
    on update restrict
    on delete restrict,
  add constraint capability_grants_granted_by_user_id_fkey
    foreign key (granted_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  add constraint capability_grants_validity_check
    check (valid_until is null or valid_until > granted_at),
  add constraint capability_grants_revoked_at_check
    check (revoked_at is null or revoked_at >= granted_at);

create index capability_grants_active_lookup_idx
  on public.capability_grants (
    user_id,
    capability_code,
    jurisdiction_id,
    revoked_at,
    valid_until
  );

alter table public.application_sessions
  drop constraint application_sessions_reference_length_check,
  drop constraint application_sessions_expiry_check,
  drop constraint application_sessions_revoked_at_check;

alter table public.application_sessions
  rename column session_reference to auth_session_reference;

alter table public.application_sessions
  rename column expires_at to ended_at;

alter table public.application_sessions
  rename constraint application_sessions_session_reference_key
    to application_sessions_auth_session_reference_key;

alter table public.application_sessions
  add column started_at timestamptz not null,
  alter column ended_at drop not null,
  drop column updated_at,
  add constraint application_sessions_auth_session_reference_length_check
    check (char_length(auth_session_reference) between 16 and 256),
  add constraint application_sessions_started_at_check
    check (started_at <= created_at),
  add constraint application_sessions_ended_at_check
    check (ended_at is null or ended_at > started_at),
  add constraint application_sessions_revoked_at_check
    check (revoked_at is null or revoked_at >= started_at);

create index application_sessions_user_started_at_idx
  on public.application_sessions (user_id, started_at);

comment on table public.staff_profiles is
  'Staff profile with a server-authoritative staff state.';
comment on table public.capability_definitions is
  'Stable capability catalog; this migration intentionally creates no capability rows.';
comment on table public.capability_grants is
  'Capability grant history for Staff subjects; this migration intentionally creates no grant rows.';
comment on table public.application_sessions is
  'Application session metadata; authentication workflows and secrets remain out of scope.';
comment on column public.capability_grants.jurisdiction_id is
  'Optional jurisdiction scope enforced by locked physical Migration 3.';
comment on column public.application_sessions.auth_session_reference is
  'Opaque unique non-secret authentication-provider session reference, not a bearer token or credential.';
comment on column public.application_sessions.started_at is
  'Authoritative application session lifecycle start; intentionally has no database default.';
