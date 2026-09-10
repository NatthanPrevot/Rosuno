-- P1-004 local candidate. Never persist during rollback-only validation.
-- Exactly nine relations and the separately approved read-only capability predicate.
-- Historical evaluations retain direct Evidence AND professional-record identifiers;
-- a mutable association ID alone is never sufficient historical evidence.

create table public.attorney_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on update restrict on delete restrict unique,
  display_name text, bio text, headline text,
  years_experience smallint check (years_experience >= 0),
  response_expectation_seconds integer check (response_expectation_seconds >= 0),
  profile_state text not null check (profile_state in ('applicant','under_review','approved','suspended','removed')),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);
alter table public.attorney_profiles enable row level security;

create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null references public.attorney_profiles(id) on update restrict on delete restrict,
  jurisdiction_id uuid not null references public.jurisdictions(id) on update restrict on delete restrict,
  license_number text not null check (btrim(license_number) <> ''),
  license_type text, effective_from date, effective_until date, reported_status text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (jurisdiction_id, license_number),
  check (effective_until >= effective_from)
);
alter table public.licenses enable row level security;

create table public.insurance_records (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null references public.attorney_profiles(id) on update restrict on delete restrict,
  jurisdiction_id uuid references public.jurisdictions(id) on update restrict on delete restrict,
  carrier_name text, policy_reference text, coverage_type text,
  per_occurrence_limit_minor bigint check (per_occurrence_limit_minor >= 0),
  aggregate_limit_minor bigint check (aggregate_limit_minor >= 0),
  currency_code char(3) check (currency_code::text ~ '^[A-Z]{3}$'),
  coverage_from date, coverage_until date,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check (coverage_until >= coverage_from)
);
alter table public.insurance_records enable row level security;

create table public.discipline_records (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null references public.attorney_profiles(id) on update restrict on delete restrict,
  jurisdiction_id uuid not null references public.jurisdictions(id) on update restrict on delete restrict,
  external_reference text, finding_type text, opened_at date, resolved_at date,
  status text, details_reference jsonb,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check (resolved_at >= opened_at)
);
alter table public.discipline_records enable row level security;

create table public.practice_areas (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  active boolean not null
);
alter table public.practice_areas enable row level security;

create table public.practice_area_authorisations (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null references public.attorney_profiles(id) on update restrict on delete restrict,
  jurisdiction_id uuid not null references public.jurisdictions(id) on update restrict on delete restrict,
  practice_area_id uuid not null references public.practice_areas(id) on update restrict on delete restrict,
  status text not null check (btrim(status) <> ''),
  requested_at timestamptz not null, decided_at timestamptz,
  effective_from timestamptz, effective_until timestamptz,
  criteria_policy_version_id uuid references public.policy_versions(id) on update restrict on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (attorney_id, jurisdiction_id, practice_area_id),
  check (decided_at >= requested_at),
  check (effective_until >= effective_from)
);
alter table public.practice_area_authorisations enable row level security;

create table public.verification_evidence (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid references public.jurisdictions(id) on update restrict on delete restrict,
  source_type text, source_uri text, source_reference text,
  retrieved_at timestamptz not null,
  retrieved_by_user_id uuid references public.users(id) on update restrict on delete restrict,
  evidence_summary text, evidence_digest text, verification_method text,
  discrepancy_flag boolean not null default false, retention_class text,
  created_at timestamptz not null default statement_timestamp()
);
alter table public.verification_evidence enable row level security;

create table public.eligibility_evaluations (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null references public.attorney_profiles(id) on update restrict on delete restrict,
  jurisdiction_id uuid not null references public.jurisdictions(id) on update restrict on delete restrict,
  context_type text not null, context_id uuid,
  evaluated_at timestamptz not null, policy_references jsonb not null,
  result text not null, factor_results jsonb not null, evidence_references jsonb not null,
  as_of timestamptz not null,
  created_at timestamptz not null default statement_timestamp()
);
alter table public.eligibility_evaluations enable row level security;

create table public.verification_evidence_subjects (
  id uuid primary key default gen_random_uuid(),
  verification_evidence_id uuid not null references public.verification_evidence(id) on update restrict on delete restrict,
  license_id uuid references public.licenses(id) on update restrict on delete restrict,
  insurance_record_id uuid references public.insurance_records(id) on update restrict on delete restrict,
  discipline_record_id uuid references public.discipline_records(id) on update restrict on delete restrict,
  practice_area_authorisation_id uuid references public.practice_area_authorisations(id) on update restrict on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  check (num_nonnulls(license_id, insurance_record_id, discipline_record_id, practice_area_authorisation_id) = 1)
);
alter table public.verification_evidence_subjects enable row level security;

