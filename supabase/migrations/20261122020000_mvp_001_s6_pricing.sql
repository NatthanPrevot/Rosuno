-- MVP-001 S6 (2 of 3): the attorney price-source seam, the Fee Policy reader, the derived quote engine and the
-- client's request review reads (MVP-001 Packet S6 "immutable fee calculation from Fee Policy", "quote validity and
-- expiry", "review and confirmation UI"; MBS section 11 deliverables and financial invariants; DM sections 2.5 and
-- 10; PS section 22.1; PM section 1 INV-2 and INV-7; MB sections 151 and 152; Packet section 3 gates "quote
-- validity; 90-minute enablement" and PS-A3 "attorney listed price, enabled durations and modalities, and request
-- duration").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). Nothing here
-- persists anything: the quote is derived on every call, and only Request creation (20261122030000) records a Fee
-- Calculation.
--
-- The price-source seam (internal): pricing_attorney_offers(attorney) and pricing_attorney_offer(attorney, modality,
-- duration) answer the attorney's offers, each a modality, a duration in minutes, the listed price in minor units,
-- its currency and an offer reference. No relation stores an attorney's listed price, enabled durations or
-- modalities until the owner adopts PS-A3 (Packet section 3), so both answer no row: a missing price makes the
-- attorney not bookable (MB section 152), never a zero or fallback price. With these bodies every quote, preview
-- and Request creation answers price_unavailable and writes nothing. A later forward migration replaces the two
-- bodies once PS-A3 exists; nothing else changes.
--
-- The Fee Policy (internal; Packet rule 6; MBS sections 2.5 and 2.10; DM section 10 "a Fee Policy governs permitted
-- economics; the attorney's price is a business input"): pricing_fee_policy reads the one version the
-- environment-anchored resolver (policy_select_version, PS-A2 section 5) selects for the 'fee' type, the exact
-- jurisdiction scope and no regulatory mode, at the instant. Every parameter is required and explicit (no default,
-- no fallback), and the object has exactly these keys; anything missing, extra or malformed answers
-- policy_incomplete and every caller refuses with policy_unavailable:
-- - currency_code: an ISO 4217 code (three capital letters);
-- - quote_validity_seconds: an integer 60..604800 (DM section 2.5: quote validity is policy-driven);
-- - permitted_durations_minutes: a non-empty array of at most 48 distinct integers 1..1440 (MB section 151:
--   which durations are enabled, a 90-minute one included, is configuration);
-- - permitted_modalities: a non-empty array of at most 32 distinct lower-snake codes (^[a-z][a-z0-9_]{1,31}$);
--   no modality vocabulary is fixed anywhere in the schema;
-- - listed_price_minimum_minor and listed_price_maximum_minor: an integer 1..10^12, or JSON null for no bound,
--   minimum not above maximum (MB section 151: no universal minimum is hard-coded; a minimum is configuration);
-- - rounding: half_up, half_even, down or up;
-- - platform_fee, client_fee and other_required_fee: each an object of exactly basis_points (an integer 0..10000),
--   fixed_minor (an integer 0..10^12), minimum_minor and maximum_minor (an integer 0..10^12 or JSON null; minimum not
--   above maximum).
-- The bounds are wide sanity bounds, not values. Nothing here supplies a value, a currency or an economic rule
-- (PS section 22.1: the fee components are policy-driven; no hard-coded California economics).
--
-- The quote engine (internal, derived): pricing_quote(attorney, jurisdiction, modality, duration, as_of) answers, in
-- this order: invalid (a malformed call); policy_unavailable (no complete Fee Policy); price_unavailable (the seam
-- has no single offer for the modality and duration, or its price is not a positive integer of at most 10^12 minor
-- units, its currency not a currency code or its reference not an object); modality_not_permitted;
-- duration_not_permitted; price_not_permitted (the offer's currency differs from the policy currency, or the price is
-- outside the policy bounds); or priced, with every amount, the currency, the quote validity, the Fee Policy version
-- and the calculation snapshot. Each fee component is clamp(round(price x basis_points / 10000) + fixed_minor,
-- minimum_minor, maximum_minor) with the policy's rounding; the client total is the listed price plus the client fee
-- plus the other required fee; the platform fee is the attorney-side component and is not part of the client total.
-- The snapshot records the inputs (attorney, jurisdiction, modality, duration, instant, the listed price and its
-- source, the Fee Policy version and its parameters, caps and floors included), every component with its pricing
-- source, the formula and the quote validity period (DM section 10). Never a zero price, never a fallback, never a
-- recomputation of a recorded Fee Calculation.
--
-- The client's review reads (EXECUTE for authenticated only; stable security definer; nothing persisted): for one
-- of the caller's own Referrals (an active User's own Client Profile's Intake; another client's Referral and an
-- unknown one answer alike, no row or not_found):
-- - client_request_review: the attorney's presentable display name, the path the Referral's bookable evaluation
--   recorded, the Request already made from it if any, and whether a Request can be made now (no Request, no
--   recorded outcome, the Intake submitted or active and not past its expiry);
-- - request_options: the modality and duration pairs the attorney offers that the quote engine prices now (offered,
--   permitted by the Fee Policy and validly priced); none with the shipped seam;
-- - request_slot_starts: for a scheduled Referral and a priced option, up to 20 slot starts derived from the
--   attorney's offered windows in the 14-day discovery horizon (scheduling_offered_windows, 20261121020000): starts
--   on the half-hour UTC grid at which the whole duration fits inside one offered window, earliest first. The grid
--   and the bound are a fixed display granularity, not policy values; Request creation checks the slot afresh;
-- - request_quote_preview: the derived quote for the chosen path, modality, duration and (scheduled) slot start, or
--   its refusal: priced, invalid, not_found, already_requested, not_available, policy_unavailable,
--   price_unavailable, modality_not_permitted, duration_not_permitted or price_not_permitted. The client sees the
--   listed price, the client fee, the other required fee, the total, the currency and the quote validity; never
--   the attorney-side platform fee, the policy or the snapshot.

