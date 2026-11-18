-- MVP-001 S6 (PS-A3): consultation offers, the request duration and the request message, and the public offer
-- fields of the S5 profile (MVP-001 Packet S6 and the S5 profile part; Physical Specification amendment PS-A3,
-- sections 2 to 8; MBS section 11; DM sections 2.5, 9 and 10; MB sections 30, 35, 36, 151 and 152; PS sections 8.4,
-- 15.1 and 22.1; PS-A1 (the client free-text ceiling); PS-A2 section 5).
--
-- Schema (PS-A3 sections 4, 5 and 8; the one relation and the two columns PS-A3 adds, and nothing else: no policy
-- type, capability, enum, seed, settings store or row policy):
-- - attorney_consultation_offers (PS-A3 section 4): one row per consultation an attorney offers (a modality and a
--   duration at a listed price in a currency). Technical invariants only (PS-A3 section 2): a lower-snake modality,
--   a whole-minute duration 1..1440, a price above zero, an ISO 4217 currency code, a withdrawal no earlier than the
--   creation, and at most one current (not withdrawn) offer per attorney, modality, duration and currency. A guard
--   holds for every role, the database owner included: a row is created current, is never deleted or truncated, and
--   only its withdrawal instant is ever recorded, once; a price change therefore withdraws the current offer and
--   creates a new one, so every earlier price stays as history. Row level security is enabled with no policy and
--   no API role holds any privilege on it: offers are written and read only through the functions below;
-- - consultation_requests.requested_duration_minutes and consultation_requests.client_message (PS-A3 section 5),
--   nullable only so that the migration applies to a database that already holds Requests. Both join the S6
--   creation facts that never change once a Request is inserted (the S6 guard is replaced with them added). The
--   message is plain text of at most 20,000 characters and never blank. service_role keeps SELECT on every other
--   column but not on the message (column-level grants), so only the client reads it (PS-A3 section 5: the counsel
--   gate on what an attorney sees before acceptance is undecided; the P1 own-client row policy is unchanged and
--   attorneys read no Request).
--
-- Configuration (PS-A3 section 3; existing policy versions, resolver, capability and staff administration only;
-- nothing here supplies a value):
-- - the platform-scope Fee Policy (PS-A3 section 3.1): the one 'fee' version with no jurisdiction and no regulatory
--   mode that policy_select_version selects for a null jurisdiction. Its parameters are exactly
--   permitted_durations_minutes (a non-empty array of distinct integers 1..1440) and permitted_modalities (a
--   non-empty array of distinct lower-snake codes). It is the single source of the duration and modality options for
--   every attorney and jurisdiction. None selectable, a conflict, or malformed parameters: no offer can be created
--   or priced;
-- - the jurisdiction-scope Fee Policy (PS-A3 section 3.2) keeps only the economics: exactly currency_code,
--   quote_validity_seconds, listed_price_minimum_minor, listed_price_maximum_minor, rounding, platform_fee,
--   client_fee and other_required_fee, each as 20261122020000 describes. The duration and modality lists move to the
--   platform scope: pricing_fee_parameters_valid is replaced accordingly. A Fee Calculation keeps the jurisdiction
--   version as its fee_policy_version_id and records the platform version, its parameters and the offer in its
--   snapshot (schema rosuno.fee_calculation_snapshot.v2);
-- - the request message maximum (PS-A3 section 3.3): request_message_maximum_characters (an integer 1..20000) in the
--   'referral' version a Request records (referral_policy_version_id). Absent: a Request without a message is
--   accepted and one with a message is refused (message_not_permitted). Present but malformed: a message is refused
--   (policy_unavailable). Changing the maximum never changes a stored message;
-- - validation before approval (PS-A3 section 3.4; PS section 8.4): staff_transition_policy_version is replaced so
--   that a transition to approved answers parameters_invalid for a 'fee' version whose parameters do not match the
--   schema of its scope (no jurisdiction: platform; a jurisdiction: economics) and for a 'referral' version carrying
--   a malformed request_message_maximum_characters. The check runs last, just before the change, so every other
--   behaviour, outcome and audit of the function is exactly as before. Approved parameters are immutable (S1), and
--   every reader validates again and fails closed.
--
-- The attorney's offers (EXECUTE for authenticated only; security definer; the caller's own approved Attorney
-- Profile at aal2 through lock_current_attorney_profile, as the S4 schedule functions; each change audited once in
-- its own transaction with identifiers, modality, duration, amount and currency only, no free text):
-- - attorney_set_consultation_offer: creates an offer for a modality and duration the platform-scope version permits
--   now, in a currency allowed for the attorney now (the currency of the selected, complete jurisdiction-scope Fee
--   Policy of at least one jurisdiction where the attorney holds a licence row). When a current offer exists for the
--   same modality, duration and currency, it is withdrawn and the new one created in the same transaction (replaced);
--   the same price again changes nothing (unchanged). The profile row lock (FOR NO KEY UPDATE) serializes the
--   attorney's changes, and the decision-point eligibility recorder's FOR SHARE lock on the same row orders them
--   against a Request being created for the attorney. Outcomes: created, replaced, unchanged (each with the offer
--   id), invalid, denied, options_unavailable, not_permitted, currency_not_allowed, rate_limited, conflict. Fixed
--   abuse bounds (not policy values): a price of at most 10^12 minor units, at most 200 current offers per attorney
--   and at most 200 offers created per attorney in any 24 hours;
-- - attorney_withdraw_consultation_offer: withdraws one of the caller's own current offers. Outcomes: withdrawn,
--   already_withdrawn, not_found (another attorney's offer and an unknown one alike), denied;
-- - attorney_consultation_offers: the caller's own offers, current first, then the withdrawn history (at most 500),
--   each with whether the platform-scope version permits its modality and duration now (an offer no longer
--   permitted stays stored, is neither shown publicly nor priced, and is marked so here);
-- - attorney_consultation_offer_options: whether the platform-scope version is configured, its permitted durations
--   and modalities, and the attorney's allowed currencies.
-- Without an aal2 session, an active User and an approved Attorney Profile the writes answer denied and the reads
-- answer no row.
--
-- Pricing (PS-A3 section 5): the S6 price-source seam (pricing_attorney_offers, pricing_attorney_offer) now reads
-- the attorney's current offers, and the quote engine (pricing_quote) is replaced: it prices the current offer for
-- the chosen modality and duration in the currency of the jurisdiction-scope Fee Policy, so an attorney practising
-- in jurisdictions with different currencies is priced in each with that jurisdiction's own offer. In order:
-- invalid; policy_unavailable (no complete jurisdiction-scope or platform-scope version); price_unavailable (no
-- current offer for the pair in that currency); modality_not_permitted and duration_not_permitted (by the
-- platform-scope version); price_not_permitted (outside the jurisdiction's bounds); priced. Never a zero or fallback
-- price. A later withdrawal, new offer or configuration change never changes a recorded Fee Calculation.
--
-- Requests (PS-A3 section 5): request_create is replaced by a version with the optional client message (the old
-- five-argument function is dropped). The Request records requested_duration_minutes (the priced offer's duration;
-- for a scheduled Request also its Hold's length) and the message as given; the message is checked against the
-- maximum of the referral version the Request records, independently of the client, and any refusal writes nothing.
-- The deferred S6 point-in-time evidence check is replaced so that a Request also commits only with its duration,
-- and a scheduled one only with a Hold of exactly that length. client_request is replaced to answer the recorded
-- duration and the client's own message; client_request_review to answer the message maximum the Request would
-- record now (null: no message can be added). The audit event of a creation also names the offer and the
-- platform-scope version.
--
-- Public offers (PS-A3 section 6; EXECUTE for anon and authenticated; stable security definer; persists nothing;
-- strict allowlist): public_attorney_offers answers a publicly listed attorney's current offers (modality, duration,
-- listed price, currency) whose pair the platform-scope version permits now; with a jurisdiction given, only the
-- offers that would be priced there. The attorney must be listed exactly as public_attorney_profile lists (the S5
-- reads keep their signatures): an unknown and an unlisted attorney answer alike, no row.
--
-- Rollback is a separately reviewed forward migration; no historical row is removed (PS-A3 section 8).

-- ---------------------------------------------------------------------------
-- The relation (PS-A3 section 4).
-- ---------------------------------------------------------------------------

create table public.attorney_consultation_offers (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null,
  modality text not null,
  duration_minutes integer not null,
  listed_price_minor bigint not null,
  currency_code char(3) not null,
  created_at timestamptz not null default statement_timestamp(),
  withdrawn_at timestamptz,
  constraint attorney_consultation_offers_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint attorney_consultation_offers_modality_check
    check (modality ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint attorney_consultation_offers_duration_check
    check (duration_minutes between 1 and 1440),
  constraint attorney_consultation_offers_price_check
    check (listed_price_minor > 0),
  constraint attorney_consultation_offers_currency_check
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint attorney_consultation_offers_withdrawn_check
    check (withdrawn_at is null or withdrawn_at >= created_at)
);

create unique index attorney_consultation_offers_current_key
  on public.attorney_consultation_offers (attorney_id, modality, duration_minutes, currency_code)
  where withdrawn_at is null;

create index attorney_consultation_offers_attorney_idx
  on public.attorney_consultation_offers (attorney_id, created_at, id);

-- Created current; never deleted or truncated; only the withdrawal instant is recorded, once. For every role.
create function public.attorney_consultation_offer_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.attorney_consultation_offers rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.withdrawn_at is not null then
      raise exception 'a consultation offer is created current'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if old.withdrawn_at is not null
     or new.withdrawn_at is null
     or (to_jsonb(new) - 'withdrawn_at') is distinct from (to_jsonb(old) - 'withdrawn_at') then
    raise exception 'a consultation offer changes only by recording its withdrawal once'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger attorney_consultation_offers_change_guard
before insert or update or delete on public.attorney_consultation_offers
for each row
execute function public.attorney_consultation_offer_integrity();

create trigger attorney_consultation_offers_no_truncate
before truncate on public.attorney_consultation_offers
for each statement
execute function public.attorney_consultation_offer_integrity();

alter table public.attorney_consultation_offers enable row level security;

revoke all on table public.attorney_consultation_offers
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The two Request columns (PS-A3 section 5).
-- ---------------------------------------------------------------------------

alter table public.consultation_requests
  add column requested_duration_minutes integer,
  add column client_message text,
  add constraint consultation_requests_requested_duration_minutes_check
    check (requested_duration_minutes is null or requested_duration_minutes between 1 and 1440),
  add constraint consultation_requests_client_message_check
    check (client_message is null or (btrim(client_message) <> '' and char_length(client_message) <= 20000));

-- The S6 lifecycle guard with the two new creation facts (unchanged otherwise).
create or replace function public.consultation_request_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.consultation_requests rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'created' then
      raise exception 'a consultation request is created in state created'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.intake_id is distinct from old.intake_id
     or new.client_id is distinct from old.client_id
     or new.selected_attorney_id is distinct from old.selected_attorney_id
     or new.referral_id is distinct from old.referral_id
     or new.request_path is distinct from old.request_path
     or new.referral_policy_version_id is distinct from old.referral_policy_version_id
     or new.requested_modality is distinct from old.requested_modality
     or new.requested_duration_minutes is distinct from old.requested_duration_minutes
     or new.client_message is distinct from old.client_message
     or new.created_at is distinct from old.created_at then
    raise exception 'a consultation request keeps its identity and creation facts'
      using errcode = '55000';
  end if;
  if old.state in ('accepted', 'declined', 'expired', 'cancelled')
     and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'a consultation request in a terminal state is immutable'
      using errcode = '55000';
  end if;
  if old.response_deadline_at is not null
     and new.response_deadline_at is distinct from old.response_deadline_at then
    raise exception 'a consultation request response deadline is fixed once set'
      using errcode = '55000';
  end if;
  if old.engagement_policy_version_id is not null
     and new.engagement_policy_version_id is distinct from old.engagement_policy_version_id then
    raise exception 'a consultation request engagement policy version is set once'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.request_path = 'instant' and old.state = 'created' and new.state = 'payment_authorized')
       or (old.request_path = 'instant' and old.state = 'payment_authorized' and new.state = 'awaiting_attorney')
       or (old.request_path = 'scheduled' and old.state = 'created' and new.state = 'slot_held')
       or (old.request_path = 'scheduled' and old.state = 'slot_held' and new.state = 'awaiting_attorney')
       or (old.state = 'awaiting_attorney' and new.state in ('accepted', 'declined'))
       or (old.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
           and new.state in ('cancelled', 'expired'))
     ) then
    raise exception 'consultation request transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

-- The deferred S6 point-in-time evidence check, with the Request's duration (and, scheduled, its Hold's length)
-- added (unchanged otherwise).
create or replace function public.request_point_in_time_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_request public.consultation_requests;
  v_xmin xid;
  v_jurisdiction uuid;
  v_roots integer;
