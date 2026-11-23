-- MVP-001 S11 pass 2 (14 of 16): policy configuration corrections D2, D5 and D7 of the S11 architecture
-- verification (MVP-001 Packet section 2 rule 4: defects of earlier slices are corrected forward in the current
-- slice; Packet S11; IMP section 27 exit "operations can operate the MVP without direct database edits for normal
-- tasks"; PS sections 8.3, 8.4 and 30.4; PS-A2 section 5; PS-A3 section 3.4).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16).
--
-- D2 (mode-scoped policy versions could not be created by staff). staff_create_policy_version (S1, unchanged) already
-- takes a Regulatory Mode, but staff could not read which modes a jurisdiction has, so the payment_flow, payment,
-- engagement, cancellation and refund versions (selected per Regulatory Mode) needed SQL. One read is added:
-- staff_jurisdiction_regulatory_modes (EXECUTE for authenticated only; stable security definer; search_path pinned):
-- the Regulatory Modes mapped to one jurisdiction (mode id, code, name, status, and the mapping's active period and
-- approval status, by code), for staff holding manage_policy_configuration covering that jurisdiction at aal2
-- (has_staff_capability); nothing for anyone else, for no jurisdiction or for an unknown one. The application offers
-- them on the new-version form and passes the chosen mode to the existing parameter. Creating Regulatory Modes and
-- mapping them stay out of scope (M14).
--
-- D5 (approval validation gaps). policy_parameters_approvable (S10, replaced forward with its signature, volatility,
-- security mode and search_path; every existing branch kept exactly) now also validates what the readers read, never
-- an invented key:
-- - eligibility: eligibility_parameters_valid, the parameter checks eligibility_selected_policy (S1, unchanged)
--   applies, extracted into a validator: exactly the five top-level keys with schema rosuno.attorney_eligibility.v1;
--   the license, insurance, discipline and practice_area objects with exactly their keys; a non-empty duplicate-free
--   qualifying status list, a whole evidence age of at least one day, a boolean insurance requirement, optional
--   whole evidence age and minimum amounts, an optional three-letter currency required with a minimum, two
--   duplicate-free and disjoint discipline lists and a boolean authorisation requirement;
-- - bookability: presence_window_seconds, a whole number from 1 to 86400 (the S4 reader requires it);
-- - scheduling, in addition to the two S9 keys: hold_response_window_seconds (1 to 2592000),
--   hold_pre_slot_interval_seconds (0 to 2592000), pending_hold_cap (1 to 10000), minimum_notice_seconds (0 to
--   31536000) (the S4 reader's bounds) and instant_request_response_window_seconds and
--   scheduled_request_response_window_seconds (1 to 2592000, the S6 reader's bounds), each a whole number when present;
-- - referral, in addition to request_message_maximum_characters: outcome_codes when present, a list of 1 to 100
--   distinct lower-snake codes (the S5 reader reads 1 to 100 lower-snake codes).
-- Every other policy type is unchanged.
--
-- D7 (integer casts that raise on a whole JSON number written with a fraction, for example 3600.0, which every
-- validator accepts as whole): five readers cast the JSON text straight to integer. Each is replaced forward with its
-- signature, volatility, security mode, search_path, owner, privileges and comment kept, and only that cast now goes
-- through numeric (as S10 fixed communication_window): pricing_quote (quote_validity_seconds; the S6 offers
-- version), request_response_window (the two response windows), request_message_limit
-- (request_message_maximum_characters), attorney_consultation_offer_options (permitted_durations_minutes) and the S9
-- consultation_timing_policy (consultation_join_window_seconds and consultation_overrun_seconds). Nothing else in
-- their text changes.

-- ---------------------------------------------------------------------------
-- D2: the Regulatory Modes of a jurisdiction.
-- ---------------------------------------------------------------------------

create function public.staff_jurisdiction_regulatory_modes(p_jurisdiction_id uuid)
returns table (
  regulatory_mode_id uuid,
  code text,
  name text,
  status text,
  active_from timestamptz,
  active_until timestamptz,
  approval_status text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select m.id, m.code, m.name, m.status, jm.active_from, jm.active_until, jm.approval_status
  from public.jurisdiction_regulatory_modes as jm
  join public.regulatory_modes as m on m.id = jm.regulatory_mode_id
  where p_jurisdiction_id is not null
    and jm.jurisdiction_id = p_jurisdiction_id
    and public.has_staff_capability('manage_policy_configuration', p_jurisdiction_id, false)
  order by m.code, m.id
  limit 100;
$function$;

-- ---------------------------------------------------------------------------
-- D5: approval validation.
-- ---------------------------------------------------------------------------

-- The parameter checks of eligibility_selected_policy (S1), as a validator (internal).
create function public.eligibility_parameters_valid(p_parameters jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_license jsonb;
  v_insurance jsonb;
  v_discipline jsonb;
  v_practice jsonb;
  v_qualifying text[];
  v_license_age numeric;
  v_disqualifying text[];
  v_cleared text[];
  v_per numeric;
  v_aggregate numeric;
  v_currency text;
begin
  if not public.eligibility_exact_object(
       p_parameters, array['schema', 'license', 'insurance', 'discipline', 'practice_area'])
     or jsonb_typeof(p_parameters -> 'schema') <> 'string'
     or (p_parameters ->> 'schema') <> 'rosuno.attorney_eligibility.v1' then
    return false;
  end if;
  v_license := p_parameters -> 'license';
  v_insurance := p_parameters -> 'insurance';
  v_discipline := p_parameters -> 'discipline';
  v_practice := p_parameters -> 'practice_area';
  if not public.eligibility_exact_object(
       v_license, array['qualifying_reported_statuses', 'evidence_max_age_days'])
     or not public.eligibility_exact_object(
       v_insurance, array['required', 'evidence_max_age_days',
                          'minimum_per_occurrence_minor',
                          'minimum_aggregate_minor', 'currency_code'])
     or not public.eligibility_exact_object(
       v_discipline, array['disqualifying_statuses', 'cleared_statuses'])
     or not public.eligibility_exact_object(
       v_practice, array['authorisation_required']) then
    return false;
  end if;
  v_qualifying := public.eligibility_status_list(v_license -> 'qualifying_reported_statuses');
  v_license_age := public.eligibility_safe_integer(v_license -> 'evidence_max_age_days', 1);
  v_disqualifying := public.eligibility_status_list(v_discipline -> 'disqualifying_statuses');
  v_cleared := public.eligibility_status_list(v_discipline -> 'cleared_statuses');
  if jsonb_typeof(v_insurance -> 'evidence_max_age_days') <> 'null'
     and public.eligibility_safe_integer(v_insurance -> 'evidence_max_age_days', 1) is null then
    return false;
  end if;
  if jsonb_typeof(v_insurance -> 'minimum_per_occurrence_minor') <> 'null' then
    v_per := public.eligibility_safe_integer(v_insurance -> 'minimum_per_occurrence_minor', 0);
    if v_per is null then
      return false;
    end if;
  end if;
  if jsonb_typeof(v_insurance -> 'minimum_aggregate_minor') <> 'null' then
    v_aggregate := public.eligibility_safe_integer(v_insurance -> 'minimum_aggregate_minor', 0);
    if v_aggregate is null then
      return false;
    end if;
  end if;
  if jsonb_typeof(v_insurance -> 'currency_code') <> 'null' then
    if jsonb_typeof(v_insurance -> 'currency_code') <> 'string'
       or not ((v_insurance ->> 'currency_code') collate "C" ~ '^[A-Z]{3}$') then
      return false;
    end if;
    v_currency := v_insurance ->> 'currency_code';
  end if;
  return not (
    v_qualifying is null
    or cardinality(v_qualifying) = 0
    or v_license_age is null
    or jsonb_typeof(v_insurance -> 'required') <> 'boolean'
    or v_disqualifying is null
    or v_cleared is null
    or v_disqualifying && v_cleared
    or jsonb_typeof(v_practice -> 'authorisation_required') <> 'boolean'
    or ((v_per is not null or v_aggregate is not null) and v_currency is null)
  );
end;
$function$;

-- A whole number within the bounds when the key is present (internal).
create function public.policy_optional_whole_within(p_parameters jsonb, p_key text, p_minimum numeric, p_maximum numeric)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select not (p_parameters ? p_key) or public.pricing_integer_within(p_parameters -> p_key, p_minimum, p_maximum);
$function$;

-- Approval validation (PS section 8.4): the S10 function with the eligibility, bookability, remaining scheduling and
-- referral outcome checks added (every earlier branch unchanged).
create or replace function public.policy_parameters_approvable(
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
        )
        and (
          not (p_parameters ? 'outcome_codes')
          or (
            jsonb_typeof(p_parameters -> 'outcome_codes') = 'array'
            and jsonb_array_length(p_parameters -> 'outcome_codes') between 1 and 100
            and not exists (
              select 1 from jsonb_array_elements(p_parameters -> 'outcome_codes') as c
              where jsonb_typeof(c) <> 'string' or (c #>> '{}') collate "C" !~ '^[a-z][a-z0-9_]{1,63}$'
            )
            and (select count(distinct c) from jsonb_array_elements_text(p_parameters -> 'outcome_codes') as c)
                = jsonb_array_length(p_parameters -> 'outcome_codes')
          )
        ),
        false)
    when 'payment_flow' then public.payment_flow_parameters_valid(p_parameters)
    when 'engagement' then public.engagement_parameters_valid(p_parameters)
    when 'scheduling' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or (
          (
            not (p_parameters ? 'consultation_join_window_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_join_window_seconds', 0, 86400)
          )
          and (
            not (p_parameters ? 'consultation_overrun_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_overrun_seconds', 0, 86400)
          )
          and public.policy_optional_whole_within(p_parameters, 'hold_response_window_seconds', 1, 2592000)
          and public.policy_optional_whole_within(p_parameters, 'hold_pre_slot_interval_seconds', 0, 2592000)
          and public.policy_optional_whole_within(p_parameters, 'pending_hold_cap', 1, 10000)
          and public.policy_optional_whole_within(p_parameters, 'minimum_notice_seconds', 0, 31536000)
          and public.policy_optional_whole_within(
            p_parameters, 'instant_request_response_window_seconds', 1, 2592000)
          and public.policy_optional_whole_within(
            p_parameters, 'scheduled_request_response_window_seconds', 1, 2592000)
        ),
        false)
    when 'notification' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or public.notification_parameters_valid(p_parameters),
        false)
    when 'eligibility' then coalesce(public.eligibility_parameters_valid(p_parameters), false)
    when 'bookability' then
      coalesce(
        jsonb_typeof(p_parameters) = 'object'
        and public.pricing_integer_within(p_parameters -> 'presence_window_seconds', 1, 86400),
        false)
    else true
  end;
$function$;

-- ---------------------------------------------------------------------------
-- D7: the five readers, each cast through numeric.
-- ---------------------------------------------------------------------------

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
  v_validity := (v_parameters ->> 'quote_validity_seconds')::numeric::integer;
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

create or replace function public.request_response_window(p_jurisdiction uuid, p_path text, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, window_seconds integer)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_outcome text;
  v_id uuid;
  v_key text;
  v_value jsonb;
begin
  v_key := case p_path
    when 'instant' then 'instant_request_response_window_seconds'
    when 'scheduled' then 'scheduled_request_response_window_seconds'
  end;
  if p_jurisdiction is null or v_key is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  select p.outcome, p.policy_version_id
  into v_outcome, v_id
  from public.scheduling_policy('scheduling', p_jurisdiction, p_as_of) as p;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::integer;
    return;
  end if;
  select v.parameters -> v_key into v_value from public.policy_versions as v where v.id = v_id;
  if not public.pricing_integer_within(v_value, 1, 2592000) then
    return query select 'policy_incomplete'::text, v_id, null::integer;
    return;
  end if;
  return query select 'selected'::text, v_id, (v_value #>> '{}')::numeric::integer;
end;
$function$;

create or replace function public.request_message_limit(p_referral_policy_version_id uuid)
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
  return query select 'set'::text, (v_parameters ->> 'request_message_maximum_characters')::numeric::integer;
end;
$function$;

create or replace function public.attorney_consultation_offer_options()
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
    select coalesce(array_agg((d #>> '{}')::numeric::integer order by (d #>> '{}')::numeric::integer), array[]::integer[])
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

create or replace function public.consultation_timing_policy(p_jurisdiction uuid, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, join_window_seconds integer, overrun_seconds integer)
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
  if p_jurisdiction is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::integer, null::integer;
    return;
  end if;
  select p.outcome, p.policy_version_id into v_outcome, v_id
  from public.scheduling_policy('scheduling', p_jurisdiction, p_as_of) as p;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::integer, null::integer;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  if not public.pricing_integer_within(v_raw -> 'consultation_join_window_seconds', 0, 86400)
     or not public.pricing_integer_within(v_raw -> 'consultation_overrun_seconds', 0, 86400) then
    return query select 'policy_incomplete'::text, v_id, null::integer, null::integer;
    return;
  end if;
  return query select
    'selected'::text,
    v_id,
    (v_raw ->> 'consultation_join_window_seconds')::numeric::integer,
    (v_raw ->> 'consultation_overrun_seconds')::numeric::integer;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges (the replaced functions keep their owner, privileges and comments).
-- ---------------------------------------------------------------------------

revoke all on function public.eligibility_parameters_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.policy_optional_whole_within(jsonb, text, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_jurisdiction_regulatory_modes(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_jurisdiction_regulatory_modes(uuid) to authenticated;

comment on function public.eligibility_parameters_valid(jsonb) is
  'MVP-001 S11 (internal; D5): whether eligibility parameters pass exactly the checks eligibility_selected_policy applies (schema rosuno.attorney_eligibility.v1). Executable by no API role.';
comment on function public.policy_optional_whole_within(jsonb, text, numeric, numeric) is
  'MVP-001 S11 (internal; D5): whether a policy parameter is absent or a whole number within the bounds. Executable by no API role.';
comment on function public.staff_jurisdiction_regulatory_modes(uuid) is
  'MVP-001 S11 policy configuration (D2): the Regulatory Modes mapped to one jurisdiction (id, code, name, status, the mapping''s active period and approval status) for staff holding manage_policy_configuration covering that jurisdiction (aal2).';