-- ---------------------------------------------------------------------------
-- The attorney price-source seam (internal; executable by no API role).
-- ---------------------------------------------------------------------------

-- No attorney price source is adopted until PS-A3; a missing price makes the attorney not bookable (MB section
-- 152). A later forward migration replaces this body.
create function public.pricing_attorney_offers(p_attorney uuid)
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
  select null::text, null::integer, null::bigint, null::text, null::jsonb
  where p_attorney is null and false;
$function$;

-- No attorney price source is adopted until PS-A3; a missing price makes the attorney not bookable (MB section
-- 152). A later forward migration replaces this body.
create function public.pricing_attorney_offer(
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
  select null::text, null::integer, null::bigint, null::text, null::jsonb
  where p_attorney is null and p_modality is null and p_duration_minutes is null and false;
$function$;

-- ---------------------------------------------------------------------------
-- The Fee Policy (internal).
-- ---------------------------------------------------------------------------

-- Whether a JSON value is an integer within [p_minimum, p_maximum].
create function public.pricing_integer_within(p_value jsonb, p_minimum numeric, p_maximum numeric)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'number'
    and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
    and (p_value #>> '{}')::numeric between p_minimum and p_maximum,
    false);
$function$;

-- Whether a JSON value is null or an integer within [p_minimum, p_maximum].
create function public.pricing_optional_integer_within(p_value jsonb, p_minimum numeric, p_maximum numeric)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'null' or public.pricing_integer_within(p_value, p_minimum, p_maximum),
    false);
$function$;

