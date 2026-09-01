-- WI-P1-002-AUTHORIZATION-SCOPE-CORRECTION
-- Forward-only correction of the P1-002 authorization surface.

do $$
declare
  profile_name text;
  profile_table regclass;
  profile_rows bigint;
  unexpected_dependents text[];
begin
  foreach profile_name in array array['attorney_profiles', 'client_profiles']
  loop
    profile_table := to_regclass(format('public.%I', profile_name));

    if profile_table is null then
      raise exception using
        errcode = '42P01',
        message = format('required profile table public.%I is missing', profile_name);
    end if;

    execute format('select count(*) from %s', profile_table)
      into profile_rows;

    if profile_rows <> 0 then
      raise exception using
        errcode = '55000',
        message = format(
          'refusing to drop public.%I: expected exactly zero rows, found %s',
          profile_name,
          profile_rows
        );
    end if;

    select array_agg(
      pg_describe_object(
        dependency.classid,
        dependency.objid,
        dependency.objsubid
      )
      order by
        pg_describe_object(
          dependency.classid,
          dependency.objid,
          dependency.objsubid
        )
    )
    into unexpected_dependents
    from pg_depend dependency
    where dependency.refclassid = 'pg_class'::regclass
      and dependency.refobjid = profile_table
      and dependency.deptype not in ('a', 'i');

    if coalesce(cardinality(unexpected_dependents), 0) <> 0 then
      raise exception using
        errcode = '2BP01',
        message = format(
          'refusing to drop public.%I: unexpected or external dependents exist',
          profile_name
        ),
        detail = array_to_string(unexpected_dependents, E'\n');
    end if;
  end loop;
end;
$$;

do $$
declare
  jurisdiction_fk_definition text;
  jurisdiction_fk_deferrable boolean;
  jurisdiction_fk_deferred boolean;
  jurisdiction_fk_validated boolean;
  jurisdiction_comment text;
begin
  select
    pg_get_constraintdef(constraint_record.oid, true),
    constraint_record.condeferrable,
    constraint_record.condeferred,
    constraint_record.convalidated
  into
    jurisdiction_fk_definition,
    jurisdiction_fk_deferrable,
    jurisdiction_fk_deferred,
    jurisdiction_fk_validated
  from pg_constraint constraint_record
  where constraint_record.conrelid = 'public.capability_grants'::regclass
    and constraint_record.conname = 'capability_grants_jurisdiction_id_fkey'
    and constraint_record.contype = 'f';

  select col_description(
    'public.capability_grants'::regclass,
    column_record.attnum
  )
  into jurisdiction_comment
  from pg_attribute column_record
  where column_record.attrelid = 'public.capability_grants'::regclass
    and column_record.attname = 'jurisdiction_id'
    and not column_record.attisdropped;

  if jurisdiction_fk_definition is distinct from
    'FOREIGN KEY (jurisdiction_id) REFERENCES jurisdictions(id) ON UPDATE RESTRICT ON DELETE RESTRICT'
    or jurisdiction_fk_deferrable is distinct from false
    or jurisdiction_fk_deferred is distinct from false
    or jurisdiction_fk_validated is distinct from true
    or jurisdiction_comment is distinct from
      'Optional jurisdiction scope enforced by locked physical Migration 3.'
  then
    raise exception using
      errcode = '55000',
      message = 'P1-003 capability-grant jurisdiction contract is not exact';
  end if;
end;
$$;

drop table public.attorney_profiles restrict;
drop table public.client_profiles restrict;

alter table public.staff_profiles
  drop constraint staff_profiles_lifecycle_state_check,
  drop constraint staff_profiles_years_experience_check;

alter table public.staff_profiles
  rename column lifecycle_state to staff_state;

alter table public.staff_profiles
  alter column staff_state drop default,
  drop column years_experience restrict,
  add constraint staff_profiles_staff_state_check
    check (
      staff_state in (
        'invited',
        'active',
        'deactivated',
        'removed'
      )
    );

comment on table public.staff_profiles is
  'Staff profile with a server-authoritative staff state.';

drop trigger capability_definitions_set_updated_at
  on public.capability_definitions;

alter table public.capability_definitions
  drop constraint capability_definitions_capability_code_check,
  drop column display_name restrict,
  drop column description restrict,
  drop column created_at restrict,
  drop column updated_at restrict;

comment on table public.capability_definitions is null;
comment on column public.capability_definitions.capability_code is null;

drop trigger capability_grants_set_updated_at
  on public.capability_grants;

drop index public.capability_grants_user_capability_idx;

alter table public.capability_grants
  drop constraint capability_grants_capability_definition_id_fkey,
  drop constraint capability_grants_validity_check,
  drop constraint capability_grants_granted_at_check;

alter table public.capability_grants
  rename column valid_until to expires_at;

