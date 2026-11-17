-- MVP-001 S1 (2 of 4): conformance corrections of the P3-904 professional write boundary.
--
-- SCH-1 (PS section 2.2: primary keys are generated server-side; no client-provided primary keys). The create
-- paths of six write functions now require a NULL identifier argument and generate the key with
-- gen_random_uuid(); revisions of existing rows still name the row. Signatures, outcomes, locks, audit and
-- every other rule are unchanged; CREATE OR REPLACE keeps each function's owner and privileges.
-- SCH-4 (PS section 8.3): the eligibility policy-type code is 'eligibility' (it was 'attorney_eligibility').
-- No policy-type or policy-version row existed, so no data changes.
-- PS-A2 section 5 (PHYSICAL-SPECIFICATION-AMENDMENT-PS-A2-LOCKED, sha256
-- 599c2235f540233c7475dd28799bfb2bb201c09cf88e53d2461b35099a42a1ba): eligibility selection refuses in an
-- unrecorded or mismatched environment and admits development configuration only in a development or staging
-- database. The parameter schema identifier rosuno.attorney_eligibility.v1 is unchanged.
-- Every function body is migration 20261106090000's text with only these edits.

create or replace function public.eligibility_selected_policy(
  p_jurisdiction_id uuid,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_as_of bigint := public.eligibility_epoch_ms(p_as_of);
  v_version public.policy_versions;
  v_applicable integer;
  v_p jsonb;
  v_license jsonb;
  v_insurance jsonb;
  v_discipline jsonb;
  v_practice jsonb;
  v_qualifying text[];
  v_license_age numeric;
  v_insurance_age numeric;
  v_per numeric;
  v_aggregate numeric;
  v_currency text;
  v_disqualifying text[];
  v_cleared text[];
  v_environment text;
  v_dev_ok boolean;
begin
  -- PS-A2 section 5: nothing is selectable in an unrecorded or mismatched environment;
  -- development configuration only in a development or staging database.
  v_environment := public.rosuno_environment_status();
  if v_environment <> 'ok' then
    return jsonb_build_object('status', 'undetermined', 'reason', v_environment);
  end if;
  v_dev_ok := public.rosuno_environment_class() in ('development', 'staging');
  -- The application reads at most 50 versions and 500 authority references.
  if (select count(*) from public.policy_versions as v
      where v.policy_type_code = 'eligibility'
        and v.jurisdiction_id = p_jurisdiction_id) > 50
     or (select count(*)
         from public.policy_authority_references as r
         join public.policy_versions as v on v.id = r.policy_version_id
         where v.policy_type_code = 'eligibility'
           and v.jurisdiction_id = p_jurisdiction_id) > 500 then
    return jsonb_build_object('status', 'unverifiable');
  end if;
  -- In force: active, approved by a recorded actor, inside its period; or, in a development or staging
  -- database, development configuration inside its period (PS-A2 section 5).
  if exists (
    select 1 from public.policy_versions as v
    where v.policy_type_code = 'eligibility'
      and v.jurisdiction_id = p_jurisdiction_id
      and ((not v.development_only and v.status = 'active'
            and v.approved_at is not null
            and v.approved_by_user_id is not null)
           or (v.development_only and v.status = 'draft' and v_dev_ok))
      and v.effective_from is not null
      and public.eligibility_epoch_ms(v.effective_from) <= v_as_of
      and (v.effective_until is null
           or public.eligibility_epoch_ms(v.effective_until) > v_as_of)
      and v.regulatory_mode_id is not null
  ) then
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'regulatory_mode_undetermined');
  end if;
  select count(*) into v_applicable
  from public.policy_versions as v
  where v.policy_type_code = 'eligibility'
    and v.jurisdiction_id = p_jurisdiction_id
    and ((not v.development_only and v.status = 'active'
          and v.approved_at is not null
          and v.approved_by_user_id is not null)
         or (v.development_only and v.status = 'draft' and v_dev_ok))
    and v.effective_from is not null
    and public.eligibility_epoch_ms(v.effective_from) <= v_as_of
    and (v.effective_until is null
         or public.eligibility_epoch_ms(v.effective_until) > v_as_of);
  if v_applicable = 0 then
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'no_applicable_policy');
  end if;
  if v_applicable > 1 then
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'conflicting_policies');
  end if;
  select v.* into v_version
  from public.policy_versions as v
  where v.policy_type_code = 'eligibility'
    and v.jurisdiction_id = p_jurisdiction_id
    and ((not v.development_only and v.status = 'active'
          and v.approved_at is not null
          and v.approved_by_user_id is not null)
         or (v.development_only and v.status = 'draft' and v_dev_ok))
    and v.effective_from is not null
    and public.eligibility_epoch_ms(v.effective_from) <= v_as_of
    and (v.effective_until is null
         or public.eligibility_epoch_ms(v.effective_until) > v_as_of);
  if not v_version.development_only and not exists (
    select 1 from public.policy_authority_references as r
    where r.policy_version_id = v_version.id
      and r.verification_status = 'verified'
      and r.verified_by_user_id is not null
  ) then
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'authority_unverified');
  end if;
  -- readParameters: every key required, null only where the schema allows.
  v_p := v_version.parameters;
  if not public.eligibility_exact_object(
       v_p, array['schema', 'license', 'insurance', 'discipline', 'practice_area'])
     or jsonb_typeof(v_p -> 'schema') <> 'string'
     or (v_p ->> 'schema') <> 'rosuno.attorney_eligibility.v1' then
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'policy_parameters_unreadable');
  end if;
  v_license := v_p -> 'license';
  v_insurance := v_p -> 'insurance';
  v_discipline := v_p -> 'discipline';
  v_practice := v_p -> 'practice_area';
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
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'policy_parameters_unreadable');
  end if;
  v_qualifying := public.eligibility_status_list(v_license -> 'qualifying_reported_statuses');
  v_license_age := public.eligibility_safe_integer(v_license -> 'evidence_max_age_days', 1);
  v_disqualifying := public.eligibility_status_list(v_discipline -> 'disqualifying_statuses');
  v_cleared := public.eligibility_status_list(v_discipline -> 'cleared_statuses');
  if jsonb_typeof(v_insurance -> 'evidence_max_age_days') <> 'null' then
    v_insurance_age := public.eligibility_safe_integer(v_insurance -> 'evidence_max_age_days', 1);
    if v_insurance_age is null then
      return jsonb_build_object('status', 'undetermined',
                                'reason', 'policy_parameters_unreadable');
    end if;
  end if;
  if jsonb_typeof(v_insurance -> 'minimum_per_occurrence_minor') <> 'null' then
    v_per := public.eligibility_safe_integer(v_insurance -> 'minimum_per_occurrence_minor', 0);
    if v_per is null then
      return jsonb_build_object('status', 'undetermined',
                                'reason', 'policy_parameters_unreadable');
    end if;
  end if;
  if jsonb_typeof(v_insurance -> 'minimum_aggregate_minor') <> 'null' then
    v_aggregate := public.eligibility_safe_integer(v_insurance -> 'minimum_aggregate_minor', 0);
    if v_aggregate is null then
      return jsonb_build_object('status', 'undetermined',
                                'reason', 'policy_parameters_unreadable');
    end if;
  end if;
  if jsonb_typeof(v_insurance -> 'currency_code') <> 'null' then
    if jsonb_typeof(v_insurance -> 'currency_code') <> 'string'
       or not ((v_insurance ->> 'currency_code') collate "C" ~ '^[A-Z]{3}$') then
      return jsonb_build_object('status', 'undetermined',
                                'reason', 'policy_parameters_unreadable');
    end if;
    v_currency := v_insurance ->> 'currency_code';
  end if;
  if v_qualifying is null
     or cardinality(v_qualifying) = 0
     or v_license_age is null
     or jsonb_typeof(v_insurance -> 'required') <> 'boolean'
     or v_disqualifying is null
     or v_cleared is null
     or v_disqualifying && v_cleared
     or jsonb_typeof(v_practice -> 'authorisation_required') <> 'boolean'
     or ((v_per is not null or v_aggregate is not null) and v_currency is null) then
    return jsonb_build_object('status', 'undetermined',
                              'reason', 'policy_parameters_unreadable');
  end if;
  return jsonb_build_object(
    'status', 'selected',
    'policy_version_id', v_version.id,
    'version_label', v_version.version_label,
    'qualifying', to_jsonb(v_qualifying),
    'license_age', v_license_age,
    'insurance_required', (v_insurance -> 'required')::boolean,
    'insurance_age', v_insurance_age,
    'minimum_per_occurrence', v_per,
    'minimum_aggregate', v_aggregate,
    'currency', v_currency,
    'disqualifying', to_jsonb(v_disqualifying),
    'cleared', to_jsonb(v_cleared),
    'authorisation_required', (v_practice -> 'authorisation_required')::boolean
  );
