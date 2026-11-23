-- MVP-001 S11 PS-A6 (2 of 3): data requests (PS-A6 sections 3 and 8; MVP-001 Packet S11; MBS sections 16 and 18.2
-- "privacy / data controls", 18.4 "privacy / data requests"; IMP section 27; TA sections 18, 41 and 51; PM row 48; PS
-- sections 26.2 and 30).
--
-- This migration creates exactly one relation, public.data_requests, with exactly the PS-A6 section 3 columns, and one
-- capability catalog row (reference data; grants stay configuration rows and none is inserted). No other relation,
-- column, policy type or business row is added and no existing function changes.
--
-- Rules, for every role, the database owner included (constraints and one guard trigger):
-- - request_type takes one of five values: access, correction, deletion, export, restriction (PS-A6 section 3 rule 1);
-- - state takes one of submitted, in_review, decided, withdrawn; inserts start at submitted; allowed moves are
--   submitted to in_review or withdrawn and in_review to decided or withdrawn, after which nothing changes (rule 2);
-- - the decision columns (decided_by_user_id, decided_at, outcome_code) are present exactly when the state is decided,
--   hence written once; outcome_code takes one of allowed, restricted, deferred, denied (rule 3);
-- - while a Legal Hold covers the requester (coverage below), a deletion request cannot reach decided with the outcome
--   allowed (rule 5; data_request_legal_hold_applies);
-- - details, when present, hold up to 20,000 characters and not only whitespace (rule 6);
-- - rows are never deleted or truncated, and the requester, type, details, submission instant, identifier and creation
--   instant are fixed (rules 6 and 7); updated_at follows the house set_updated_at trigger;
-- - technical idempotency: one open (submitted or in_review) request per requester and type at most.
--
-- Rule 4: the decision is only written down. Nothing in this migration deletes, erases, exports, corrects or restricts
-- any data or schedules such work, and nothing here settles retention or disposition.
--
-- Legal Hold coverage (rule 5; the S11 legal_holds scope types consultation, intake, resource, complaint_case and user,
-- 20261127050000): a hold counts while its released_at is unset or in the future, whatever its scope type or status
-- says (an unknown vocabulary fails closed, as S3), when its scope id is the requester's User, an Intake of the
-- requester's Client Profile, a Consultation in which the requester is the client or the attorney, a Resource the
-- requester owns or of such an Intake or Consultation, or a Complaint Case the requester opened or that links such a
-- Consultation or a Referral of the requester (of the requester's Intakes, or one in which the requester is the
-- attorney). Besides, such a Resource counts whenever the house resource coverage (resource_under_legal_hold,
-- 20261127050000) reports it held, so a user hold on the counterparty of a Consultation or a hold on a verification
-- finding covers the request as it covers the Resource. The check runs in the guard (every role) and, first, in the
-- decision command, which takes a SHARE lock on public.legal_holds for that one decision so a hold placed or released
-- concurrently is decided before it.
--
-- Commands and reads (EXECUTE for authenticated only; security definer; search_path pinned; fixed outcomes; audited
-- with codes and identifiers only, never the details):
-- - client_submit_data_request, client_withdraw_data_request and client_data_requests: the existing client admission
--   (an active User with a Client Profile, lock_current_client for the commands) and the admission complaint_cases_mine
--   uses (notification_caller: any aal for a client, aal2 for a User who also holds an Attorney or Staff Profile). The
--   requester is always the caller; another client's request and an unknown id answer alike (not_found). A second open
--   request of one type answers already_open and records nothing.
-- - staff_data_request_queue, staff_data_request, staff_assign_data_request and staff_decide_data_request: staff
--   holding manage_data_requests as a global grant at aal2 (a data request carries no jurisdiction). The assignee is
--   always the caller (submitted -> in_review, or taking over a request in review; a repeated assignment to the caller
--   changes and audits nothing). One request answers its type, state, details, instants, assignment, the requester's
--   User id and account state and whether a Legal Hold applies.
--
-- Lock order: the caller's own rows (User FOR SHARE, then the Client Profile FOR NO KEY UPDATE or the Staff Profile and
-- capability grant FOR SHARE), then the data request FOR UPDATE, then (a deletion decided allowed only)
-- public.legal_holds in SHARE mode.

-- ---------------------------------------------------------------------------
-- The relation (PS-A6 section 3).
-- ---------------------------------------------------------------------------

