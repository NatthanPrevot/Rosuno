-- P1-005 local candidate. Unreviewed and unapplied.
-- Client / Intake / Jurisdiction Assessment / AI Suggestion foundation.
-- AI output is advisory persistence only and never canonical legal,
-- verification, eligibility, referral, engagement, payment, or regulatory authority.

create table public.client_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint client_profiles_user_id_key unique (user_id),
  constraint client_profiles_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict
);

alter table public.client_profiles enable row level security;

create table public.intakes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  matter_reference text,
  state text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz,
  closed_at timestamptz,
  constraint intakes_client_id_fkey
    foreign key (client_id)
    references public.client_profiles (id)
    on update restrict
    on delete restrict,
  constraint intakes_state_check
    check (
      state in (
        'draft',
        'submitted',
        'active',
        'expired',
        'superseded',
        'closed'
      )
    )
);

alter table public.intakes enable row level security;

create table public.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  context_type text not null,
  context_id uuid not null,
  suggestion_type text not null,
  suggestion_value jsonb not null,
  generated_at timestamptz not null,
  model_reference text,
  presented_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by_user_id uuid,
  rejected_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint ai_suggestions_confirmed_by_user_id_fkey
    foreign key (confirmed_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint ai_suggestions_context_type_nonblank_check
    check (btrim(context_type) <> ''),
  constraint ai_suggestions_suggestion_type_nonblank_check
    check (btrim(suggestion_type) <> ''),
  constraint ai_suggestions_confirmation_actor_check
    check (
      (confirmed_at is null and confirmed_by_user_id is null)
      or
      (confirmed_at is not null and confirmed_by_user_id is not null)
    ),
  constraint ai_suggestions_confirmation_rejection_check
    check (
      not (confirmed_at is not null and rejected_at is not null)
    )
);

alter table public.ai_suggestions enable row level security;

create table public.jurisdiction_assessments (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null,
  jurisdiction_id uuid not null,
  assessment_basis text,
  source_type text,
  ai_suggestion_id uuid,
  review_status text,
  created_at timestamptz not null default statement_timestamp(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  constraint jurisdiction_assessments_intake_id_fkey
    foreign key (intake_id)
    references public.intakes (id)
    on update restrict
    on delete restrict,
  constraint jurisdiction_assessments_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint jurisdiction_assessments_ai_suggestion_id_fkey
    foreign key (ai_suggestion_id)
    references public.ai_suggestions (id)
    on update restrict
    on delete restrict,
  constraint jurisdiction_assessments_reviewed_by_user_id_fkey
    foreign key (reviewed_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint jurisdiction_assessments_review_actor_check
    check (
      (reviewed_at is null and reviewed_by_user_id is null)
      or
      (reviewed_at is not null and reviewed_by_user_id is not null)
    )
);

alter table public.jurisdiction_assessments enable row level security;

create index intakes_client_state_idx
  on public.intakes (client_id, state);

create index jurisdiction_assessments_intake_idx
  on public.jurisdiction_assessments (intake_id);

create index jurisdiction_assessments_ai_suggestion_idx
  on public.jurisdiction_assessments (ai_suggestion_id)
  where ai_suggestion_id is not null;

create index ai_suggestions_context_idx
  on public.ai_suggestions (context_type, context_id);

revoke all on table public.client_profiles
  from public, anon, authenticated, service_role;

grant select on table public.client_profiles to authenticated;
grant select, insert, update on table public.client_profiles to service_role;

revoke all on table public.intakes
  from public, anon, authenticated, service_role;

grant select on table public.intakes to authenticated;
grant select, insert, update on table public.intakes to service_role;

revoke all on table public.ai_suggestions
  from public, anon, authenticated, service_role;

grant select on table public.ai_suggestions to authenticated;
grant select, insert on table public.ai_suggestions to service_role;
grant update (
  presented_at,
  confirmed_at,
  confirmed_by_user_id,
  rejected_at
) on table public.ai_suggestions to service_role;

revoke all on table public.jurisdiction_assessments
  from public, anon, authenticated, service_role;

grant select on table public.jurisdiction_assessments to authenticated;
grant select, insert on table public.jurisdiction_assessments to service_role;
grant update (
  review_status,
  reviewed_at,
  reviewed_by_user_id
) on table public.jurisdiction_assessments to service_role;

create policy client_profiles_select_own
on public.client_profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.users as u
    where u.id = client_profiles.user_id
      and u.auth_user_id = (select auth.uid())
  )
);

create policy intakes_select_own
on public.intakes
for select
to authenticated
using (
  exists (
    select 1
    from public.client_profiles as c
    join public.users as u on u.id = c.user_id
    where c.id = intakes.client_id
      and u.auth_user_id = (select auth.uid())
  )
);

create policy jurisdiction_assessments_select_own
on public.jurisdiction_assessments
for select
to authenticated
using (
  exists (
    select 1
    from public.intakes as i
    join public.client_profiles as c on c.id = i.client_id
    join public.users as u on u.id = c.user_id
    where i.id = jurisdiction_assessments.intake_id
      and u.auth_user_id = (select auth.uid())
  )
);

create policy ai_suggestions_select_own
on public.ai_suggestions
for select
to authenticated
using (
  (
    context_type = 'intake'
    and exists (
      select 1
      from public.intakes as i
      join public.client_profiles as c on c.id = i.client_id
      join public.users as u on u.id = c.user_id
      where i.id = ai_suggestions.context_id
        and u.auth_user_id = (select auth.uid())
    )
  )
  or
  (
    context_type = 'jurisdiction_assessment'
    and exists (
      select 1
      from public.jurisdiction_assessments as ja
      join public.intakes as i on i.id = ja.intake_id
      join public.client_profiles as c on c.id = i.client_id
      join public.users as u on u.id = c.user_id
      where ja.id = ai_suggestions.context_id
        and u.auth_user_id = (select auth.uid())
    )
  )
);

create trigger client_profiles_set_updated_at
before update on public.client_profiles
for each row
execute function public.set_updated_at();

create trigger intakes_set_updated_at
before update on public.intakes
for each row
execute function public.set_updated_at();

comment on table public.intakes is
  'Durable client intake container. Decline, retry, or consultation completion must not silently erase intake continuity.';

comment on table public.jurisdiction_assessments is
  'Historical jurisdiction assessment records. An assessment is recorded provenance and never determines governing law by itself.';

comment on table public.ai_suggestions is
  'Persisted human-facing or decision-influencing AI suggestions. AI output is advisory only and cannot establish authoritative Rosuno business or legal state.';

comment on column public.ai_suggestions.context_id is
  'Polymorphic context identity. Trusted application writers must validate context existence and authorization before insert. Authenticated reads recognize only intake and jurisdiction_assessment contexts in this slice.';
