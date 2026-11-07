-- P3-904 local candidate. Unreviewed and unapplied.
-- Forward-only security correction of the P3-003 professional write path.
--
-- R2. public.has_manage_attorney_verification_scope keeps its signature,
-- return type, owner, fixed search_path, and global/jurisdiction semantics,
-- and now also requires the caller's one Rosuno User to be active and that
-- User's one Staff Profile to be active. Every row policy that calls it
-- enforces the corrected predicate unchanged.
--
-- R1. Every consequential attorney and staff professional change is one
-- operation-specific SECURITY DEFINER function, executable only by the
-- authenticated role. Each derives its actor from auth.uid() of the request's
-- own session (it takes no actor, User, reviewer, or grant argument), and in
-- its own transaction locks, in one fixed order, the actor's User row, then
-- (staff) the Staff Profile row and one currently valid
-- manage_attorney_verification grant row, then the target Attorney Profile,
-- then the professional record it changes. Authority is decided on those
-- locked rows, so a revocation, suspension, deactivation, expiry shortening,
-- or re-scoping committed before the decisive check denies, and one attempted
-- after it waits until the protected change commits or rolls back. Lock
-- waits are bounded by lock_timeout; a timeout, deadlock, or any error rolls
-- the whole call back.
--
-- R3. Each function writes its domain change and its one mandatory audit
-- event in the same transaction. Either both commit or neither does. Evidence
-- and its subject link, and discipline findings with their evidence, commit
-- together or not at all. The audit actor is the locked caller.
--
-- Bypass prevention. The service role keeps SELECT on the eight M4 relations
-- and loses INSERT, UPDATE, and DELETE on them, so the privileged credential
-- can no longer change professional, evidence, or evaluation state directly.
-- P3-002 initial applicant creation moves to its own bounded function.
-- audit_events grants are unchanged: no other writer exists today, and no
-- unrelated auditing is disabled.
--
-- Every function returns one fixed outcome: applied, denied, locked,
-- conflict, or invalid. Only applied means anything changed. No business
-- table, role, capability, policy, or regulatory rule is introduced.

-- ---------------------------------------------------------------------------
-- R2: active User and active Staff Profile in the read predicate
-- ---------------------------------------------------------------------------

create or replace function public.has_manage_attorney_verification_scope(
  required_jurisdiction uuid, allow_any_jurisdiction boolean
) returns boolean
language sql stable security definer
set search_path = pg_catalog
as $function$
  select exists (
    select 1
    from public.users as u
    join public.staff_profiles as s on s.user_id = u.id
    join public.capability_grants as g on g.user_id = u.id
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
      and s.staff_state = 'active'
      and g.capability_code = 'manage_attorney_verification'
      and g.granted_at <= statement_timestamp()
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > statement_timestamp())
      and g.resource_scope is null
      and (allow_any_jurisdiction is true or g.jurisdiction_id is null
           or g.jurisdiction_id = required_jurisdiction)
  );
$function$;