create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null,
  request_type text not null,
  state text not null,
  details text,
  submitted_at timestamptz not null,
  assigned_to_user_id uuid,
  decided_by_user_id uuid,
  decided_at timestamptz,
  outcome_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint data_requests_requester_user_id_fkey
    foreign key (requester_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint data_requests_assigned_to_user_id_fkey
    foreign key (assigned_to_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint data_requests_decided_by_user_id_fkey
    foreign key (decided_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint data_requests_request_type_v1_check
    check (request_type in ('access', 'correction', 'deletion', 'export', 'restriction')),
  constraint data_requests_state_v1_check
    check (state in ('submitted', 'in_review', 'decided', 'withdrawn')),
  constraint data_requests_decision_v1_check
    check (
      (decided_by_user_id is null) = (decided_at is null)
      and (decided_at is null) = (outcome_code is null)
      and (state = 'decided') = (decided_at is not null)
    ),
  constraint data_requests_outcome_v1_check
    check (outcome_code is null or outcome_code in ('allowed', 'restricted', 'deferred', 'denied')),
  constraint data_requests_details_v1_check
    check (details is null or (char_length(details) <= 20000 and details ~ '[^[:space:]]'))
);

alter table public.data_requests enable row level security;

-- At most one open request per requester and type (technical idempotency).
create unique index data_requests_one_open_idx
  on public.data_requests (requester_user_id, request_type)
  where state in ('submitted', 'in_review');

create index data_requests_requester_idx
  on public.data_requests (requester_user_id, submitted_at desc, id);

create index data_requests_state_submitted_idx
  on public.data_requests (state, submitted_at, id);

create trigger data_requests_set_updated_at
before update on public.data_requests
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Capability catalog (reference data; grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values ('manage_data_requests');

-- ---------------------------------------------------------------------------
-- Legal Hold coverage (internal; PS-A6 section 3 rule 5).
-- ---------------------------------------------------------------------------

create function public.data_request_legal_hold_applies(p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  with
    own_intakes as (
      select i.id
      from public.intakes as i
      join public.client_profiles as cp on cp.id = i.client_id
      where cp.user_id = p_user_id
    ),
    own_consultations as (
      select c.id
      from public.consultations as c
      join public.client_profiles as cp on cp.id = c.client_id
      join public.attorney_profiles as ap on ap.id = c.attorney_id
      where cp.user_id = p_user_id or ap.user_id = p_user_id
    ),
    own_referrals as (
      select f.id
      from public.referrals as f
      join public.attorney_profiles as ap on ap.id = f.attorney_id
      where f.intake_id in (select o.id from own_intakes as o)
        or ap.user_id = p_user_id
    ),
    scopes as (
      select p_user_id as id
      union all
      select o.id from own_intakes as o
      union all
      select o.id from own_consultations as o
      union all
      select r.id
      from public.resources as r
      where r.owner_user_id = p_user_id
        or r.intake_id in (select o.id from own_intakes as o)
        or r.consultation_id in (select o.id from own_consultations as o)
      union all
      select k.id
      from public.complaint_cases as k
      where k.complainant_user_id = p_user_id
        or k.consultation_id in (select o.id from own_consultations as o)
        or k.referral_id in (select o.id from own_referrals as o)
    )
  select p_user_id is not null and (
    exists (
      select 1
      from public.legal_holds as h
      where h.scope_id in (select s.id from scopes as s)
        and (h.released_at is null or h.released_at > statement_timestamp())
    )
    or exists (
      select 1
      from public.resources as r
      where (
          r.owner_user_id = p_user_id
          or r.intake_id in (select o.id from own_intakes as o)
          or r.consultation_id in (select o.id from own_consultations as o)
        )
        and public.resource_under_legal_hold(r.id)
    )
  );
$function$;

-- ---------------------------------------------------------------------------
-- The guard (every role).
-- ---------------------------------------------------------------------------

create function public.data_request_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.data_requests rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'submitted' then
      raise exception 'a data request is recorded submitted'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.requester_user_id is distinct from old.requester_user_id
     or new.request_type is distinct from old.request_type
     or new.details is distinct from old.details
     or new.submitted_at is distinct from old.submitted_at
     or new.created_at is distinct from old.created_at then
    raise exception 'a data request keeps its requester, type, details and submission'
      using errcode = '55000';
  end if;
  if old.state in ('decided', 'withdrawn')
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'a decided or withdrawn data request is final'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'submitted' and new.state in ('in_review', 'withdrawn'))
       or (old.state = 'in_review' and new.state in ('decided', 'withdrawn'))
     ) then
    raise exception 'data request transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  if new.state = 'decided'
     and old.state is distinct from 'decided'
     and new.request_type = 'deletion'
     and new.outcome_code = 'allowed'
     and public.data_request_legal_hold_applies(new.requester_user_id) then
    raise exception 'a deletion request is not allowed while a Legal Hold applies'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger data_requests_guard
before insert or update or delete on public.data_requests
for each row
execute function public.data_request_guard();

create trigger data_requests_no_truncate
before truncate on public.data_requests
for each statement
execute function public.data_request_guard();

-- ---------------------------------------------------------------------------
-- Privileges: writes are function-only and the record is restricted (no direct read or write by any API role).
-- ---------------------------------------------------------------------------

revoke all on table public.data_requests
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Client commands and read (EXECUTE for authenticated only; the existing client admission).
-- ---------------------------------------------------------------------------

-- Outcomes: submitted (with the new request's id), invalid, denied (not an active client, or a User who also holds an
-- Attorney or Staff Profile without aal2), already_open (an open request of that type exists; nothing is recorded).
create function public.client_submit_data_request(p_request_type text, p_details text)
returns table (outcome text, data_request_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_details text;
  v_user uuid;
  v_request uuid;
begin
  v_details := nullif(regexp_replace(p_details, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if p_request_type is null
     or p_request_type not in ('access', 'correction', 'deletion', 'export', 'restriction')
     or char_length(v_details) > 20000 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select l.user_id into v_user from public.lock_current_client() as l;
  if v_user is null or public.notification_caller() is distinct from v_user then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  insert into public.data_requests (requester_user_id, request_type, state, details, submitted_at)
  values (v_user, p_request_type, 'submitted', v_details, clock_timestamp())
  on conflict (requester_user_id, request_type) where state in ('submitted', 'in_review')
  do nothing
  returning id into v_request;
  if v_request is null then
    return query select 'already_open'::text, null::uuid;
    return;
  end if;
  perform public.decision_audit(
    v_user, 'client', 'data_request.submitted', 'data_request', v_request,
    null,
    jsonb_build_object('request_type', p_request_type, 'state', 'submitted'),
    null, null, null
  );
  return query select 'submitted'::text, v_request;
end;
$function$;

-- Withdraws the caller's own request before its decision. Outcomes: withdrawn, invalid, denied, not_found,
-- already_decided, already_withdrawn (nothing changes).
create function public.client_withdraw_data_request(p_data_request_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_user uuid;
  v_before public.data_requests;
begin
  if p_data_request_id is null then
    return 'invalid';
  end if;
  select l.user_id into v_user from public.lock_current_client() as l;
  if v_user is null or public.notification_caller() is distinct from v_user then
    return 'denied';
  end if;
  select d.* into v_before
  from public.data_requests as d
  where d.id = p_data_request_id
    and d.requester_user_id = v_user
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state in ('decided', 'withdrawn') then
    return 'already_' || v_before.state;
  end if;
  update public.data_requests as d
  set state = 'withdrawn'
  where d.id = p_data_request_id;
  perform public.decision_audit(
    v_user, 'client', 'data_request.withdrawn', 'data_request', p_data_request_id,
    jsonb_build_object('state', v_before.state),
    jsonb_build_object('request_type', v_before.request_type, 'state', 'withdrawn'),
    null, null, null
  );
  return 'withdrawn';
end;
$function$;

-- The caller's own requests (an active User with a Client Profile, admitted as complaint_cases_mine admits), the most
-- recent first, at most 200, with their details (the requester's own words).
create function public.client_data_requests()
returns table (
  data_request_id uuid,
  request_type text,
  state text,
  details text,
  outcome_code text,
  submitted_at timestamptz,
  decided_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select d.id, d.request_type, d.state, d.details, d.outcome_code, d.submitted_at, d.decided_at, d.updated_at
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.data_requests as d on d.requester_user_id = u.id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and u.id = public.notification_caller()
  order by d.submitted_at desc, d.id
  limit 200;
$function$;

-- ---------------------------------------------------------------------------
-- Staff reads and commands (EXECUTE for authenticated only; manage_data_requests, global grant, aal2).
-- ---------------------------------------------------------------------------

-- One page (25 rows, plus one) of the requests in one state, the oldest first; never the details.
create function public.staff_data_request_queue(p_state text, p_offset integer)
returns table (
  data_request_id uuid,
  request_type text,
  state text,
  outcome_code text,
  submitted_at timestamptz,
  decided_at timestamptz,
  assigned_to_me boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    d.id, d.request_type, d.state, d.outcome_code, d.submitted_at, d.decided_at,
    coalesce(d.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false)
  from public.data_requests as d
  where public.has_staff_capability('manage_data_requests', null, false)
    and p_state in ('submitted', 'in_review', 'decided', 'withdrawn')
    and d.state = p_state
    and p_offset between 0 and 100000
  order by d.submitted_at, d.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One request with what staff need to handle it; no row without the capability or for an unknown id.
create function public.staff_data_request(p_data_request_id uuid)
returns table (
  data_request_id uuid,
  request_type text,
  state text,
  details text,
  outcome_code text,
  submitted_at timestamptz,
  decided_at timestamptz,
  updated_at timestamptz,
  assigned boolean,
  assigned_to_me boolean,
  requester_user_id uuid,
  requester_account_state text,
  legal_hold_applies boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    d.id, d.request_type, d.state, d.details, d.outcome_code, d.submitted_at, d.decided_at, d.updated_at,
    d.assigned_to_user_id is not null,
    coalesce(d.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false),
    d.requester_user_id,
    r.account_state,
    public.data_request_legal_hold_applies(d.requester_user_id)
  from public.data_requests as d
  join public.users as r on r.id = d.requester_user_id
  where d.id = p_data_request_id
    and public.has_staff_capability('manage_data_requests', null, false);
$function$;

-- Assigns a request to the caller: submitted -> in_review, or taking over a request in review. Outcomes: applied,
-- invalid, denied, not_found, invalid_transition (decided or withdrawn). A request already in review and assigned to
-- the caller answers applied and changes and audits nothing.
create function public.staff_assign_data_request(p_data_request_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.data_requests;
begin
  if p_data_request_id is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_data_requests', null);
  if v_staff is null then
    return 'denied';
  end if;
  select d.* into v_before
  from public.data_requests as d
  where d.id = p_data_request_id
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state not in ('submitted', 'in_review') then
    return 'invalid_transition';
  end if;
  if v_before.state = 'in_review' and v_before.assigned_to_user_id = v_staff then
    return 'applied';
  end if;
  update public.data_requests as d
  set state = 'in_review',
      assigned_to_user_id = v_staff
  where d.id = p_data_request_id;
  perform public.decision_audit(
    v_staff, 'staff', 'data_request.assigned', 'data_request', p_data_request_id,
    jsonb_build_object('state', v_before.state, 'assigned', v_before.assigned_to_user_id is not null),
    jsonb_build_object('request_type', v_before.request_type, 'state', 'in_review', 'assigned', true),
    null, null, null
  );
  return 'applied';
end;
$function$;

-- Decides a request in review with an outcome code. The decision is a record only: nothing is deleted, exported,
-- corrected or restricted. Outcomes: applied, invalid, denied, not_found, invalid_transition (not in review),
-- legal_hold (a deletion request decided allowed while a Legal Hold applies; nothing changes).
create function public.staff_decide_data_request(p_data_request_id uuid, p_outcome_code text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.data_requests;
begin
  if p_data_request_id is null
     or p_outcome_code is null
     or p_outcome_code not in ('allowed', 'restricted', 'deferred', 'denied') then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_data_requests', null);
  if v_staff is null then
    return 'denied';
  end if;
  select d.* into v_before
  from public.data_requests as d
  where d.id = p_data_request_id
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state is distinct from 'in_review' then
    return 'invalid_transition';
  end if;
  if v_before.request_type = 'deletion' and p_outcome_code = 'allowed' then
    lock table public.legal_holds in share mode;
    if public.data_request_legal_hold_applies(v_before.requester_user_id) then
      return 'legal_hold';
    end if;
  end if;
  update public.data_requests as d
  set state = 'decided',
      decided_by_user_id = v_staff,
      decided_at = clock_timestamp(),
      outcome_code = p_outcome_code
  where d.id = p_data_request_id;
  perform public.decision_audit(
    v_staff, 'staff', 'data_request.decided', 'data_request', p_data_request_id,
    jsonb_build_object('state', 'in_review'),
    jsonb_build_object('request_type', v_before.request_type, 'state', 'decided', 'outcome_code', p_outcome_code),
    null, null, null
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
    'public.data_request_legal_hold_applies(uuid)',
    'public.data_request_guard()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.client_submit_data_request(text, text)',
    'public.client_withdraw_data_request(uuid)',
    'public.client_data_requests()',
    'public.staff_data_request_queue(text, integer)',
    'public.staff_data_request(uuid)',
    'public.staff_assign_data_request(uuid)',
    'public.staff_decide_data_request(uuid, text)'
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

comment on table public.data_requests is
  'PS-A6 section 3 (MVP-001 S11): a User''s data request and the decision staff record on it. Recording the decision changes no other data. The state only moves forward; rows are kept forever; the request facts are fixed. Writes go through functions only and no API role holds a privilege; the requester and holders of manage_data_requests read it through functions.';
comment on column public.data_requests.request_type is
  'PS-A6 section 3 rule 1: access, correction, deletion, export or restriction.';
comment on column public.data_requests.state is
  'PS-A6 section 3 rule 2: submitted, in_review, decided or withdrawn (forward only; the last two are terminal).';
comment on column public.data_requests.details is
  'PS-A6 section 3 rule 6: what the requester wrote (up to 20,000 characters), fixed at submission and never copied into an audit event.';
comment on column public.data_requests.outcome_code is
  'PS-A6 section 3 rule 3: allowed, restricted, deferred or denied, written with the decision; allowed is refused for a deletion request while a Legal Hold covers the requester (rule 5).';
comment on function public.data_request_legal_hold_applies(uuid) is
  'PS-A6 section 3 rule 5 (internal): whether an unreleased Legal Hold (any scope type or status while released_at is unset or in the future) names the User, an Intake of their Client Profile, a Consultation they are the client or attorney of, a Resource they own or of such an Intake or Consultation, or a Complaint Case they opened or that links such a Consultation or a Referral of theirs; or whether resource_under_legal_hold reports such a Resource held.';
comment on function public.data_request_guard() is
  'PS-A6 section 3 (every role): refuses deletion and truncation, an insert not in state submitted, any change of the request facts, any move other than submitted to in_review or withdrawn and in_review to decided or withdrawn, any change after a terminal state, and allowed for a deletion request while a Legal Hold covers the requester.';
comment on function public.client_submit_data_request(text, text) is
  'PS-A6 section 3: an active client submits a data request of one type with optional details (at most 20,000 characters); one open request per type; audited without the details. Outcomes: submitted, invalid, denied, already_open.';
comment on function public.client_withdraw_data_request(uuid) is
  'PS-A6 section 3: the requester withdraws their own request before its decision; audited. Outcomes: withdrawn, invalid, denied, not_found, already_decided, already_withdrawn.';
comment on function public.client_data_requests() is
  'PS-A6 section 3: the calling client''s own data requests (type, state, details, outcome, instants); at most 200.';
comment on function public.staff_data_request_queue(text, integer) is
  'PS-A6 section 3: one page of the data requests in one state, oldest first, for staff holding manage_data_requests (global grant, aal2); never the details.';
comment on function public.staff_data_request(uuid) is
  'PS-A6 section 3: one data request for staff holding manage_data_requests (global grant, aal2): type, state, details, instants, assignment, the requester''s User id and account state and whether a Legal Hold applies.';
comment on function public.staff_assign_data_request(uuid) is
  'PS-A6 section 3: staff holding manage_data_requests (global grant, aal2) assign a request to themselves (submitted -> in_review, or taking over one in review); audited. Outcomes: applied, invalid, denied, not_found, invalid_transition.';
comment on function public.staff_decide_data_request(uuid, text) is
  'PS-A6 section 3: staff holding manage_data_requests (global grant, aal2) decide a request in review (allowed, restricted, deferred or denied); a record only, nothing is executed; a deletion request is refused allowed while a Legal Hold applies; audited. Outcomes: applied, invalid, denied, not_found, invalid_transition, legal_hold.';
