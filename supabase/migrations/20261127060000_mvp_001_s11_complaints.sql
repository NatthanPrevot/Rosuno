-- MVP-001 S11 (6 of 7): the complaint foundation on the existing Physical 1K relation (MVP-001 Packet S11 "complaint
-- foundation"; MBS section 16 "Complaint Foundation" and its failure test "complaints preserve evidence and respect
-- access controls"; TA sections 18, 40, 41 and 50; PS sections 27.1 and 30.4 "complaint staff -> complaint cases"; PM
-- row 47; MB sections 120 to 122; Packet section 3 gate "complaint vocabularies: configuration").
--
-- No relation, column or policy type is added (Packet rules 8 and 16). public.complaint_cases exists since P1
-- (20260921051204) with exactly the PS section 27.1 columns, and that is all this foundation uses: it has no
-- narrative field, and the complaint vocabularies (category codes, resolution codes) are configuration that does not
-- exist yet. So intake records who complains and about which Consultation or Referral, and nothing the complainant
-- writes; classification and resolution exist as commands that answer configuration_unavailable and change nothing
-- until a vocabulary can be selected (complaint_vocabulary below is the one seam). It is a foundation, not a
-- case-management suite (MBS section 16).
--
-- Rules, for every role, the database owner included (constraints and one guard trigger):
-- - state is opened, in_review, escalated or resolved (the workflow states of "authorized assignment / status /
--   resolution handling", MBS section 16; a technical workflow vocabulary, not a complaint taxonomy). A case is
--   recorded opened, unassigned and unclassified; it moves opened -> in_review, in_review -> opened | escalated |
--   resolved, escalated -> in_review | resolved; a resolved case never changes;
-- - a case is assigned exactly while it is not opened; it is resolved exactly when its resolution instant and its
--   resolution code are recorded;
-- - category and resolution codes are lower-snake codes;
-- - the complainant, the linked Consultation and Referral, the jurisdiction and the opening instant never change. The
--   jurisdiction is derived from the linkage (the Consultation's Referral's, or the Referral's; none without a
--   linkage), a Consultation and a Referral named together must belong together, and the complainant is the client
--   or the attorney of the linked matter (or, without a linkage, holds a Client or an Attorney Profile);
-- - a case is never deleted or truncated;
-- - at most one case that is not resolved exists per complainant and linkage (the unlinked one included): a
--   technical idempotency bound, so a repeated submission opens nothing new.
--
-- PM row 47 (settled): opening a complaint changes nothing else. complaint_open reads the linked Consultation or
-- Referral and writes one Complaint Case, one Notification to the complainant and one audit event; it never touches
-- the Consultation, its Booking, its payment, an Engagement or any evidence row. Evidence is preserved by what
-- already holds for every role (Messages, participation records, audit events and provider receipts are append-only;
-- documents and their resources have no deletion path), and a Legal Hold scoped to the case covers the resources of
-- its linked Consultation (20261127050000).
--
-- complaint_open (EXECUTE for authenticated only): the complainant is always the caller, never an input. A client (an
-- active User, any aal) or an attorney (an approved Attorney Profile at aal2) may name at most one of a Consultation
-- they participate in or a Referral of their own (the client's Intake's, or the one that names the attorney); anyone
-- else's, and an unknown id, answer alike (not_found). Lock order: the caller's own rows, then the Consultation FOR
-- SHARE (communication_participant, S10).
--
-- Restricted record (PS section 27.1 "complaint records are restricted"; TA section 41 minimum necessary): no API
-- role holds any privilege on the relation and it has no row policy; every read is a function.
-- - complaint_cases_mine: the caller's own cases (state, linkage, instants); the other participant of the matter sees
--   nothing, and the assignee, category and resolution are not answered;
-- - staff_complaint_queue and staff_complaint_case: staff holding manage_complaints for the case's jurisdiction (a
--   global grant for a case without one) at aal2. One case answers minimum metadata: the complainant's role in the
--   matter, the linked Consultation's and Referral's ids and states, the four participation-evidence facts, the
--   latest payment state and the number of unreleased Legal Holds on the case or its Consultation. Never a name, a
--   message, a document, Intake content or a User id.
-- - staff_update_complaint: assign (to the caller: opened -> in_review, or taking over an assigned case), unassign
--   (in_review -> opened), escalate (in_review -> escalated) and return_to_review (escalated -> in_review); audited.
-- - staff_classify_complaint and staff_resolve_complaint: authorized and validated like the others, then
--   configuration_unavailable while no vocabulary is selectable. Both are complete behind the seam: when
--   complaint_vocabulary answers a selected vocabulary, a listed code is recorded (the resolution with its instant and
--   the resolved state) and audited.

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relation.
-- ---------------------------------------------------------------------------

