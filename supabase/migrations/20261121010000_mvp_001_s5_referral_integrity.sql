-- MVP-001 S5 (1 of 3): referral evidence integrity on the existing Physical 1F relations (MVP-001 Packet S5; MBS
-- section 10; DM section 7; PS section 14; TA section 8; Packet section 4 "append-only evidence" and "fresh
-- evaluations").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). This migration
-- adds implementation constraints, indexes and guard triggers on the relations P1-006 created
-- (20260914000658), and narrows service_role to SELECT on them, so from now on every referral write is one of the
-- S5 database functions (20261121030000) or a later slice's function built on them (DL-ENG-1 R9). Each guard
-- applies to every role, the database owner included:
-- - referrals: a Referral is never deleted or truncated. Everything about it is fixed when it is created except
--   one change: its outcome is recorded once, outcome_code and outcome_recorded_at set together from null (PS
--   section 14: there is no accepted state; acceptance belongs to the Consultation Request). attempt_ordinal
--   starts at 1 (the P1 unique key keeps one Referral per Intake and ordinal: the attempt sequence, DM section 7).
--   The allocation method is one of the two DM section 7 methods, client_selected or allocated (S5 creates only
--   client_selected Referrals; allocation is not implemented). The outcome code is a lower-snake code; which codes
--   exist is the referral outcome taxonomy, a regulatory-gated value (Packet section 3), so it is configuration
--   (the selected 'referral' policy, 20261121030000) and is deliberately not enumerated here;
-- - referral_eligible_pool_entries and referral_presentations are append-only evidence: never updated, deleted or
--   truncated. Each attorney appears at most once in a Referral's pool and once in its presented set, and each
--   display position at most once. A pool entry names an Eligibility Evaluation of exactly its attorney, in its
--   Referral's jurisdiction, whose result is eligible, recorded together with the Referral (the same
--   transaction), and eligible_as_of is that evaluation's as_of instant: an attorney who was not evaluated
--   eligible at that point can never be in the pool. A presented attorney must be in the Referral's pool: an
--   ineligible attorney can never be presented. display_position starts at 1 and the narrowing actor is the
--   client or the platform; both filter contexts are JSON objects;
-- - evidence is created only with its Referral: a pool entry or presentation commits only in the transaction that
--   created its Referral, while the Referral has no outcome, so nothing can be added to a Referral afterwards;
-- - point-in-time evidence (MBS section 10 failure test "a Referral cannot be created without point-in-time
--   evaluation evidence"): a deferred constraint trigger makes a Referral uncommittable unless, created in the same
--   transaction, it has its attorney and (a) a pool entry for that attorney naming an eligible evaluation in its
--   jurisdiction, (b) a Bookability Evaluation for that attorney with context referral and this Referral's id,
--   result bookable, based on an eligible evaluation in its jurisdiction, and (c) for a client_selected Referral,
--   a presentation of that attorney (the client chose from what was presented);
-- - eligibility_evaluations: append-only evidence (PS section 4 table comment: an evaluation is immutable historical
--   evidence; corrections are new evaluations; Packet section 4). It was already write-protected for every API
--   role (20261106090000); this adds the same guard for the owner, so a pool entry's evaluation can never change
--   after the fact.
-- Indexes: the per-Referral uniqueness above, and the Bookability Evaluation context lookup the evidence check
-- and the client's attempt list use.

-- ---------------------------------------------------------------------------
-- Implementation constraints and indexes on the existing relations.
-- ---------------------------------------------------------------------------

alter table public.referrals
  add constraint referrals_attempt_ordinal_v1_check
    check (attempt_ordinal >= 1),
  add constraint referrals_allocation_method_v1_check
    check (allocation_method is not null and allocation_method in ('client_selected', 'allocated')),
  add constraint referrals_outcome_pair_v1_check
    check ((outcome_code is null) = (outcome_recorded_at is null)),
  add constraint referrals_outcome_code_v1_check
    check (outcome_code is null or outcome_code ~ '^[a-z][a-z0-9_]{1,63}$');

alter table public.referral_eligible_pool_entries
  add constraint referral_eligible_pool_entries_reason_v1_check
    check (pool_reason is null or jsonb_typeof(pool_reason) = 'object');

alter table public.referral_presentations
  add constraint referral_presentations_display_position_v1_check
    check (display_position >= 1),
  add constraint referral_presentations_narrowing_actor_v1_check
    check (narrowing_actor in ('client', 'platform')),
  add constraint referral_presentations_contexts_v1_check
    check (
      (client_filter_context is null or jsonb_typeof(client_filter_context) = 'object')
      and (platform_presentation_filter_context is null
           or jsonb_typeof(platform_presentation_filter_context) = 'object')
    );

create unique index referral_eligible_pool_entries_referral_attorney_key
  on public.referral_eligible_pool_entries (referral_id, attorney_id);

create unique index referral_presentations_referral_attorney_key
  on public.referral_presentations (referral_id, attorney_id);

create unique index referral_presentations_referral_position_key
  on public.referral_presentations (referral_id, display_position);

create index bookability_evaluations_context_idx
  on public.bookability_evaluations (context_type, context_id);

-- ---------------------------------------------------------------------------
-- Referrals.
-- ---------------------------------------------------------------------------

create function public.referral_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.referrals rows are never deleted'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'outcome_code' - 'outcome_recorded_at')
     is distinct from (to_jsonb(old) - 'outcome_code' - 'outcome_recorded_at') then
    raise exception 'a referral changes only by recording its outcome'
      using errcode = '55000';
  end if;
  if old.outcome_code is not null or old.outcome_recorded_at is not null then
    raise exception 'a referral outcome is recorded once'
      using errcode = '55000';
  end if;
  if new.outcome_code is null or new.outcome_recorded_at is null then
    raise exception 'a referral outcome is recorded with its code and time together'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger referrals_change_guard
before update or delete on public.referrals
for each row
execute function public.referral_integrity();

create trigger referrals_no_truncate
before truncate on public.referrals
for each statement
execute function public.referral_integrity();

-- ---------------------------------------------------------------------------
-- Pool entries and presentations: append-only, consistent with their Referral.
-- ---------------------------------------------------------------------------

create function public.referral_evidence_append_only()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'public.% is append-only referral evidence', tg_table_name
    using errcode = '55000';
end;
$function$;

create trigger referral_eligible_pool_entries_append_only
before update or delete on public.referral_eligible_pool_entries
for each row
execute function public.referral_evidence_append_only();

create trigger referral_eligible_pool_entries_no_truncate
before truncate on public.referral_eligible_pool_entries
for each statement
execute function public.referral_evidence_append_only();

create trigger referral_presentations_append_only
before update or delete on public.referral_presentations
for each row
execute function public.referral_evidence_append_only();

create trigger referral_presentations_no_truncate
before truncate on public.referral_presentations
for each statement
execute function public.referral_evidence_append_only();

-- A pool entry names an eligible evaluation of exactly its attorney in its Referral's jurisdiction, recorded with
-- the Referral (the same transaction: a fresh decision-point evaluation), and is eligible as of that evaluation's
-- instant.
create function public.referral_pool_entry_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_referral_jurisdiction uuid;
  v_referral_xmin xid;
  v_evaluation record;
begin
  select r.jurisdiction_id, r.xmin
  into v_referral_jurisdiction, v_referral_xmin
  from public.referrals as r
  where r.id = new.referral_id;
  if not found then
    raise exception 'pool entry referral does not exist'
      using errcode = '23503';
  end if;
  select e.attorney_id, e.jurisdiction_id, e.result, e.as_of, e.xmin as row_xmin
  into v_evaluation
  from public.eligibility_evaluations as e
  where e.id = new.eligibility_evaluation_id;
  if not found then
    raise exception 'pool entry eligibility evaluation does not exist'
      using errcode = '23503';
  end if;
  if v_evaluation.attorney_id is distinct from new.attorney_id
     or v_evaluation.jurisdiction_id is distinct from v_referral_jurisdiction then
    raise exception 'a pool entry evaluation is of its attorney in its referral''s jurisdiction'
      using errcode = '23514';
  end if;
  if v_evaluation.result is distinct from 'eligible' then
    raise exception 'only an attorney evaluated eligible enters a referral pool'
      using errcode = '23514';
  end if;
  if new.eligible_as_of is distinct from v_evaluation.as_of then
    raise exception 'a pool entry is eligible as of its evaluation''s instant'
      using errcode = '23514';
  end if;
  if v_evaluation.row_xmin is distinct from v_referral_xmin then
    raise exception 'a pool entry evaluation is recorded together with its referral'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger referral_eligible_pool_entries_consistency
before insert on public.referral_eligible_pool_entries
for each row
execute function public.referral_pool_entry_consistency();

-- A presented attorney is in the Referral's eligible pool.
create function public.referral_presentation_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if not exists (
    select 1
    from public.referral_eligible_pool_entries as p
    where p.referral_id = new.referral_id
      and p.attorney_id = new.attorney_id
  ) then
    raise exception 'only an attorney in the referral''s eligible pool is presented'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger referral_presentations_consistency
before insert on public.referral_presentations
for each row
execute function public.referral_presentation_consistency();

-- Evidence is created only with its Referral: at commit, a pool entry or presentation was written by the same
-- transaction as its Referral, and the Referral has no outcome. Deferred checks run at commit under whatever role
-- the transaction then has (an API role after a security definer command), so the two deferred check functions
-- are security definer with a fixed search_path; they read only and are executable by no API role.
create function public.referral_evidence_with_referral()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_row_xmin xid;
  v_referral_xmin xid;
  v_outcome text;
begin
  if tg_table_name = 'referral_eligible_pool_entries' then
    select p.xmin into v_row_xmin
    from public.referral_eligible_pool_entries as p
    where p.id = new.id;
  else
    select p.xmin into v_row_xmin
    from public.referral_presentations as p
    where p.id = new.id;
  end if;
  select r.xmin, r.outcome_code
  into v_referral_xmin, v_outcome
  from public.referrals as r
  where r.id = new.referral_id;
  if v_row_xmin is null
     or v_referral_xmin is null
     or v_row_xmin is distinct from v_referral_xmin
     or v_outcome is not null then
    raise exception 'referral evidence is created only together with its referral'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

create constraint trigger referral_eligible_pool_entries_with_referral
after insert on public.referral_eligible_pool_entries
deferrable initially deferred
for each row
execute function public.referral_evidence_with_referral();

create constraint trigger referral_presentations_with_referral
after insert on public.referral_presentations
deferrable initially deferred
for each row
execute function public.referral_evidence_with_referral();

-- Point-in-time evidence: at commit, a Referral has its attorney, a pool entry and a bookable Bookability
-- Evaluation for that attorney (each recorded in the same transaction, each based on an eligible evaluation in
-- its jurisdiction) and, when client_selected, a presentation of that attorney.
create function public.referral_point_in_time_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_referral public.referrals;
  v_xmin xid;
begin
  select r.* into v_referral from public.referrals as r where r.id = new.id;
  select r.xmin into v_xmin from public.referrals as r where r.id = new.id;
  if v_xmin is null then
    raise exception 'referral evidence check found no referral'
      using errcode = '23514';
  end if;
  if v_referral.attorney_id is null then
    raise exception 'a referral names its attorney'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.referral_eligible_pool_entries as p
    join public.eligibility_evaluations as e on e.id = p.eligibility_evaluation_id
    where p.referral_id = v_referral.id
      and p.attorney_id = v_referral.attorney_id
      and p.xmin = v_xmin
      and e.attorney_id = v_referral.attorney_id
      and e.jurisdiction_id = v_referral.jurisdiction_id
      and e.result = 'eligible'
  ) then
    raise exception 'a referral needs a point-in-time eligible pool entry for its attorney'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.bookability_evaluations as b
    join public.eligibility_evaluations as e on e.id = b.eligibility_evaluation_id
    where b.context_type = 'referral'
      and b.context_id = v_referral.id
      and b.attorney_id = v_referral.attorney_id
      and b.result = 'bookable'
      and b.xmin = v_xmin
      and e.attorney_id = v_referral.attorney_id
      and e.jurisdiction_id = v_referral.jurisdiction_id
      and e.result = 'eligible'
  ) then
    raise exception 'a referral needs a point-in-time bookable evaluation for its attorney'
      using errcode = '23514';
  end if;
  if v_referral.allocation_method = 'client_selected' and not exists (
    select 1
    from public.referral_presentations as p
    where p.referral_id = v_referral.id
      and p.attorney_id = v_referral.attorney_id
      and p.xmin = v_xmin
  ) then
    raise exception 'a client-selected referral needs the presentation of its attorney'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

