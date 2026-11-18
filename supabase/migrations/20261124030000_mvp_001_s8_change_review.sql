-- MVP-001 S8 (3 of 3): eligibility and jurisdiction changes routed to review (MVP-001 Packet S8 "jurisdiction or
-- eligibility change routed to hold/review per configuration"; PM sections 11 and 12, rows 37-45; TA sections 25
-- (human-review required, regulatory exception), 26, 55 and 63; DM section 10 "Reconciliation Exception: detect,
-- record, surface"; PM section 1 INV-11 and INV-12; Packet section 3 gates).
--
-- No relation, column, policy type, capability or seed is added (Packet rules 8, 10 and 16). Rows 37 and 38 are
-- settled and are enforced at the decision points (S6 request creation; S8 acceptance: an attorney not eligible at
-- acceptance ends the Request, 20261124020000). Rows 39-45 are counsel- or regulator-gated ([C]): what happens to an
-- accepted Consultation, its Booking and its payment when the attorney stops being eligible, or when a jurisdiction's
-- state changes, is not decided here. This migration only detects and surfaces: it never changes a Request,
-- Consultation, Booking or payment.
--
-- Mechanism: a Reconciliation Exception (PS section 22.5; TA section 26) is the existing open/assign/resolve review
-- record with an audited human resolution in the finance workspace (S7); there is no other review relation in the
-- physical model. Two distinct exception types are used, each with the affected matter as source and canonical object
-- (source_type and canonical_type consultation_request or consultation; one open item per type and matter, the S7
-- unique key), severity medium for an undecided Request (rows 37-38: the decision point will refuse it anyway) and
-- high otherwise, and evidence holding only identifiers, states, the cause, the derived result and the Payment Matrix
-- rows concerned; each new item is audited once (system actor). A matter is open while it is an undecided Request
-- (created, payment_authorized, slot_held, awaiting_attorney), an accepted Request without its Consultation yet (the
-- deferred instant creation), or a Consultation that is not terminal (created, scheduled, ready, live).
-- - eligibility_change_review (rows 37-41): deferred constraint triggers (at commit, so a multi-row change is judged
--   on its final state) on the canonical eligibility inputs the adopted engine reads: licenses, insurance_records,
--   discipline_records and practice_area_authorisations (any row change of the attorney), verification_evidence_subjects
--   (any link of evidence to one of those rows: the attorney it evidences) and verification_evidence (any change of an
--   evidence row, for example its discrepancy flag: every attorney whose rows it evidences), attorney_profiles
--   (profile_state), users (account_state, for a User holding an Attorney Profile), eligibility policy_versions and
--   their policy_authority_references (any change of a version or of its authority verification in a jurisdiction:
--   every attorney with an open matter there). For each open matter of
--   the attorney, the engine (eligibility_assessment) is run read-only for the matter's jurisdiction (the Referral's)
--   and, when the client filtered by one, its practice area; a result other than eligible opens the item. Nothing is
--   persisted as an Eligibility Evaluation: these are not decision points (TA section 55); the next decision point
--   (S8 acceptance, S9 consultation start) records its own evaluation;
-- - jurisdiction_change_review (rows 42-44): a deferred constraint trigger on jurisdictions.lifecycle_state: any
--   change opens an item for every open matter in the jurisdiction (the old and new states recorded), whichever
--   states are involved (which restriction matters is regulatory-gated).
-- Not detectable here, and listed as residual: eligibility that lapses by time passing alone (evidence age, an
-- insurance end date) until the next fact change or decision point, and a certification lapse (row 45) beyond the
-- jurisdiction's lifecycle state (PS section 28.1 lrs_certifications does not exist in the physical model). Fixed
-- technical bound (not a policy value): the open-matter listing answers at most 1000 matters per attorney, or per
-- jurisdiction for a jurisdiction or policy change (which then examines each listed attorney's own matters, at most
-- 1000 each); matters beyond the bound are not routed by that change (residual, far above MVP volumes).
-- Lock behaviour: the triggers read without locking and insert only Reconciliation Exceptions and audit events, so
-- they add no lock edge towards the decision functions (which take the attorney's User and Profile, the scheduling
-- lock, the Hold, the Request and the payment).

-- ---------------------------------------------------------------------------
-- Internal: open one review item (idempotent per type and matter), audited once.
-- ---------------------------------------------------------------------------