begin
  select r.* into v_request from public.consultation_requests as r where r.id = new.id;
  select r.xmin into v_xmin from public.consultation_requests as r where r.id = new.id;
  if v_xmin is null then
    raise exception 'request evidence check found no consultation request'
      using errcode = '23514';
  end if;
  if v_request.requested_duration_minutes is null then
    raise exception 'a consultation request records its duration'
      using errcode = '23514';
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  if not exists (
    select 1
    from public.eligibility_evaluations as e
    where e.attorney_id = v_request.selected_attorney_id
      and e.jurisdiction_id = v_jurisdiction
      and e.result = 'eligible'
      and e.xmin = v_xmin
  ) then
    raise exception 'a consultation request needs a point-in-time eligible evaluation of its attorney'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.bookability_evaluations as b
    join public.eligibility_evaluations as e on e.id = b.eligibility_evaluation_id
    where b.context_type = 'consultation_request'
      and b.context_id = v_request.id
      and b.attorney_id = v_request.selected_attorney_id
      and b.result = 'bookable'
      and b.modality = v_request.requested_modality
      and b.xmin = v_xmin
      and e.attorney_id = v_request.selected_attorney_id
      and e.jurisdiction_id = v_jurisdiction
      and e.result = 'eligible'
      and e.xmin = v_xmin
      and (
        (v_request.request_path = 'instant' and b.slot_start_at is null)
        or (
          v_request.request_path = 'scheduled'
          and exists (
            select 1
            from public.slot_holds as h
            where h.consultation_request_id = v_request.id
              and h.slot_start_at = b.slot_start_at
              and h.slot_end_at = b.slot_end_at
          )
        )
      )
  ) then
    raise exception 'a consultation request needs a point-in-time bookable evaluation of its attorney'
      using errcode = '23514';
  end if;
  if v_request.request_path = 'scheduled' and not exists (
    select 1
    from public.slot_holds as h
    where h.consultation_request_id = v_request.id
      and h.slot_end_at - h.slot_start_at = make_interval(mins => v_request.requested_duration_minutes)
  ) then
    raise exception 'a scheduled consultation request holds a slot of exactly its duration'
      using errcode = '23514';
  end if;
  select count(*)::integer into v_roots
  from public.fee_calculations as c
  where c.consultation_request_id = v_request.id
    and c.supersedes_fee_calculation_id is null
    and c.xmin = v_xmin;
  if v_roots <> 1 then
    raise exception 'a consultation request needs its one fee calculation from its creation'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

-- Only the client reads the message: service_role keeps SELECT on every other column.
revoke select on table public.consultation_requests from service_role;
grant select (
  id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id,
  engagement_policy_version_id, requested_modality, state, response_deadline_at, created_at, accepted_at,
  declined_at, expired_at, cancelled_at, requested_duration_minutes
) on table public.consultation_requests to service_role;

-- ---------------------------------------------------------------------------
-- Configuration readers and approval validation (PS-A3 section 3).
-- ---------------------------------------------------------------------------