create constraint trigger referrals_point_in_time_evidence
after insert on public.referrals
deferrable initially deferred
for each row
execute function public.referral_point_in_time_evidence();

-- ---------------------------------------------------------------------------
-- Eligibility Evaluations are append-only evidence.
-- ---------------------------------------------------------------------------

create function public.eligibility_evaluation_append_only()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'public.eligibility_evaluations is append-only evidence'
    using errcode = '55000';
end;
$function$;

create trigger eligibility_evaluations_append_only
before update or delete on public.eligibility_evaluations
for each row
execute function public.eligibility_evaluation_append_only();

create trigger eligibility_evaluations_no_truncate
before truncate on public.eligibility_evaluations
for each statement
execute function public.eligibility_evaluation_append_only();

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only (Packet section 1 RLS impact). SELECT grants are unchanged; no API role
-- other than service_role holds any privilege on the three referral relations, and RLS stays enabled with no
-- policy (attorneys and clients read nothing of them directly).
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.referrals,
  public.referral_eligible_pool_entries,
  public.referral_presentations
from public, anon, authenticated, service_role;

revoke all on function public.referral_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.referral_evidence_append_only()
  from public, anon, authenticated, service_role;
revoke all on function public.referral_pool_entry_consistency()
  from public, anon, authenticated, service_role;