alter table public.capability_grants
  add column capability_code text not null,
  add column resource_scope jsonb,
  add column granted_by_user_id uuid not null,
  drop column capability_definition_id restrict,
  drop column valid_from restrict,
  drop column updated_at restrict,
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
    check (expires_at is null or expires_at > granted_at);

create index capability_grants_user_capability_idx
  on public.capability_grants (user_id, capability_code, expires_at);

comment on table public.capability_grants is
  'Capability grant history for Staff subjects; this migration intentionally creates no grant rows.';
comment on column public.capability_grants.jurisdiction_id is
  'Optional jurisdiction scope enforced by locked physical Migration 3.';

drop trigger application_sessions_set_updated_at
  on public.application_sessions;

alter table public.application_sessions
  drop constraint application_sessions_reference_length_check,
  drop constraint application_sessions_expiry_check,
  drop constraint application_sessions_revoked_at_check;

alter table public.application_sessions
  rename column session_reference to auth_session_reference;

alter table public.application_sessions
  rename constraint application_sessions_session_reference_key
    to application_sessions_auth_session_reference_key;

alter table public.application_sessions
  add column started_at timestamptz not null,
  add column ended_at timestamptz,
  drop column updated_at restrict,
  add constraint application_sessions_expiry_check
    check (expires_at > started_at),
  add constraint application_sessions_ended_at_check
    check (ended_at is null or ended_at >= started_at),
  add constraint application_sessions_revoked_at_check
    check (revoked_at is null or revoked_at >= started_at);

comment on table public.application_sessions is
  'Application session metadata; authentication workflows and secrets remain out of scope.';
comment on column public.application_sessions.auth_session_reference is
  'Opaque unique non-secret authentication-provider session reference, not a bearer token, credential, or raw token.';
comment on column public.application_sessions.started_at is
  'Authoritative server-observed application session start; intentionally has no database default.';

alter table public.staff_profiles enable row level security;
alter table public.capability_definitions enable row level security;
alter table public.capability_grants enable row level security;
alter table public.application_sessions enable row level security;

revoke all on table public.staff_profiles from public;
revoke all on table public.staff_profiles from anon;
revoke all on table public.staff_profiles from authenticated;
revoke all on table public.staff_profiles from service_role;
grant select on table public.staff_profiles to authenticated;
grant select, insert, update on table public.staff_profiles to service_role;

revoke all on table public.capability_definitions from public;
revoke all on table public.capability_definitions from anon;
revoke all on table public.capability_definitions from authenticated;
revoke all on table public.capability_definitions from service_role;
grant select on table public.capability_definitions to service_role;

revoke all on table public.capability_grants from public;
revoke all on table public.capability_grants from anon;
revoke all on table public.capability_grants from authenticated;
revoke all on table public.capability_grants from service_role;
grant select, insert, update on table public.capability_grants to service_role;

revoke all on table public.application_sessions from public;
revoke all on table public.application_sessions from anon;
revoke all on table public.application_sessions from authenticated;
revoke all on table public.application_sessions from service_role;
grant select, insert, update on table public.application_sessions to service_role;

do $$
declare
  jurisdiction_fk_definition text;
  jurisdiction_fk_deferrable boolean;
  jurisdiction_fk_deferred boolean;
  jurisdiction_fk_validated boolean;
  jurisdiction_comment text;
begin
  select
    pg_get_constraintdef(constraint_record.oid, true),
    constraint_record.condeferrable,
    constraint_record.condeferred,
    constraint_record.convalidated
  into
    jurisdiction_fk_definition,
    jurisdiction_fk_deferrable,
    jurisdiction_fk_deferred,
    jurisdiction_fk_validated
  from pg_constraint constraint_record
  where constraint_record.conrelid = 'public.capability_grants'::regclass
    and constraint_record.conname = 'capability_grants_jurisdiction_id_fkey'
    and constraint_record.contype = 'f';

  select col_description(
    'public.capability_grants'::regclass,
    column_record.attnum
  )
  into jurisdiction_comment
  from pg_attribute column_record
  where column_record.attrelid = 'public.capability_grants'::regclass
    and column_record.attname = 'jurisdiction_id'
    and not column_record.attisdropped;

  if jurisdiction_fk_definition is distinct from
    'FOREIGN KEY (jurisdiction_id) REFERENCES jurisdictions(id) ON UPDATE RESTRICT ON DELETE RESTRICT'
    or jurisdiction_fk_deferrable is distinct from false
    or jurisdiction_fk_deferred is distinct from false
    or jurisdiction_fk_validated is distinct from true
    or jurisdiction_comment is distinct from
      'Optional jurisdiction scope enforced by locked physical Migration 3.'
  then
    raise exception using
      errcode = '55000',
      message = 'P1-003 capability-grant jurisdiction contract changed during correction';
  end if;
end;
$$;