create function public.decision_open_review(
  p_exception_type text,
  p_matter_type text,
  p_matter_id uuid,
  p_severity text,
  p_jurisdiction uuid,
  p_evidence jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_id uuid;
begin
  insert into public.reconciliation_exceptions (
    source_type, source_id, canonical_type, canonical_id, exception_type, severity,
    detected_at, status, evidence_reference
  ) values (
    p_matter_type, p_matter_id, p_matter_type, p_matter_id, p_exception_type, p_severity,
    clock_timestamp(), 'open', coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (exception_type, source_type, source_id) where status = 'open' and source_id is not null
  do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'reconciliation_exception.opened', 'reconciliation_exception', v_id,
    null,
    jsonb_build_object(
      'exception_type', p_exception_type,
      'severity', p_severity,
      'source_type', p_matter_type,
      'canonical_type', p_matter_type,
      'canonical_id', p_matter_id
    ),
    p_exception_type, null, p_jurisdiction, clock_timestamp()
  );
  return v_id;
end;
$function$;

-- The open matters (internal), of one attorney or in one jurisdiction (at least one given), at most 1000: matter type
-- and id, the Request, its jurisdiction, the client's practice-area filter, the Request and Consultation states and
-- the latest payment state.
create function public.decision_open_matters(p_attorney uuid, p_jurisdiction uuid)
returns table (
  matter_type text,
  matter_id uuid,
  attorney_id uuid,
  request_id uuid,
  jurisdiction_id uuid,
  practice_area_id uuid,
  request_state text,
  consultation_state text,
  payment_state text
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    m.matter_type,
    m.matter_id,
    m.attorney_id,
    m.request_id,
    m.jurisdiction_id,
    (
      select case
        when p.client_filter_context ->> 'practice_area_id'
             ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (p.client_filter_context ->> 'practice_area_id')::uuid
      end
      from public.referral_presentations as p
      where p.referral_id = m.referral_id
        and p.attorney_id = m.attorney_id
      limit 1
    ),
    m.request_state,
    m.consultation_state,
    (
      select pt.state
      from public.payment_transactions as pt
      where pt.consultation_request_id = m.request_id
      order by pt.created_at desc, pt.id desc
      limit 1
    )
  from (
    select
      'consultation_request'::text as matter_type,
      r.id as matter_id,
      r.selected_attorney_id as attorney_id,
      r.id as request_id,
      f.jurisdiction_id,
      r.referral_id,
      r.state as request_state,
      null::text as consultation_state
    from public.consultation_requests as r
    join public.referrals as f on f.id = r.referral_id
    where (p_attorney is null or r.selected_attorney_id = p_attorney)
      and (p_jurisdiction is null or f.jurisdiction_id = p_jurisdiction)
      and (
        r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
        or (
          r.state = 'accepted'
          and not exists (select 1 from public.consultations as c where c.consultation_request_id = r.id)
        )
      )
    union all
    select
      'consultation'::text,
      c.id,
      c.attorney_id,
      r.id,
      f.jurisdiction_id,
      r.referral_id,
      r.state,
      c.state
    from public.consultations as c
    join public.consultation_requests as r on r.id = c.consultation_request_id
    join public.referrals as f on f.id = r.referral_id
    where (p_attorney is null or c.attorney_id = p_attorney)
      and (p_jurisdiction is null or f.jurisdiction_id = p_jurisdiction)
      and c.state in ('created', 'scheduled', 'ready', 'live')
  ) as m
  where p_attorney is not null or p_jurisdiction is not null
  order by m.matter_type, m.matter_id
  limit 1000;
$function$;

-- Re-derives the attorney's eligibility (read-only, the adopted engine) for each of the attorney's open matters and
-- opens an eligibility_change_review for each matter no longer eligible. Answers the number of matters examined.
create function public.decision_review_attorney(p_attorney uuid, p_cause text)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_matter record;
  v_result text;
  v_count integer := 0;
begin
  if p_attorney is null then
    return 0;
  end if;
  for v_matter in
    select m.* from public.decision_open_matters(p_attorney, null) as m
  loop
    v_count := v_count + 1;
    v_result := public.eligibility_assessment(p_attorney, v_matter.jurisdiction_id, null, v_now) ->> 'result';
    if v_result = 'eligible' and v_matter.practice_area_id is not null then
      v_result := public.eligibility_assessment(
        p_attorney, v_matter.jurisdiction_id, v_matter.practice_area_id, v_now
      ) ->> 'result';
    end if;
    if v_result is distinct from 'eligible' then
      perform public.decision_open_review(
        'eligibility_change_review',
        v_matter.matter_type,
        v_matter.matter_id,
        case
          when v_matter.request_state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney') then 'medium'
          else 'high'
        end,
        v_matter.jurisdiction_id,
        jsonb_build_object(
          'cause', p_cause,
          'attorney_id', p_attorney,
          'consultation_request_id', v_matter.request_id,
          'jurisdiction_id', v_matter.jurisdiction_id,
          'practice_area_id', v_matter.practice_area_id,
          'eligibility_result', coalesce(v_result, 'unverifiable'),
          'request_state', v_matter.request_state,
          'consultation_state', v_matter.consultation_state,
          'payment_state', v_matter.payment_state,
          'payment_matrix_rows', case
            when v_matter.request_state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
              then jsonb_build_array(37, 38)
            when v_matter.consultation_state = 'live' then jsonb_build_array(41)
            else jsonb_build_array(39, 40)
          end
        )
      );
    end if;
  end loop;
  return v_count;
end;
$function$;

-- Opens a jurisdiction_change_review for every open matter in a jurisdiction whose lifecycle state changed. Answers
-- the number of matters examined.
create function public.decision_review_jurisdiction(p_jurisdiction uuid, p_old_state text, p_new_state text)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_matter record;
  v_count integer := 0;
begin
  if p_jurisdiction is null then
    return 0;
  end if;
  for v_matter in
    select m.* from public.decision_open_matters(null, p_jurisdiction) as m
  loop
    v_count := v_count + 1;
    perform public.decision_open_review(
      'jurisdiction_change_review',
      v_matter.matter_type,
      v_matter.matter_id,
      'high',
      p_jurisdiction,
      jsonb_build_object(
        'cause', 'jurisdictions',
        'jurisdiction_id', p_jurisdiction,
        'previous_lifecycle_state', p_old_state,
        'lifecycle_state', p_new_state,
        'attorney_id', v_matter.attorney_id,
        'consultation_request_id', v_matter.request_id,
        'request_state', v_matter.request_state,
        'consultation_state', v_matter.consultation_state,
        'payment_state', v_matter.payment_state,
        'payment_matrix_rows', case
          when v_matter.payment_state in (
            'authorized', 'capture_pending', 'captured', 'refund_pending', 'partially_refunded', 'release_pending'
          ) then jsonb_build_array(42, 43, 44)
          else jsonb_build_array(42, 43)
        end
      )
    );
  end loop;
  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Trigger functions (deferred constraint triggers; security definer: they run at commit under whatever role the
-- transaction has; executable by no API role).
-- ---------------------------------------------------------------------------

-- A change to an attorney's licence, insurance, discipline or practice-area authorisation rows.
create function public.decision_review_attorney_fact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.decision_review_attorney(old.attorney_id, tg_table_name);
    return null;
  end if;
  perform public.decision_review_attorney(new.attorney_id, tg_table_name);
  if tg_op = 'UPDATE' and old.attorney_id is distinct from new.attorney_id then
    perform public.decision_review_attorney(old.attorney_id, tg_table_name);
  end if;
  return null;
end;
$function$;

-- A change of an Attorney Profile's lifecycle state.
create function public.decision_review_attorney_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  perform public.decision_review_attorney(new.id, 'attorney_profiles');
  return null;
end;
$function$;

-- A change of a User's account state, for a User holding an Attorney Profile.
create function public.decision_review_attorney_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
begin
  select p.id into v_attorney from public.attorney_profiles as p where p.user_id = new.id;
  if v_attorney is not null then
    perform public.decision_review_attorney(v_attorney, 'users');
  end if;
  return null;
end;
$function$;

-- A change of an eligibility policy version of a jurisdiction: every attorney with an open matter there.
create function public.decision_review_eligibility_policy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  perform public.decision_review_jurisdiction_attorneys(new.jurisdiction_id, 'policy_versions');
  return null;
end;
$function$;

-- A change of a jurisdiction's lifecycle state.
create function public.decision_review_jurisdiction_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  perform public.decision_review_jurisdiction(new.id, old.lifecycle_state, new.lifecycle_state);
  return null;
end;
$function$;

-- The attorney whose licence, insurance, discipline or practice-area authorisation row an evidence link names
-- (internal; exactly one of the four is set, P1 check).
create function public.decision_evidence_subject_attorney(
  p_license_id uuid,
  p_insurance_record_id uuid,
  p_discipline_record_id uuid,
  p_practice_area_authorisation_id uuid
)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    (select l.attorney_id from public.licenses as l where l.id = p_license_id),
    (select i.attorney_id from public.insurance_records as i where i.id = p_insurance_record_id),
    (select d.attorney_id from public.discipline_records as d where d.id = p_discipline_record_id),
    (select a.attorney_id from public.practice_area_authorisations as a where a.id = p_practice_area_authorisation_id)
  );
$function$;

-- Every attorney with an open matter in a jurisdiction (internal): each one's open matters are re-derived. Answers
-- the number of attorneys examined.
create function public.decision_review_jurisdiction_attorneys(p_jurisdiction uuid, p_cause text)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_count integer := 0;
begin
  if p_jurisdiction is null then
    return 0;
  end if;
  for v_attorney in
    select distinct m.attorney_id
    from public.decision_open_matters(null, p_jurisdiction) as m
    order by m.attorney_id
  loop
    v_count := v_count + 1;
    perform public.decision_review_attorney(v_attorney, p_cause);
  end loop;
  return v_count;
end;
$function$;

-- A new, changed or removed link of verification evidence to an attorney's licence, insurance, discipline or
-- practice-area authorisation row: that attorney (the previous one too, if a link changed).
create function public.decision_review_evidence_subject()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := public.decision_evidence_subject_attorney(
      old.license_id, old.insurance_record_id, old.discipline_record_id, old.practice_area_authorisation_id
    );
    perform public.decision_review_attorney(v_old, tg_table_name);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := public.decision_evidence_subject_attorney(
      new.license_id, new.insurance_record_id, new.discipline_record_id, new.practice_area_authorisation_id
    );
    if v_new is distinct from v_old then
      perform public.decision_review_attorney(v_new, tg_table_name);
    end if;
  end if;
  return null;
end;
$function$;

-- A change of a verification evidence row (for example its discrepancy flag): every attorney whose rows it evidences.
create function public.decision_review_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
begin
  for v_attorney in
    select distinct public.decision_evidence_subject_attorney(
      s.license_id, s.insurance_record_id, s.discipline_record_id, s.practice_area_authorisation_id
    ) as attorney_id
    from public.verification_evidence_subjects as s
    where s.verification_evidence_id = new.id
    order by 1
  loop
    perform public.decision_review_attorney(v_attorney, 'verification_evidence');
  end loop;
  return null;
end;
$function$;

-- A change of an authority reference (its verification) of an eligibility policy version of a jurisdiction: every
-- attorney with an open matter there.
create function public.decision_review_authority_reference()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_jurisdiction uuid;
begin
  select v.jurisdiction_id into v_jurisdiction
  from public.policy_versions as v
  where v.id = case when tg_op = 'DELETE' then old.policy_version_id else new.policy_version_id end
    and v.policy_type_code = 'eligibility';
  perform public.decision_review_jurisdiction_attorneys(v_jurisdiction, 'policy_authority_references');
  if tg_op = 'UPDATE' and old.policy_version_id is distinct from new.policy_version_id then
    select v.jurisdiction_id into v_jurisdiction
    from public.policy_versions as v
    where v.id = old.policy_version_id
      and v.policy_type_code = 'eligibility';
    perform public.decision_review_jurisdiction_attorneys(v_jurisdiction, 'policy_authority_references');
  end if;
  return null;
end;
$function$;

create constraint trigger licenses_decision_review
after insert or update or delete on public.licenses
deferrable initially deferred
for each row
execute function public.decision_review_attorney_fact();

create constraint trigger insurance_records_decision_review
after insert or update or delete on public.insurance_records
deferrable initially deferred
for each row
execute function public.decision_review_attorney_fact();

create constraint trigger discipline_records_decision_review
after insert or update or delete on public.discipline_records
deferrable initially deferred
for each row
execute function public.decision_review_attorney_fact();

create constraint trigger practice_area_authorisations_decision_review
after insert or update or delete on public.practice_area_authorisations
deferrable initially deferred
for each row
execute function public.decision_review_attorney_fact();

create constraint trigger verification_evidence_subjects_decision_review
after insert or update or delete on public.verification_evidence_subjects
deferrable initially deferred
for each row
execute function public.decision_review_evidence_subject();

create constraint trigger verification_evidence_decision_review
after update on public.verification_evidence
deferrable initially deferred
for each row
execute function public.decision_review_evidence();

create constraint trigger attorney_profiles_decision_review
after update of profile_state on public.attorney_profiles
deferrable initially deferred
for each row
when (old.profile_state is distinct from new.profile_state)
execute function public.decision_review_attorney_profile();

create constraint trigger users_decision_review
after update of account_state on public.users
deferrable initially deferred
for each row
when (old.account_state is distinct from new.account_state)
execute function public.decision_review_attorney_user();

create constraint trigger policy_versions_decision_review
after insert or update on public.policy_versions
deferrable initially deferred
for each row
when (new.policy_type_code = 'eligibility')
execute function public.decision_review_eligibility_policy();

create constraint trigger policy_authority_references_decision_review
after insert or update or delete on public.policy_authority_references
deferrable initially deferred
for each row
execute function public.decision_review_authority_reference();

create constraint trigger jurisdictions_decision_review
after update of lifecycle_state on public.jurisdictions
deferrable initially deferred
for each row
when (old.lifecycle_state is distinct from new.lifecycle_state)
execute function public.decision_review_jurisdiction_state();

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.decision_open_review(text, text, uuid, text, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_open_matters(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_attorney(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_jurisdiction(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_attorney_fact()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_attorney_profile()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_attorney_user()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_eligibility_policy()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_jurisdiction_state()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_evidence_subject_attorney(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_jurisdiction_attorneys(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_evidence_subject()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.decision_review_authority_reference()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.decision_open_review(text, text, uuid, text, uuid, jsonb) is
  'MVP-001 S8 (internal): opens one review Reconciliation Exception for an affected Request or Consultation (one open item per type and matter), audited once; changes nothing else.';
comment on function public.decision_open_matters(uuid, uuid) is
  'MVP-001 S8 (internal): the open matters of an attorney or in a jurisdiction (undecided Requests, accepted Requests without a Consultation, non-terminal Consultations), at most 1000.';
comment on function public.decision_review_attorney(uuid, text) is
  'MVP-001 S8 (internal): re-derives eligibility read-only for each open matter of the attorney and opens an eligibility_change_review (PM rows 37-41) for each one no longer eligible; decides nothing.';
comment on function public.decision_review_jurisdiction(uuid, text, text) is
  'MVP-001 S8 (internal): opens a jurisdiction_change_review (PM rows 42-44) for every open matter of a jurisdiction whose lifecycle state changed; decides nothing.';
comment on function public.decision_review_attorney_fact() is
  'MVP-001 S8 (deferred trigger): a licence, insurance, discipline or practice-area authorisation change routes the attorney''s open matters to eligibility review.';
comment on function public.decision_review_attorney_profile() is
  'MVP-001 S8 (deferred trigger): an Attorney Profile lifecycle change routes the attorney''s open matters to eligibility review.';
comment on function public.decision_review_attorney_user() is
  'MVP-001 S8 (deferred trigger): an account state change of a User holding an Attorney Profile routes the attorney''s open matters to eligibility review.';
comment on function public.decision_review_eligibility_policy() is
  'MVP-001 S8 (deferred trigger): an eligibility policy version change routes the open matters of every attorney in its jurisdiction to eligibility review.';
comment on function public.decision_review_jurisdiction_state() is
  'MVP-001 S8 (deferred trigger): a jurisdiction lifecycle change routes its open matters to jurisdiction review.';
comment on function public.decision_evidence_subject_attorney(uuid, uuid, uuid, uuid) is
  'MVP-001 S8 (internal): the attorney whose licence, insurance, discipline or practice-area authorisation row an evidence link names.';
comment on function public.decision_review_jurisdiction_attorneys(uuid, text) is
  'MVP-001 S8 (internal): re-derives eligibility for the open matters of every attorney with an open matter in a jurisdiction; decides nothing.';
comment on function public.decision_review_evidence_subject() is
  'MVP-001 S8 (deferred trigger): a verification evidence link change routes the evidenced attorney''s open matters to eligibility review.';
comment on function public.decision_review_evidence() is
  'MVP-001 S8 (deferred trigger): a verification evidence change routes the open matters of every attorney it evidences to eligibility review.';
comment on function public.decision_review_authority_reference() is
  'MVP-001 S8 (deferred trigger): an authority reference change of an eligibility policy version routes the open matters of every attorney in its jurisdiction to eligibility review.';