revoke all on function public.referral_presentation_consistency()
  from public, anon, authenticated, service_role;
revoke all on function public.referral_evidence_with_referral()
  from public, anon, authenticated, service_role;
revoke all on function public.referral_point_in_time_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.eligibility_evaluation_append_only()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.referral_integrity() is
  'MVP-001 S5: a Referral is never deleted or truncated and changes only once, when its outcome is recorded (outcome_code and outcome_recorded_at together from null); nothing else about it ever changes.';
comment on function public.referral_evidence_append_only() is
  'MVP-001 S5: Referral pool entries and presentations are append-only evidence.';
comment on function public.referral_pool_entry_consistency() is
  'MVP-001 S5: a pool entry names an eligible Eligibility Evaluation of exactly its attorney in its Referral''s jurisdiction, recorded with the Referral, and is eligible as of that evaluation''s instant.';
comment on function public.referral_presentation_consistency() is
  'MVP-001 S5: only an attorney in the Referral''s eligible pool is presented.';
comment on function public.referral_evidence_with_referral() is
  'MVP-001 S5 (deferred): a pool entry or presentation commits only in the transaction that created its Referral, while the Referral has no outcome.';
comment on function public.referral_point_in_time_evidence() is
  'MVP-001 S5 (deferred): a Referral commits only with its attorney, a same-transaction eligible pool entry and bookable Bookability Evaluation for that attorney in its jurisdiction and, when client_selected, the presentation of that attorney.';
comment on function public.eligibility_evaluation_append_only() is
  'MVP-001 S5: Eligibility Evaluations are append-only evidence for every role.';
comment on column public.referrals.allocation_method is
  'How the attorney came to be referred (DM section 7): client_selected (the client chose from a presented set) or allocated (not implemented).';
comment on column public.referrals.outcome_code is
  'The Referral attempt''s recorded outcome, set once together with outcome_recorded_at. The taxonomy is regulatory-gated configuration: only codes listed by the selected referral policy are recorded.';
comment on column public.referral_eligible_pool_entries.eligible_as_of is
  'The as_of instant of the fresh decision-point Eligibility Evaluation that put this attorney in the pool.';