revoke all on function public.has_manage_attorney_verification_scope(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.has_manage_attorney_verification_scope(uuid, boolean)
  to authenticated;

comment on function public.has_manage_attorney_verification_scope(uuid, boolean) is
  'Read-only current-caller verification capability predicate. Requires an authenticated caller whose Rosuno User and Staff Profile are both active and who holds a granted, unrevoked, unexpired, non-resource-scoped manage_attorney_verification grant. Any-jurisdiction mode is used only for inactive Practice Area reads. No caller identity or capability parameter.';

-- ---------------------------------------------------------------------------
-- Internal helpers. Never executable by anon, authenticated, or service_role;
-- they run only inside the definer functions below.
-- ---------------------------------------------------------------------------

-- Bounded professional text: null, or 1..max_length characters with no
-- leading or trailing whitespace and no control characters other than tab,
-- line feed, and carriage return (the application's own form rules).
create function public.professional_text_within(value text, max_length integer)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $function$
  select value is null
    or (
      char_length(value) between 1 and max_length
      and value !~ '^[[:space:]]'
      and value !~ '[[:space:]]$'
      and value !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]'
    );
$function$;

-- The caller's one Rosuno User, locked FOR SHARE and active, or null.
create function public.lock_current_active_user()
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_caller uuid := auth.uid();
  v_user uuid;
  v_state text;
begin
  if v_caller is null then
    return null;
  end if;
  select u.id, u.account_state
  into v_user, v_state
  from public.users as u
  where u.auth_user_id = v_caller
  for share;
  if not found or v_state is distinct from 'active' then
    return null;
  end if;
  return v_user;
end;
$function$;

-- The caller's staff User when, on rows locked FOR SHARE in the fixed order
-- User -> Staff Profile -> grant, the User and Staff Profile are active and
-- one manage_attorney_verification grant is currently valid for exactly this
-- scope (null: the global, jurisdiction-free scope). Otherwise null. The
-- locked grant cannot be revoked, re-scoped, or re-dated until the caller's
-- transaction ends; its expiry is re-checked once the lock is held.
create function public.lock_current_verification_staff(required_jurisdiction uuid)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_staff_state text;
  v_expires timestamptz;
  v_decided timestamptz;
begin
  v_user := public.lock_current_active_user();
  if v_user is null then
    return null;
  end if;
  select s.staff_state
  into v_staff_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for share;
  if not found or v_staff_state is distinct from 'active' then
    return null;
  end if;
  v_decided := clock_timestamp();
  select g.expires_at
  into v_expires
  from public.capability_grants as g
  where g.user_id = v_user
    and g.capability_code = 'manage_attorney_verification'
    and g.granted_at <= v_decided
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > v_decided)
    and g.resource_scope is null
    and (g.jurisdiction_id is null or g.jurisdiction_id = required_jurisdiction)
  order by g.id
  limit 1
  for share;
  if not found then
    return null;
  end if;
  if v_expires is not null and v_expires <= clock_timestamp() then
    return null;
  end if;
  return v_user;
end;
$function$;

-- The caller's own Attorney Profile, after locking the caller's active User:
-- FOR NO KEY UPDATE when the profile itself changes, otherwise FOR SHARE so
-- its lifecycle stage cannot change until the caller's transaction ends. An
-- all-null row when there is no active User or no profile.
create function public.lock_current_attorney_profile(for_change boolean)
returns public.attorney_profiles
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_profile public.attorney_profiles;
begin
  v_user := public.lock_current_active_user();
  if v_user is null then
    return v_profile;
  end if;
  if for_change then
    select p.* into v_profile
    from public.attorney_profiles as p
    where p.user_id = v_user
    for no key update;
  else
    select p.* into v_profile
    from public.attorney_profiles as p
    where p.user_id = v_user
    for share;
  end if;
  return v_profile;
end;
$function$;

-- One professional record's owner, jurisdiction, and version, by fixed kind,
-- read without a lock ('none') or locked FOR SHARE ('share') or FOR NO KEY
-- UPDATE ('update'). All-null outputs when absent or the kind is unknown.
create function public.professional_record_of(
  subject_kind text,
  subject_id uuid,
  lock_mode text,
  out record_attorney uuid,
  out record_jurisdiction uuid,
  out record_updated_at timestamptz
)
returns record
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
begin
  if subject_kind = 'license' then
    if lock_mode = 'update' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.licenses as r where r.id = subject_id for no key update;
    elsif lock_mode = 'share' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.licenses as r where r.id = subject_id for share;
    else
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.licenses as r where r.id = subject_id;
    end if;
  elsif subject_kind = 'insurance' then
    if lock_mode = 'update' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.insurance_records as r where r.id = subject_id for no key update;
    elsif lock_mode = 'share' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.insurance_records as r where r.id = subject_id for share;
    else
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.insurance_records as r where r.id = subject_id;
    end if;
  elsif subject_kind = 'discipline' then
    if lock_mode = 'update' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.discipline_records as r where r.id = subject_id for no key update;
    elsif lock_mode = 'share' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.discipline_records as r where r.id = subject_id for share;
    else
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.discipline_records as r where r.id = subject_id;
    end if;
  elsif subject_kind = 'practice_area_authorisation' then
    if lock_mode = 'update' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.practice_area_authorisations as r where r.id = subject_id for no key update;
    elsif lock_mode = 'share' then
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.practice_area_authorisations as r where r.id = subject_id for share;
    else
      select r.attorney_id, r.jurisdiction_id, r.updated_at
      into record_attorney, record_jurisdiction, record_updated_at
      from public.practice_area_authorisations as r where r.id = subject_id;
    end if;
  end if;
