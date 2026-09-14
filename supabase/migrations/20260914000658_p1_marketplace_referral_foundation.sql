-- P1-006 local candidate. Unreviewed and unapplied.
-- Physical 1F Marketplace / Referral persistence foundation only.
-- This migration does not implement the end-to-end Referral workflow.
-- Consequential Referral creation remains dependent on later Bookability /
-- Scheduling capability and authoritative decision-point revalidation.

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null,
  attorney_id uuid,
  jurisdiction_id uuid not null,
  attempt_ordinal integer not null,
  allocation_method text,
  outcome_code text,
  created_at timestamptz not null default statement_timestamp(),
  outcome_recorded_at timestamptz,
  constraint referrals_intake_attempt_ordinal_key
    unique (intake_id, attempt_ordinal),
  constraint referrals_intake_id_fkey
    foreign key (intake_id)
    references public.intakes (id)
    on update restrict
    on delete restrict,
  constraint referrals_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint referrals_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict
);

alter table public.referrals enable row level security;

create table public.referral_eligible_pool_entries (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null,
  attorney_id uuid not null,
  eligibility_evaluation_id uuid not null,
  eligible_as_of timestamptz not null,
  pool_reason jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint referral_eligible_pool_entries_referral_id_fkey
    foreign key (referral_id)
    references public.referrals (id)
    on update restrict
    on delete restrict,
  constraint referral_eligible_pool_entries_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint referral_eligible_pool_entries_eligibility_evaluation_id_fkey
    foreign key (eligibility_evaluation_id)
    references public.eligibility_evaluations (id)
    on update restrict
    on delete restrict
);

alter table public.referral_eligible_pool_entries enable row level security;

create table public.referral_presentations (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null,
  attorney_id uuid not null,
  display_position integer not null,
  client_filter_context jsonb,
  platform_presentation_filter_context jsonb,
  narrowing_actor text not null,
  shown_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint referral_presentations_referral_id_fkey
    foreign key (referral_id)
    references public.referrals (id)
    on update restrict
    on delete restrict,
  constraint referral_presentations_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict
);

alter table public.referral_presentations enable row level security;

create index referral_eligible_pool_entries_referral_idx
  on public.referral_eligible_pool_entries (referral_id);

create index referral_presentations_referral_display_idx
  on public.referral_presentations (referral_id, display_position);

revoke all on table public.referrals
  from public, anon, authenticated, service_role;

grant select, insert on table public.referrals to service_role;

grant update (
  outcome_code,
  outcome_recorded_at
) on table public.referrals to service_role;

revoke all on table public.referral_eligible_pool_entries
  from public, anon, authenticated, service_role;

grant select, insert
  on table public.referral_eligible_pool_entries
  to service_role;

revoke all on table public.referral_presentations
  from public, anon, authenticated, service_role;

grant select, insert
  on table public.referral_presentations
  to service_role;

comment on table public.referrals is
  'Durable Referral attempt context. Attorney acceptance belongs to Consultation Request and is not a Referral lifecycle state.';

comment on table public.referral_eligible_pool_entries is
  'Immutable point-in-time Referral-Eligible Pool evidence. It is historical evidence, not a mutable live candidate list.';

comment on table public.referral_presentations is
  'Immutable Presented Set evidence preserving who was shown and the presentation/filter context at that point in time.';
