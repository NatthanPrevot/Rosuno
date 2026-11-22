-- MVP-001 S11 pass 2 (11 of 16): attorney lifecycle operations, rejoin prevention, the attorney waitlist and the
-- compliance workspace reads (MVP-001 Packet S11 "compliance workspace", "operations dashboard"; MBS sections 16
-- "Operations" and 18.4 "attorney applications; verification; attorney compliance; licenses; insurance; discipline";
-- TA sections 18 "attorney operations incl. suspensions/removals" and "compliance: ... complaints, legal holds", 40
-- and 41; DM section 5 (Attorney: applicant -> under_review -> approved -> suspended -> removed); MB sections 19, 22
-- and 81 to 90; PS section 30.4; PM section 1 INV-11, rows 37 to 41).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). This migration adds one command,
-- replaces one command and three S5 reads forward, adds two triggers on existing relations with their functions and
-- four reads.
--
-- Attorney lifecycle commands (EXECUTE for authenticated only; security definer; search_path pinned; lock waits
-- bounded). Both run under exactly the capability and scope rule of the existing suspend intent: the caller's User,
-- Staff Profile and a global manage_attorney_verification grant locked FOR SHARE at aal2
-- (lock_current_verification_staff(null)), and a staff member never acts on their own Attorney Profile.
-- - staff_change_attorney_lifecycle (new; the P3-904 staff_change_profile_stage keeps its three intents and their
--   outcomes exactly): reinstate (suspended -> approved) and remove (approved | suspended -> removed), each with a
--   required staff note of at most 500 characters stored only on its audit event (action
--   attorney_profile_state_changed, reason staff_review_reinstate or staff_review_remove, the before and after
--   stage). Removal is final: no command moves a removed profile anywhere. Removal changes only the profile's stage:
--   every licence, insurance record, discipline record, evidence row, Request, Consultation, payment, message,
--   document and audit event stays exactly as it was. Outcomes: applied, invalid, denied (no capability, an unknown
--   profile or the caller's own), locked (the stage does not allow the intent), review_required (a reinstatement
--   while a rejoin review of the profile is open). The S8 deferred trigger on attorney_profiles.profile_state
--   (20261124030000, unchanged) routes every open matter of the attorney to review at commit, for both intents.
-- - staff_change_profile_stage (P3-904, replaced forward with its signature, outcomes, locks, audit and every rule
--   kept): an approval first runs the rejoin detection below for the profile (so a match created since the
--   submission is still found) and answers review_required, changing nothing else, while a rejoin review of the
--   profile is open. The other intents are unchanged.
--
-- Rejoin prevention (MB section 19: evasion should be difficult and detectable, not impossible; detection never
-- rejects or changes an application by itself). A profile's licence matches when its jurisdiction and its
-- normalized licence number (license_number_normalized: upper-case ASCII letters and digits only, every other
-- character dropped; an empty result never matches) equal those of a licence of a different Attorney Profile whose
-- stage is removed. attorney_rejoin_detect opens, for a profile that is not removed, at most one compliance review
-- item: type rejoin_review (compliance family, 20261127080000), severity high, source and canonical object the
-- applying profile, the licence's jurisdiction, evidence holding only the two profile identifiers and the two
-- licence identifiers; audited once by the S8 decision_open_review (system actor). One open item per profile (the S7
-- unique key), and a match whose removed licence already has an item for that profile (open or resolved) never
-- opens another, so a resolution is final for that match and only a new match opens a new item. It runs:
-- - when a licence claim is saved (trigger licenses_rejoin_detection: after insert, or after an update of the
--   number or jurisdiction, of any licence);
-- - when an application is submitted (trigger attorney_profiles_rejoin_detection: after an update of profile_state
--   to under_review);
-- - at approval (staff_change_profile_stage, above).
-- The detection takes the applying profile FOR SHARE first, so it serializes with an approval (which holds the
-- profile FOR NO KEY UPDATE): either the approval sees the open item, or the approval committed first. An exact
-- duplicate of a removed profile's licence number in the same jurisdiction is already refused by the P1 unique key
-- (attorney_save_license_claim answers conflict); the detection covers every other variant that normalizes equal. A
-- holder of manage_compliance_reviews resolves the item with notes through the existing family-aware resolve
-- command (20261127030000), after which approval follows the normal rules. Other identity signals (identity
-- documents, payment identity, contact details) are follow-ups listed with the S11 report.
--
-- Reads (EXECUTE for authenticated only; stable security definer; search_path pinned; aal2 through the existing
-- capability predicates; no row without the capability, and an unknown or out-of-scope record answers nothing):
-- - staff_compliance_summary: counts only, one group per capability the caller holds: attorney_profiles by stage and
--   waitlist members (manage_attorney_verification, by jurisdiction: a scoped grant counts the profiles holding a
--   licence in one of its jurisdictions), open compliance review items by type (manage_compliance_reviews, global),
--   Complaint Cases by state (manage_complaints, by the case's jurisdiction; a case without one needs a global
--   grant), active Legal Holds (manage_legal_holds, global);
-- - staff_compliance_records: one page (25 rows, plus one) of one section, for manage_attorney_verification by
--   jurisdiction: license_expiry and insurance_expiry (the recorded end dates of the licences and insurance records
--   of profiles under review, approved or suspended, soonest first; past dates included), evidence_age (the
--   licences and insurance records of approved profiles in a jurisdiction whose in-force eligibility policy
--   eligibility_selected_policy selects: the latest evidence retrieval and the date the policy's evidence maximum age
--   is reached, soonest first, records without evidence first), under_review, approved, suspended and removed (profiles by
--   stage, most recently changed first; a scoped grant sees the profiles holding a licence in one of its
--   jurisdictions), discipline (discipline records, most recently recorded first) and waitlist (MB section 22: every
--   licence claim in a jurisdiction whose lifecycle_state is waitlist is that attorney's waitlist membership there;
--   attorney, stage and claim time, earliest first). No threshold is applied anywhere: every date is shown as
--   recorded and staff decide;
-- - staff_attorney_profile: one Attorney Profile for the lifecycle commands (id, display name, stage, last change and
--   whether a rejoin review of it is open), under the commands' own rule (the global manage_attorney_verification
--   grant at aal2); nothing for anyone else or for an unknown id;
-- - staff_policy_changes: one page of policy version status changes (the policy_version.transitioned audit events
--   with the version's type and scope, the stage before and after, newest first) for manage_policy_configuration
--   covering the version's scope.
-- The attorney waitlist (MB section 22: an attorney licensed in an inactive jurisdiction has no marketplace
-- visibility, referrals, consultations or eligibility claims there). The S5 discovery reads do not read the
-- jurisdiction's lifecycle state (20261121020000: nobody is listed where no eligibility policy applies), so until now
-- the waitlist depended on configuration alone. Three S5 reads are replaced forward, each with exactly one added
-- condition, so a jurisdiction whose lifecycle_state is waitlist presents and lists nobody whatever its
-- configuration: discovery_presented_set (the directory and the presented set referral_create checks, so no Referral
-- can be created there), discovery_jurisdiction_listed (the discovery filters) and public_attorney_profile (the
-- jurisdictions a public profile lists). Every other state keeps exactly its S5 behaviour (development proofs use
-- unsupported jurisdictions with development configuration). The attorney's own waitlist state is shown from the
-- jurisdiction's lifecycle state the professional page already reads; it needs no database change. Panels, surveys, referral quality and every other regulatory-mode-conditional
-- section are not presented (MBS section 18.4).

-- ---------------------------------------------------------------------------
-- Rejoin detection (internal).
-- ---------------------------------------------------------------------------

create function public.license_number_normalized(p_number text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select nullif(regexp_replace(upper(p_number collate "C"), '[^A-Z0-9]', '', 'g'), '');
$function$;

create function public.attorney_rejoin_detect(p_attorney uuid)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_state text;
  v_match record;
begin
  select p.profile_state into v_state
  from public.attorney_profiles as p
  where p.id = p_attorney
  for share;
  if not found or v_state = 'removed' then
    return null;
  end if;
  select l.id as license_id, l.jurisdiction_id, r.id as removed_license_id, r.attorney_id as removed_attorney_id
  into v_match
  from public.licenses as l
  join public.licenses as r
    on r.jurisdiction_id = l.jurisdiction_id
   and r.attorney_id <> l.attorney_id
   and public.license_number_normalized(r.license_number) = public.license_number_normalized(l.license_number)
  join public.attorney_profiles as q on q.id = r.attorney_id and q.profile_state = 'removed'
  where l.attorney_id = p_attorney
    and public.license_number_normalized(l.license_number) is not null
    and not exists (
      select 1 from public.reconciliation_exceptions as e
      where e.exception_type = 'rejoin_review'
        and e.source_type = 'attorney_profile'
        and e.source_id = p_attorney
        and e.evidence_reference ->> 'removed_license_id' = r.id::text
    )
  order by l.created_at, l.id, r.created_at, r.id
  limit 1;
  if v_match.license_id is null then
    return null;
  end if;
  return public.decision_open_review(
    'rejoin_review', 'attorney_profile', p_attorney, 'high', v_match.jurisdiction_id,
    jsonb_build_object(
      'attorney_profile_id', p_attorney,
      'license_id', v_match.license_id,
      'removed_attorney_profile_id', v_match.removed_attorney_id,
      'removed_license_id', v_match.removed_license_id
    )
  );
end;
$function$;

create function public.attorney_rejoin_review_open(p_attorney uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select exists (
    select 1 from public.reconciliation_exceptions as e
    where e.exception_type = 'rejoin_review'
      and e.source_type = 'attorney_profile'
      and e.source_id = p_attorney
      and e.status = 'open'
  );
$function$;

create function public.attorney_rejoin_license_saved()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  perform public.attorney_rejoin_detect(new.attorney_id);
  return null;
end;
$function$;

create function public.attorney_rejoin_application_submitted()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  perform public.attorney_rejoin_detect(new.id);
  return null;
end;
$function$;

create trigger licenses_rejoin_detection
after insert or update of license_number, jurisdiction_id on public.licenses
for each row
execute function public.attorney_rejoin_license_saved();

create trigger attorney_profiles_rejoin_detection
after update of profile_state on public.attorney_profiles
for each row
when (new.profile_state = 'under_review' and old.profile_state is distinct from 'under_review')
execute function public.attorney_rejoin_application_submitted();

-- ---------------------------------------------------------------------------
-- The profile review command (P3-904, replaced forward: approval refuses while a rejoin review is open).
-- ---------------------------------------------------------------------------

create or replace function public.staff_change_profile_stage(
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
  -- MVP-001 S11 (MB section 19): approval waits for the human resolution of an open rejoin review.
  if p_intent = 'approve' then
    perform public.attorney_rejoin_detect(v_before.id);
    if public.attorney_rejoin_review_open(v_before.id) then
      return 'review_required';
    end if;
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

-- ---------------------------------------------------------------------------
-- Reinstatement and removal.
-- ---------------------------------------------------------------------------

create function public.staff_change_attorney_lifecycle(
  p_attorney_id uuid,
  p_intent text,
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
  v_to text;
begin
  if p_attorney_id is null
     or p_intent is null
     or p_intent not in ('reinstate', 'remove')
     or p_note is null
     or not public.professional_text_within(p_note, 500) then
    return 'invalid';
  end if;
  v_to := case p_intent when 'reinstate' then 'approved' else 'removed' end;
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
  if not (
    (p_intent = 'reinstate' and v_before.profile_state = 'suspended')
    or (p_intent = 'remove' and v_before.profile_state in ('approved', 'suspended'))
  ) then
    return 'locked';
  end if;
  if p_intent = 'reinstate' and public.attorney_rejoin_review_open(v_before.id) then
    return 'review_required';
  end if;
  update public.attorney_profiles as p
  set profile_state = v_to
  where p.id = v_before.id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'attorney_profile_state_changed', 'attorney_profile', v_before.id,
    jsonb_build_object('profile_state', v_before.profile_state),
    jsonb_build_object('profile_state', v_to, 'staff_note', p_note),
    'staff_review_' || p_intent, null, null, clock_timestamp()
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- The attorney waitlist (MB section 22): no marketplace visibility, no Referral.
-- ---------------------------------------------------------------------------

-- The S5 discovery reads (20261121020000), replaced forward with their signatures, volatility, security modes,
-- search_paths, owners, privileges and comments kept; the only change in each is the waitlist condition.

create or replace function public.discovery_presented_set(
  p_jurisdiction uuid,
  p_practice_area uuid,
  p_availability text,
  p_referral uuid
)
returns table (
  attorney_id uuid,
  display_name text,
  headline text,
  years_experience smallint,
  presentable boolean,
  passes_practice_area boolean,
  available_now boolean,
  has_scheduled_availability boolean,
  passes_availability boolean,
  display_position integer
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  -- MVP-001 S11 (MB section 22): a jurisdiction on the waitlist presents nobody.
  if p_jurisdiction is null
     or exists (
       select 1 from public.jurisdictions as w
       where w.id = p_jurisdiction and w.lifecycle_state = 'waitlist'
     )
     or p_availability is null
     or p_availability not in ('any', 'instant', 'scheduled')
     or (p_practice_area is not null
         and not exists (
           select 1 from public.practice_areas as a where a.id = p_practice_area and a.active
         )) then
    return;
  end if;
  return query
  with candidates as (
    select p.id, p.display_name, p.headline, p.years_experience
    from public.attorney_profiles as p
    join public.users as u on u.id = p.user_id
    where p.profile_state = 'approved'
      and u.account_state = 'active'
      and exists (
        select 1 from public.licenses as l
        where l.attorney_id = p.id and l.jurisdiction_id = p_jurisdiction
      )
    order by p.id
    limit 500
  ),
  eligible as (
    select c.*
    from candidates as c
    where case
      when p_referral is null then
        (public.eligibility_assessment(c.id, p_jurisdiction, null, v_now) ->> 'result') = 'eligible'
      else exists (
        select 1 from public.referral_eligible_pool_entries as e
        where e.referral_id = p_referral and e.attorney_id = c.id
      )
    end
  ),
  flagged as (
    select
      e.id,
      e.display_name,
      e.headline,
      e.years_experience,
      public.discovery_presentable_text(e.display_name) is not null as presentable,
      (p_practice_area is null
       or (public.eligibility_assessment(e.id, p_jurisdiction, p_practice_area, v_now) ->> 'result')
          = 'eligible') as passes_practice_area,
      public.discovery_available_now(e.id) as available_now,
      exists (select 1 from public.scheduling_offered_windows(e.id, p_jurisdiction, 1)) as has_scheduled
    from eligible as e
  ),
  judged as (
    select
      f.*,
      (p_availability = 'any'
       or (p_availability = 'instant' and f.available_now)
       or (p_availability = 'scheduled' and f.has_scheduled)) as passes_availability
    from flagged as f
  ),
  ordered as (
    select
      j.id,
      row_number() over (
        order by lower(j.display_name) collate "C", j.display_name collate "C", j.id
      )::integer as position
    from judged as j
    where j.presentable and j.passes_practice_area and j.passes_availability
  )
  select
    j.id,
    j.display_name,
    j.headline,
    j.years_experience,
    j.presentable,
    j.passes_practice_area,
    j.available_now,
    j.has_scheduled,
    j.passes_availability,
    o.position
  from judged as j
  left join ordered as o on o.id = j.id
  order by o.position nulls last, j.id;
end;
$function$;

create or replace function public.discovery_jurisdiction_listed(p_jurisdiction uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  -- MVP-001 S11 (MB section 22): a jurisdiction on the waitlist is never listed.
  select not exists (
    select 1 from public.jurisdictions as w
    where w.id = p_jurisdiction and w.lifecycle_state = 'waitlist'
  ) and exists (
    select 1
    from (
      select p.id, p.display_name
      from public.attorney_profiles as p
      join public.users as u on u.id = p.user_id
      where p.profile_state = 'approved'
        and u.account_state = 'active'
        and exists (
          select 1 from public.licenses as l
          where l.attorney_id = p.id and l.jurisdiction_id = p_jurisdiction
        )
      order by p.id
      limit 500
    ) as c
    where public.discovery_presentable_text(c.display_name) is not null
      and (public.eligibility_assessment(c.id, p_jurisdiction, null, clock_timestamp()) ->> 'result')
          = 'eligible'
  );
$function$;

create or replace function public.public_attorney_profile(p_attorney_id uuid, p_jurisdiction_id uuid)
returns table (
  attorney_id uuid,
  display_name text,
  headline text,
  bio text,
  years_experience smallint,
  jurisdictions jsonb,
  practice_areas text[],
  available_now boolean,
  upcoming_windows jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_profile public.attorney_profiles;
  v_listed jsonb;
  v_areas text[];
  v_windows jsonb := '[]'::jsonb;
begin
  if p_attorney_id is null then
    return;
  end if;
  select p.* into v_profile
  from public.attorney_profiles as p
  join public.users as u on u.id = p.user_id
  where p.id = p_attorney_id
    and p.profile_state = 'approved'
    and u.account_state = 'active';
  if not found or public.discovery_presentable_text(v_profile.display_name) is null then
    return;
  end if;
  select coalesce(
           jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code, 'name', x.name)
                     order by x.name collate "C", x.code collate "C"),
           '[]'::jsonb)
  into v_listed
  from (
    select j.id, j.code, j.name
    from public.jurisdictions as j
    -- MVP-001 S11 (MB section 22): a jurisdiction on the waitlist is never listed.
    where j.lifecycle_state <> 'waitlist'
      and exists (
        select 1 from public.licenses as l
        where l.attorney_id = p_attorney_id and l.jurisdiction_id = j.id
      )
      and (public.eligibility_assessment(p_attorney_id, j.id, null, clock_timestamp()) ->> 'result')
          = 'eligible'
    order by j.name collate "C", j.code collate "C"
    limit 20
  ) as x;
  if jsonb_array_length(v_listed) = 0
     or (p_jurisdiction_id is not null
         and not exists (
           select 1 from jsonb_array_elements(v_listed) as e
           where e ->> 'id' = p_jurisdiction_id::text
         )) then
    return;
  end if;
  if p_jurisdiction_id is not null then
    v_areas := public.discovery_practice_area_names(p_attorney_id, p_jurisdiction_id);
    select coalesce(
             jsonb_agg(jsonb_build_object('starts_at', w.window_start, 'ends_at', w.window_end)
                       order by w.window_start),
             '[]'::jsonb)
    into v_windows
    from public.scheduling_offered_windows(p_attorney_id, p_jurisdiction_id, 5) as w;
  else
    select coalesce(array_agg(distinct n.name order by n.name), array[]::text[])
    into v_areas
    from jsonb_array_elements(v_listed) as e
    cross join lateral unnest(
      public.discovery_practice_area_names(p_attorney_id, (e ->> 'id')::uuid)
    ) as n(name);
  end if;
  return query select
    v_profile.id,
    v_profile.display_name,
    public.discovery_presentable_text(v_profile.headline),
    public.discovery_presentable_text(v_profile.bio),
    v_profile.years_experience,
    v_listed,
    v_areas,
    public.discovery_available_now(v_profile.id),
    v_windows;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Compliance reads.
-- ---------------------------------------------------------------------------

-- Whether the caller holds manage_attorney_verification covering an Attorney Profile: a global grant, or a grant
-- for the jurisdiction of one of the profile's licences (internal; aal2 through the existing predicate).
create function public.compliance_profile_visible(p_attorney uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select public.has_manage_attorney_verification_scope(null, false)
    or exists (
      select 1 from public.licenses as l
      where l.attorney_id = p_attorney
        and public.has_manage_attorney_verification_scope(l.jurisdiction_id, false)
    );
$function$;

create function public.staff_compliance_summary()
returns table (metric text, dimension text, value bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
begin
  if public.has_manage_attorney_verification_scope(null, true) is true then
    return query
      select 'attorney_profiles'::text, s.state,
        (select count(*) from public.attorney_profiles as a
         where a.profile_state = s.state and public.compliance_profile_visible(a.id))::bigint
      from unnest(array['applicant', 'under_review', 'approved', 'suspended', 'removed']) with ordinality as s(state, n)
      order by s.n;
    return query
      select 'waitlist'::text, 'members'::text, count(*)::bigint
      from public.licenses as l
      join public.jurisdictions as j on j.id = l.jurisdiction_id and j.lifecycle_state = 'waitlist'
      where public.has_manage_attorney_verification_scope(l.jurisdiction_id, false);
  end if;
  if public.has_staff_capability('manage_compliance_reviews', null, false) is true then
    return query
      select 'compliance_reviews'::text, s.type,
        (select count(*) from public.reconciliation_exceptions as e
         where e.exception_type = s.type and e.status = 'open')::bigint
      from unnest(array[
        'eligibility_change_review', 'jurisdiction_change_review', 'rejoin_review', 'client_account_review'
      ]) with ordinality as s(type, n)
      order by s.n;
  end if;
  if public.has_staff_capability('manage_complaints', null, true) is true then
    return query
      select 'complaints'::text, s.state,
        (select count(*) from public.complaint_cases as c
         where c.state = s.state and public.has_staff_capability('manage_complaints', c.jurisdiction_id, false))::bigint
      from unnest(array['opened', 'in_review', 'escalated', 'resolved']) with ordinality as s(state, n)
      order by s.n;
  end if;
  if public.has_staff_capability('manage_legal_holds', null, false) is true then
    return query
      select 'legal_holds'::text, 'active'::text, count(*)::bigint
      from public.legal_holds as h
      where h.released_at is null;
  end if;
end;
$function$;

create function public.staff_compliance_records(p_section text, p_offset integer)
returns table (
  record_type text,
  record_id uuid,
  attorney_id uuid,
  display_name text,
  profile_state text,
  jurisdiction_id uuid,
  status_code text,
  recorded_at timestamptz,
  lapses_on date
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
begin
  if p_section is null
     or p_offset is null
     or p_offset < 0
     or p_offset > 100000
     or public.has_manage_attorney_verification_scope(null, true) is not true then
    return;
  end if;
  if p_section = 'license_expiry' then
    return query
      select 'license'::text, l.id, a.id, a.display_name, a.profile_state, l.jurisdiction_id, null::text,
        l.updated_at, l.effective_until
      from public.licenses as l
      join public.attorney_profiles as a on a.id = l.attorney_id
      where l.effective_until is not null
        and a.profile_state in ('under_review', 'approved', 'suspended')
        and public.has_manage_attorney_verification_scope(l.jurisdiction_id, false)
      order by l.effective_until, l.id
      offset p_offset limit 26;
  elsif p_section = 'insurance_expiry' then
    return query
      select 'insurance'::text, i.id, a.id, a.display_name, a.profile_state, i.jurisdiction_id, null::text,
        i.updated_at, i.coverage_until
      from public.insurance_records as i
      join public.attorney_profiles as a on a.id = i.attorney_id
      where i.coverage_until is not null
        and a.profile_state in ('under_review', 'approved', 'suspended')
        and public.has_manage_attorney_verification_scope(i.jurisdiction_id, false)
      order by i.coverage_until, i.id
      offset p_offset limit 26;
  elsif p_section = 'evidence_age' then
    return query
      with records as (
        select 'license'::text as kind, l.id, l.attorney_id, l.jurisdiction_id
        from public.licenses as l
        union all
        select 'insurance'::text, i.id, i.attorney_id, i.jurisdiction_id
        from public.insurance_records as i
      ),
      scoped as (
        select r.*, a.display_name, a.profile_state
        from records as r
        join public.attorney_profiles as a on a.id = r.attorney_id
        where a.profile_state = 'approved'
          and public.has_manage_attorney_verification_scope(r.jurisdiction_id, false)
      ),
      policies as (
        select x.jurisdiction_id, public.eligibility_selected_policy(x.jurisdiction_id, statement_timestamp()) as p
        from (select distinct s.jurisdiction_id from scoped as s) as x
      ),
      aged as (
        select s.*,
          (
            select max(v.retrieved_at)
            from public.verification_evidence_subjects as vs
            join public.verification_evidence as v on v.id = vs.verification_evidence_id
            where (s.kind = 'license' and vs.license_id = s.id)
               or (s.kind = 'insurance' and vs.insurance_record_id = s.id)
          ) as retrieved_at,
          case s.kind
            when 'license' then (p.p ->> 'license_age')::numeric
            else (p.p ->> 'insurance_age')::numeric
          end as max_age_days
        from scoped as s
        join policies as p on p.jurisdiction_id = s.jurisdiction_id and p.p ->> 'status' = 'selected'
      )
      select g.kind, g.id, g.attorney_id, g.display_name, g.profile_state, g.jurisdiction_id, null::text,
        g.retrieved_at,
        case when g.retrieved_at is null then null
          else ((g.retrieved_at at time zone 'UTC')::date + least(g.max_age_days, 1000000)::integer) end
      from aged as g
      where g.max_age_days is not null
      order by (g.retrieved_at is not null),
        case when g.retrieved_at is null then null
          else ((g.retrieved_at at time zone 'UTC')::date + least(g.max_age_days, 1000000)::integer) end,
        g.id
      offset p_offset limit 26;
  elsif p_section in ('under_review', 'approved', 'suspended', 'removed') then
    return query
      select 'attorney_profile'::text, a.id, a.id, a.display_name, a.profile_state, null::uuid, null::text,
        a.updated_at, null::date
      from public.attorney_profiles as a
      where a.profile_state = p_section
        and public.compliance_profile_visible(a.id)
      order by a.updated_at desc, a.id
      offset p_offset limit 26;
  elsif p_section = 'discipline' then
    return query
      select 'discipline_record'::text, d.id, a.id, a.display_name, a.profile_state, d.jurisdiction_id,
        case when d.status collate "C" ~ '^[a-z][a-z0-9_]{1,63}$' then d.status end,
        d.created_at, d.opened_at
      from public.discipline_records as d
      join public.attorney_profiles as a on a.id = d.attorney_id
      where public.has_manage_attorney_verification_scope(d.jurisdiction_id, false)
      order by d.created_at desc, d.id
      offset p_offset limit 26;
  elsif p_section = 'waitlist' then
    return query
      select 'license'::text, l.id, a.id, a.display_name, a.profile_state, l.jurisdiction_id, null::text,
        l.created_at, null::date
      from public.licenses as l
      join public.jurisdictions as j on j.id = l.jurisdiction_id and j.lifecycle_state = 'waitlist'
      join public.attorney_profiles as a on a.id = l.attorney_id
      where public.has_manage_attorney_verification_scope(l.jurisdiction_id, false)
      order by l.created_at, l.id
      offset p_offset limit 26;
  end if;
end;
$function$;

create function public.staff_attorney_profile(p_attorney_id uuid)
returns table (
  attorney_id uuid,
  display_name text,
  profile_state text,
  updated_at timestamptz,
  rejoin_review_open boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select a.id, a.display_name, a.profile_state, a.updated_at, public.attorney_rejoin_review_open(a.id)
  from public.attorney_profiles as a
  where a.id = p_attorney_id
    and public.has_manage_attorney_verification_scope(null, false);
$function$;

create function public.staff_policy_changes(p_offset integer)
returns table (
  audit_event_id uuid,
  policy_version_id uuid,
  policy_type_code text,
  jurisdiction_id uuid,
  from_status text,
  to_status text,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select e.id, v.id, v.policy_type_code, v.jurisdiction_id,
    e.before_snapshot ->> 'status', e.after_snapshot ->> 'status', e.occurred_at
  from public.audit_events as e
  join public.policy_versions as v on v.id = e.resource_id
  where e.action_code = 'policy_version.transitioned'
    and e.resource_type = 'policy_version'
    and p_offset between 0 and 100000
    and public.has_staff_capability('manage_policy_configuration', v.jurisdiction_id, false)
  order by e.occurred_at desc, e.id desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.license_number_normalized(text)
  from public, anon, authenticated, service_role;
revoke all on function public.attorney_rejoin_detect(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.attorney_rejoin_review_open(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.attorney_rejoin_license_saved()
  from public, anon, authenticated, service_role;
revoke all on function public.attorney_rejoin_application_submitted()
  from public, anon, authenticated, service_role;
revoke all on function public.compliance_profile_visible(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.staff_change_attorney_lifecycle(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_change_attorney_lifecycle(uuid, text, text) to authenticated;
revoke all on function public.staff_compliance_summary()
  from public, anon, authenticated, service_role;
grant execute on function public.staff_compliance_summary() to authenticated;
revoke all on function public.staff_compliance_records(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_compliance_records(text, integer) to authenticated;
revoke all on function public.staff_attorney_profile(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_attorney_profile(uuid) to authenticated;
revoke all on function public.staff_policy_changes(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_policy_changes(integer) to authenticated;

comment on function public.license_number_normalized(text) is
  'MVP-001 S11 (internal): a licence number normalized for rejoin detection: upper-case ASCII letters and digits only, null when nothing remains. Executable by no API role.';
comment on function public.attorney_rejoin_detect(uuid) is
  'MVP-001 S11 (internal; MB section 19): opens at most one high rejoin_review compliance item for a profile that is not removed when one of its licences matches (jurisdiction and normalized number) a licence of another, removed profile and that match has no item yet; evidence holds the two profile and two licence identifiers only. Locks the profile FOR SHARE first. Executable by no API role.';
comment on function public.attorney_rejoin_review_open(uuid) is
  'MVP-001 S11 (internal): whether a rejoin_review item of the profile is open. Executable by no API role.';
comment on function public.attorney_rejoin_license_saved() is
  'MVP-001 S11 (trigger): runs the rejoin detection for the licence''s profile when a licence is inserted or its number or jurisdiction changes. Executable by no API role.';
comment on function public.attorney_rejoin_application_submitted() is
  'MVP-001 S11 (trigger): runs the rejoin detection when a profile enters under_review (an application submitted). Executable by no API role.';
comment on function public.compliance_profile_visible(uuid) is
  'MVP-001 S11 (internal): whether the caller holds manage_attorney_verification covering the profile (a global grant, or the jurisdiction of one of its licences; aal2). Executable by no API role.';
comment on function public.staff_change_attorney_lifecycle(uuid, text, text) is
  'MVP-001 S11 attorney operations: reinstate (suspended -> approved) or remove (approved | suspended -> removed, final) with a required staff note on the audit event, for staff holding the global manage_attorney_verification grant (aal2), never on their own profile; a reinstatement waits while a rejoin review is open. Outcomes: applied, invalid, denied, locked, review_required.';
comment on function public.staff_compliance_summary() is
  'MVP-001 S11 compliance workspace: counts only, one group per capability held (profiles by stage and waitlist members by verification scope; open compliance review items by type; Complaint Cases by state by complaint scope; active Legal Holds), aal2.';
comment on function public.staff_compliance_records(text, integer) is
  'MVP-001 S11 compliance workspace: one page (25 rows, plus one) of one section (license_expiry, insurance_expiry, evidence_age, under_review, approved, suspended, removed, discipline, waitlist) for manage_attorney_verification by jurisdiction (aal2): record and profile identifiers, the attorney''s display name and stage, the jurisdiction and the recorded dates; no threshold applied.';
comment on function public.staff_attorney_profile(uuid) is
  'MVP-001 S11 attorney operations: one Attorney Profile (id, display name, stage, last change, whether a rejoin review is open) for staff holding the global manage_attorney_verification grant (aal2).';
comment on function public.staff_policy_changes(integer) is
  'MVP-001 S11 compliance workspace: one page (25 rows, plus one) of policy version status changes (type, scope, stage before and after, time), newest first, for manage_policy_configuration covering the version''s scope (aal2).';