end;
$function$;

create or replace function public.eligibility_assessment(
  p_attorney_id uuid,
  p_jurisdiction_id uuid,
  p_practice_area_id uuid,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_as_of bigint := public.eligibility_epoch_ms(p_as_of);
  v_today date := (p_as_of at time zone 'UTC')::date;
  v_day constant bigint := 86400000;
  v_user uuid;
  v_profile_state text;
  v_account text;
  v_policy jsonb;
  v_factors jsonb;
  v_records jsonb;
  v_relied text[] := array[]::text[];
  v_outcome text;
  v_reason text;
  v_standing text;
  v_evidence record;
  v_row record;
  v_none jsonb := '[]'::jsonb;
  v_unreadable jsonb;
  v_qualifying text[];
  v_disqualifying text[];
  v_cleared text[];
  v_license_age numeric;
  v_insurance_age numeric;
  v_per numeric;
  v_aggregate numeric;
  v_currency text;
  v_result text;
begin
  v_unreadable := jsonb_build_object(
    'verifiable', true,
    'result', 'undetermined',
    'factor_results', jsonb_build_array(jsonb_build_object(
      'factor', 'account', 'outcome', 'undetermined',
      'reason', 'facts_unreadable', 'records', v_none)),
    'policy_references', v_none,
    'evidence_references', jsonb_build_object(
      'evidence_ids', v_none, 'license_ids', v_none,
      'insurance_record_ids', v_none, 'discipline_record_ids', v_none,
      'practice_area_authorisation_ids', v_none)
  );

  -- The application's bounded reads: 500 rows per record list, per subject
  -- kind and for the evidence set.
  if (select count(*) from public.licenses as l
      where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.insurance_records as i
         where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.discipline_records as d
         where d.attorney_id = p_attorney_id and d.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.practice_area_authorisations as a
         where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.verification_evidence_subjects as s
         join public.licenses as l on l.id = s.license_id
         where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.verification_evidence_subjects as s
         join public.insurance_records as i on i.id = s.insurance_record_id
         where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.verification_evidence_subjects as s
         join public.discipline_records as d on d.id = s.discipline_record_id
         where d.attorney_id = p_attorney_id and d.jurisdiction_id = p_jurisdiction_id) > 500
     or (select count(*) from public.verification_evidence_subjects as s
         join public.practice_area_authorisations as a on a.id = s.practice_area_authorisation_id
         where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id) > 500 then
    return jsonb_build_object('verifiable', false);
  end if;
  -- More than 500 linked evidence ids is a refused read in the application,
  -- so its facts are unreadable.
  if (select count(distinct s.verification_evidence_id)
      from public.verification_evidence_subjects as s
      left join public.licenses as l on l.id = s.license_id
      left join public.insurance_records as i on i.id = s.insurance_record_id
      left join public.discipline_records as d on d.id = s.discipline_record_id
      left join public.practice_area_authorisations as a on a.id = s.practice_area_authorisation_id
      where coalesce(l.attorney_id, i.attorney_id, d.attorney_id, a.attorney_id) = p_attorney_id
        and coalesce(l.jurisdiction_id, i.jurisdiction_id, d.jurisdiction_id, a.jurisdiction_id)
            = p_jurisdiction_id) > 500 then
    return v_unreadable;
  end if;

  -- The profile and its User, as the trusted reads return them.
  select p.user_id, p.profile_state into v_user, v_profile_state
  from public.attorney_profiles as p
  where p.id = p_attorney_id;
  if not found then
    return jsonb_build_object('verifiable', false);
  end if;
  select u.account_state into v_account
  from public.users as u
  where u.id = v_user;

  -- The strict readers: one row the application cannot read makes the facts
  -- unreadable.
  if exists (
       select 1 from public.licenses as l
       where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id
         and (coalesce(public.eligibility_js_blank(l.license_number), true)
              or (l.reported_status is not null
                  and public.eligibility_js_blank(l.reported_status))))
     or exists (
       select 1 from public.insurance_records as i
       where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id
         and ((i.currency_code is not null
               and not (i.currency_code collate "C" ~ '^[A-Z]{3}$'))
              or (i.per_occurrence_limit_minor is not null
                  and (i.per_occurrence_limit_minor < 0
                       or i.per_occurrence_limit_minor > 9007199254740991))
              or (i.aggregate_limit_minor is not null
                  and (i.aggregate_limit_minor < 0
                       or i.aggregate_limit_minor > 9007199254740991))))
     or exists (
       select 1 from public.practice_area_authorisations as a
       where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id
         and public.eligibility_js_blank(a.status)) then
    return v_unreadable;
  end if;

  v_policy := public.eligibility_selected_policy(p_jurisdiction_id, p_as_of);
  if v_policy ->> 'status' = 'unverifiable' then
    return jsonb_build_object('verifiable', false);
  end if;

  v_factors := jsonb_build_array(
    case
      when v_account = 'active' then
        jsonb_build_object('factor', 'account', 'outcome', 'pass',
                           'reason', 'account_active', 'records', v_none)
      when v_account in ('pending_verification', 'suspended', 'closed') then
        jsonb_build_object('factor', 'account', 'outcome', 'fail',
                           'reason', 'account_not_active', 'records', v_none)
      else
        jsonb_build_object('factor', 'account', 'outcome', 'undetermined',
                           'reason', 'account_state_unreadable', 'records', v_none)
    end,
    case v_profile_state
      when 'approved' then
        jsonb_build_object('factor', 'profile', 'outcome', 'pass',
                           'reason', 'profile_approved', 'records', v_none)
      when 'suspended' then
        jsonb_build_object('factor', 'profile', 'outcome', 'fail',
                           'reason', 'profile_suspended_or_removed', 'records', v_none)
      when 'removed' then
        jsonb_build_object('factor', 'profile', 'outcome', 'fail',
                           'reason', 'profile_suspended_or_removed', 'records', v_none)
      else
        jsonb_build_object('factor', 'profile', 'outcome', 'fail',
                           'reason', 'profile_not_approved', 'records', v_none)
    end
  );

  if v_policy ->> 'status' <> 'selected' then
    v_factors := v_factors || jsonb_build_array(
      jsonb_build_object('factor', 'policy', 'outcome', 'undetermined',
                         'reason', v_policy ->> 'reason', 'records', v_none),
      jsonb_build_object('factor', 'license', 'outcome', 'undetermined',
                         'reason', 'policy_undetermined', 'records', v_none),
      jsonb_build_object('factor', 'insurance', 'outcome', 'undetermined',
                         'reason', 'policy_undetermined', 'records', v_none),
      jsonb_build_object('factor', 'discipline', 'outcome', 'undetermined',
                         'reason', 'policy_undetermined', 'records', v_none),
      case when p_practice_area_id is null then
        jsonb_build_object('factor', 'practice_area', 'outcome', 'not_applicable',
                           'reason', 'jurisdiction_context', 'records', v_none)
      else
        jsonb_build_object('factor', 'practice_area', 'outcome', 'undetermined',
                           'reason', 'policy_undetermined', 'records', v_none)
      end
    );
  else
    v_qualifying := array(select jsonb_array_elements_text(v_policy -> 'qualifying'));
    v_disqualifying := array(select jsonb_array_elements_text(v_policy -> 'disqualifying'));
    v_cleared := array(select jsonb_array_elements_text(v_policy -> 'cleared'));
    v_license_age := (v_policy ->> 'license_age')::numeric;
    v_insurance_age := (v_policy ->> 'insurance_age')::numeric;
    v_per := (v_policy ->> 'minimum_per_occurrence')::numeric;
    v_aggregate := (v_policy ->> 'minimum_aggregate')::numeric;
    v_currency := v_policy ->> 'currency';
    v_factors := v_factors || jsonb_build_array(jsonb_build_object(
      'factor', 'policy', 'outcome', 'pass', 'reason', 'policy_selected',
      'records', v_none));

    -- License: one passing record suffices.
    v_records := v_none;
    for v_row in
      select l.* from public.licenses as l
      where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id
      order by l.id
    loop
      if v_row.effective_until is not null and v_row.effective_until < v_today then
        v_outcome := 'fail'; v_reason := 'license_expired';
      elsif v_row.effective_from is not null and v_row.effective_from > v_today then
        v_outcome := 'fail'; v_reason := 'license_not_yet_effective';
      else
        select e.id, e.retrieved_at, e.discrepancy_flag into v_evidence
        from public.verification_evidence_subjects as s
        join public.verification_evidence as e on e.id = s.verification_evidence_id
        where s.license_id = v_row.id and e.jurisdiction_id = p_jurisdiction_id
        order by public.eligibility_epoch_ms(e.retrieved_at) desc,
                 public.eligibility_epoch_ms(e.created_at) desc,
                 e.id::text collate "C" desc
        limit 1;
        if not found then
          v_standing := 'no_evidence';
        else
          v_relied := v_relied || v_evidence.id::text;
          if public.eligibility_epoch_ms(v_evidence.retrieved_at) > v_as_of then
            v_standing := 'evidence_after_assessment';
          elsif v_as_of - public.eligibility_epoch_ms(v_evidence.retrieved_at)
                > v_license_age * v_day then
            v_standing := 'evidence_stale';
          elsif v_evidence.discrepancy_flag then
            v_standing := 'evidence_discrepancy_unresolved';
          else
            v_standing := null;
          end if;
        end if;
        if v_standing is not null and v_standing <> 'evidence_discrepancy_unresolved' then
          v_outcome := 'undetermined'; v_reason := v_standing;
        elsif v_row.reported_status is null then
          v_outcome := 'undetermined'; v_reason := 'no_source_observation';
        elsif not (v_row.reported_status collate "C" = any (v_qualifying)) then
          v_outcome := 'fail'; v_reason := 'reported_status_not_qualifying';
        elsif v_standing is not null then
          v_outcome := 'undetermined'; v_reason := v_standing;
        else
          v_outcome := 'pass'; v_reason := 'license_verified';
        end if;
      end if;
      v_records := v_records || jsonb_build_array(jsonb_build_object(
        'id', v_row.id, 'outcome', v_outcome, 'reason', v_reason));
    end loop;
    v_factors := v_factors || jsonb_build_array(
      case
        when jsonb_array_length(v_records) = 0 then
          jsonb_build_object('factor', 'license', 'outcome', 'fail',
                             'reason', 'no_license_in_jurisdiction', 'records', v_none)
        when jsonb_path_exists(v_records, '$[*] ? (@.outcome == "pass")') then
          jsonb_build_object('factor', 'license', 'outcome', 'pass',
                             'reason', 'license_verified', 'records', v_records)
        when jsonb_path_exists(v_records, '$[*] ? (@.outcome == "undetermined")') then
          jsonb_build_object('factor', 'license', 'outcome', 'undetermined',
                             'reason', 'no_record_determined', 'records', v_records)
        else
          jsonb_build_object('factor', 'license', 'outcome', 'fail',
                             'reason', 'no_record_qualifies', 'records', v_records)
      end);

    -- Insurance: only when the selected policy requires it.
    if not (v_policy ->> 'insurance_required')::boolean then
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'factor', 'insurance', 'outcome', 'not_required',
        'reason', 'insurance_not_required', 'records', v_none));
    else
      v_records := v_none;
      for v_row in
        select i.* from public.insurance_records as i
        where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id
        order by i.id
      loop
        v_standing := null;
        if v_row.coverage_from is null or v_row.coverage_until is null then
          v_outcome := 'undetermined'; v_reason := 'coverage_period_missing';
        elsif v_row.coverage_from > v_today or v_row.coverage_until < v_today then
          v_outcome := 'fail'; v_reason := 'coverage_not_current';
        elsif (v_per is not null or v_aggregate is not null)
              and v_row.currency_code is distinct from v_currency then
          v_outcome := 'undetermined'; v_reason := 'currency_mismatch';
        elsif v_per is not null and v_row.per_occurrence_limit_minor is null then
          v_outcome := 'undetermined'; v_reason := 'limit_missing';
        elsif v_per is not null and v_row.per_occurrence_limit_minor < v_per then
          v_outcome := 'fail'; v_reason := 'limit_below_minimum';
        elsif v_aggregate is not null and v_row.aggregate_limit_minor is null then
          v_outcome := 'undetermined'; v_reason := 'limit_missing';
        elsif v_aggregate is not null and v_row.aggregate_limit_minor < v_aggregate then
          v_outcome := 'fail'; v_reason := 'limit_below_minimum';
        else
          select e.id, e.retrieved_at, e.discrepancy_flag into v_evidence
          from public.verification_evidence_subjects as s
          join public.verification_evidence as e on e.id = s.verification_evidence_id
          where s.insurance_record_id = v_row.id and e.jurisdiction_id = p_jurisdiction_id
          order by public.eligibility_epoch_ms(e.retrieved_at) desc,
                   public.eligibility_epoch_ms(e.created_at) desc,
                   e.id::text collate "C" desc
          limit 1;
          if not found then
            v_standing := 'no_evidence';
          else
            v_relied := v_relied || v_evidence.id::text;
            if public.eligibility_epoch_ms(v_evidence.retrieved_at) > v_as_of then
              v_standing := 'evidence_after_assessment';
            elsif v_insurance_age is not null
                  and v_as_of - public.eligibility_epoch_ms(v_evidence.retrieved_at)
                      > v_insurance_age * v_day then
              v_standing := 'evidence_stale';
            elsif v_evidence.discrepancy_flag then
              v_standing := 'evidence_discrepancy_unresolved';
            end if;
          end if;
          if v_standing is not null then
            v_outcome := 'undetermined'; v_reason := v_standing;
          else
            v_outcome := 'pass'; v_reason := 'insurance_verified';
          end if;
        end if;
        v_records := v_records || jsonb_build_array(jsonb_build_object(
          'id', v_row.id, 'outcome', v_outcome, 'reason', v_reason));
      end loop;
      v_factors := v_factors || jsonb_build_array(
        case
          when jsonb_array_length(v_records) = 0 then
            jsonb_build_object('factor', 'insurance', 'outcome', 'fail',
                               'reason', 'no_insurance_in_jurisdiction', 'records', v_none)
          when jsonb_path_exists(v_records, '$[*] ? (@.outcome == "pass")') then
            jsonb_build_object('factor', 'insurance', 'outcome', 'pass',
                               'reason', 'insurance_verified', 'records', v_records)
          when jsonb_path_exists(v_records, '$[*] ? (@.outcome == "undetermined")') then
            jsonb_build_object('factor', 'insurance', 'outcome', 'undetermined',
                               'reason', 'no_record_determined', 'records', v_records)
          else
            jsonb_build_object('factor', 'insurance', 'outcome', 'fail',
                               'reason', 'no_record_qualifies', 'records', v_records)
        end);
    end if;

    -- Discipline: every linked evidence item is relied upon.
    v_records := v_none;
    for v_row in
      select d.* from public.discipline_records as d
      where d.attorney_id = p_attorney_id and d.jurisdiction_id = p_jurisdiction_id
      order by d.id
    loop
      v_relied := v_relied || array(
        select e.id::text
        from public.verification_evidence_subjects as s
        join public.verification_evidence as e on e.id = s.verification_evidence_id
        where s.discipline_record_id = v_row.id and e.jurisdiction_id = p_jurisdiction_id);
      if v_row.status is not null and v_row.status collate "C" = any (v_disqualifying) then
        v_outcome := 'fail'; v_reason := 'disqualifying_record';
      elsif v_row.status is not null and v_row.status collate "C" = any (v_cleared) then
        v_outcome := 'pass'; v_reason := 'record_cleared';
      else
        v_outcome := 'undetermined'; v_reason := 'status_not_classified';
      end if;
      v_records := v_records || jsonb_build_array(jsonb_build_object(
        'id', v_row.id, 'outcome', v_outcome, 'reason', v_reason));
    end loop;
    v_factors := v_factors || jsonb_build_array(
      case
        when jsonb_path_exists(v_records, '$[*] ? (@.outcome == "fail")') then
          jsonb_build_object('factor', 'discipline', 'outcome', 'fail',
                             'reason', 'disqualifying_record', 'records', v_records)
        when jsonb_path_exists(v_records, '$[*] ? (@.outcome == "undetermined")') then
          jsonb_build_object('factor', 'discipline', 'outcome', 'undetermined',
                             'reason', 'status_not_classified', 'records', v_records)
        else
          jsonb_build_object('factor', 'discipline', 'outcome', 'pass',
                             'reason', 'no_disqualifying_record_on_file', 'records', v_records)
      end);

    -- Practice area: only for a practice-area context and only when the
    -- selected policy requires an authorisation.
    if p_practice_area_id is null then
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'factor', 'practice_area', 'outcome', 'not_applicable',
        'reason', 'jurisdiction_context', 'records', v_none));
    elsif not (v_policy ->> 'authorisation_required')::boolean then
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'factor', 'practice_area', 'outcome', 'not_required',
        'reason', 'authorisation_not_required', 'records', v_none));
    else
      select a.* into v_row
      from public.practice_area_authorisations as a
      where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id
        and a.practice_area_id = p_practice_area_id;
      if not found then
        v_factors := v_factors || jsonb_build_array(jsonb_build_object(
          'factor', 'practice_area', 'outcome', 'fail',
          'reason', 'no_authorisation', 'records', v_none));
      else
        if v_row.status = 'authorised' then
          if v_row.effective_from is null
             or public.eligibility_epoch_ms(v_row.effective_from) > v_as_of
             or (v_row.effective_until is not null
                 and public.eligibility_epoch_ms(v_row.effective_until) <= v_as_of) then
            v_outcome := 'fail'; v_reason := 'authorisation_not_current';
          else
            v_outcome := 'pass'; v_reason := 'authorisation_current';
          end if;
        elsif v_row.status = 'requested' then
          v_outcome := 'undetermined'; v_reason := 'authorisation_pending';
        elsif v_row.status = 'refused' then
          v_outcome := 'fail'; v_reason := 'authorisation_refused';
        elsif v_row.status = 'withdrawn' then
          v_outcome := 'fail'; v_reason := 'authorisation_withdrawn';
        else
          v_outcome := 'undetermined'; v_reason := 'status_not_classified';
        end if;
        v_factors := v_factors || jsonb_build_array(jsonb_build_object(
          'factor', 'practice_area', 'outcome', v_outcome, 'reason', v_reason,
          'records', jsonb_build_array(jsonb_build_object(
            'id', v_row.id, 'outcome', v_outcome, 'reason', v_reason))));
      end if;
    end if;
  end if;

  -- combine: any definite failure, then anything undetermined, else eligible.
  if jsonb_path_exists(v_factors, '$[*] ? (@.outcome == "fail")') then
    v_result := 'not_eligible';
  elsif jsonb_path_exists(v_factors, '$[*] ? (@.outcome == "undetermined")') then
    v_result := 'undetermined';
  else
    v_result := 'eligible';
  end if;

  return jsonb_build_object(
    'verifiable', true,
    'result', v_result,
    'factor_results', v_factors,
    'policy_references',
      case when v_policy ->> 'status' = 'selected' then
        jsonb_build_array(jsonb_build_object(
          'policy_version_id', v_policy ->> 'policy_version_id',
          'version_label', v_policy ->> 'version_label',
          'policy_type_code', 'eligibility'))
      else v_none end,
    'evidence_references', jsonb_build_object(
      'evidence_ids', coalesce(
        (select jsonb_agg(x.id order by x.id collate "C")
         from (select distinct r.id from unnest(v_relied) as r(id)) as x), v_none),
      'license_ids', coalesce(
        (select jsonb_agg(l.id::text order by l.id::text collate "C")
         from public.licenses as l
         where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id), v_none),
      'insurance_record_ids', coalesce(
        (select jsonb_agg(i.id::text order by i.id::text collate "C")
         from public.insurance_records as i
         where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id), v_none),
      'discipline_record_ids', coalesce(
        (select jsonb_agg(d.id::text order by d.id::text collate "C")
         from public.discipline_records as d
         where d.attorney_id = p_attorney_id and d.jurisdiction_id = p_jurisdiction_id), v_none),
      'practice_area_authorisation_ids', coalesce(
        (select jsonb_agg(a.id::text order by a.id::text collate "C")
         from public.practice_area_authorisations as a
         where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id), v_none)
    )
  );
