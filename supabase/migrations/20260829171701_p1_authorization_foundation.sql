-- WI-P1-002-AUTHORIZATION-FOUNDATION
-- Physical migration 2: profiles, capability grants, and application sessions.

create table public.client_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  display_name text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint client_profiles_user_id_key unique (user_id),
  constraint client_profiles_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict
);

create table public.attorney_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  lifecycle_state text not null default 'pending_verification',
  years_experience integer,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint attorney_profiles_user_id_key unique (user_id),
  constraint attorney_profiles_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint attorney_profiles_lifecycle_state_check
    check (
      lifecycle_state in (
        'pending_verification',
        'active',
        'suspended',
        'closed'
      )
    ),
  constraint attorney_profiles_years_experience_check
    check (years_experience is null or years_experience >= 0)
);

create table public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  lifecycle_state text not null default 'pending_verification',
  years_experience integer,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint staff_profiles_user_id_key unique (user_id),
  constraint staff_profiles_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint staff_profiles_lifecycle_state_check
    check (
      lifecycle_state in (
        'pending_verification',
        'active',
        'suspended',
        'closed'
      )
    ),
  constraint staff_profiles_years_experience_check
    check (years_experience is null or years_experience >= 0)
);

create table public.capability_definitions (
  id uuid primary key default gen_random_uuid(),
  capability_code text not null,
  display_name text not null,
  description text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint capability_definitions_capability_code_key
    unique (capability_code),
  constraint capability_definitions_capability_code_check
    check (capability_code ~ '^[a-z][a-z0-9_]{2,63}$')
);

create table public.capability_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  capability_definition_id uuid not null,
  jurisdiction_id uuid,
  granted_at timestamptz not null default statement_timestamp(),
  valid_from timestamptz not null default statement_timestamp(),
  valid_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint capability_grants_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint capability_grants_capability_definition_id_fkey
    foreign key (capability_definition_id)
    references public.capability_definitions (id)
    on update restrict
    on delete restrict,
  constraint capability_grants_validity_check
    check (valid_until is null or valid_until > valid_from),
  constraint capability_grants_granted_at_check
    check (granted_at <= valid_from),
  constraint capability_grants_revoked_at_check
    check (revoked_at is null or revoked_at >= granted_at)
);

create index capability_grants_user_capability_idx
  on public.capability_grants (user_id, capability_definition_id, valid_from);

create table public.application_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_reference text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint application_sessions_session_reference_key
    unique (session_reference),
  constraint application_sessions_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint application_sessions_reference_length_check
    check (char_length(session_reference) between 16 and 256),
  constraint application_sessions_expiry_check
    check (expires_at > created_at),
  constraint application_sessions_revoked_at_check
    check (revoked_at is null or revoked_at >= created_at)
);

comment on table public.client_profiles is
  'Client profile identity owned by the corresponding Rosuno application user.';
comment on table public.attorney_profiles is
  'Attorney profile with a server-authoritative lifecycle state.';
comment on table public.staff_profiles is
  'Staff profile with a server-authoritative lifecycle state.';
comment on table public.capability_definitions is
  'Stable capability catalog; this migration intentionally creates no capability rows.';
comment on table public.capability_grants is
  'Capability grant history; jurisdiction remains nullable until locked Migration 3.';
comment on table public.application_sessions is
  'Application session metadata; authentication workflows and secrets remain out of scope.';
comment on column public.capability_definitions.capability_code is
  'Stable non-secret capability identifier used as the catalog key.';
comment on column public.capability_grants.jurisdiction_id is
  'Nullable placeholder for locked Migration 3 jurisdictions; intentionally has no foreign key here.';
comment on column public.application_sessions.session_reference is
  'Opaque unique non-secret application reference, not a bearer token or credential.';

alter table public.client_profiles enable row level security;
alter table public.attorney_profiles enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.capability_definitions enable row level security;
alter table public.capability_grants enable row level security;
alter table public.application_sessions enable row level security;

revoke all on table public.client_profiles from public;
revoke all on table public.client_profiles from anon;
revoke all on table public.client_profiles from authenticated;
revoke all on table public.client_profiles from service_role;
grant select on table public.client_profiles to authenticated;
grant select, insert, update on table public.client_profiles to service_role;

revoke all on table public.attorney_profiles from public;
revoke all on table public.attorney_profiles from anon;
revoke all on table public.attorney_profiles from authenticated;
revoke all on table public.attorney_profiles from service_role;
grant select on table public.attorney_profiles to authenticated;
grant select, insert, update on table public.attorney_profiles to service_role;

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
grant select, insert, update on table public.capability_definitions to service_role;

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

create policy client_profiles_select_own
on public.client_profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.users
    where users.id = client_profiles.user_id
      and users.auth_user_id = (select auth.uid())
  )
);

create policy attorney_profiles_select_own
on public.attorney_profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.users
    where users.id = attorney_profiles.user_id
      and users.auth_user_id = (select auth.uid())
  )
);

create policy staff_profiles_select_own
on public.staff_profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.users
    where users.id = staff_profiles.user_id
      and users.auth_user_id = (select auth.uid())
  )
);

create trigger client_profiles_set_updated_at
before update on public.client_profiles
for each row
execute function public.set_updated_at();

create trigger attorney_profiles_set_updated_at
before update on public.attorney_profiles
for each row
execute function public.set_updated_at();

create trigger staff_profiles_set_updated_at
before update on public.staff_profiles
for each row
execute function public.set_updated_at();

create trigger capability_definitions_set_updated_at
before update on public.capability_definitions
for each row
execute function public.set_updated_at();

create trigger capability_grants_set_updated_at
before update on public.capability_grants
for each row
execute function public.set_updated_at();

create trigger application_sessions_set_updated_at
before update on public.application_sessions
for each row
execute function public.set_updated_at();