end;
$function$;

-- The source-grounded evidence fields a reviewer submits, within the
-- application's own form bounds. retrieved_at may not be in the future
-- beyond a small clock allowance.
create function public.verification_evidence_input_valid(
  source_type text,
  source_uri text,
  source_reference text,
  retrieved_at timestamptz,
  verification_method text,
  evidence_summary text,
  evidence_digest text,
  discrepancy_flag boolean
)
returns boolean
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select source_type is not null
    and public.professional_text_within(source_type, 80)
    and source_reference is not null
    and public.professional_text_within(source_reference, 200)
    and public.professional_text_within(source_uri, 500)
    and (source_uri is null or source_uri ~ '^https://[^[:space:]]+$')
    and retrieved_at is not null
    and retrieved_at <= clock_timestamp() + interval '5 minutes'
    and verification_method is not null
    and public.professional_text_within(verification_method, 80)
    and evidence_summary is not null
    and public.professional_text_within(evidence_summary, 2000)
    and public.professional_text_within(evidence_digest, 128)
    and discrepancy_flag is not null;
$function$;

-- ---------------------------------------------------------------------------
-- P3-002: initial applicant creation
-- ---------------------------------------------------------------------------

-- Creates the caller's one Attorney Profile in the applicant state, for the
-- caller's own active User only, and returns it; returns no row when the
-- caller has no active User or already holds a profile (the unique User link
-- decides concurrent starts). No existing profile is changed.
create function public.attorney_start_application()
returns table (id uuid, user_id uuid, profile_state text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_user uuid;
begin
  v_user := public.lock_current_active_user();
  if v_user is null then
    return;
  end if;
  return query
    insert into public.attorney_profiles as p (user_id, profile_state)
    values (v_user, 'applicant')
    on conflict (user_id) do nothing
    returning p.id, p.user_id, p.profile_state;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Attorney professional setup (P3-003 attorney actions)
-- ---------------------------------------------------------------------------

-- Ordinary profile details of the caller's own profile. In the applicant
-- stage display name, headline, biography, and years of experience change;
-- in the approved stage only the presentation fields do, and years of
-- experience must be submitted unchanged. p_expected_state is the stage the
-- caller saw; any other current stage is locked.
create function public.attorney_save_profile_details(
  p_expected_state text,
  p_display_name text,
  p_headline text,
  p_bio text,
  p_years_experience integer
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_before public.attorney_profiles;
  v_after public.attorney_profiles;
  v_time timestamptz;
begin
  if p_expected_state is null
     or p_expected_state not in ('applicant', 'approved')
     or not public.professional_text_within(p_display_name, 120)
     or not public.professional_text_within(p_headline, 160)
     or not public.professional_text_within(p_bio, 2000)
     or (p_years_experience is not null
         and p_years_experience not between 0 and 80) then
    return 'invalid';
  end if;
  v_before := public.lock_current_attorney_profile(true);
  if v_before.id is null
     or v_before.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if v_before.profile_state is distinct from p_expected_state then
    return 'locked';
  end if;
  if p_expected_state = 'approved'
     and p_years_experience is distinct from v_before.years_experience then
    return 'invalid';
  end if;
  update public.attorney_profiles as p
  set display_name = p_display_name,
      headline = p_headline,
      bio = p_bio,
      years_experience = p_years_experience
  where p.id = v_before.id
  returning p.* into v_after;
  v_time := clock_timestamp();
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_before.user_id, 'attorney', 'attorney_profile_details_revised',
    'attorney_profile', v_before.id,
    jsonb_build_object(
      'display_name', v_before.display_name,
      'headline', v_before.headline,
      'bio', v_before.bio,
      'years_experience', v_before.years_experience
    ),
    jsonb_build_object(
      'display_name', v_after.display_name,
      'headline', v_after.headline,
      'bio', v_after.bio,
      'years_experience', v_after.years_experience
    ),
    case when p_expected_state = 'approved' then 'presentation_only' end,
    null, null, v_time
  );
  return 'applied';
end;
$function$;

-- Adds a license claim (p_expected_updated_at null, p_license_id a new id)
-- or revises one of the caller's own claims that has no source-observed
-- status and no linked evidence, at exactly the version the caller saw.
-- Only in the applicant stage. The observed status is never written here.
create function public.attorney_save_license_claim(
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
  if p_license_id is null
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

-- Adds an insurance claim or revises one of the caller's own claims that
-- has no linked evidence, at exactly the version the caller saw. Only in the
-- applicant stage.
create function public.attorney_save_insurance_claim(
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
  if p_record_id is null
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

-- Requests one active practice area in one jurisdiction for the caller's own
-- applicant profile. A request is never an authorisation.
create function public.attorney_request_practice_area(
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
  if p_authorisation_id is null
     or p_jurisdiction_id is null
     or p_practice_area_id is null then
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

-- Withdraws one of the caller's own undecided requests, or renews one the
-- caller withdrew, at exactly the version the caller saw. A staff decision
-- is never changed.
create function public.attorney_change_practice_area_request(
  p_authorisation_id uuid,
  p_intent text,
  p_expected_updated_at timestamptz
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
  v_before public.practice_area_authorisations;
  v_after public.practice_area_authorisations;
  v_expected text;
  v_time timestamptz;
begin
  if p_authorisation_id is null
     or p_expected_updated_at is null
     or p_intent is null
     or p_intent not in ('withdraw', 'renew') then
    return 'invalid';
  end if;
  v_expected := case p_intent when 'withdraw' then 'requested' else 'withdrawn' end;
  v_profile := public.lock_current_attorney_profile(false);
  if v_profile.id is null
     or v_profile.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if v_profile.profile_state <> 'applicant' then
    return 'locked';
  end if;
  select a.* into v_before
  from public.practice_area_authorisations as a
  where a.id = p_authorisation_id and a.attorney_id = v_profile.id
  for no key update;
  if not found then
    return 'denied';
  end if;
  if v_before.status is distinct from v_expected
     or v_before.decided_at is not null then
    return 'locked';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  v_time := clock_timestamp();
  update public.practice_area_authorisations as a
  set status = case p_intent when 'withdraw' then 'withdrawn' else 'requested' end,
      requested_at = case p_intent when 'renew' then v_time else a.requested_at end
  where a.id = v_before.id
  returning a.* into v_after;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_profile.user_id, 'attorney', 'practice_area_request_changed',
    'practice_area_authorisation', v_after.id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_after.status),
    null, null, v_after.jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

-- Submits the caller's own applicant profile for review: applicant to
-- under_review, and nothing else.
create function public.attorney_submit_application()
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_before public.attorney_profiles;
  v_after public.attorney_profiles;
  v_time timestamptz;
begin
  v_before := public.lock_current_attorney_profile(true);
  if v_before.id is null
     or v_before.profile_state in ('suspended', 'removed') then
    return 'denied';
  end if;
  if v_before.profile_state <> 'applicant' then
    return 'locked';
  end if;
  update public.attorney_profiles as p
  set profile_state = 'under_review'
  where p.id = v_before.id
  returning p.* into v_after;
  v_time := clock_timestamp();
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_before.user_id, 'attorney', 'attorney_application_submitted',
    'attorney_profile', v_before.id,
    jsonb_build_object('profile_state', v_before.profile_state),
    jsonb_build_object('profile_state', v_after.profile_state),
    null, null, null, v_time
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Staff verification (P3-003 staff actions)
-- ---------------------------------------------------------------------------

-- Records a source-grounded finding for one professional record: one new
-- immutable evidence row in the record's jurisdiction, attributed to the
-- caller, its link to exactly that record, and optionally (license) the
-- status the source reported or (discipline) the record's status and an
-- added resolved date. Needs the caller's scope for the record's
-- jurisdiction (global for insurance without one), another attorney's
-- profile in under_review, approved, or suspended, and the record at exactly
-- the version the caller saw.
create function public.staff_record_verification_finding(
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
  if p_evidence_id is null
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

-- Records that a verification source could not be consulted for one
-- professional record: an audit event only, never evidence or a status.
create function public.staff_record_source_unavailable(
  p_subject_kind text,
  p_subject_id uuid,
  p_note text
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
begin
  if p_subject_id is null
     or p_subject_kind is null
     or p_subject_kind not in (
       'license', 'insurance', 'discipline', 'practice_area_authorisation'
     )
     or p_note is null
     or not public.professional_text_within(p_note, 500) then
    return 'invalid';
  end if;
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
  from public.professional_record_of(p_subject_kind, p_subject_id, 'share') as r;
  if v_locked_attorney is distinct from v_attorney
     or v_locked_jurisdiction is distinct from v_jurisdiction then
    return 'conflict';
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'verification_source_unavailable',
    case p_subject_kind
      when 'license' then 'license'
      when 'insurance' then 'insurance_record'
      when 'discipline' then 'discipline_record'
      else 'practice_area_authorisation'
    end,
    p_subject_id,
    null,
    jsonb_build_object('note', p_note),
    'verification_source_unavailable', null, v_jurisdiction, clock_timestamp()
  );
  return 'applied';
end;
$function$;

-- Records a discipline finding from a named source for another attorney in a
-- jurisdiction the caller holds: a new discipline record, the evidence it
-- rests on, and their link, all or nothing.
create function public.staff_record_discipline_finding(
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
  if p_discipline_id is null
     or p_evidence_id is null
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

-- Decides one pending practice-area request of another attorney whose
-- profile is under_review or approved: authorised, with an explicit
-- effective start, or refused, at exactly the version the caller saw.
create function public.staff_decide_practice_area(
  p_authorisation_id uuid,
  p_expected_updated_at timestamptz,
  p_decision text,
  p_effective_from timestamptz,
  p_effective_until timestamptz,
  p_note text
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
  v_staff uuid;
  v_target public.attorney_profiles;
  v_before public.practice_area_authorisations;
  v_after public.practice_area_authorisations;
  v_time timestamptz;
begin
  if p_authorisation_id is null
     or p_expected_updated_at is null
     or p_decision is null
     or p_decision not in ('authorised', 'refused')
     or p_note is null
     or not public.professional_text_within(p_note, 500)
     or (p_decision = 'authorised' and p_effective_from is null)
     or (p_decision = 'refused'
         and (p_effective_from is not null or p_effective_until is not null))
     or (p_effective_from is not null and p_effective_until is not null
         and p_effective_until < p_effective_from) then
    return 'invalid';
  end if;
  select r.record_attorney, r.record_jurisdiction
  into v_attorney, v_jurisdiction
  from public.professional_record_of(
    'practice_area_authorisation', p_authorisation_id, 'none'
  ) as r;
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
  if v_target.profile_state not in ('under_review', 'approved') then
    return 'locked';
  end if;
  select a.* into v_before
  from public.practice_area_authorisations as a
  where a.id = p_authorisation_id
  for no key update;
  if v_before.attorney_id is distinct from v_attorney
     or v_before.jurisdiction_id is distinct from v_jurisdiction then
    return 'conflict';
  end if;
  if v_before.status is distinct from 'requested'
     or v_before.decided_at is not null then
    return 'locked';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    return 'conflict';
  end if;
  v_time := clock_timestamp();
  begin
    update public.practice_area_authorisations as a
    set status = p_decision,
        decided_at = v_time,
        effective_from = p_effective_from,
        effective_until = p_effective_until
    where a.id = v_before.id
    returning a.* into v_after;
  exception
    when check_violation then
      return 'invalid';
  end;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'practice_area_authorisation_decided',
    'practice_area_authorisation', v_after.id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object(
      'status', v_after.status,
      'decided_at', v_after.decided_at,
      'effective_from', v_after.effective_from,
      'effective_until', v_after.effective_until,
      'note', p_note
    ),
    null, null, v_after.jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

-- One supported review transition of another attorney's profile, with the
-- global scope: approve (under_review to approved), request_information
-- (under_review to applicant, with a message to the applicant), or suspend
-- (approved to suspended).
create function public.staff_change_profile_stage(
  p_attorney_id uuid,
  p_intent text,
  p_message text,
  p_note text
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
  v_before public.attorney_profiles;
  v_after public.attorney_profiles;
  v_from text;
  v_to text;
  v_time timestamptz;
begin
  if p_attorney_id is null
     or p_intent is null
     or p_intent not in ('approve', 'request_information', 'suspend')
     or (p_intent = 'request_information'
         and (p_message is null
              or not public.professional_text_within(p_message, 1000)
              or p_note is not null))
     or (p_intent <> 'request_information'
         and (p_message is not null
              or not public.professional_text_within(p_note, 500))) then
    return 'invalid';
  end if;
  v_from := case p_intent when 'suspend' then 'approved' else 'under_review' end;
  v_to := case p_intent
    when 'approve' then 'approved'
    when 'request_information' then 'applicant'
    else 'suspended'
  end;
  v_staff := public.lock_current_verification_staff(null);
  if v_staff is null then
    return 'denied';
  end if;
  select p.* into v_before
  from public.attorney_profiles as p
  where p.id = p_attorney_id
  for no key update;
  if not found or v_before.user_id = v_staff then
    return 'denied';
  end if;
  if v_before.profile_state is distinct from v_from then
    return 'locked';
  end if;
  update public.attorney_profiles as p
  set profile_state = v_to
  where p.id = v_before.id
  returning p.* into v_after;
  v_time := clock_timestamp();
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff',
    case when p_intent = 'request_information'
      then 'attorney_information_requested'
      else 'attorney_profile_state_changed' end,
    'attorney_profile', v_before.id,
    jsonb_build_object('profile_state', v_before.profile_state),
    case when p_intent = 'request_information'
      then jsonb_build_object(
        'profile_state', v_after.profile_state,
        'message_to_applicant', p_message
      )
      else jsonb_build_object(
        'profile_state', v_after.profile_state,
        'staff_note', p_note
      )
    end,
    'staff_review_' || p_intent, null, null, v_time
  );
  return 'applied';
end;
$function$;

-- Persists one consequential Eligibility determination for another attorney
-- in a jurisdiction the caller holds, as a new immutable evaluation. The
-- server application computes the assessment; the database decides the
-- actor and authority, records the time, and admits only a structurally
-- valid evaluation whose every policy, record, and evidence reference names
-- an existing row of this attorney and jurisdiction, assessed no more than
-- fifteen minutes earlier.
create function public.staff_record_eligibility_evaluation(
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
  v_target public.attorney_profiles;
  v_time timestamptz;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_evaluation_id is null
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
  if p_context_type = 'practice_area'
     and not exists (
       select 1 from public.practice_areas as a where a.id = p_context_id
     ) then
    return 'invalid';
  end if;
  if exists (
       select 1 from jsonb_array_elements(p_policy_references) as r
       where jsonb_typeof(r) <> 'object'
          or (r ->> 'policy_type_code') is distinct from 'attorney_eligibility'
          or not exists (
            select 1 from public.policy_versions as v
            where v.id::text = r ->> 'policy_version_id'
              and v.policy_type_code = 'attorney_eligibility'
              and v.jurisdiction_id = p_jurisdiction_id
              and v.version_label = r ->> 'version_label'
          )
     )
     or exists (
       select 1 from jsonb_array_elements_text(p_evidence_references -> 'license_ids') as x
       where not exists (
         select 1 from public.licenses as l
         where l.id::text = x and l.attorney_id = p_attorney_id
           and l.jurisdiction_id = p_jurisdiction_id
       )
     )
     or exists (
       select 1 from jsonb_array_elements_text(p_evidence_references -> 'insurance_record_ids') as x
       where not exists (
         select 1 from public.insurance_records as i
         where i.id::text = x and i.attorney_id = p_attorney_id
           and i.jurisdiction_id = p_jurisdiction_id
       )
     )
     or exists (
       select 1 from jsonb_array_elements_text(p_evidence_references -> 'discipline_record_ids') as x
       where not exists (
         select 1 from public.discipline_records as d
         where d.id::text = x and d.attorney_id = p_attorney_id
           and d.jurisdiction_id = p_jurisdiction_id
       )
     )
     or exists (
       select 1 from jsonb_array_elements_text(p_evidence_references -> 'practice_area_authorisation_ids') as x
       where not exists (
         select 1 from public.practice_area_authorisations as a
         where a.id::text = x and a.attorney_id = p_attorney_id
           and a.jurisdiction_id = p_jurisdiction_id
       )
     )
     or exists (
       select 1 from jsonb_array_elements_text(p_evidence_references -> 'evidence_ids') as x
       where not exists (
         select 1
         from public.verification_evidence_subjects as s
         left join public.licenses as l on l.id = s.license_id
         left join public.insurance_records as i on i.id = s.insurance_record_id
         left join public.discipline_records as d on d.id = s.discipline_record_id
         left join public.practice_area_authorisations as a
           on a.id = s.practice_area_authorisation_id
         where s.verification_evidence_id::text = x
           and coalesce(l.attorney_id, i.attorney_id, d.attorney_id, a.attorney_id)
             = p_attorney_id
       )
     ) then
    return 'invalid';
  end if;
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
  v_time := clock_timestamp();
  if p_as_of > v_time + interval '1 minute'
     or p_as_of < v_time - interval '15 minutes' then
    return 'invalid';
  end if;
  begin
    insert into public.eligibility_evaluations (
      id, attorney_id, jurisdiction_id, context_type, context_id,
      evaluated_at, policy_references, result, factor_results,
      evidence_references, as_of
    ) values (
      p_evaluation_id, p_attorney_id, p_jurisdiction_id, p_context_type,
      p_context_id, v_time, p_policy_references, p_result, p_factor_results,
      p_evidence_references, p_as_of
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
      'result', p_result,
      'attorney_id', p_attorney_id,
      'practice_area_id', p_context_id,
      'as_of', p_as_of
    ),
    null, p_policy_references, p_jurisdiction_id, v_time
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges: helpers for no API role; operations for authenticated
-- only (never anon, service_role, or PUBLIC).
-- ---------------------------------------------------------------------------

revoke all on function public.professional_text_within(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.lock_current_active_user()
  from public, anon, authenticated, service_role;
revoke all on function public.lock_current_verification_staff(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.lock_current_attorney_profile(boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.professional_record_of(text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.verification_evidence_input_valid(
  text, text, text, timestamptz, text, text, text, boolean
) from public, anon, authenticated, service_role;

revoke all on function public.attorney_start_application()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_start_application()
  to authenticated;

revoke all on function public.attorney_save_profile_details(
  text, text, text, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.attorney_save_profile_details(
  text, text, text, text, integer
) to authenticated;

revoke all on function public.attorney_save_license_claim(
  uuid, timestamptz, uuid, text, text, date, date
) from public, anon, authenticated, service_role;
grant execute on function public.attorney_save_license_claim(
  uuid, timestamptz, uuid, text, text, date, date
) to authenticated;

revoke all on function public.attorney_save_insurance_claim(
  uuid, timestamptz, uuid, text, text, text, bigint, bigint, text, date, date
) from public, anon, authenticated, service_role;
grant execute on function public.attorney_save_insurance_claim(
  uuid, timestamptz, uuid, text, text, text, bigint, bigint, text, date, date
) to authenticated;

revoke all on function public.attorney_request_practice_area(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_request_practice_area(uuid, uuid, uuid)
  to authenticated;

revoke all on function public.attorney_change_practice_area_request(
  uuid, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.attorney_change_practice_area_request(
  uuid, text, timestamptz
) to authenticated;

revoke all on function public.attorney_submit_application()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_submit_application()
  to authenticated;

revoke all on function public.staff_record_verification_finding(
  uuid, text, uuid, timestamptz, text, text, text, timestamptz, text, text,
  text, boolean, text, text, date
) from public, anon, authenticated, service_role;
grant execute on function public.staff_record_verification_finding(
  uuid, text, uuid, timestamptz, text, text, text, timestamptz, text, text,
  text, boolean, text, text, date
) to authenticated;

revoke all on function public.staff_record_source_unavailable(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_record_source_unavailable(text, uuid, text)
  to authenticated;

revoke all on function public.staff_record_discipline_finding(
  uuid, uuid, uuid, uuid, text, text, date, date, text, text, text, text,
  timestamptz, text, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.staff_record_discipline_finding(
  uuid, uuid, uuid, uuid, text, text, date, date, text, text, text, text,
  timestamptz, text, text, text, boolean
) to authenticated;

revoke all on function public.staff_decide_practice_area(
  uuid, timestamptz, text, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.staff_decide_practice_area(
  uuid, timestamptz, text, timestamptz, timestamptz, text
) to authenticated;

revoke all on function public.staff_change_profile_stage(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_change_profile_stage(uuid, text, text, text)
  to authenticated;

revoke all on function public.staff_record_eligibility_evaluation(
  uuid, uuid, uuid, text, uuid, timestamptz, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.staff_record_eligibility_evaluation(
  uuid, uuid, uuid, text, uuid, timestamptz, text, jsonb, jsonb, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- Retire the direct privileged DML on the eight M4 relations. SELECT stays
-- for the existing server reads; table-level revocation also removes the
-- earlier column-level UPDATE grant on verification_evidence_subjects.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.attorney_profiles,
  public.licenses,
  public.insurance_records,
  public.discipline_records,
  public.practice_area_authorisations,
  public.verification_evidence,
  public.verification_evidence_subjects,
  public.eligibility_evaluations
from public, anon, authenticated, service_role;

comment on table public.verification_evidence is
  'Protected historical evidence: written only through the P3-904 staff verification functions, together with its subject link and audit event; application service privileges permit SELECT only. Professional linkage correction never rewrites evidence.';

comment on function public.attorney_start_application() is
  'P3-002 initial applicant creation for the caller''s own active User only; returns the created applicant profile, or no row when none is created.';
comment on function public.attorney_save_profile_details(text, text, text, text, integer) is
  'Caller''s own Attorney Profile details with atomic audit; actor from auth.uid(); rows locked User -> profile.';
comment on function public.attorney_save_license_claim(uuid, timestamptz, uuid, text, text, date, date) is
  'Caller''s own license claim insert or guarded revision with atomic audit; applicant stage only.';
comment on function public.attorney_save_insurance_claim(uuid, timestamptz, uuid, text, text, text, bigint, bigint, text, date, date) is
  'Caller''s own insurance claim insert or guarded revision with atomic audit; applicant stage only.';
comment on function public.attorney_request_practice_area(uuid, uuid, uuid) is
  'Caller''s own practice-area request with atomic audit; applicant stage only.';
comment on function public.attorney_change_practice_area_request(uuid, text, timestamptz) is
  'Caller''s own practice-area request withdrawal or renewal with atomic audit; never a staff decision.';
comment on function public.attorney_submit_application() is
  'Caller''s own applicant profile to under_review with atomic audit.';
comment on function public.staff_record_verification_finding(uuid, text, uuid, timestamptz, text, text, text, timestamptz, text, text, text, boolean, text, text, date) is
  'Evidence, subject link, optional observed or discipline status, and audit in one transaction; staff authority locked and decided at the write.';
comment on function public.staff_record_source_unavailable(text, uuid, text) is
  'Audit-only record of an unavailable verification source; staff authority locked and decided at the write.';
comment on function public.staff_record_discipline_finding(uuid, uuid, uuid, uuid, text, text, date, date, text, text, text, text, timestamptz, text, text, text, boolean) is
  'Discipline record, evidence, link, and audit in one transaction; staff authority locked and decided at the write.';
comment on function public.staff_decide_practice_area(uuid, timestamptz, text, timestamptz, timestamptz, text) is
  'Pending practice-area decision and audit in one transaction; staff authority locked and decided at the write.';
comment on function public.staff_change_profile_stage(uuid, text, text, text) is
  'Supported review transition and audit in one transaction; global staff authority locked and decided at the write.';
comment on function public.staff_record_eligibility_evaluation(uuid, uuid, uuid, text, uuid, timestamptz, text, jsonb, jsonb, jsonb) is
  'Immutable eligibility evaluation and audit in one transaction; staff authority locked and decided at the write; references validated.';