alter table public.complaint_cases
  add constraint complaint_cases_state_v1_check
    check (state in ('opened', 'in_review', 'escalated', 'resolved')),
  add constraint complaint_cases_codes_v1_check
    check (
      (category_code is null or category_code collate "C" ~ '^[a-z][a-z0-9_]{1,63}$')
      and (resolution_code is null or resolution_code collate "C" ~ '^[a-z][a-z0-9_]{1,63}$')
    ),
  add constraint complaint_cases_assignment_v1_check
    check ((state = 'opened') = (assigned_to_user_id is null)),
  add constraint complaint_cases_resolution_v1_check
    check (
      (state = 'resolved') = (resolved_at is not null)
      and (state = 'resolved') = (resolution_code is not null)
    );

-- One case that is not resolved per complainant and linkage (the unlinked one included).
create unique index complaint_cases_one_open_idx
  on public.complaint_cases (
    complainant_user_id,
    (coalesce(consultation_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(referral_id, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  where state <> 'resolved';

create index complaint_cases_state_opened_idx
  on public.complaint_cases (state, opened_at, id);

create index complaint_cases_consultation_idx
  on public.complaint_cases (consultation_id)
  where consultation_id is not null;

-- ---------------------------------------------------------------------------
-- Derived facts of a case (internal).
-- ---------------------------------------------------------------------------

-- The jurisdiction of a linkage: the Consultation's Referral's, else the Referral's, else none.
create function public.complaint_linkage_jurisdiction(p_consultation_id uuid, p_referral_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    (
      select f.jurisdiction_id
      from public.consultations as c
      join public.consultation_requests as r on r.id = c.consultation_request_id
      join public.referrals as f on f.id = r.referral_id
      where c.id = p_consultation_id
    ),
    (select f.jurisdiction_id from public.referrals as f where f.id = p_referral_id)
  );
$function$;

-- The role a User has in a linkage: client or attorney of the Consultation, else of the Referral (its Intake's client,
-- the attorney it names), else, without a linkage, the profile the User holds (attorney before client); null when
-- none.
create function public.complaint_complainant_role(p_user_id uuid, p_consultation_id uuid, p_referral_id uuid)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_consultation_id is not null then (
      select case
        when cp.user_id = p_user_id then 'client'
        when ap.user_id = p_user_id then 'attorney'
      end
      from public.consultations as c
      join public.client_profiles as cp on cp.id = c.client_id
      join public.attorney_profiles as ap on ap.id = c.attorney_id
      where c.id = p_consultation_id
    )
    when p_referral_id is not null then (
      select case
        when cp.user_id = p_user_id then 'client'
        when ap.user_id = p_user_id then 'attorney'
      end
      from public.referrals as f
      join public.intakes as i on i.id = f.intake_id
      join public.client_profiles as cp on cp.id = i.client_id
      left join public.attorney_profiles as ap on ap.id = f.attorney_id
      where f.id = p_referral_id
    )
    when exists (select 1 from public.attorney_profiles as ap where ap.user_id = p_user_id) then 'attorney'
    when exists (select 1 from public.client_profiles as cp where cp.user_id = p_user_id) then 'client'
  end;
$function$;

-- The complaint vocabularies that govern a case at an instant: ('selected', version, category codes, resolution
-- codes) or a refusal. Complaint vocabularies are configuration (Packet section 3) and no configuration home for them
-- exists yet, so this always answers configuration_unavailable: the one seam a later, separately authorized change
-- replaces. Nothing is seeded and no code is a default.
create function public.complaint_vocabulary(p_jurisdiction uuid, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, category_codes text[], resolution_codes text[])
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select 'configuration_unavailable'::text, null::uuid, array[]::text[], array[]::text[];
$function$;

-- ---------------------------------------------------------------------------
-- The guard (every role).
-- ---------------------------------------------------------------------------

create function public.complaint_case_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.complaint_cases rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'opened'
       or new.category_code is not null
       or new.resolution_code is not null
       or new.resolved_at is not null
       or new.assigned_to_user_id is not null then
      raise exception 'a complaint case is recorded opened, unassigned and unclassified'
        using errcode = '23514';
    end if;
    if new.consultation_id is not null
       and new.referral_id is not null
       and not exists (
         select 1
         from public.consultations as c
         join public.consultation_requests as r on r.id = c.consultation_request_id
         where c.id = new.consultation_id
           and r.referral_id = new.referral_id
       ) then
      raise exception 'a complaint case''s consultation and referral belong together'
        using errcode = '23514';
    end if;
    if new.jurisdiction_id is distinct from
       public.complaint_linkage_jurisdiction(new.consultation_id, new.referral_id) then
      raise exception 'a complaint case''s jurisdiction is its linkage''s'
        using errcode = '23514';
    end if;
    if public.complaint_complainant_role(new.complainant_user_id, new.consultation_id, new.referral_id) is null then
      raise exception 'a complainant is the client or the attorney of the linked matter'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.complainant_user_id is distinct from old.complainant_user_id
     or new.consultation_id is distinct from old.consultation_id
     or new.referral_id is distinct from old.referral_id
     or new.jurisdiction_id is distinct from old.jurisdiction_id
     or new.opened_at is distinct from old.opened_at
     or new.created_at is distinct from old.created_at then
    raise exception 'a complaint case keeps its complainant, linkage, jurisdiction and opening'
      using errcode = '55000';
  end if;
  if old.state = 'resolved'
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'a resolved complaint case is final'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'opened' and new.state = 'in_review')
       or (old.state = 'in_review' and new.state in ('opened', 'escalated', 'resolved'))
       or (old.state = 'escalated' and new.state in ('in_review', 'resolved'))
     ) then
    raise exception 'complaint case transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger complaint_cases_guard
before insert or update or delete on public.complaint_cases
for each row
execute function public.complaint_case_guard();

create trigger complaint_cases_no_truncate
before truncate on public.complaint_cases
for each statement
execute function public.complaint_case_guard();

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only and the record is restricted (no direct read by any API role).
-- ---------------------------------------------------------------------------

revoke all on table public.complaint_cases
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Intake (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- The caller as a complainant for a linkage, with their own rows locked in the canonical order: ('ok', role, User),
-- ('denied', ...) for an attorney whose profile is not approved or a User with neither profile, or ('not_found', ...)
-- for a matter that is not the caller's (an attorney at aal1 and an unknown id alike).
create function public.complaint_caller(p_consultation_id uuid, p_referral_id uuid)
returns table (outcome text, complainant_role text, user_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_role text;
  v_participant record;
  v_locked uuid;
  v_profile public.attorney_profiles;
begin
  if p_consultation_id is not null then
    select p.* into v_participant from public.communication_participant(p_consultation_id) as p;
    return query select
      coalesce(v_participant.outcome, 'not_found'),
      case when v_participant.outcome = 'ok' then v_participant.participant_role end,
      case when v_participant.outcome = 'ok' then v_participant.user_id end;
    return;
  end if;
  select u.id into v_user
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
  if v_user is null then
    return query select
      case when p_referral_id is null then 'denied' else 'not_found' end::text, null::text, null::uuid;
    return;
  end if;
  v_role := public.complaint_complainant_role(v_user, null, p_referral_id);
  if v_role = 'client' then
    select l.user_id into v_locked from public.lock_current_client() as l;
    if v_locked is distinct from v_user then
      v_role := null;
    end if;
  elsif v_role = 'attorney' then
    v_profile := public.lock_current_attorney_profile(false);
    if v_profile.user_id is distinct from v_user then
      -- Not at aal2: a named Referral answers as an unknown one does; without a linkage the caller is refused.
      v_role := null;
    elsif v_profile.profile_state is distinct from 'approved' then
      return query select 'denied'::text, null::text, null::uuid;
      return;
    end if;
  end if;
  if v_role is null then
    return query select
      case when p_referral_id is null then 'denied' else 'not_found' end::text, null::text, null::uuid;
    return;
  end if;
  return query select 'ok'::text, v_role, v_user;
end;
$function$;

-- Outcomes: opened (with the case id), invalid (a Consultation and a Referral named together), denied, not_found,
-- already_open.
create function public.complaint_open(p_consultation_id uuid, p_referral_id uuid)
returns table (outcome text, complaint_case_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_caller record;
  v_jurisdiction uuid;
  v_case uuid;
begin
  if p_consultation_id is not null and p_referral_id is not null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select c.* into v_caller from public.complaint_caller(p_consultation_id, p_referral_id) as c;
  if v_caller.outcome is distinct from 'ok' then
    return query select coalesce(v_caller.outcome, 'not_found'), null::uuid;
    return;
  end if;
  v_jurisdiction := public.complaint_linkage_jurisdiction(p_consultation_id, p_referral_id);
  insert into public.complaint_cases (
    complainant_user_id, consultation_id, referral_id, jurisdiction_id, state, opened_at
  ) values (
    v_caller.user_id, p_consultation_id, p_referral_id, v_jurisdiction, 'opened', clock_timestamp()
  )
  on conflict (
    complainant_user_id,
    (coalesce(consultation_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(referral_id, '00000000-0000-0000-0000-000000000000'::uuid))
  ) where state <> 'resolved'
  do nothing
  returning id into v_case;
  if v_case is null then
    return query select 'already_open'::text, null::uuid;
    return;
  end if;
  perform public.notification_emit(v_caller.user_id, 'complaint_received', 'complaint_case.opened', v_case);
  perform public.decision_audit(
    v_caller.user_id, v_caller.complainant_role, 'complaint_case.opened', 'complaint_case', v_case,
    null,
    jsonb_build_object(
      'state', 'opened',
      'complainant_role', v_caller.complainant_role,
      'consultation_id', p_consultation_id,
      'referral_id', p_referral_id
    ),
    null, null, v_jurisdiction
  );
  return query select 'opened'::text, v_case;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reads.
-- ---------------------------------------------------------------------------

-- The caller's own Complaint Cases (an active User; aal2 for a User holding an Attorney or Staff Profile, the
-- notification center's rule): state, linkage and instants, the most recent first, at most 200.
create function public.complaint_cases_mine()
returns table (
  complaint_case_id uuid,
  state text,
  consultation_id uuid,
  referral_id uuid,
  opened_at timestamptz,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select k.id, k.state, k.consultation_id, k.referral_id, k.opened_at, k.resolved_at
  from public.complaint_cases as k
  where k.complainant_user_id = public.notification_caller()
  order by k.opened_at desc, k.id
  limit 200;
$function$;

-- One page (25 rows, plus one) of the Complaint Cases in one state, the oldest first, in the jurisdictions the caller
-- holds manage_complaints for (a case without a jurisdiction needs a global grant; aal2).
create function public.staff_complaint_queue(p_state text, p_offset integer)
returns table (
  complaint_case_id uuid,
  jurisdiction_id uuid,
  state text,
  consultation_id uuid,
  referral_id uuid,
  opened_at timestamptz,
  resolved_at timestamptz,
  assigned_to_me boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    k.id, k.jurisdiction_id, k.state, k.consultation_id, k.referral_id, k.opened_at, k.resolved_at,
    coalesce(k.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false)
  from public.complaint_cases as k
  where p_state in ('opened', 'in_review', 'escalated', 'resolved')
    and k.state = p_state
    and p_offset between 0 and 100000
    and public.has_staff_capability('manage_complaints', k.jurisdiction_id, false)
  order by k.opened_at, k.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One Complaint Case with the minimum metadata staff need (see the header). No row without the capability for its
-- jurisdiction or for an unknown id.
create function public.staff_complaint_case(p_complaint_case_id uuid)
returns table (
  complaint_case_id uuid,
  jurisdiction_id uuid,
  state text,
  category_code text,
  resolution_code text,
  opened_at timestamptz,
  resolved_at timestamptz,
  assigned_to_me boolean,
  complainant_role text,
  consultation_id uuid,
  consultation_state text,
  consultation_outcome_code text,
  referral_id uuid,
  referral_outcome_code text,
  attorney_joined boolean,
  client_joined boolean,
  both_present boolean,
  either_left boolean,
  payment_state text,
  active_legal_holds integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    k.id,
    k.jurisdiction_id,
    k.state,
    k.category_code,
    k.resolution_code,
    k.opened_at,
    k.resolved_at,
    coalesce(k.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false),
    public.complaint_complainant_role(k.complainant_user_id, k.consultation_id, k.referral_id),
    k.consultation_id,
    c.state,
    c.outcome_code,
    k.referral_id,
    f.outcome_code,
    case when c.id is not null then p.attorney_joined_at is not null end,
    case when c.id is not null then p.client_joined_at is not null end,
    case when c.id is not null then coalesce(p.both_present, false) end,
    case when c.id is not null then coalesce(p.either_left, false) end,
    (
      select pt.state
      from public.payment_transactions as pt
      where pt.consultation_request_id = c.consultation_request_id
      order by pt.created_at desc, pt.id desc
      limit 1
    ),
    (
      select count(*)::integer
      from public.legal_holds as h
      where (h.released_at is null or h.released_at > statement_timestamp())
        and (
          (h.scope_type = 'complaint_case' and h.scope_id = k.id)
          or (k.consultation_id is not null and h.scope_id = k.consultation_id)
        )
    )
  from public.complaint_cases as k
  left join public.consultations as c on c.id = k.consultation_id
  left join public.referrals as f on f.id = k.referral_id
  left join lateral public.consultation_participation(c.id) as p on c.id is not null
  where k.id = p_complaint_case_id
    and public.has_staff_capability('manage_complaints', k.jurisdiction_id, false);
$function$;

-- ---------------------------------------------------------------------------
-- Staff handling (EXECUTE for authenticated only; manage_complaints for the case's jurisdiction, aal2).
-- ---------------------------------------------------------------------------

-- The calling staff member when they hold manage_complaints for the given case's jurisdiction, locked (User, Staff
-- Profile, grant), with the case's jurisdiction and whether the case exists. The jurisdiction is an immutable fact of
-- the case, read before any lock; for an unknown id a global grant is needed.
create function public.complaint_lock_staff(
  p_complaint_case_id uuid,
  out staff_user_id uuid,
  out case_known boolean,
  out jurisdiction_id uuid
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  select true, k.jurisdiction_id into case_known, jurisdiction_id
  from public.complaint_cases as k
  where k.id = p_complaint_case_id;
  case_known := coalesce(case_known, false);
  staff_user_id := public.lock_current_capability_staff('manage_complaints', jurisdiction_id);
end;
$function$;

-- p_action assign | unassign | escalate | return_to_review (see the header). No User id is an input: the assignee is
-- always the caller. Outcomes: applied, invalid, denied, not_found, invalid_transition.
create function public.staff_update_complaint(p_complaint_case_id uuid, p_action text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_before public.complaint_cases;
  v_state text;
  v_assignee uuid;
begin
  if p_complaint_case_id is null
     or p_action is null
     or p_action not in ('assign', 'unassign', 'escalate', 'return_to_review') then
    return 'invalid';
  end if;
  select l.* into v_lock from public.complaint_lock_staff(p_complaint_case_id) as l;
  if v_lock.staff_user_id is null then
    return 'denied';
  end if;
  if not v_lock.case_known then
    return 'not_found';
  end if;
  select k.* into v_before from public.complaint_cases as k where k.id = p_complaint_case_id for update;
  v_state := v_before.state;
  v_assignee := v_before.assigned_to_user_id;
  if p_action = 'assign' and v_before.state in ('opened', 'in_review', 'escalated') then
    v_state := case v_before.state when 'opened' then 'in_review' else v_before.state end;
    v_assignee := v_lock.staff_user_id;
  elsif p_action = 'unassign' and v_before.state = 'in_review' then
    v_state := 'opened';
    v_assignee := null;
  elsif p_action = 'escalate' and v_before.state = 'in_review' then
    v_state := 'escalated';
  elsif p_action = 'return_to_review' and v_before.state = 'escalated' then
    v_state := 'in_review';
  else
    return 'invalid_transition';
  end if;
  update public.complaint_cases as k
  set state = v_state,
      assigned_to_user_id = v_assignee
  where k.id = p_complaint_case_id;
  perform public.decision_audit(
    v_lock.staff_user_id, 'staff',
    case p_action
      when 'assign' then 'complaint_case.assigned'
      when 'unassign' then 'complaint_case.unassigned'
      when 'escalate' then 'complaint_case.escalated'
      else 'complaint_case.returned_to_review'
    end,
    'complaint_case', p_complaint_case_id,
    jsonb_build_object('state', v_before.state, 'assigned', v_before.assigned_to_user_id is not null),
    jsonb_build_object('state', v_state, 'assigned', v_assignee is not null),
    null, null, v_lock.jurisdiction_id
  );
  return 'applied';
end;
$function$;

-- Records a category code the selected vocabulary lists on a case that is not resolved. Outcomes: applied, invalid,
-- denied, not_found, invalid_transition (resolved), configuration_unavailable (no vocabulary is selectable: nothing
-- changes), invalid_code.
create function public.staff_classify_complaint(p_complaint_case_id uuid, p_category_code text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_before public.complaint_cases;
  v_vocabulary record;
begin
  if p_complaint_case_id is null
     or p_category_code is null
     or p_category_code collate "C" !~ '^[a-z][a-z0-9_]{1,63}$' then
    return 'invalid';
  end if;
  select l.* into v_lock from public.complaint_lock_staff(p_complaint_case_id) as l;
  if v_lock.staff_user_id is null then
    return 'denied';
  end if;
  if not v_lock.case_known then
    return 'not_found';
  end if;
  select k.* into v_before from public.complaint_cases as k where k.id = p_complaint_case_id for update;
  if v_before.state = 'resolved' then
    return 'invalid_transition';
  end if;
  select v.* into v_vocabulary
  from public.complaint_vocabulary(v_before.jurisdiction_id, clock_timestamp()) as v;
  if v_vocabulary.outcome is distinct from 'selected' then
    return 'configuration_unavailable';
  end if;
  if not (p_category_code = any (v_vocabulary.category_codes)) then
    return 'invalid_code';
  end if;
  update public.complaint_cases as k
  set category_code = p_category_code
  where k.id = p_complaint_case_id;
  perform public.decision_audit(
    v_lock.staff_user_id, 'staff', 'complaint_case.classified', 'complaint_case', p_complaint_case_id,
    jsonb_build_object('category_code', v_before.category_code),
    jsonb_build_object(
      'category_code', p_category_code, 'vocabulary_policy_version_id', v_vocabulary.policy_version_id
    ),
    null, null, v_lock.jurisdiction_id
  );
  return 'applied';
end;
$function$;

-- Resolves a case in review or escalated with a resolution code the selected vocabulary lists. Outcomes: applied,
-- invalid, denied, not_found, invalid_transition, configuration_unavailable (no vocabulary is selectable: nothing
-- changes), invalid_code.
create function public.staff_resolve_complaint(p_complaint_case_id uuid, p_resolution_code text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_before public.complaint_cases;
  v_vocabulary record;
begin
  if p_complaint_case_id is null
     or p_resolution_code is null
     or p_resolution_code collate "C" !~ '^[a-z][a-z0-9_]{1,63}$' then
    return 'invalid';
  end if;
  select l.* into v_lock from public.complaint_lock_staff(p_complaint_case_id) as l;
  if v_lock.staff_user_id is null then
    return 'denied';
  end if;
  if not v_lock.case_known then
    return 'not_found';
  end if;
  select k.* into v_before from public.complaint_cases as k where k.id = p_complaint_case_id for update;
  if v_before.state not in ('in_review', 'escalated') then
    return 'invalid_transition';
  end if;
  select v.* into v_vocabulary
  from public.complaint_vocabulary(v_before.jurisdiction_id, clock_timestamp()) as v;
  if v_vocabulary.outcome is distinct from 'selected' then
    return 'configuration_unavailable';
  end if;
  if not (p_resolution_code = any (v_vocabulary.resolution_codes)) then
    return 'invalid_code';
  end if;
  update public.complaint_cases as k
  set state = 'resolved',
      resolved_at = clock_timestamp(),
      resolution_code = p_resolution_code
  where k.id = p_complaint_case_id;
  perform public.decision_audit(
    v_lock.staff_user_id, 'staff', 'complaint_case.resolved', 'complaint_case', p_complaint_case_id,
    jsonb_build_object('state', v_before.state),
    jsonb_build_object(
      'state', 'resolved', 'resolution_code', p_resolution_code,
      'vocabulary_policy_version_id', v_vocabulary.policy_version_id
    ),
    null, null, v_lock.jurisdiction_id
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.complaint_linkage_jurisdiction(uuid, uuid)',
    'public.complaint_complainant_role(uuid, uuid, uuid)',
    'public.complaint_vocabulary(uuid, timestamptz)',
    'public.complaint_case_guard()',
    'public.complaint_caller(uuid, uuid)',
    'public.complaint_lock_staff(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.complaint_open(uuid, uuid)',
    'public.complaint_cases_mine()',
    'public.staff_complaint_queue(text, integer)',
    'public.staff_complaint_case(uuid)',
    'public.staff_update_complaint(uuid, text)',
    'public.staff_classify_complaint(uuid, text)',
    'public.staff_resolve_complaint(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.complaint_linkage_jurisdiction(uuid, uuid) is
  'MVP-001 S11 (internal): the jurisdiction of a complaint linkage: the Consultation''s Referral''s, else the Referral''s, else none.';
comment on function public.complaint_complainant_role(uuid, uuid, uuid) is
  'MVP-001 S11 (internal): the role a User has in a complaint linkage (client or attorney of the Consultation, else of the Referral, else by the profile held), or null.';
comment on function public.complaint_vocabulary(uuid, timestamptz) is
  'MVP-001 S11 (internal seam): the complaint category and resolution codes that govern a case. Complaint vocabularies are configuration with no home yet, so this always answers configuration_unavailable; classification and resolution change nothing until it answers a selected vocabulary.';
comment on function public.complaint_case_guard() is
  'MVP-001 S11 (every role): a Complaint Case is never deleted or truncated; it is recorded opened, unassigned and unclassified, by a participant of its linked matter, with its linkage''s jurisdiction; its complainant, linkage, jurisdiction and opening never change; it moves only opened -> in_review, in_review -> opened | escalated | resolved, escalated -> in_review | resolved, and a resolved case never changes.';
comment on function public.complaint_caller(uuid, uuid) is
  'MVP-001 S11 (internal): the caller as a complainant for a linkage with their own rows locked (ok with role and User, denied, or not_found for a matter that is not theirs).';
comment on function public.complaint_lock_staff(uuid) is
  'MVP-001 S11 (internal): the calling staff member, locked, when they hold manage_complaints for the given case''s jurisdiction (a global grant for a case without one or an unknown id), with whether the case exists.';
comment on function public.complaint_open(uuid, uuid) is
  'MVP-001 S11: a client (any aal) or an attorney (approved, aal2) opens one Complaint Case, optionally linked to a Consultation they participate in or a Referral of their own; the complainant is the caller; the jurisdiction is derived; nothing else changes (PM row 47); one Notification to the complainant; audited. Outcomes: opened, invalid, denied, not_found, already_open.';
comment on function public.complaint_cases_mine() is
  'MVP-001 S11: the caller''s own Complaint Cases (state, linkage, instants); at most 200. Nothing about assignment, classification or resolution.';
comment on function public.staff_complaint_queue(text, integer) is
  'MVP-001 S11 complaint workspace: one page of the Complaint Cases in one state, oldest first, in the jurisdictions the caller holds manage_complaints for (aal2; a case without a jurisdiction needs a global grant).';
comment on function public.staff_complaint_case(uuid) is
  'MVP-001 S11 complaint workspace: one Complaint Case with minimum metadata for staff holding manage_complaints for its jurisdiction (aal2): the complainant''s role, the linked Consultation''s and Referral''s ids and states, four participation-evidence facts, the latest payment state and the number of unreleased Legal Holds on the case or its Consultation; never a name, a User id or any content.';
comment on function public.staff_update_complaint(uuid, text) is
  'MVP-001 S11: staff holding manage_complaints for the case''s jurisdiction (aal2) assign a case to themselves, unassign it, escalate it or return it to review; audited. Outcomes: applied, invalid, denied, not_found, invalid_transition.';
comment on function public.staff_classify_complaint(uuid, text) is
  'MVP-001 S11: records a category code of the selected complaint vocabulary on a case that is not resolved; answers configuration_unavailable and changes nothing while no vocabulary is selectable. Outcomes: applied, invalid, denied, not_found, invalid_transition, configuration_unavailable, invalid_code.';
comment on function public.staff_resolve_complaint(uuid, text) is
  'MVP-001 S11: resolves a case in review or escalated with a resolution code of the selected complaint vocabulary; answers configuration_unavailable and changes nothing while no vocabulary is selectable. Outcomes: applied, invalid, denied, not_found, invalid_transition, configuration_unavailable, invalid_code.';
comment on column public.complaint_cases.state is
  'MVP-001 S11: opened, in_review, escalated or resolved (a technical workflow vocabulary). Category and resolution codes stay configuration.';