-- Whether platform-scope Fee Policy parameters are exactly the two option lists (PS-A3 section 3.1).
create function public.pricing_platform_parameters_valid(p_parameters jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_durations jsonb;
  v_modalities jsonb;
begin
  if jsonb_typeof(p_parameters) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p_parameters)) <> 2
     or not (p_parameters ?& array['permitted_durations_minutes', 'permitted_modalities']) then
    return false;
  end if;
  v_durations := p_parameters -> 'permitted_durations_minutes';
  if jsonb_typeof(v_durations) is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(v_durations) < 1
     or exists (
       select 1 from jsonb_array_elements(v_durations) as d
       where not public.pricing_integer_within(d, 1, 1440)
     ) then
    return false;
  end if;
  if (select count(distinct (d #>> '{}')::numeric) from jsonb_array_elements(v_durations) as d)
     <> jsonb_array_length(v_durations) then
    return false;
  end if;
  v_modalities := p_parameters -> 'permitted_modalities';
  if jsonb_typeof(v_modalities) is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(v_modalities) < 1
     or exists (
       select 1 from jsonb_array_elements(v_modalities) as m
       where jsonb_typeof(m) is distinct from 'string' or (m #>> '{}') !~ '^[a-z][a-z0-9_]{1,31}$'
     ) then
    return false;
  end if;
  return (select count(distinct m #>> '{}') from jsonb_array_elements(v_modalities) as m)
    = jsonb_array_length(v_modalities);
end;
$function$;

-- Whether jurisdiction-scope Fee Policy parameters are exactly the eight economic keys (PS-A3 section 3.2), each as
-- 20261122020000 describes; the duration and modality lists are no longer part of this scope.
create or replace function public.pricing_fee_parameters_valid(p_parameters jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if jsonb_typeof(p_parameters) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p_parameters)) <> 8
     or not (p_parameters ?& array[
       'currency_code', 'quote_validity_seconds',
       'listed_price_minimum_minor', 'listed_price_maximum_minor', 'rounding',
       'platform_fee', 'client_fee', 'other_required_fee'
     ]) then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'currency_code') is distinct from 'string'
     or (p_parameters ->> 'currency_code') !~ '^[A-Z]{3}$' then
    return false;
  end if;
  if not public.pricing_integer_within(p_parameters -> 'quote_validity_seconds', 60, 604800) then
    return false;
  end if;
  if not public.pricing_optional_integer_within(p_parameters -> 'listed_price_minimum_minor', 1, 1000000000000)
     or not public.pricing_optional_integer_within(p_parameters -> 'listed_price_maximum_minor', 1, 1000000000000) then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'listed_price_minimum_minor') = 'number'
     and jsonb_typeof(p_parameters -> 'listed_price_maximum_minor') = 'number'
     and (p_parameters ->> 'listed_price_minimum_minor')::numeric
         > (p_parameters ->> 'listed_price_maximum_minor')::numeric then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'rounding') is distinct from 'string'
     or (p_parameters ->> 'rounding') not in ('half_up', 'half_even', 'down', 'up') then
    return false;
  end if;
  return public.pricing_component_valid(p_parameters -> 'platform_fee')
    and public.pricing_component_valid(p_parameters -> 'client_fee')
    and public.pricing_component_valid(p_parameters -> 'other_required_fee');
end;
$function$;

-- The platform-scope Fee Policy at an instant: ('selected', version, parameters), the resolver's own refusal
-- (environment_unrecorded, environment_mismatch, no_applicable_policy, policy_conflict, invalid), or
-- ('policy_incomplete', version, null).
create function public.pricing_platform_policy(p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, parameters jsonb)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_outcome text;
  v_id uuid;
  v_raw jsonb;
begin
  if p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::jsonb;
    return;
  end if;
  select s.outcome, s.policy_version_id
  into v_outcome, v_id
  from public.policy_select_version('fee', null, null, p_as_of) as s;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::jsonb;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  if not public.pricing_platform_parameters_valid(v_raw) then
    return query select 'policy_incomplete'::text, v_id, null::jsonb;
    return;
  end if;
  return query select 'selected'::text, v_id, v_raw;
end;
$function$;

-- Whether a version's parameters may be approved (PS-A3 section 3.4): a 'fee' version matches the schema of its
-- scope (no jurisdiction: platform; a jurisdiction: economics); a 'referral' version carries no
-- request_message_maximum_characters or an integer 1..20000. Other types are not concerned.
create function public.policy_parameters_approvable(
  p_policy_type_code text,
  p_jurisdiction_id uuid,
  p_parameters jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_policy_type_code
    when 'fee' then
      case
        when p_jurisdiction_id is null then public.pricing_platform_parameters_valid(p_parameters)
        else public.pricing_fee_parameters_valid(p_parameters)
      end
    when 'referral' then
      coalesce(
        jsonb_typeof(p_parameters) = 'object'
        and (
          not (p_parameters ? 'request_message_maximum_characters')
          or public.pricing_integer_within(p_parameters -> 'request_message_maximum_characters', 1, 20000)
        ),
        false)
    else true
  end;
$function$;

-- The S1 lifecycle transition with the PS-A3 section 3.4 approval validation added as its last check (unchanged
-- otherwise).
create or replace function public.staff_transition_policy_version(
  p_policy_version_id uuid,
  p_expected_updated_at timestamptz,
  p_target_status text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_environment text;
  v_jurisdiction uuid;
  v_before public.policy_versions;
  v_now timestamptz;
begin
  if p_policy_version_id is null
     or p_expected_updated_at is null
     or p_target_status is null
     or p_target_status not in (
       'draft', 'internal_review', 'counsel_review', 'approved',
       'scheduled', 'active', 'suspended', 'retired'
     ) then
    return 'invalid';
  end if;
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return v_environment;
  end if;
  select v.jurisdiction_id into v_jurisdiction
  from public.policy_versions as v where v.id = p_policy_version_id;
  if not found then
    return 'not_found';
  end if;
  v_staff := public.lock_current_capability_staff('manage_policy_configuration', v_jurisdiction);
  if v_staff is null then
    return 'denied';
  end if;
  select v.* into v_before
  from public.policy_versions as v
  where v.id = p_policy_version_id
  for no key update;
  if v_before.development_only then
    return 'locked';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  if not (
    (v_before.status = 'draft' and p_target_status = 'internal_review')
    or (v_before.status = 'internal_review' and p_target_status in ('draft', 'counsel_review'))
    or (v_before.status = 'counsel_review' and p_target_status in ('draft', 'internal_review', 'approved'))
    or (v_before.status = 'approved' and p_target_status in ('scheduled', 'active', 'retired'))
    or (v_before.status = 'scheduled' and p_target_status in ('active', 'retired'))
    or (v_before.status = 'active' and p_target_status in ('suspended', 'retired'))
    or (v_before.status = 'suspended' and p_target_status in ('active', 'retired'))
  ) then
    return 'invalid_transition';
  end if;
  v_now := statement_timestamp();
  if p_target_status = 'approved' and not exists (
    select 1 from public.policy_authority_references as r
    where r.policy_version_id = v_before.id
      and r.verification_status = 'verified'
      and r.verified_by_user_id is not null
  ) then
    return 'authority_unverified';
  end if;
  -- effective_from is fixed once a version is approved, so approval needs it set.
  if (p_target_status = 'approved' and v_before.effective_from is null)
     or (p_target_status = 'scheduled'
      and (v_before.effective_from is null or v_before.effective_from <= v_now))
     or (p_target_status = 'active'
         and (v_before.effective_from is null or v_before.effective_from > v_now
              or (v_before.effective_until is not null and v_before.effective_until <= v_now))) then
    return 'effective_period_required';
  end if;
  -- MVP-001 S6 (PS-A3 section 3.4; PS section 8.4): the parameters are validated before approval.
  if p_target_status = 'approved'
     and not public.policy_parameters_approvable(
       v_before.policy_type_code, v_before.jurisdiction_id, v_before.parameters
     ) then
    return 'parameters_invalid';
  end if;
  update public.policy_versions as v
  set status = p_target_status,
      approved_at = case when p_target_status = 'approved' then v_now else v.approved_at end,
      approved_by_user_id = case when p_target_status = 'approved' then v_staff else v.approved_by_user_id end
  where v.id = v_before.id;
  perform public.configuration_audit(
    v_staff, 'policy_version.transitioned', 'policy_version', v_before.id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', p_target_status),
    v_jurisdiction
  );
  return 'applied';
end;
$function$;

-- The request message maximum of a referral version (PS-A3 section 3.3): ('set', maximum), ('absent', null) when
-- the version carries none, or ('invalid', null) for a malformed value or a version that is not a referral one.
create function public.request_message_limit(p_referral_policy_version_id uuid)
returns table (outcome text, maximum_characters integer)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_parameters jsonb;
begin
  select v.parameters into v_parameters
  from public.policy_versions as v
  where v.id = p_referral_policy_version_id
    and v.policy_type_code = 'referral';
  if not found or jsonb_typeof(v_parameters) is distinct from 'object' then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if not (v_parameters ? 'request_message_maximum_characters') then
    return query select 'absent'::text, null::integer;
    return;
  end if;
  if not public.pricing_integer_within(v_parameters -> 'request_message_maximum_characters', 1, 20000) then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  return query select 'set'::text, (v_parameters ->> 'request_message_maximum_characters')::integer;
end;
$function$;

-- The currencies an attorney may offer in now: those of the selected, complete jurisdiction-scope Fee Policies of
-- the jurisdictions where the attorney holds a licence row (at most 100 jurisdictions, a fixed technical bound).
create function public.attorney_offer_allowed_currencies(p_attorney uuid, p_as_of timestamptz)
returns text[]
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    array_agg(distinct f.parameters ->> 'currency_code' order by f.parameters ->> 'currency_code'),
    array[]::text[])
  from (
    select distinct l.jurisdiction_id
    from public.licenses as l
    where l.attorney_id = p_attorney
    order by l.jurisdiction_id
    limit 100
  ) as j
  cross join lateral public.pricing_fee_policy(j.jurisdiction_id, p_as_of) as f
  where p_attorney is not null
    and p_as_of is not null
    and f.outcome = 'selected';
$function$;

-- ---------------------------------------------------------------------------
-- The attorney's offers (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.attorney_set_consultation_offer(
  p_modality text,
  p_duration_minutes integer,
  p_listed_price_minor bigint,
  p_currency_code text
)
returns table (outcome text, offer_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_profile public.attorney_profiles;
  v_now timestamptz;
  v_selection text;
  v_platform uuid;
  v_parameters jsonb;
  v_current public.attorney_consultation_offers;
  v_id uuid;
begin
  if p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440
     or p_listed_price_minor is null
     or p_listed_price_minor not between 1 and 1000000000000
     or p_currency_code is null
     or p_currency_code !~ '^[A-Z]{3}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null or v_profile.profile_state is distinct from 'approved' then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  v_now := clock_timestamp();
  select p.outcome, p.policy_version_id, p.parameters
  into v_selection, v_platform, v_parameters
  from public.pricing_platform_policy(v_now) as p;
  if v_selection is distinct from 'selected' then
    return query select 'options_unavailable'::text, null::uuid;
    return;
  end if;
  if not ((v_parameters -> 'permitted_modalities') ? p_modality)
     or not ((v_parameters -> 'permitted_durations_minutes') @> to_jsonb(p_duration_minutes)) then
    return query select 'not_permitted'::text, null::uuid;
    return;
  end if;
  if not (p_currency_code = any (public.attorney_offer_allowed_currencies(v_profile.id, v_now))) then
    return query select 'currency_not_allowed'::text, null::uuid;
    return;
  end if;
  select o.* into v_current
  from public.attorney_consultation_offers as o
  where o.attorney_id = v_profile.id
    and o.modality = p_modality
    and o.duration_minutes = p_duration_minutes
    and o.currency_code = p_currency_code
    and o.withdrawn_at is null
  for update;
  if v_current.id is not null and v_current.listed_price_minor = p_listed_price_minor then
    return query select 'unchanged'::text, v_current.id;
    return;
  end if;
  if (v_current.id is null
      and (select count(*) from public.attorney_consultation_offers as o
           where o.attorney_id = v_profile.id and o.withdrawn_at is null) >= 200)
     or (select count(*) from public.attorney_consultation_offers as o
         where o.attorney_id = v_profile.id and o.created_at > v_now - interval '24 hours') >= 200 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  begin
    if v_current.id is not null then
      update public.attorney_consultation_offers as o
      set withdrawn_at = v_now
      where o.id = v_current.id;
    end if;
    insert into public.attorney_consultation_offers (
      attorney_id, modality, duration_minutes, listed_price_minor, currency_code, created_at
    ) values (
      v_profile.id, p_modality, p_duration_minutes, p_listed_price_minor, p_currency_code, v_now
    )
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
  end;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney',
    case when v_current.id is null then 'consultation_offer.created' else 'consultation_offer.replaced' end,
    'attorney_consultation_offer', v_id,
    case when v_current.id is null then null
         else jsonb_build_object(
           'offer_id', v_current.id,
           'listed_price_minor', v_current.listed_price_minor
         )
    end,
    jsonb_build_object(
      'attorney_id', v_profile.id,
      'modality', p_modality,
      'duration_minutes', p_duration_minutes,
      'listed_price_minor', p_listed_price_minor,
      'currency_code', p_currency_code
    ),
    null,
    jsonb_build_array(jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', v_platform)),
    null, clock_timestamp()
  );
  return query select
    case when v_current.id is null then 'created' else 'replaced' end::text,
    v_id;
end;
$function$;

create function public.attorney_withdraw_consultation_offer(p_offer_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_offer public.attorney_consultation_offers;
  v_now timestamptz;
begin
  v_profile := public.lock_current_attorney_profile(true);
  if v_profile.id is null or v_profile.profile_state is distinct from 'approved' then
    return 'denied';
  end if;
  if p_offer_id is null then
    return 'not_found';
  end if;
  select o.* into v_offer
  from public.attorney_consultation_offers as o
  where o.id = p_offer_id
    and o.attorney_id = v_profile.id
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_offer.withdrawn_at is not null then
    return 'already_withdrawn';
  end if;
  v_now := clock_timestamp();
  update public.attorney_consultation_offers as o
  set withdrawn_at = v_now
  where o.id = p_offer_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney', 'consultation_offer.withdrawn', 'attorney_consultation_offer', p_offer_id,
    jsonb_build_object('withdrawn_at', null),
    jsonb_build_object(
      'attorney_id', v_profile.id,
      'modality', v_offer.modality,
      'duration_minutes', v_offer.duration_minutes,
      'listed_price_minor', v_offer.listed_price_minor,
      'currency_code', v_offer.currency_code,
      'withdrawn_at', v_now
    ),
    null, null, null, clock_timestamp()
  );
  return 'withdrawn';
end;
$function$;

create function public.attorney_consultation_offers()
returns table (
  offer_id uuid,
  modality text,
  duration_minutes integer,
  listed_price_minor bigint,
  currency_code text,
  created_at timestamptz,
  withdrawn_at timestamptz,
  permitted boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with me as (
    select p.id
    from public.attorney_profiles as p
    join public.users as u on u.id = p.user_id
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
      and p.profile_state = 'approved'
      and public.current_session_aal2() is true
  ),
  platform as (
    select x.outcome, x.parameters
    from public.pricing_platform_policy(clock_timestamp()) as x
  )
  select
    o.id,
    o.modality,
    o.duration_minutes,
    o.listed_price_minor,
    o.currency_code::text,
    o.created_at,
    o.withdrawn_at,
    coalesce(
      pl.outcome = 'selected'
      and (pl.parameters -> 'permitted_modalities') ? o.modality
      and (pl.parameters -> 'permitted_durations_minutes') @> to_jsonb(o.duration_minutes),
      false)
  from me
  join public.attorney_consultation_offers as o on o.attorney_id = me.id
  cross join platform as pl
  order by o.withdrawn_at is not null, o.modality, o.duration_minutes, o.currency_code, o.created_at desc, o.id
  limit 500;
$function$;

create function public.attorney_consultation_offer_options()
returns table (
  options_configured boolean,
  permitted_durations_minutes integer[],
  permitted_modalities text[],
  allowed_currencies text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_attorney uuid;
  v_now timestamptz := clock_timestamp();
  v_selection text;
  v_parameters jsonb;
  v_durations integer[] := array[]::integer[];
  v_modalities text[] := array[]::text[];
begin
  if public.current_session_aal2() is not true then
    return;
  end if;
  select p.id into v_attorney
  from public.attorney_profiles as p
  join public.users as u on u.id = p.user_id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and p.profile_state = 'approved';
  if v_attorney is null then
    return;
  end if;
  select x.outcome, x.parameters into v_selection, v_parameters
  from public.pricing_platform_policy(v_now) as x;
  if v_selection = 'selected' then
    select coalesce(array_agg((d #>> '{}')::integer order by (d #>> '{}')::integer), array[]::integer[])
    into v_durations
    from jsonb_array_elements(v_parameters -> 'permitted_durations_minutes') as d;
    select coalesce(array_agg(m order by m), array[]::text[])
    into v_modalities
    from jsonb_array_elements_text(v_parameters -> 'permitted_modalities') as m;
  end if;
  return query select
    coalesce(v_selection = 'selected', false),
    v_durations,
    v_modalities,
    public.attorney_offer_allowed_currencies(v_attorney, v_now);
end;
$function$;

-- ---------------------------------------------------------------------------
-- The price source and the quote engine read current offers (PS-A3 section 5).
-- ---------------------------------------------------------------------------

-- The attorney's current offers, every currency.
create or replace function public.pricing_attorney_offers(p_attorney uuid)
returns table (
  modality text,
  duration_minutes integer,
  listed_price_minor bigint,
  currency_code text,
  offer_reference jsonb
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code::text,
         jsonb_build_object('offer_id', o.id)
  from public.attorney_consultation_offers as o
  where o.attorney_id = p_attorney
    and o.withdrawn_at is null
  order by o.modality, o.duration_minutes, o.currency_code;
$function$;

-- The attorney's current offers for one modality and duration, one per currency.
create or replace function public.pricing_attorney_offer(
  p_attorney uuid,
  p_modality text,
  p_duration_minutes integer
)
returns table (
  modality text,
  duration_minutes integer,
  listed_price_minor bigint,
  currency_code text,
  offer_reference jsonb
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code::text,
         jsonb_build_object('offer_id', o.id)
  from public.attorney_consultation_offers as o
  where o.attorney_id = p_attorney
    and o.modality = p_modality
    and o.duration_minutes = p_duration_minutes
    and o.withdrawn_at is null
  order by o.currency_code;
$function$;

create or replace function public.pricing_quote(
  p_attorney uuid,
  p_jurisdiction uuid,
  p_modality text,
  p_duration_minutes integer,
  p_as_of timestamptz
)
returns table (
  outcome text,
  fee_policy_version_id uuid,
  attorney_listed_price_minor bigint,
  platform_fee_minor bigint,
  client_fee_minor bigint,
  tax_or_other_required_fee_minor bigint,
  total_client_amount_minor bigint,
  currency_code text,
  quote_validity_seconds integer,
  calculation_snapshot jsonb
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_selection text;
  v_policy uuid;
  v_parameters jsonb;
  v_platform_selection text;
  v_platform uuid;
  v_platform_parameters jsonb;
  v_offers integer;
  v_offer record;
  v_offer_id text;
  v_currency text;
  v_rounding text;
  v_price bigint;
  v_platform_fee bigint;
  v_client bigint;
  v_other bigint;
  v_validity integer;
  v_snapshot jsonb;
begin
  if p_attorney is null
     or p_jurisdiction is null
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440
     or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::bigint, null::bigint, null::bigint, null::bigint,
      null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  select f.outcome, f.policy_version_id, f.parameters
  into v_selection, v_policy, v_parameters
  from public.pricing_fee_policy(p_jurisdiction, p_as_of) as f;
  select f.outcome, f.policy_version_id, f.parameters
  into v_platform_selection, v_platform, v_platform_parameters
  from public.pricing_platform_policy(p_as_of) as f;
  if v_selection is distinct from 'selected' or v_platform_selection is distinct from 'selected' then
    return query select 'policy_unavailable'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  v_currency := v_parameters ->> 'currency_code';
  -- The attorney's current offer for the pair in the jurisdiction's currency (one at most by the partial unique
  -- index; anything else is not a price).
  select count(*)::integer into v_offers
  from (
    select 1
    from public.pricing_attorney_offer(p_attorney, p_modality, p_duration_minutes) as o
    where o.currency_code = v_currency
    limit 2
  ) as x;
  if v_offers <> 1 then
    return query select 'price_unavailable'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code, o.offer_reference
  into v_offer
  from public.pricing_attorney_offer(p_attorney, p_modality, p_duration_minutes) as o
  where o.currency_code = v_currency;
  v_offer_id := v_offer.offer_reference ->> 'offer_id';
  if v_offer.modality is distinct from p_modality
     or v_offer.duration_minutes is distinct from p_duration_minutes
     or v_offer.listed_price_minor is null
     or v_offer.listed_price_minor <= 0
     or v_offer.listed_price_minor > 1000000000000
     or v_offer.currency_code is distinct from v_currency
     or jsonb_typeof(v_offer.offer_reference) is distinct from 'object'
     or v_offer_id is null
     or v_offer_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query select 'price_unavailable'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  if not ((v_platform_parameters -> 'permitted_modalities') ? p_modality) then
    return query select 'modality_not_permitted'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  if not ((v_platform_parameters -> 'permitted_durations_minutes') @> to_jsonb(p_duration_minutes)) then
    return query select 'duration_not_permitted'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  v_price := v_offer.listed_price_minor;
  if (jsonb_typeof(v_parameters -> 'listed_price_minimum_minor') = 'number'
      and v_price < (v_parameters ->> 'listed_price_minimum_minor')::numeric)
     or (jsonb_typeof(v_parameters -> 'listed_price_maximum_minor') = 'number'
         and v_price > (v_parameters ->> 'listed_price_maximum_minor')::numeric) then
    return query select 'price_not_permitted'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  v_rounding := v_parameters ->> 'rounding';
  v_platform_fee := public.pricing_component_minor(v_price, v_parameters -> 'platform_fee', v_rounding);
  v_client := public.pricing_component_minor(v_price, v_parameters -> 'client_fee', v_rounding);
  v_other := public.pricing_component_minor(v_price, v_parameters -> 'other_required_fee', v_rounding);
  v_validity := (v_parameters ->> 'quote_validity_seconds')::integer;
  v_snapshot := jsonb_build_object(
    'schema', 'rosuno.fee_calculation_snapshot.v2',
    'inputs', jsonb_build_object(
      'attorney_id', p_attorney,
      'jurisdiction_id', p_jurisdiction,
      'modality', p_modality,
      'duration_minutes', p_duration_minutes,
      'as_of', p_as_of,
      'attorney_listed_price_minor', v_price,
      'attorney_price_currency_code', v_offer.currency_code,
      'offer', jsonb_build_object(
        'id', v_offer_id,
        'modality', v_offer.modality,
        'duration_minutes', v_offer.duration_minutes,
        'listed_price_minor', v_price,
        'currency_code', v_offer.currency_code
      ),
      'fee_policy_version_id', v_policy,
      'fee_policy_parameters', v_parameters,
      'platform_fee_policy_version_id', v_platform,
      'platform_fee_policy_parameters', v_platform_parameters
    ),
    'components', jsonb_build_object(
      'attorney_listed_price', jsonb_build_object(
        'amount_minor', v_price,
        'pricing_source', 'attorney_offer',
        'offer_reference', v_offer.offer_reference
      ),
      'platform_fee', jsonb_build_object(
        'amount_minor', v_platform_fee,
        'pricing_source', 'fee_policy',
        'fee_policy_version_id', v_policy,
        'party', 'attorney',
        'rule', v_parameters -> 'platform_fee',
        'rounding', v_rounding
      ),
      'client_fee', jsonb_build_object(
        'amount_minor', v_client,
        'pricing_source', 'fee_policy',
        'fee_policy_version_id', v_policy,
        'party', 'client',
        'rule', v_parameters -> 'client_fee',
        'rounding', v_rounding
      ),
      'tax_or_other_required_fee', jsonb_build_object(
        'amount_minor', v_other,
        'pricing_source', 'fee_policy',
        'fee_policy_version_id', v_policy,
        'party', 'client',
        'rule', v_parameters -> 'other_required_fee',
        'rounding', v_rounding
      )
    ),
    'formula', jsonb_build_object(
      'component', 'clamp(round(attorney_listed_price_minor * basis_points / 10000) + fixed_minor, minimum_minor, maximum_minor)',
      'total_client_amount_minor', 'attorney_listed_price_minor + client_fee_minor + tax_or_other_required_fee_minor',
      'platform_fee_minor', 'attorney side; not part of the client total'
    ),
    'quote_validity_seconds', v_validity
  );
  return query select
    'priced'::text,
    v_policy,
    v_price,
    v_platform_fee,
    v_client,
    v_other,
    v_price + v_client + v_other,
    v_currency,
    v_validity,
    v_snapshot;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The client's review and Request reads, and Request creation (PS-A3 section 5).
-- ---------------------------------------------------------------------------

drop function public.client_request_review(uuid);

create function public.client_request_review(p_referral_id uuid)
returns table (
  referral_id uuid,
  attorney_display_name text,
  request_path text,
  request_id uuid,
  requestable boolean,
  message_maximum_characters integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    f.referral_id,
    public.discovery_presentable_text(p.display_name),
    f.request_path,
    f.request_id,
    f.requestable,
    (
      select l.maximum_characters
      from public.policy_select_version('referral', f.jurisdiction_id, null, clock_timestamp()) as s
      cross join lateral public.request_message_limit(s.policy_version_id) as l
      where s.outcome = 'selected'
        and l.outcome = 'set'
    )
  from public.request_client_referral(p_referral_id) as f
  left join public.attorney_profiles as p on p.id = f.attorney_id;
$function$;

drop function public.client_request(uuid);

create function public.client_request(p_request_id uuid)
returns table (
  request_id uuid,
  state text,
  expired_due boolean,
  request_path text,
  attorney_display_name text,
  requested_modality text,
  duration_minutes integer,
  slot_start_at timestamptz,
  slot_end_at timestamptz,
  response_deadline_at timestamptz,
  created_at timestamptz,
  attorney_listed_price_minor bigint,
  client_fee_minor bigint,
  tax_or_other_required_fee_minor bigint,
  total_client_amount_minor bigint,
  currency_code text,
  quote_valid_until timestamptz,
  client_message text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    r.id,
    r.state,
    coalesce(public.request_expired_due(r.id), false),
    r.request_path,
    public.discovery_presentable_text(p.display_name),
    r.requested_modality,
    coalesce(
      r.requested_duration_minutes,
      case
        when public.pricing_integer_within(c.calculation_snapshot -> 'inputs' -> 'duration_minutes', 1, 1440)
          then (c.calculation_snapshot -> 'inputs' ->> 'duration_minutes')::integer
      end
    ),
    h.slot_start_at,
    h.slot_end_at,
    r.response_deadline_at,
    r.created_at,
    c.attorney_listed_price_minor,
    c.client_fee_minor,
    c.tax_or_other_required_fee_minor,
    c.total_client_amount_minor,
    c.currency_code::text,
    c.quote_valid_until,
    r.client_message
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id and r.id = p_request_id
  left join public.attorney_profiles as p on p.id = r.selected_attorney_id
  left join public.slot_holds as h on h.consultation_request_id = r.id
  left join lateral (
    select x.*
    from public.fee_calculations as x
    where x.consultation_request_id = r.id
      and not exists (
        select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = x.id
      )
    limit 1
  ) as c on true
  where p_request_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

drop function public.request_create(uuid, text, text, integer, timestamptz);

create function public.request_create(
  p_referral_id uuid,
  p_path text,
  p_modality text,
  p_duration_minutes integer,
  p_slot_start timestamptz,
  p_client_message text
)
returns table (outcome text, request_id uuid, problem text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_client uuid;
  v_intake uuid;
  v_state text;
  v_referral public.referrals;
  v_path text;
  v_area uuid;
  v_now timestamptz;
  v_refusal text;
  v_problem text;
  v_selection text;
  v_referral_policy uuid;
  v_limit record;
  v_window record;
  v_request uuid;
  v_evaluation uuid;
  v_area_evaluation uuid;
  v_result text;
  v_bookability uuid;
  v_bookability_result text;
  v_slot_end timestamptz;
  v_quote record;
  v_calculated timestamptz;
  v_fee uuid;
  v_hold_outcome text;
  v_hold uuid;
  v_hold_problem text;
  v_final_state text := 'created';
  v_policy_references jsonb;
begin
  if p_referral_id is null
     or p_path is null
     or p_path not in ('instant', 'scheduled')
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440
     or (p_path = 'scheduled' and p_slot_start is null)
     or (p_path = 'instant' and p_slot_start is not null)
     or (p_client_message is not null and btrim(p_client_message) = '') then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  -- Beyond the technical ceiling (PS-A1), longer than any configurable maximum.
  if p_client_message is not null and char_length(p_client_message) > 20000 then
    return query select 'message_too_long'::text, null::uuid, null::text;
    return;
  end if;
  select l.user_id, l.client_id into v_user, v_client from public.lock_current_client() as l;
  if v_client is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  select r.intake_id into v_intake
  from public.referrals as r
  join public.intakes as i on i.id = r.intake_id
  where r.id = p_referral_id
    and i.client_id = v_client;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  perform 1
  from public.intakes as i
  where i.id = v_intake
    and i.client_id = v_client
  for update;
  v_state := public.intake_expire_if_due(v_intake);
  if v_state is null or v_state not in ('submitted', 'active') then
    return query select 'intake_not_ready'::text, null::uuid, null::text;
    return;
  end if;
  select r.* into v_referral
  from public.referrals as r
  where r.id = p_referral_id
  for update;
  if exists (select 1 from public.consultation_requests as q where q.referral_id = p_referral_id) then
    return query select 'already_requested'::text, null::uuid, null::text;
    return;
  end if;
  if v_referral.outcome_code is not null or v_referral.attorney_id is null then
    return query select 'not_available'::text, null::uuid, 'referral_ended'::text;
    return;
  end if;
  v_path := public.request_referral_path(p_referral_id);
  if v_path is distinct from p_path then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  select case
    when p.client_filter_context ->> 'practice_area_id'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (p.client_filter_context ->> 'practice_area_id')::uuid
  end
  into v_area
  from public.referral_presentations as p
  where p.referral_id = p_referral_id
    and p.attorney_id = v_referral.attorney_id
  limit 1;
  -- The attorney's scheduling lock before any Request or Hold row (S4 lock order).
  perform public.scheduling_lock_attorney(v_referral.attorney_id);
  begin
    v_now := clock_timestamp();

    -- 1. The referral policy of the Referral's jurisdiction.
    select s.outcome, s.policy_version_id
    into v_selection, v_referral_policy
    from public.policy_select_version('referral', v_referral.jurisdiction_id, null, v_now) as s;
    if v_selection is distinct from 'selected' or v_referral_policy is null then
      v_refusal := 'policy_unavailable';
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 1a. The message limit of that referral policy (PS-A3 section 3.3), only when a message is given.
    if p_client_message is not null then
      select l.outcome, l.maximum_characters
      into v_limit
      from public.request_message_limit(v_referral_policy) as l;
      if v_limit.outcome = 'absent' then
        v_refusal := 'message_not_permitted';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      if v_limit.outcome is distinct from 'set' then
        v_refusal := 'policy_unavailable';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      if char_length(p_client_message) > v_limit.maximum_characters then
        v_refusal := 'message_too_long';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
    end if;

    -- 2. The response window for the path.
    select w.outcome, w.policy_version_id, w.window_seconds
    into v_window
    from public.request_response_window(v_referral.jurisdiction_id, p_path, v_now) as w;
    if v_window.outcome is distinct from 'selected' then
      v_refusal := 'policy_unavailable';
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 3. The Request, with its duration and the client's message as given.
    insert into public.consultation_requests (
      intake_id, client_id, selected_attorney_id, referral_id, request_path,
      referral_policy_version_id, requested_modality, requested_duration_minutes, client_message,
      state, response_deadline_at
    ) values (
      v_intake, v_client, v_referral.attorney_id, p_referral_id, p_path,
      v_referral_policy, p_modality, p_duration_minutes, p_client_message,
      'created', clock_timestamp() + make_interval(secs => v_window.window_seconds)
    )
    returning id into v_request;

    -- 4. Fresh eligibility (jurisdiction context, and the filtered practice-area context).
    select d.evaluation_id, d.result
    into v_evaluation, v_result
    from public.eligibility_record_decision_point(
      v_referral.attorney_id, v_referral.jurisdiction_id, null, v_now
    ) as d;
    if v_result is distinct from 'eligible' then
      v_refusal := 'not_available';
      v_problem := 'not_eligible';
      raise exception 'request refused' using errcode = 'RS601';
    end if;
    if v_area is not null then
      select d.evaluation_id, d.result
      into v_area_evaluation, v_result
      from public.eligibility_record_decision_point(
        v_referral.attorney_id, v_referral.jurisdiction_id, v_area, v_now
      ) as d;
      if v_result is distinct from 'eligible' then
        v_refusal := 'not_available';
        v_problem := 'not_eligible';
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      v_evaluation := v_area_evaluation;
    end if;

    -- 5. Fresh Bookability for the Request.
    if p_path = 'scheduled' then
      v_slot_end := p_slot_start + make_interval(mins => p_duration_minutes);
    end if;
    select b.result, b.evaluation_id
    into v_bookability_result, v_bookability
    from public.scheduling_evaluate_bookability(
      v_referral.attorney_id, v_evaluation, 'consultation_request', v_request,
      p_modality, p_slot_start, v_slot_end
    ) as b;
    if v_bookability_result is distinct from 'bookable' then
      v_refusal := 'not_available';
      select f ->> 'reason' into v_problem
      from public.bookability_evaluations as e
      cross join lateral jsonb_array_elements(e.constraint_results) with ordinality as x(f, n)
      where e.id = v_bookability
        and (f ->> 'passed') is distinct from 'true'
      order by x.n
      limit 1;
      v_problem := coalesce(v_problem, 'not_bookable');
      raise exception 'request refused' using errcode = 'RS601';
    end if;

    -- 6. The quote from the attorney's current offer and the Fee Calculation.
    select q.* into v_quote
    from public.pricing_quote(
      v_referral.attorney_id, v_referral.jurisdiction_id, p_modality, p_duration_minutes, v_now
    ) as q;
    if v_quote.outcome is distinct from 'priced' then
      v_refusal := coalesce(v_quote.outcome, 'policy_unavailable');
      raise exception 'request refused' using errcode = 'RS601';
    end if;
    v_calculated := clock_timestamp();
    insert into public.fee_calculations (
      consultation_request_id, fee_policy_version_id, attorney_listed_price_minor,
      platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor,
      total_client_amount_minor, currency_code, quote_valid_until, calculated_at,
      supersedes_fee_calculation_id, calculation_snapshot
    ) values (
      v_request, v_quote.fee_policy_version_id, v_quote.attorney_listed_price_minor,
      v_quote.platform_fee_minor, v_quote.client_fee_minor, v_quote.tax_or_other_required_fee_minor,
      v_quote.total_client_amount_minor, v_quote.currency_code,
      v_calculated + make_interval(secs => v_quote.quote_validity_seconds), v_calculated,
      null, v_quote.calculation_snapshot
    )
    returning id into v_fee;

    -- 7. Scheduled: the Hold (exactly the offer's duration), then slot_held.
    if p_path = 'scheduled' then
      select a.outcome, a.hold_id, a.problem
      into v_hold_outcome, v_hold, v_hold_problem
      from public.scheduling_acquire_hold(v_request, p_slot_start, v_slot_end) as a;
      if v_hold_outcome is distinct from 'held' then
        v_refusal := case
          when v_hold_outcome in ('not_available', 'cap_reached', 'too_late', 'policy_unavailable')
            then v_hold_outcome
          else 'not_available'
        end;
        v_problem := v_hold_problem;
        raise exception 'request refused' using errcode = 'RS601';
      end if;
      update public.consultation_requests as r
      set state = 'slot_held'
      where r.id = v_request;
      v_final_state := 'slot_held';
    end if;

    -- 8. One audit event.
    select case when jsonb_typeof(e.policy_references) = 'array' then e.policy_references else '[]'::jsonb end
    into v_policy_references
    from public.eligibility_evaluations as e
    where e.id = v_evaluation;
    v_policy_references := coalesce(v_policy_references, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('policy_type_code', 'referral', 'policy_version_id', v_referral_policy),
      jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', v_quote.fee_policy_version_id),
      jsonb_build_object(
        'policy_type_code', 'fee',
        'policy_version_id', v_quote.calculation_snapshot -> 'inputs' -> 'platform_fee_policy_version_id'
      ),
      jsonb_build_object('policy_type_code', 'scheduling', 'policy_version_id', v_window.policy_version_id)
    );
    insert into public.audit_events (
      actor_user_id, actor_type, action_code, resource_type, resource_id,
      before_snapshot, after_snapshot, reason_code, policy_references,
      jurisdiction_id, occurred_at
    ) values (
      v_user, 'client', 'consultation_request.created', 'consultation_request', v_request,
      null,
      jsonb_build_object(
        'referral_id', p_referral_id,
        'intake_id', v_intake,
        'attorney_id', v_referral.attorney_id,
        'request_path', p_path,
        'requested_modality', p_modality,
        'duration_minutes', p_duration_minutes,
        'state', v_final_state,
        'eligibility_evaluation_id', v_evaluation,
        'bookability_evaluation_id', v_bookability,
        'fee_calculation_id', v_fee,
        'offer_id', v_quote.calculation_snapshot -> 'inputs' -> 'offer' -> 'id',
        'hold_id', v_hold,
        'attorney_listed_price_minor', v_quote.attorney_listed_price_minor,
        'platform_fee_minor', v_quote.platform_fee_minor,
        'client_fee_minor', v_quote.client_fee_minor,
        'tax_or_other_required_fee_minor', v_quote.tax_or_other_required_fee_minor,
        'total_client_amount_minor', v_quote.total_client_amount_minor,
        'currency_code', v_quote.currency_code,
        'quote_valid_until', v_calculated + make_interval(secs => v_quote.quote_validity_seconds)
      ),
      null, v_policy_references, v_referral.jurisdiction_id, clock_timestamp()
    );
  exception
    when sqlstate 'RS601' then
      return query select v_refusal, null::uuid, v_problem;
      return;
    when unique_violation then
      return query select 'already_requested'::text, null::uuid, null::text;
      return;
    when foreign_key_violation then
      return query select 'not_available'::text, null::uuid, null::text;
      return;
  end;
  return query select 'created'::text, v_request, null::text;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Public offers (PS-A3 section 6; EXECUTE for anon and authenticated).
-- ---------------------------------------------------------------------------

create function public.public_attorney_offers(p_attorney_id uuid, p_jurisdiction_id uuid)
returns table (
  modality text,
  duration_minutes integer,
  listed_price_minor bigint,
  currency_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_platform record;
  v_fee record;
begin
  if p_attorney_id is null then
    return;
  end if;
  -- Listed exactly as the public profile lists (an unknown and an unlisted attorney alike: no row).
  if not exists (select 1 from public.public_attorney_profile(p_attorney_id, p_jurisdiction_id)) then
    return;
  end if;
  select x.outcome, x.parameters into v_platform from public.pricing_platform_policy(v_now) as x;
  if v_platform.outcome is distinct from 'selected' then
    return;
  end if;
  if p_jurisdiction_id is null then
    return query
    select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code
    from public.pricing_attorney_offers(p_attorney_id) as o
    where (v_platform.parameters -> 'permitted_modalities') ? o.modality
      and (v_platform.parameters -> 'permitted_durations_minutes') @> to_jsonb(o.duration_minutes)
    order by o.modality, o.duration_minutes, o.currency_code
    limit 100;
    return;
  end if;
  select f.outcome, f.parameters into v_fee from public.pricing_fee_policy(p_jurisdiction_id, v_now) as f;
  if v_fee.outcome is distinct from 'selected' then
    return;
  end if;
  return query
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code
  from public.pricing_attorney_offers(p_attorney_id) as o
  cross join lateral public.pricing_quote(
    p_attorney_id, p_jurisdiction_id, o.modality, o.duration_minutes, v_now
  ) as q
  where o.currency_code = (v_fee.parameters ->> 'currency_code')
    and (v_platform.parameters -> 'permitted_modalities') ? o.modality
    and (v_platform.parameters -> 'permitted_durations_minutes') @> to_jsonb(o.duration_minutes)
    and q.outcome = 'priced'
    and q.currency_code = o.currency_code
    and q.attorney_listed_price_minor = o.listed_price_minor
  order by o.modality, o.duration_minutes
  limit 100;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.attorney_consultation_offer_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_platform_parameters_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_platform_policy(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.policy_parameters_approvable(text, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.request_message_limit(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.attorney_offer_allowed_currencies(uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.attorney_set_consultation_offer(text, integer, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_set_consultation_offer(text, integer, bigint, text) to authenticated;
revoke all on function public.attorney_withdraw_consultation_offer(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_withdraw_consultation_offer(uuid) to authenticated;
revoke all on function public.attorney_consultation_offers()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_consultation_offers() to authenticated;
revoke all on function public.attorney_consultation_offer_options()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_consultation_offer_options() to authenticated;

revoke all on function public.client_request_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request_review(uuid) to authenticated;
revoke all on function public.client_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request(uuid) to authenticated;
revoke all on function public.request_create(uuid, text, text, integer, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_create(uuid, text, text, integer, timestamptz, text) to authenticated;

revoke all on function public.public_attorney_offers(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.public_attorney_offers(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on table public.attorney_consultation_offers is
  'MVP-001 S6 (PS-A3 section 4): one consultation an attorney offers (modality, duration in minutes, listed price in minor units, currency). Current offers are the rows not withdrawn; at most one current per attorney, modality, duration and currency. Never deleted or truncated; only withdrawn_at is recorded, once, so a price change withdraws the current offer and creates a new one and earlier prices remain as history. RLS with no policy; no API role privilege; read and written only through owner-defined functions.';
comment on column public.consultation_requests.requested_duration_minutes is
  'MVP-001 S6 (PS-A3 section 5): the duration of the priced offer, in minutes (for a scheduled Request also its Hold''s length). Fixed once inserted; nullable only for Requests that predate it.';
comment on column public.consultation_requests.client_message is
  'MVP-001 S6 (PS-A3 section 5): the optional plain-text message the client wrote when creating the Request, stored as given, at most the referral policy''s maximum at creation (never above 20,000 characters) and never changed. Not an inbox. Read only by the client until the counsel gate on pre-acceptance visibility is decided.';

comment on function public.attorney_consultation_offer_integrity() is
  'MVP-001 S6 (PS-A3 section 4): a consultation offer is created current, never deleted or truncated, and changes only by recording its withdrawal once; for every role.';
comment on function public.consultation_request_integrity() is
  'MVP-001 S6: a Consultation Request is never deleted or truncated; it is created in state created; its identity and creation facts (PS-A3: its requested duration and client message included) never change, its response deadline is fixed once set and its engagement policy version set once; its state moves only along the DM section 9 paths (instant created -> payment_authorized -> awaiting_attorney; scheduled created -> slot_held -> awaiting_attorney; awaiting_attorney -> accepted | declined; any undecided state -> cancelled | expired) and never leaves a terminal state.';
comment on function public.request_point_in_time_evidence() is
  'MVP-001 S6 (deferred): a Consultation Request commits only with its requested duration (PS-A3) and same-transaction evidence: an eligible Eligibility Evaluation of its attorney in its Referral''s jurisdiction, a bookable consultation_request Bookability Evaluation for its modality based on one (with the Hold''s slot exactly when scheduled, the Hold lasting exactly the duration), and exactly one root Fee Calculation.';
comment on function public.pricing_platform_parameters_valid(jsonb) is
  'MVP-001 S6 (PS-A3 section 3.1; internal): whether platform-scope Fee Policy parameters are exactly permitted_durations_minutes (non-empty, distinct integers 1..1440) and permitted_modalities (non-empty, distinct lower-snake codes).';
comment on function public.pricing_fee_parameters_valid(jsonb) is
  'MVP-001 S6 (PS-A3 section 3.2; internal): whether jurisdiction-scope Fee Policy parameters are complete and well formed (exactly the eight economic keys; no default; no duration or modality list).';
comment on function public.pricing_platform_policy(timestamptz) is
  'MVP-001 S6 (PS-A3 section 3.1; internal): the selected platform-scope Fee Policy (fee type, no jurisdiction, no regulatory mode) with its validated option lists, the resolver''s refusal, or policy_incomplete.';
comment on function public.policy_parameters_approvable(text, uuid, jsonb) is
  'MVP-001 S6 (PS-A3 section 3.4; internal): whether a version''s parameters may be approved: a fee version matches its scope''s schema (platform or jurisdiction), a referral version''s request_message_maximum_characters is absent or an integer 1..20000.';
comment on function public.staff_transition_policy_version(uuid, timestamptz, text) is
  'Staff policy version lifecycle transition (MVP-001 S1). MVP-001 S6 (PS-A3 section 3.4): a transition to approved answers parameters_invalid when the parameters fail the schema of the version''s type and scope; every other behaviour, outcome and audit is unchanged.';
comment on function public.request_message_limit(uuid) is
  'MVP-001 S6 (PS-A3 section 3.3; internal): the request_message_maximum_characters of a referral version: set (with the maximum), absent, or invalid.';
comment on function public.attorney_offer_allowed_currencies(uuid, timestamptz) is
  'MVP-001 S6 (PS-A3 section 4; internal): the currencies of the selected, complete jurisdiction-scope Fee Policies of the jurisdictions where the attorney holds a licence row.';
comment on function public.attorney_set_consultation_offer(text, integer, bigint, text) is
  'MVP-001 S6 (PS-A3 section 4): the caller''s own approved Attorney Profile at aal2 sets the price of a permitted modality and duration in an allowed currency: creates the offer, or withdraws the current one for the same pair and currency and creates the new one atomically; audited once. Outcomes: created, replaced, unchanged, invalid, denied, options_unavailable, not_permitted, currency_not_allowed, rate_limited, conflict.';
comment on function public.attorney_withdraw_consultation_offer(uuid) is
  'MVP-001 S6 (PS-A3 section 4): the caller''s own approved Attorney Profile at aal2 withdraws one of its current offers; audited once. Outcomes: withdrawn, already_withdrawn, not_found, denied.';
comment on function public.attorney_consultation_offers() is
  'MVP-001 S6 (PS-A3 section 4): the caller''s own offers (approved profile, aal2), current first then the withdrawn history (at most 500), each with whether the platform-scope Fee Policy permits its modality and duration now.';
comment on function public.attorney_consultation_offer_options() is
  'MVP-001 S6 (PS-A3 section 4): for the caller''s own approved profile at aal2: whether the platform-scope Fee Policy is configured, its permitted durations and modalities, and the currencies the attorney may offer in.';
comment on function public.pricing_attorney_offers(uuid) is
  'MVP-001 S6 (internal; price source, PS-A3 section 5): the attorney''s current offers in every currency (modality, duration, listed price, currency, offer reference).';
comment on function public.pricing_attorney_offer(uuid, text, integer) is
  'MVP-001 S6 (internal; price source, PS-A3 section 5): the attorney''s current offers for one modality and duration, one per currency.';
comment on function public.pricing_quote(uuid, uuid, text, integer, timestamptz) is
  'MVP-001 S6 (internal; derived, persists nothing; PS-A3 section 5): the quote from the attorney''s current offer for the modality and duration in the currency of the jurisdiction-scope Fee Policy, permitted by the platform-scope Fee Policy and within the jurisdiction''s bounds, with the calculation snapshot (v2: the offer and the platform version recorded); or invalid, policy_unavailable, price_unavailable, modality_not_permitted, duration_not_permitted or price_not_permitted. Never a zero or fallback price.';
comment on function public.client_request_review(uuid) is
  'MVP-001 S6: the caller''s own Referral for the request review page: the attorney''s presentable display name, the recorded path, the Request already made from it, whether a Request can be made now, and (PS-A3 section 3.3) the message maximum the Request would record now (null: no message can be added).';
comment on function public.client_request(uuid) is
  'MVP-001 S6: one of the caller''s own Requests: state, expired_due, path, attorney display name, modality, duration (PS-A3: the recorded one), slot, response deadline, creation time, the client''s quote amounts, currency, quote validity and the client''s own message; nothing else.';
comment on function public.request_create(uuid, text, text, integer, timestamptz, text) is
  'MVP-001 S6: the client''s Consultation Request from one of their own Referrals, with fresh eligibility and Bookability, the immutable Fee Calculation from the attorney''s current offer and the Fee Policies, the recorded duration and optional message (PS-A3), the Hold for a scheduled Request, and one audit event; any refusal leaves nothing. Outcomes: created, invalid, not_found, intake_not_ready, already_requested, not_available, price_unavailable, price_not_permitted, duration_not_permitted, modality_not_permitted, policy_unavailable, message_not_permitted, message_too_long, cap_reached, too_late.';
comment on function public.public_attorney_offers(uuid, uuid) is
  'MVP-001 S6 (PS-A3 section 6; public): a publicly listed attorney''s current offers (modality, duration, listed price, currency) whose pair the platform-scope Fee Policy permits now; with a jurisdiction, only those that would be priced there. Unknown and unlisted attorneys answer alike: no row. Persists nothing.';