create function public.has_manage_attorney_verification_scope(
  required_jurisdiction uuid, allow_any_jurisdiction boolean
) returns boolean
language sql stable security definer
set search_path = pg_catalog
as $function$
  select exists (
    select 1 from public.capability_grants as g
    join public.users as u on u.id = g.user_id
    where u.auth_user_id = auth.uid()
      and g.capability_code = 'manage_attorney_verification'
      and g.granted_at <= statement_timestamp()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > statement_timestamp())
      and g.resource_scope is null
      and (allow_any_jurisdiction is true or g.jurisdiction_id is null
           or g.jurisdiction_id = required_jurisdiction)
  );
$function$;
revoke all on function public.has_manage_attorney_verification_scope(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.has_manage_attorney_verification_scope(uuid, boolean) to authenticated;

insert into public.capability_definitions (capability_code) values ('manage_attorney_verification');

revoke all on table public.attorney_profiles from public, anon, authenticated, service_role;
grant select on table public.attorney_profiles to authenticated;
grant select, insert, update on table public.attorney_profiles to service_role;
create trigger attorney_profiles_set_updated_at before update on public.attorney_profiles for each row execute function public.set_updated_at();

revoke all on table public.licenses from public, anon, authenticated, service_role;
grant select on table public.licenses to authenticated;
grant select, insert, update on table public.licenses to service_role;
create trigger licenses_set_updated_at before update on public.licenses for each row execute function public.set_updated_at();

revoke all on table public.insurance_records from public, anon, authenticated, service_role;
grant select on table public.insurance_records to authenticated;
grant select, insert, update on table public.insurance_records to service_role;
create trigger insurance_records_set_updated_at before update on public.insurance_records for each row execute function public.set_updated_at();

revoke all on table public.discipline_records from public, anon, authenticated, service_role;
grant select on table public.discipline_records to authenticated;
grant select, insert, update on table public.discipline_records to service_role;
create trigger discipline_records_set_updated_at before update on public.discipline_records for each row execute function public.set_updated_at();

revoke all on table public.practice_areas from public, anon, authenticated, service_role;
grant select on table public.practice_areas to authenticated;
grant select, insert, update on table public.practice_areas to service_role;

revoke all on table public.practice_area_authorisations from public, anon, authenticated, service_role;
grant select on table public.practice_area_authorisations to authenticated;
grant select, insert, update on table public.practice_area_authorisations to service_role;
create trigger practice_area_authorisations_set_updated_at before update on public.practice_area_authorisations for each row execute function public.set_updated_at();

revoke all on table public.verification_evidence from public, anon, authenticated, service_role;
grant select on table public.verification_evidence to authenticated;
grant select, insert on table public.verification_evidence to service_role;

revoke all on table public.eligibility_evaluations from public, anon, authenticated, service_role;
grant select on table public.eligibility_evaluations to authenticated;
grant select, insert on table public.eligibility_evaluations to service_role;

revoke all on table public.verification_evidence_subjects from public, anon, authenticated, service_role;
grant select on table public.verification_evidence_subjects to authenticated;
grant select, insert, delete on table public.verification_evidence_subjects to service_role;
grant update (license_id, insurance_record_id, discipline_record_id, practice_area_authorisation_id) on table public.verification_evidence_subjects to service_role;

create policy attorney_profiles_select on public.attorney_profiles for select to authenticated
using (exists (select 1 from public.users u where u.id = attorney_profiles.user_id and u.auth_user_id = (select auth.uid())) or public.has_manage_attorney_verification_scope(null, false));

create policy licenses_select on public.licenses for select to authenticated
using (public.has_manage_attorney_verification_scope(licenses.jurisdiction_id, false) or exists (
  select 1 from public.attorney_profiles a join public.users u on u.id = a.user_id
  where a.id = licenses.attorney_id and u.auth_user_id = (select auth.uid())
));

create policy insurance_records_select on public.insurance_records for select to authenticated
using (public.has_manage_attorney_verification_scope(insurance_records.jurisdiction_id, false) or exists (
  select 1 from public.attorney_profiles a join public.users u on u.id = a.user_id
  where a.id = insurance_records.attorney_id and u.auth_user_id = (select auth.uid())
));

create policy discipline_records_select on public.discipline_records for select to authenticated
using (public.has_manage_attorney_verification_scope(discipline_records.jurisdiction_id, false) or exists (
  select 1 from public.attorney_profiles a join public.users u on u.id = a.user_id
  where a.id = discipline_records.attorney_id and u.auth_user_id = (select auth.uid())
));

create policy practice_area_authorisations_select on public.practice_area_authorisations for select to authenticated
using (public.has_manage_attorney_verification_scope(practice_area_authorisations.jurisdiction_id, false) or exists (
  select 1 from public.attorney_profiles a join public.users u on u.id = a.user_id
  where a.id = practice_area_authorisations.attorney_id and u.auth_user_id = (select auth.uid())
));

create policy practice_areas_select on public.practice_areas for select to authenticated
using (active or public.has_manage_attorney_verification_scope(null, true));

create policy verification_evidence_select on public.verification_evidence for select to authenticated
using (public.has_manage_attorney_verification_scope(verification_evidence.jurisdiction_id, false));

create policy eligibility_evaluations_select on public.eligibility_evaluations for select to authenticated
using (public.has_manage_attorney_verification_scope(eligibility_evaluations.jurisdiction_id, false));

create policy verification_evidence_subjects_select on public.verification_evidence_subjects for select to authenticated
using (
  num_nonnulls(license_id, insurance_record_id, discipline_record_id, practice_area_authorisation_id) = 1
  and exists (select 1 from public.verification_evidence e where e.id = verification_evidence_subjects.verification_evidence_id)
  and (
exists (select 1 from public.licenses subject where subject.id = verification_evidence_subjects.license_id and public.has_manage_attorney_verification_scope(subject.jurisdiction_id, false))
    or exists (select 1 from public.insurance_records subject where subject.id = verification_evidence_subjects.insurance_record_id and public.has_manage_attorney_verification_scope(subject.jurisdiction_id, false))
    or exists (select 1 from public.discipline_records subject where subject.id = verification_evidence_subjects.discipline_record_id and public.has_manage_attorney_verification_scope(subject.jurisdiction_id, false))
    or exists (select 1 from public.practice_area_authorisations subject where subject.id = verification_evidence_subjects.practice_area_authorisation_id and public.has_manage_attorney_verification_scope(subject.jurisdiction_id, false))
  )
);

create unique index ves_license_id_unique on public.verification_evidence_subjects (verification_evidence_id, license_id) where license_id is not null;
create index ves_license_id_idx on public.verification_evidence_subjects (license_id) where license_id is not null;
create unique index ves_insurance_record_id_unique on public.verification_evidence_subjects (verification_evidence_id, insurance_record_id) where insurance_record_id is not null;
create index ves_insurance_record_id_idx on public.verification_evidence_subjects (insurance_record_id) where insurance_record_id is not null;
create unique index ves_discipline_record_id_unique on public.verification_evidence_subjects (verification_evidence_id, discipline_record_id) where discipline_record_id is not null;
create index ves_discipline_record_id_idx on public.verification_evidence_subjects (discipline_record_id) where discipline_record_id is not null;
create unique index ves_practice_area_authorisation_id_unique on public.verification_evidence_subjects (verification_evidence_id, practice_area_authorisation_id) where practice_area_authorisation_id is not null;
create index ves_practice_area_authorisation_id_idx on public.verification_evidence_subjects (practice_area_authorisation_id) where practice_area_authorisation_id is not null;
create index attorney_profiles_state_idx on public.attorney_profiles (profile_state);
create index licenses_attorney_idx on public.licenses (attorney_id);
create index licenses_jurisdiction_idx on public.licenses (jurisdiction_id, reported_status);
create index insurance_records_attorney_idx on public.insurance_records (attorney_id);
create index insurance_records_jurisdiction_idx on public.insurance_records (jurisdiction_id);
create index discipline_records_attorney_idx on public.discipline_records (attorney_id);
create index discipline_records_jurisdiction_idx on public.discipline_records (jurisdiction_id);
create index practice_area_authorisations_jurisdiction_idx on public.practice_area_authorisations (jurisdiction_id, status);
create index eligibility_evaluations_attorney_idx on public.eligibility_evaluations (attorney_id);
create index eligibility_evaluations_jurisdiction_idx on public.eligibility_evaluations (jurisdiction_id);
create index paa_practice_area_idx on public.practice_area_authorisations (practice_area_id);
create index paa_policy_version_idx on public.practice_area_authorisations (criteria_policy_version_id);
create index verification_evidence_jurisdiction_idx on public.verification_evidence (jurisdiction_id);
create index verification_evidence_retriever_idx on public.verification_evidence (retrieved_by_user_id);

comment on function public.has_manage_attorney_verification_scope(uuid, boolean) is
  'Read-only current-caller verification capability predicate. Any-jurisdiction mode is used only for inactive Practice Area reads. No caller identity or capability parameter.';
comment on table public.verification_evidence_subjects is
  'Current correctable Evidence-to-professional linkage. Subject jurisdiction only; NULL Insurance requires global. Linked Evidence readability is independently required. No Evidence jurisdiction fallback. Trusted replacement must authorize existing and new scopes; void existing scope; insertion/restoration new scope. Only subject FKs may be updated; repeated correction and restoration are permitted.';
comment on column public.eligibility_evaluations.evidence_references is
  'Writer contract: independently retain every relied-upon verification_evidence.id and direct professional-record identifiers at the consequential decision point. Association IDs are optional and insufficient alone. T1 remains immutable after association replacement/deletion; consequential re-decisions create T2.';
comment on table public.verification_evidence is
  'Protected historical evidence: application service privileges permit SELECT and INSERT only. Professional linkage correction never rewrites evidence.';
comment on table public.eligibility_evaluations is
  'Immutable historical evaluation, not current derived Eligibility. Corrections require new evaluations; no current association lookup is required to reconstruct earlier professional/evidence references.';