-- Whether one fee component is exactly { basis_points, fixed_minor, minimum_minor, maximum_minor } within bounds,
-- minimum not above maximum.
create function public.pricing_component_valid(p_component jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_component) = 'object'
    and (select count(*) from jsonb_object_keys(p_component)) = 4
    and p_component ?& array['basis_points', 'fixed_minor', 'minimum_minor', 'maximum_minor']
    and public.pricing_integer_within(p_component -> 'basis_points', 0, 10000)
    and public.pricing_integer_within(p_component -> 'fixed_minor', 0, 1000000000000)
    and public.pricing_optional_integer_within(p_component -> 'minimum_minor', 0, 1000000000000)
    and public.pricing_optional_integer_within(p_component -> 'maximum_minor', 0, 1000000000000)
    and (
      jsonb_typeof(p_component -> 'minimum_minor') = 'null'
      or jsonb_typeof(p_component -> 'maximum_minor') = 'null'
      or (p_component ->> 'minimum_minor')::numeric <= (p_component ->> 'maximum_minor')::numeric
    ),
    false);
$function$;

-- Whether Fee Policy parameters are complete and well formed (exactly the ten keys, each as the header describes).
create function public.pricing_fee_parameters_valid(p_parameters jsonb)
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
  if jsonb_typeof(p_parameters) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_parameters)) <> 10
     or not (p_parameters ?& array[
       'currency_code', 'quote_validity_seconds', 'permitted_durations_minutes', 'permitted_modalities',
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
  v_durations := p_parameters -> 'permitted_durations_minutes';
  if jsonb_typeof(v_durations) is distinct from 'array'
     or jsonb_array_length(v_durations) not between 1 and 48
     or exists (
       select 1 from jsonb_array_elements(v_durations) as d
       where not public.pricing_integer_within(d, 1, 1440)
     )
     or (select count(distinct (d #>> '{}')::numeric) from jsonb_array_elements(v_durations) as d)
        <> jsonb_array_length(v_durations) then
    return false;
  end if;
  v_modalities := p_parameters -> 'permitted_modalities';
  if jsonb_typeof(v_modalities) is distinct from 'array'
     or jsonb_array_length(v_modalities) not between 1 and 32
     or exists (
       select 1 from jsonb_array_elements(v_modalities) as m
       where jsonb_typeof(m) <> 'string' or (m #>> '{}') !~ '^[a-z][a-z0-9_]{1,31}$'
     )
     or (select count(distinct m #>> '{}') from jsonb_array_elements(v_modalities) as m)
        <> jsonb_array_length(v_modalities) then
    return false;
  end if;
  if not public.pricing_optional_integer_within(p_parameters -> 'listed_price_minimum_minor', 1, 1000000000000)
     or not public.pricing_optional_integer_within(p_parameters -> 'listed_price_maximum_minor', 1, 1000000000000)
     or (
       jsonb_typeof(p_parameters -> 'listed_price_minimum_minor') = 'number'
       and jsonb_typeof(p_parameters -> 'listed_price_maximum_minor') = 'number'
       and (p_parameters ->> 'listed_price_minimum_minor')::numeric
           > (p_parameters ->> 'listed_price_maximum_minor')::numeric
     ) then
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

-- The selected Fee Policy for a jurisdiction at an instant: ('selected', version, parameters), the resolver's own
-- refusal (environment_unrecorded, environment_mismatch, no_applicable_policy, policy_conflict, invalid), or
-- ('policy_incomplete', version, null).
create function public.pricing_fee_policy(p_jurisdiction uuid, p_as_of timestamptz)
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
  if p_jurisdiction is null or p_as_of is null then
    return query select 'invalid'::text, null::uuid, null::jsonb;
    return;
  end if;
  select s.outcome, s.policy_version_id
  into v_outcome, v_id
  from public.policy_select_version('fee', p_jurisdiction, null, p_as_of) as s;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select coalesce(v_outcome, 'no_applicable_policy'), null::uuid, null::jsonb;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  if not public.pricing_fee_parameters_valid(v_raw) then
    return query select 'policy_incomplete'::text, v_id, null::jsonb;
    return;
  end if;
  return query select 'selected'::text, v_id, v_raw;
end;
$function$;

-- One fee component in minor units: clamp(round(price x basis_points / 10000) + fixed_minor, minimum, maximum),
-- rounding half_up (half away from zero; amounts are never negative), half_even, down or up.
create function public.pricing_component_minor(p_price bigint, p_component jsonb, p_rounding text)
returns bigint
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_raw numeric := p_price::numeric * (p_component ->> 'basis_points')::numeric / 10000;
  v_rounded numeric;
  v_amount numeric;
begin
  v_rounded := case p_rounding
    when 'half_up' then round(v_raw)
    when 'down' then floor(v_raw)
    when 'up' then ceil(v_raw)
    when 'half_even' then
      case
        when v_raw - floor(v_raw) = 0.5 then
          case when mod(floor(v_raw), 2) = 0 then floor(v_raw) else floor(v_raw) + 1 end
        else round(v_raw)
      end
  end;
  if v_rounded is null then
    raise exception 'unknown rounding' using errcode = '22023';
  end if;
  v_amount := v_rounded + (p_component ->> 'fixed_minor')::numeric;
  if jsonb_typeof(p_component -> 'minimum_minor') = 'number' then
    v_amount := greatest(v_amount, (p_component ->> 'minimum_minor')::numeric);
  end if;
  if jsonb_typeof(p_component -> 'maximum_minor') = 'number' then
    v_amount := least(v_amount, (p_component ->> 'maximum_minor')::numeric);
  end if;
  return v_amount::bigint;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The derived quote engine (internal; persists nothing).
-- ---------------------------------------------------------------------------

create function public.pricing_quote(
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
  v_offers integer;
  v_offer record;
  v_currency text;
  v_rounding text;
  v_price bigint;
  v_platform bigint;
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
  if v_selection is distinct from 'selected' then
    return query select 'policy_unavailable'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  select count(*)::integer into v_offers
  from (
    select 1 from public.pricing_attorney_offer(p_attorney, p_modality, p_duration_minutes) limit 2
  ) as o;
  if v_offers <> 1 then
    return query select 'price_unavailable'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code, o.offer_reference
  into v_offer
  from public.pricing_attorney_offer(p_attorney, p_modality, p_duration_minutes) as o;
  if v_offer.modality is distinct from p_modality
     or v_offer.duration_minutes is distinct from p_duration_minutes
     or v_offer.listed_price_minor is null
     or v_offer.listed_price_minor <= 0
     or v_offer.listed_price_minor > 1000000000000
     or v_offer.currency_code is null
     or v_offer.currency_code !~ '^[A-Z]{3}$'
     or (v_offer.offer_reference is not null and jsonb_typeof(v_offer.offer_reference) <> 'object') then
    return query select 'price_unavailable'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  if not ((v_parameters -> 'permitted_modalities') ? p_modality) then
    return query select 'modality_not_permitted'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  if not ((v_parameters -> 'permitted_durations_minutes') @> to_jsonb(p_duration_minutes)) then
    return query select 'duration_not_permitted'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  v_currency := v_parameters ->> 'currency_code';
  v_price := v_offer.listed_price_minor;
  if v_offer.currency_code is distinct from v_currency
     or (jsonb_typeof(v_parameters -> 'listed_price_minimum_minor') = 'number'
         and v_price < (v_parameters ->> 'listed_price_minimum_minor')::numeric)
     or (jsonb_typeof(v_parameters -> 'listed_price_maximum_minor') = 'number'
         and v_price > (v_parameters ->> 'listed_price_maximum_minor')::numeric) then
    return query select 'price_not_permitted'::text, null::uuid, null::bigint, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::integer, null::jsonb;
    return;
  end if;
  v_rounding := v_parameters ->> 'rounding';
  v_platform := public.pricing_component_minor(v_price, v_parameters -> 'platform_fee', v_rounding);
  v_client := public.pricing_component_minor(v_price, v_parameters -> 'client_fee', v_rounding);
  v_other := public.pricing_component_minor(v_price, v_parameters -> 'other_required_fee', v_rounding);
  v_validity := (v_parameters ->> 'quote_validity_seconds')::integer;
  v_snapshot := jsonb_build_object(
    'schema', 'rosuno.fee_calculation_snapshot.v1',
    'inputs', jsonb_build_object(
      'attorney_id', p_attorney,
      'jurisdiction_id', p_jurisdiction,
      'modality', p_modality,
      'duration_minutes', p_duration_minutes,
      'as_of', p_as_of,
      'attorney_listed_price_minor', v_price,
      'attorney_price_currency_code', v_offer.currency_code,
      'fee_policy_version_id', v_policy,
      'fee_policy_parameters', v_parameters
    ),
    'components', jsonb_build_object(
      'attorney_listed_price', jsonb_build_object(
        'amount_minor', v_price,
        'pricing_source', 'attorney_offer',
        'offer_reference', v_offer.offer_reference
      ),
      'platform_fee', jsonb_build_object(
        'amount_minor', v_platform,
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
    v_platform,
    v_client,
    v_other,
    v_price + v_client + v_other,
    v_currency,
    v_validity,
    v_snapshot;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The caller's own Referral (internal).
-- ---------------------------------------------------------------------------

-- The path the Referral's bookable evaluation recorded (scheduled through its availability basis, instant through
-- its observed presence), or null.
create function public.request_referral_path(p_referral uuid)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when e.availability_basis ->> 'request_path' in ('instant', 'scheduled')
      then e.availability_basis ->> 'request_path'
    when e.availability_basis ? 'request_path' then null
    when e.presence_observed is not null then 'instant'
  end
  from public.referrals as r
  join public.bookability_evaluations as e
    on e.context_type = 'referral'
   and e.context_id = r.id
   and e.attorney_id = r.attorney_id
   and e.result = 'bookable'
  where r.id = p_referral
  order by e.evaluated_at, e.id
  limit 1;
$function$;

-- One of the caller's own Referrals (the active User's Client Profile's Intake) with what a Request needs, or no
-- row: its attorney and jurisdiction, the recorded path, the practice area the client filtered by when it was
-- presented, the Request already made from it, whether an outcome is recorded, and its Intake's state and expiry.
create function public.request_client_referral(p_referral uuid)
returns table (
  referral_id uuid,
  intake_id uuid,
  client_id uuid,
  user_id uuid,
  attorney_id uuid,
  jurisdiction_id uuid,
  request_path text,
  practice_area_id uuid,
  request_id uuid,
  outcome_recorded boolean,
  intake_state text,
  requestable boolean
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    r.id,
    i.id,
    c.id,
    u.id,
    r.attorney_id,
    r.jurisdiction_id,
    public.request_referral_path(r.id),
    (
      select case
        when p.client_filter_context ->> 'practice_area_id'
             ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (p.client_filter_context ->> 'practice_area_id')::uuid
      end
      from public.referral_presentations as p
      where p.referral_id = r.id
        and p.attorney_id = r.attorney_id
      limit 1
    ),
    q.id,
    r.outcome_code is not null,
    i.state,
    q.id is null
      and r.outcome_code is null
      and r.attorney_id is not null
      and i.state in ('submitted', 'active')
      and (i.expires_at is null or i.expires_at > clock_timestamp())
      and public.request_referral_path(r.id) is not null
  from public.users as u
  join public.client_profiles as c on c.user_id = u.id
  join public.intakes as i on i.client_id = c.id
  join public.referrals as r on r.intake_id = i.id and r.id = p_referral
  left join public.consultation_requests as q on q.referral_id = r.id
  where p_referral is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

-- ---------------------------------------------------------------------------
-- The client's review reads (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.client_request_review(p_referral_id uuid)
returns table (
  referral_id uuid,
  attorney_display_name text,
  request_path text,
  request_id uuid,
  requestable boolean
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
    f.requestable
  from public.request_client_referral(p_referral_id) as f
  left join public.attorney_profiles as p on p.id = f.attorney_id;
$function$;

create function public.request_options(p_referral_id uuid)
returns table (modality text, duration_minutes integer)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select distinct o.modality, o.duration_minutes
  from public.request_client_referral(p_referral_id) as f
  cross join lateral (
    select x.modality, x.duration_minutes
    from public.pricing_attorney_offers(f.attorney_id) as x
    limit 200
  ) as o
  where f.requestable
    and o.modality ~ '^[a-z][a-z0-9_]{1,31}$'
    and o.duration_minutes between 1 and 1440
    and (
      select q.outcome
      from public.pricing_quote(f.attorney_id, f.jurisdiction_id, o.modality, o.duration_minutes, clock_timestamp())
        as q
    ) = 'priced'
  order by o.modality, o.duration_minutes
  limit 50;
$function$;

create function public.request_slot_starts(
  p_referral_id uuid,
  p_modality text,
  p_duration_minutes integer
)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_referral record;
  v_length interval;
begin
  if p_referral_id is null
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440 then
    return;
  end if;
  select f.* into v_referral from public.request_client_referral(p_referral_id) as f;
  if not found or not v_referral.requestable or v_referral.request_path is distinct from 'scheduled' then
    return;
  end if;
  if (
    select q.outcome
    from public.pricing_quote(
      v_referral.attorney_id, v_referral.jurisdiction_id, p_modality, p_duration_minutes, clock_timestamp()
    ) as q
  ) is distinct from 'priced' then
    return;
  end if;
  v_length := make_interval(mins => p_duration_minutes);
  return query
  select s.start_at, s.start_at + v_length
  from (
    select g as start_at
    from public.scheduling_offered_windows(v_referral.attorney_id, v_referral.jurisdiction_id, 20) as w
    cross join lateral generate_series(
      to_timestamp((ceil(extract(epoch from w.window_start) / 1800) * 1800)::double precision),
      w.window_end - v_length,
      interval '30 minutes'
    ) as g
  ) as s
  order by s.start_at
  limit 20;
end;
$function$;

create function public.request_quote_preview(
  p_referral_id uuid,
  p_path text,
  p_modality text,
  p_duration_minutes integer,
  p_slot_start timestamptz
)
returns table (
  outcome text,
  attorney_listed_price_minor bigint,
  client_fee_minor bigint,
  tax_or_other_required_fee_minor bigint,
  total_client_amount_minor bigint,
  currency_code text,
  quote_validity_seconds integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_referral record;
  v_quote record;
begin
  if p_referral_id is null
     or p_path is null
     or p_path not in ('instant', 'scheduled')
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440
     or (p_path = 'scheduled' and p_slot_start is null)
     or (p_path = 'instant' and p_slot_start is not null) then
    return query select 'invalid'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::text,
      null::integer;
    return;
  end if;
  select f.* into v_referral from public.request_client_referral(p_referral_id) as f;
  if not found then
    return query select 'not_found'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::text,
      null::integer;
    return;
  end if;
  if v_referral.request_id is not null then
    return query select 'already_requested'::text, null::bigint, null::bigint, null::bigint, null::bigint,
      null::text, null::integer;
    return;
  end if;
  if v_referral.request_path is distinct from p_path then
    return query select 'invalid'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::text,
      null::integer;
    return;
  end if;
  if not v_referral.requestable then
    return query select 'not_available'::text, null::bigint, null::bigint, null::bigint, null::bigint,
      null::text, null::integer;
    return;
  end if;
  select q.* into v_quote
  from public.pricing_quote(
    v_referral.attorney_id, v_referral.jurisdiction_id, p_modality, p_duration_minutes, clock_timestamp()
  ) as q;
  if v_quote.outcome is distinct from 'priced' then
    return query select v_quote.outcome, null::bigint, null::bigint, null::bigint, null::bigint, null::text,
      null::integer;
    return;
  end if;
  return query select
    'priced'::text,
    v_quote.attorney_listed_price_minor,
    v_quote.client_fee_minor,
    v_quote.tax_or_other_required_fee_minor,
    v_quote.total_client_amount_minor,
    v_quote.currency_code,
    v_quote.quote_validity_seconds;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.pricing_attorney_offers(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_attorney_offer(uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_integer_within(jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_optional_integer_within(jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_component_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_fee_parameters_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_fee_policy(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_component_minor(bigint, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.pricing_quote(uuid, uuid, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.request_referral_path(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_client_referral(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.client_request_review(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request_review(uuid) to authenticated;
revoke all on function public.request_options(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_options(uuid) to authenticated;
revoke all on function public.request_slot_starts(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.request_slot_starts(uuid, text, integer) to authenticated;
revoke all on function public.request_quote_preview(uuid, text, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.request_quote_preview(uuid, text, text, integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.pricing_attorney_offers(uuid) is
  'MVP-001 S6 (internal; price-source seam): the attorney''s offers (modality, duration, listed price, currency, reference). No attorney price source is adopted until PS-A3, so it answers no row: a missing price makes the attorney not bookable (MB section 152). Replaced by a later forward migration.';
comment on function public.pricing_attorney_offer(uuid, text, integer) is
  'MVP-001 S6 (internal; price-source seam): the attorney''s one offer for a modality and duration. No attorney price source is adopted until PS-A3, so it answers no row: a missing price makes the attorney not bookable (MB section 152). Replaced by a later forward migration.';
comment on function public.pricing_integer_within(jsonb, numeric, numeric) is
  'MVP-001 S6 (internal): whether a JSON value is an integer within the bounds.';
comment on function public.pricing_optional_integer_within(jsonb, numeric, numeric) is
  'MVP-001 S6 (internal): whether a JSON value is null or an integer within the bounds.';
comment on function public.pricing_component_valid(jsonb) is
  'MVP-001 S6 (internal): whether a Fee Policy component is exactly basis_points, fixed_minor, minimum_minor and maximum_minor within their sanity bounds.';
comment on function public.pricing_fee_parameters_valid(jsonb) is
  'MVP-001 S6 (internal): whether Fee Policy parameters are complete and well formed (exactly the ten required keys; no default).';
comment on function public.pricing_fee_policy(uuid, timestamptz) is
  'MVP-001 S6 (internal): the selected Fee Policy (environment-anchored resolver, fee type, exact jurisdiction, no regulatory mode) with its validated parameters, the resolver''s refusal, or policy_incomplete.';
comment on function public.pricing_component_minor(bigint, jsonb, text) is
  'MVP-001 S6 (internal): one fee component: clamp(round(price x basis_points / 10000) + fixed_minor, minimum, maximum) with the policy rounding.';
comment on function public.pricing_quote(uuid, uuid, text, integer, timestamptz) is
  'MVP-001 S6 (internal; derived, persists nothing): the quote for an attorney, jurisdiction, modality and duration from the attorney''s offer and the Fee Policy, with the calculation snapshot; or invalid, policy_unavailable, price_unavailable, modality_not_permitted, duration_not_permitted or price_not_permitted. Never a zero or fallback price.';
comment on function public.request_referral_path(uuid) is
  'MVP-001 S6 (internal): the request path the Referral''s bookable evaluation recorded, or null.';
comment on function public.request_client_referral(uuid) is
  'MVP-001 S6 (internal): one of the caller''s own Referrals with its attorney, jurisdiction, path, filtered practice area, Request, outcome, Intake state and whether a Request can be made now; no row otherwise.';
comment on function public.client_request_review(uuid) is
  'MVP-001 S6: the caller''s own Referral for the request review page: the attorney''s presentable display name, the recorded path, the Request already made from it, and whether a Request can be made now.';
comment on function public.request_options(uuid) is
  'MVP-001 S6: the modality and duration pairs of the caller''s own Referral''s attorney that the quote engine prices now (offered, permitted and validly priced). None while no price source is adopted.';
comment on function public.request_slot_starts(uuid, text, integer) is
  'MVP-001 S6: up to 20 half-hour UTC grid slot starts in which the whole duration fits one of the attorney''s offered windows (14-day horizon), for the caller''s own scheduled Referral and a priced option.';
comment on function public.request_quote_preview(uuid, text, text, integer, timestamptz) is
  'MVP-001 S6: the derived quote (listed price, client fee, other required fee, total, currency, quote validity) for the caller''s own Referral, or its refusal. Persists nothing.';