end;
$function$;

create or replace function public.staff_record_eligibility_evaluation(
  p_evaluation_id uuid,
  p_attorney_id uuid,
  p_jurisdiction_id uuid,
  p_context_type text,
  p_context_id uuid,
  p_as_of timestamptz,
  p_result text,
  p_factor_results jsonb,
  p_policy_references jsonb,
  p_evidence_references jsonb
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
  v_target_user uuid;
  v_target public.attorney_profiles;
  v_time timestamptz;
  v_derived jsonb;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  -- Shape only: nothing is read before the caller's authority is decided.
  if p_evaluation_id is not null
     or p_attorney_id is null
     or p_jurisdiction_id is null
     or p_as_of is null
     or p_result is null
     or p_result not in ('eligible', 'not_eligible', 'undetermined')
     or p_context_type is null
     or p_context_type not in ('jurisdiction', 'practice_area')
     or (p_context_type = 'jurisdiction' and p_context_id is not null)
     or (p_context_type = 'practice_area' and p_context_id is null)
     or p_factor_results is null
     or jsonb_typeof(p_factor_results) <> 'array'
     or p_policy_references is null
     or jsonb_typeof(p_policy_references) <> 'array'
     or p_evidence_references is null
     or jsonb_typeof(p_evidence_references) <> 'object' then
    return 'invalid';
  end if;
  p_evaluation_id := gen_random_uuid();
  if (select array_agg(k order by k) from jsonb_object_keys(p_evidence_references) as k)
       is distinct from array[
         'discipline_record_ids', 'evidence_ids', 'insurance_record_ids',
         'license_ids', 'practice_area_authorisation_ids'
       ]
     or exists (
       select 1 from jsonb_each(p_evidence_references) as e
       where jsonb_typeof(e.value) <> 'array'
     )
     or exists (
       select 1
       from jsonb_each(p_evidence_references) as e,
            jsonb_array_elements(e.value) as x
       where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ v_uuid
     ) then
    return 'invalid';
  end if;

  -- Authority, decided on locked rows: the caller's User, Staff Profile and
  -- grant for the jurisdiction.
  v_staff := public.lock_current_verification_staff(p_jurisdiction_id);
  if v_staff is null then
    return 'denied';
  end if;
  -- Then the target's User and Attorney Profile, in that order.
  select p.user_id into v_target_user
  from public.attorney_profiles as p
  where p.id = p_attorney_id;
  if not found or v_target_user = v_staff then
    return 'denied';
  end if;
  perform 1 from public.users as u where u.id = v_target_user for share;
  select p.* into v_target
  from public.attorney_profiles as p
  where p.id = p_attorney_id
  for share;
  if not found or v_target.user_id is distinct from v_target_user then
    return 'denied';
  end if;
  v_time := clock_timestamp();
  if p_as_of > v_time + interval '1 minute'
     or p_as_of < v_time - interval '15 minutes' then
    return 'invalid';
  end if;
  if p_context_type = 'practice_area'
     and not exists (
       select 1 from public.practice_areas as a where a.id = p_context_id
     ) then
    return 'invalid';
  end if;
  -- Then the attorney's professional records in the jurisdiction and the
  -- jurisdiction's eligibility policy rows, each set in id order, so the facts
  -- the assessment relies on cannot change before this transaction ends.
  perform 1 from public.licenses as l
  where l.attorney_id = p_attorney_id and l.jurisdiction_id = p_jurisdiction_id
  order by l.id for share;
  perform 1 from public.insurance_records as i
  where i.attorney_id = p_attorney_id and i.jurisdiction_id = p_jurisdiction_id
  order by i.id for share;
  perform 1 from public.discipline_records as d
  where d.attorney_id = p_attorney_id and d.jurisdiction_id = p_jurisdiction_id
  order by d.id for share;
  perform 1 from public.practice_area_authorisations as a
  where a.attorney_id = p_attorney_id and a.jurisdiction_id = p_jurisdiction_id
  order by a.id for share;
  perform 1 from public.policy_versions as v
  where v.policy_type_code = 'eligibility'
    and v.jurisdiction_id = p_jurisdiction_id
  order by v.id for share;
  perform 1 from public.policy_authority_references as r
  where r.policy_version_id in (
    select v.id from public.policy_versions as v
    where v.policy_type_code = 'eligibility'
      and v.jurisdiction_id = p_jurisdiction_id)
  order by r.id for share of r;

  -- §4.2a: the determination must be the one the adopted engine derives.
  v_derived := public.eligibility_assessment(
    p_attorney_id, p_jurisdiction_id,
    case when p_context_type = 'practice_area' then p_context_id end,
    p_as_of);
  if not coalesce((v_derived ->> 'verifiable')::boolean, false)
     or p_result is distinct from v_derived ->> 'result'
     or public.eligibility_normalized_factors(p_factor_results)
        is distinct from public.eligibility_normalized_factors(v_derived -> 'factor_results')
     or p_policy_references is distinct from v_derived -> 'policy_references'
     or p_evidence_references is distinct from v_derived -> 'evidence_references' then
    return 'invalid';
  end if;

  begin
    insert into public.eligibility_evaluations (
      id, attorney_id, jurisdiction_id, context_type, context_id,
      evaluated_at, policy_references, result, factor_results,
      evidence_references, as_of
    ) values (
      p_evaluation_id, p_attorney_id, p_jurisdiction_id, p_context_type,
      p_context_id, v_time, v_derived -> 'policy_references',
      v_derived ->> 'result',
      public.eligibility_normalized_factors(v_derived -> 'factor_results'),
      v_derived -> 'evidence_references', p_as_of
    );
  exception
    when unique_violation then
      return 'conflict';
    when foreign_key_violation or check_violation then
      return 'invalid';
  end;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'eligibility_evaluation_recorded',
    'eligibility_evaluation', p_evaluation_id,
    null,
    jsonb_build_object(
      'result', v_derived ->> 'result',
      'attorney_id', p_attorney_id,
      'practice_area_id', p_context_id,
      'as_of', p_as_of
    ),
    null, v_derived -> 'policy_references', p_jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

create or replace function public.attorney_save_license_claim(
  p_license_id uuid,
  p_expected_updated_at timestamptz,
  p_jurisdiction_id uuid,
  p_license_number text,
  p_license_type text,
  p_effective_from date,
  p_effective_until date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_before public.licenses;
  v_after public.licenses;
  v_time timestamptz;
begin
  if (p_license_id is null) is distinct from (p_expected_updated_at is null)
     or p_jurisdiction_id is null
     or p_license_number is null
     or not public.professional_text_within(p_license_number, 64)
     or not public.professional_text_within(p_license_type, 80)
     or (p_effective_from is not null and p_effective_until is not null
         and p_effective_until < p_effective_from) then
    return 'invalid';
  end if;
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null
     or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if v_profile.profile_state <> 'applicant' then
    return 'locked';
  end if;
  if p_expected_updated_at is null then
    p_license_id := gen_random_uuid();
    begin
      insert into public.licenses (
        id, attorney_id, jurisdiction_id, license_number, license_type,
        effective_from, effective_until
      ) values (
        p_license_id, v_profile.id, p_jurisdiction_id, p_license_number,
        p_license_type, p_effective_from, p_effective_until
      )
      returning * into v_after;
    exception
      when unique_violation then
        return 'conflict';
      when foreign_key_violation or check_violation then
        return 'invalid';
    end;
  else
    select l.* into v_before
    from public.licenses as l
    where l.id = p_license_id and l.attorney_id = v_profile.id
    for no key update;
    if not found then
      return 'denied';
    end if;
    if v_before.reported_status is not null
       or exists (
         select 1 from public.verification_evidence_subjects as s
         where s.license_id = v_before.id
       ) then
      return 'locked';
    end if;
    if v_before.updated_at is distinct from p_expected_updated_at then
      return 'conflict';
    end if;
    begin
      update public.licenses as l
      set jurisdiction_id = p_jurisdiction_id,
          license_number = p_license_number,
          license_type = p_license_type,
          effective_from = p_effective_from,
          effective_until = p_effective_until
      where l.id = v_before.id
      returning l.* into v_after;
    exception
      when unique_violation then
        return 'conflict';
      when foreign_key_violation or check_violation then
        return 'invalid';
    end;
  end if;
  v_time := clock_timestamp();
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney',
    case when v_before.id is null
      then 'attorney_claim_recorded' else 'attorney_claim_revised' end,
    'license', v_after.id,
    case when v_before.id is null then null else jsonb_build_object(
      'jurisdiction_id', v_before.jurisdiction_id,
      'license_number', v_before.license_number,
      'license_type', v_before.license_type,
      'effective_from', v_before.effective_from,
      'effective_until', v_before.effective_until
    ) end,
    jsonb_build_object(
      'jurisdiction_id', v_after.jurisdiction_id,
      'license_number', v_after.license_number,
      'license_type', v_after.license_type,
      'effective_from', v_after.effective_from,
      'effective_until', v_after.effective_until
    ),
    null, null, v_after.jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

create or replace function public.attorney_save_insurance_claim(
  p_record_id uuid,
  p_expected_updated_at timestamptz,
  p_jurisdiction_id uuid,
  p_carrier_name text,
  p_policy_reference text,
  p_coverage_type text,
  p_per_occurrence_limit_minor bigint,
  p_aggregate_limit_minor bigint,
  p_currency_code text,
  p_coverage_from date,
  p_coverage_until date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_before public.insurance_records;
  v_after public.insurance_records;
  v_time timestamptz;
begin
  if (p_record_id is null) is distinct from (p_expected_updated_at is null)
     or p_jurisdiction_id is null
     or p_carrier_name is null
     or not public.professional_text_within(p_carrier_name, 120)
     or not public.professional_text_within(p_policy_reference, 80)
     or not public.professional_text_within(p_coverage_type, 80)
     or (p_per_occurrence_limit_minor is not null
         and p_per_occurrence_limit_minor not between 0 and 9000000000000)
     or (p_aggregate_limit_minor is not null
         and p_aggregate_limit_minor not between 0 and 9000000000000)
     or (p_currency_code is not null and p_currency_code !~ '^[A-Z]{3}$')
     or ((p_per_occurrence_limit_minor is not null
          or p_aggregate_limit_minor is not null)
         and p_currency_code is null)
     or (p_coverage_from is not null and p_coverage_until is not null
         and p_coverage_until < p_coverage_from) then
    return 'invalid';
  end if;
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null
     or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if v_profile.profile_state <> 'applicant' then
    return 'locked';
  end if;
  if p_expected_updated_at is null then
    p_record_id := gen_random_uuid();
    begin
      insert into public.insurance_records (
        id, attorney_id, jurisdiction_id, carrier_name, policy_reference,
        coverage_type, per_occurrence_limit_minor, aggregate_limit_minor,
        currency_code, coverage_from, coverage_until
      ) values (
        p_record_id, v_profile.id, p_jurisdiction_id, p_carrier_name,
        p_policy_reference, p_coverage_type, p_per_occurrence_limit_minor,
        p_aggregate_limit_minor, p_currency_code, p_coverage_from,
        p_coverage_until
      )
      returning * into v_after;
    exception
      when unique_violation then
        return 'conflict';
      when foreign_key_violation or check_violation then
        return 'invalid';
    end;
  else
    select i.* into v_before
    from public.insurance_records as i
    where i.id = p_record_id and i.attorney_id = v_profile.id
    for no key update;
    if not found then
      return 'denied';
    end if;
    if exists (
      select 1 from public.verification_evidence_subjects as s
      where s.insurance_record_id = v_before.id
    ) then
      return 'locked';
    end if;
    if v_before.updated_at is distinct from p_expected_updated_at then
      return 'conflict';
    end if;
    begin
      update public.insurance_records as i
      set jurisdiction_id = p_jurisdiction_id,
          carrier_name = p_carrier_name,
          policy_reference = p_policy_reference,
          coverage_type = p_coverage_type,
          per_occurrence_limit_minor = p_per_occurrence_limit_minor,
          aggregate_limit_minor = p_aggregate_limit_minor,
          currency_code = p_currency_code,
          coverage_from = p_coverage_from,
          coverage_until = p_coverage_until
      where i.id = v_before.id
      returning i.* into v_after;
    exception
      when unique_violation then
        return 'conflict';
      when foreign_key_violation or check_violation then
        return 'invalid';
    end;
  end if;
  v_time := clock_timestamp();
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney',
    case when v_before.id is null
      then 'attorney_claim_recorded' else 'attorney_claim_revised' end,
    'insurance_record', v_after.id,
    case when v_before.id is null then null else jsonb_build_object(
      'jurisdiction_id', v_before.jurisdiction_id,
      'carrier_name', v_before.carrier_name,
      'policy_reference', v_before.policy_reference,
      'coverage_type', v_before.coverage_type,
      'per_occurrence_limit_minor', v_before.per_occurrence_limit_minor,
      'aggregate_limit_minor', v_before.aggregate_limit_minor,
      'currency_code', v_before.currency_code,
      'coverage_from', v_before.coverage_from,
      'coverage_until', v_before.coverage_until
    ) end,
    jsonb_build_object(
      'jurisdiction_id', v_after.jurisdiction_id,
      'carrier_name', v_after.carrier_name,
      'policy_reference', v_after.policy_reference,
      'coverage_type', v_after.coverage_type,
      'per_occurrence_limit_minor', v_after.per_occurrence_limit_minor,
      'aggregate_limit_minor', v_after.aggregate_limit_minor,
      'currency_code', v_after.currency_code,
      'coverage_from', v_after.coverage_from,
      'coverage_until', v_after.coverage_until
    ),
    null, null, v_after.jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

create or replace function public.attorney_request_practice_area(
  p_authorisation_id uuid,
  p_jurisdiction_id uuid,
  p_practice_area_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_profile public.attorney_profiles;
  v_after public.practice_area_authorisations;
  v_time timestamptz;
begin
  if p_authorisation_id is not null
     or p_jurisdiction_id is null
     or p_practice_area_id is null then
    return 'invalid';
  end if;
  p_authorisation_id := gen_random_uuid();
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null
     or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if v_profile.profile_state <> 'applicant' then
    return 'locked';
  end if;
  perform 1
  from public.practice_areas as a
  where a.id = p_practice_area_id and a.active
  for share;
  if not found then
    return 'invalid';
  end if;
  v_time := clock_timestamp();
  begin
    insert into public.practice_area_authorisations (
      id, attorney_id, jurisdiction_id, practice_area_id, status, requested_at
    ) values (
      p_authorisation_id, v_profile.id, p_jurisdiction_id, p_practice_area_id,
      'requested', v_time
    )
    returning * into v_after;
  exception
    when unique_violation then
      return 'conflict';
    when foreign_key_violation or check_violation then
      return 'invalid';
  end;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney', 'practice_area_request_changed',
    'practice_area_authorisation', v_after.id,
    null,
    jsonb_build_object(
      'status', v_after.status,
      'practice_area_id', v_after.practice_area_id
    ),
    null, null, v_after.jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

create or replace function public.staff_record_verification_finding(
  p_evidence_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_expected_updated_at timestamptz,
  p_source_type text,
  p_source_uri text,
  p_source_reference text,
  p_retrieved_at timestamptz,
  p_verification_method text,
  p_evidence_summary text,
  p_evidence_digest text,
  p_discrepancy_flag boolean,
  p_observed_status text,
  p_discipline_status text,
  p_resolved_at date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_attorney uuid;
  v_jurisdiction uuid;
  v_locked_attorney uuid;
  v_locked_jurisdiction uuid;
  v_locked_updated timestamptz;
  v_staff uuid;
  v_target public.attorney_profiles;
  v_time timestamptz;
begin
  if p_evidence_id is not null
     or p_subject_id is null
     or p_expected_updated_at is null
     or p_subject_kind is null
     or p_subject_kind not in (
       'license', 'insurance', 'discipline', 'practice_area_authorisation'
     )
     or not public.verification_evidence_input_valid(
       p_source_type, p_source_uri, p_source_reference, p_retrieved_at,
       p_verification_method, p_evidence_summary, p_evidence_digest,
       p_discrepancy_flag
     )
     or (p_observed_status is not null
         and (p_subject_kind <> 'license'
              or not public.professional_text_within(p_observed_status, 40)))
     or (p_discipline_status is not null
         and (p_subject_kind <> 'discipline'
              or not public.professional_text_within(p_discipline_status, 40)))
     or (p_resolved_at is not null and p_discipline_status is null) then
    return 'invalid';
  end if;
  p_evidence_id := gen_random_uuid();
  select r.record_attorney, r.record_jurisdiction
  into v_attorney, v_jurisdiction
  from public.professional_record_of(p_subject_kind, p_subject_id, 'none') as r;
  if v_attorney is null then
    return 'denied';
  end if;
  v_staff := public.lock_current_verification_staff(v_jurisdiction);
  if v_staff is null then
    return 'denied';
  end if;
  select p.* into v_target
  from public.attorney_profiles as p
  where p.id = v_attorney
  for share;
  if not found or v_target.user_id = v_staff then
    return 'denied';
  end if;
  if v_target.profile_state not in ('under_review', 'approved', 'suspended') then
    return 'locked';
  end if;
  select r.record_attorney, r.record_jurisdiction, r.record_updated_at
  into v_locked_attorney, v_locked_jurisdiction, v_locked_updated
  from public.professional_record_of(
    p_subject_kind, p_subject_id,
    case when p_observed_status is not null or p_discipline_status is not null
      then 'update' else 'share' end
  ) as r;
  if v_locked_attorney is distinct from v_attorney
     or v_locked_jurisdiction is distinct from v_jurisdiction
     or v_locked_updated is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  v_time := clock_timestamp();
  begin
    insert into public.verification_evidence (
      id, jurisdiction_id, source_type, source_uri, source_reference,
      retrieved_at, retrieved_by_user_id, evidence_summary, evidence_digest,
      verification_method, discrepancy_flag
    ) values (
      p_evidence_id, v_jurisdiction, p_source_type, p_source_uri,
      p_source_reference, p_retrieved_at, v_staff, p_evidence_summary,
      p_evidence_digest, p_verification_method, p_discrepancy_flag
    );
    insert into public.verification_evidence_subjects (
      verification_evidence_id, license_id, insurance_record_id,
      discipline_record_id, practice_area_authorisation_id
    ) values (
      p_evidence_id,
      case when p_subject_kind = 'license' then p_subject_id end,
      case when p_subject_kind = 'insurance' then p_subject_id end,
      case when p_subject_kind = 'discipline' then p_subject_id end,
      case when p_subject_kind = 'practice_area_authorisation' then p_subject_id end
    );
    if p_observed_status is not null then
      update public.licenses as l
      set reported_status = p_observed_status
      where l.id = p_subject_id;
    end if;
    if p_discipline_status is not null then
      update public.discipline_records as d
      set status = p_discipline_status,
          resolved_at = coalesce(p_resolved_at, d.resolved_at)
      where d.id = p_subject_id;
    end if;
  exception
    when unique_violation then
      return 'conflict';
    when foreign_key_violation or check_violation then
      return 'invalid';
  end;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'verification_evidence_recorded',
    'verification_evidence', p_evidence_id,
    null,
    jsonb_build_object(
      'subject_kind', p_subject_kind,
      'subject_id', p_subject_id,
      'discrepancy', p_discrepancy_flag,
      'observed_status', p_observed_status,
      'discipline_status', p_discipline_status
    ),
    null, null, v_jurisdiction, v_time
  );
  return 'applied';
end;
$function$;

create or replace function public.staff_record_discipline_finding(
  p_discipline_id uuid,
  p_evidence_id uuid,
  p_attorney_id uuid,
  p_jurisdiction_id uuid,
  p_external_reference text,
  p_finding_type text,
  p_opened_at date,
  p_resolved_at date,
  p_status text,
  p_source_type text,
  p_source_uri text,
  p_source_reference text,
  p_retrieved_at timestamptz,
  p_verification_method text,
  p_evidence_summary text,
  p_evidence_digest text,
  p_discrepancy_flag boolean
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
  v_target public.attorney_profiles;
  v_time timestamptz;
begin
  if p_discipline_id is not null
     or p_evidence_id is not null
     or p_attorney_id is null
     or p_jurisdiction_id is null
     or p_status is null
     or not public.professional_text_within(p_status, 40)
     or not public.professional_text_within(p_external_reference, 120)
     or not public.professional_text_within(p_finding_type, 80)
     or (p_opened_at is not null and p_resolved_at is not null
         and p_resolved_at < p_opened_at)
     or not public.verification_evidence_input_valid(
       p_source_type, p_source_uri, p_source_reference, p_retrieved_at,
       p_verification_method, p_evidence_summary, p_evidence_digest,
       p_discrepancy_flag
     ) then
    return 'invalid';
  end if;
  p_discipline_id := gen_random_uuid();
  p_evidence_id := gen_random_uuid();
  v_staff := public.lock_current_verification_staff(p_jurisdiction_id);
  if v_staff is null then
    return 'denied';
  end if;
  select p.* into v_target
  from public.attorney_profiles as p
  where p.id = p_attorney_id
  for share;
  if not found or v_target.user_id = v_staff then
    return 'denied';
  end if;
  if v_target.profile_state not in ('under_review', 'approved', 'suspended') then
    return 'locked';
  end if;
  v_time := clock_timestamp();
  begin
    insert into public.discipline_records (
      id, attorney_id, jurisdiction_id, external_reference, finding_type,
      opened_at, resolved_at, status
    ) values (
      p_discipline_id, p_attorney_id, p_jurisdiction_id, p_external_reference,
      p_finding_type, p_opened_at, p_resolved_at, p_status
    );
    insert into public.verification_evidence (
      id, jurisdiction_id, source_type, source_uri, source_reference,
      retrieved_at, retrieved_by_user_id, evidence_summary, evidence_digest,
      verification_method, discrepancy_flag
    ) values (
      p_evidence_id, p_jurisdiction_id, p_source_type, p_source_uri,
      p_source_reference, p_retrieved_at, v_staff, p_evidence_summary,
      p_evidence_digest, p_verification_method, p_discrepancy_flag
    );
    insert into public.verification_evidence_subjects (
      verification_evidence_id, discipline_record_id
    ) values (p_evidence_id, p_discipline_id);
  exception
    when unique_violation then
      return 'conflict';
    when foreign_key_violation or check_violation then
      return 'invalid';
  end;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'discipline_record_recorded',
    'discipline_record', p_discipline_id,
    null,
    jsonb_build_object(
      'attorney_id', p_attorney_id,
      'status', p_status,
      'finding_type', p_finding_type,
      'external_reference', p_external_reference,
      'evidence_id', p_evidence_id
    ),
    null, null, p_jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;
