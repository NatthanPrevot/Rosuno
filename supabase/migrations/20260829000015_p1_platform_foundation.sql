-- WI-P1-001-PLATFORM-FOUNDATION
-- Physical migration 1: application identity and shared timestamp behavior.

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;
grant execute on function public.set_updated_at() to postgres;
grant execute on function public.set_updated_at() to service_role;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  display_name text,
  account_state text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint users_auth_user_id_key unique (auth_user_id),
  constraint users_auth_user_id_fkey
    foreign key (auth_user_id)
    references auth.users (id)
    on update restrict
    on delete restrict,
  constraint users_account_state_check
    check (
      account_state in (
        'pending_verification',
        'active',
        'suspended',
        'closed'
      )
    )
);

comment on table public.users is
  'Rosuno application identity; authentication remains owned by auth.users.';
comment on column public.users.auth_user_id is
  'Unique Supabase Auth identity. Authentication secrets are never duplicated here.';
comment on column public.users.account_state is
  'Server-authoritative Rosuno User lifecycle state.';

alter table public.users enable row level security;

revoke all on table public.users from public;
revoke all on table public.users from anon;
revoke all on table public.users from authenticated;
grant select on table public.users to authenticated;
revoke all on table public.users from service_role;
grant select, insert, update on table public.users to service_role;

create policy users_select_own
on public.users
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (select auth.uid()) = auth_user_id
);

create trigger users_set_updated_at
before update on public.users
for each row
execute function public.set_updated_at();
