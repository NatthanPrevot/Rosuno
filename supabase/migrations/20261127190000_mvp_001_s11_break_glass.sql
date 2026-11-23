-- MVP-001 S11 PS-A6 (1 of 3): Break-Glass Grants (PS-A6 sections 2 and 8; MVP-001 Packet S11; MBS section 5
-- "break-glass foundation" and section 20; TA sections 18, 20, 21 and 41; DM section 3 "Break-Glass Grant"; PS P3, P11
-- and P12 and section 30).
--
-- This migration creates exactly one relation, public.break_glass_grants, with exactly the PS-A6 section 2 columns, and
-- one capability catalog row (reference data; grants stay configuration rows and none is inserted). No other relation,
-- column, policy type or business row is added, and no existing function, predicate or row policy changes: a grant
-- confers no capability, and neither the capability checks nor the metadata predicate nor any storage policy consult it
-- (PS-A6 sections 2 rule 7 and 6).
--
-- Rules, for every role, the database owner included (constraints and one guard trigger):
-- - resource_type admits only consultation in S11, and the named Consultation must exist when the row is inserted
--   (PS-A6 section 2 rule 1);
-- - an inserted row carries no approval and no revocation yet (PS-A6 section 1);
-- - the Domain Model state is computed from the recorded columns whenever it is read (break_glass_state; PS-A6 section
--   2 rule 2; PS P3): there is no state column and no scheduled job;
-- - the three approval columns (approved_by_user_id, approved_at, expires_at) are written in one change and never
--   rewritten, and never once a revocation is recorded; approver and requester differ; the approval instant is not
--   before requested_at and not later than the moment it is written; the expiry falls after the approval instant and
--   no more than 24 hours later (PS-A6 section 2 rule 3);
-- - the two revocation columns are written in one change, never rewritten, and not before requested_at (rule 4);
-- - the reason holds between 1 and 2,000 characters, not only whitespace (rule 5);
-- - rows are never deleted or truncated, and the requester, resource, reason, request instant, identifier and creation
--   instant are fixed (rules 5 and 6).
--
-- Authority (PS-A6 section 2 rules 8 and 9). Every command and read is EXECUTE for authenticated only, security definer
-- with search_path pinned, and needs an aal2 session; unknown and unauthorized answer alike; commands bound their lock
-- waits and audit atomically with identifiers and codes only (never the reason).
-- - staff_request_break_glass: an active User with an active Staff Profile names one existing Consultation and a
--   reason. Technical idempotency: a repeated request by the same staff member for the same Consultation while one is
--   requested or active answers that grant (existing) and records nothing. The caller's Staff Profile is locked FOR NO
--   KEY UPDATE, so two requests of one staff member serialize.
-- - staff_approve_break_glass and staff_revoke_break_glass: holders of approve_break_glass (capability catalog row
--   below) for the Consultation's jurisdiction (a global grant for a Consultation without one, or an unknown grant),
--   the has_staff_capability scope rule. Approval names the duration, 1 second to 24 hours (no default), and is refused
--   to the requester. Revocation refuses a request that was never approved (refused) or ends an active grant (ended);
--   an already revoked or expired grant answers its state and changes nothing.
-- - staff_break_glass_grants_mine (the requester's own grants), staff_break_glass_queue (holders: the grants in scope
--   by derived state) and staff_break_glass_grant (one grant, for its requester or a holder in scope).
-- - staff_break_glass_consultation (PS-A6 section 2 rule 7): the dedicated break-glass read. Only the caller's own
--   grant, in the active state at the moment of the call, opens it, and only for the one Consultation that grant names;
--   every call that answers records one audit event carrying the grant's id. It returns that Consultation's record
--   (state, scheduled times, outcome), its visible Messages and the metadata of the current version of each available
--   document, and writes nothing else. Document content is not served: no existing server-side path could serve it
--   under a break-glass authorization without widening a general predicate.
--
-- Lock order: the caller's User FOR SHARE, their Staff Profile, the capability grant FOR SHARE (approve, revoke), then
-- the Break-Glass Grant (FOR UPDATE to approve or revoke; FOR SHARE to access, so an access and a revocation serialize
-- and an access answers only a grant that is active once it holds the lock).

-- ---------------------------------------------------------------------------
-- The relation (PS-A6 section 2).
-- ---------------------------------------------------------------------------

create table public.break_glass_grants (
  id uuid primary key default gen_random_uuid(),
  requested_by_user_id uuid not null,
  resource_type text not null,
  resource_id uuid not null,
  reason text not null,
  requested_at timestamptz not null,
  approved_by_user_id uuid,
  approved_at timestamptz,
  expires_at timestamptz,
  revoked_by_user_id uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint break_glass_grants_requested_by_user_id_fkey
    foreign key (requested_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint break_glass_grants_approved_by_user_id_fkey
    foreign key (approved_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint break_glass_grants_revoked_by_user_id_fkey
    foreign key (revoked_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint break_glass_grants_resource_type_v1_check
    check (resource_type = 'consultation'),
  constraint break_glass_grants_reason_v1_check
    check (char_length(reason) <= 2000 and reason ~ '[^[:space:]]'),
  constraint break_glass_grants_approval_v1_check
    check (
      (approved_by_user_id is null) = (approved_at is null)
      and (approved_at is null) = (expires_at is null)
      and (approved_by_user_id is null or approved_by_user_id <> requested_by_user_id)
      and (
        approved_at is null
        or (
          approved_at >= requested_at
          and expires_at > approved_at
          and expires_at <= approved_at + interval '24 hours'
        )
      )
    ),
  constraint break_glass_grants_revocation_v1_check
    check (
      (revoked_by_user_id is null) = (revoked_at is null)
      and (revoked_at is null or revoked_at >= requested_at)
    )
);

alter table public.break_glass_grants enable row level security;

create index break_glass_grants_requester_idx
  on public.break_glass_grants (requested_by_user_id, requested_at desc, id);

create index break_glass_grants_resource_idx
  on public.break_glass_grants (resource_type, resource_id);

create index break_glass_grants_requested_at_idx
  on public.break_glass_grants (requested_at, id);

-- ---------------------------------------------------------------------------
-- Capability catalog (reference data; grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values ('approve_break_glass');

-- ---------------------------------------------------------------------------
-- Derived facts (internal).
-- ---------------------------------------------------------------------------

-- The Domain Model state of a grant at an instant (PS-A6 section 2 rule 2): revoked when its revocation is recorded,
-- requested when it is not approved, active before its expiry, expired at or after it.
create function public.break_glass_state(
  p_approved_at timestamptz,
  p_expires_at timestamptz,
  p_revoked_at timestamptz,
  p_as_of timestamptz
)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_revoked_at is not null then 'revoked'
    when p_approved_at is null then 'requested'
    when p_as_of < p_expires_at then 'active'
    else 'expired'
  end;
$function$;

-- The jurisdiction of a grant's resource: a Consultation's (its Request's Referral's); null otherwise.
create function public.break_glass_resource_jurisdiction(p_resource_type text, p_resource_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select f.jurisdiction_id
  from public.consultations as c
  join public.consultation_requests as r on r.id = c.consultation_request_id
  join public.referrals as f on f.id = r.referral_id
  where p_resource_type = 'consultation'
    and c.id = p_resource_id;
$function$;

-- ---------------------------------------------------------------------------
-- The guard (every role).
-- ---------------------------------------------------------------------------

create function public.break_glass_grant_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.break_glass_grants rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.approved_by_user_id is not null
       or new.approved_at is not null
       or new.expires_at is not null
       or new.revoked_by_user_id is not null
       or new.revoked_at is not null then
      raise exception 'a break-glass grant is recorded as a request'
        using errcode = '23514';
    end if;
    if new.resource_type = 'consultation'
       and not exists (select 1 from public.consultations as c where c.id = new.resource_id) then
      raise exception 'a break-glass grant names one existing resource'
        using errcode = '23503';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.requested_by_user_id is distinct from old.requested_by_user_id
     or new.resource_type is distinct from old.resource_type
     or new.resource_id is distinct from old.resource_id
     or new.reason is distinct from old.reason
     or new.requested_at is distinct from old.requested_at
     or new.created_at is distinct from old.created_at then
    raise exception 'a break-glass grant keeps its requester, resource, reason and request'
      using errcode = '55000';
  end if;
  if old.approved_at is not null
     and (
       new.approved_by_user_id is distinct from old.approved_by_user_id
       or new.approved_at is distinct from old.approved_at
       or new.expires_at is distinct from old.expires_at
     ) then
    raise exception 'a break-glass grant is approved once'
      using errcode = '55000';
  end if;
  if old.revoked_at is not null
     and (
       new.approved_by_user_id is distinct from old.approved_by_user_id
       or new.approved_at is distinct from old.approved_at
       or new.expires_at is distinct from old.expires_at
     ) then
    raise exception 'a revoked break-glass grant is never approved'
      using errcode = '55000';
  end if;
  if old.approved_at is null
     and new.approved_at is not null
     and new.approved_at > clock_timestamp() then
    raise exception 'a break-glass approval is not recorded ahead of its instant'
      using errcode = '23514';
  end if;
  if old.revoked_at is not null
     and (
       new.revoked_by_user_id is distinct from old.revoked_by_user_id
       or new.revoked_at is distinct from old.revoked_at
     ) then
    raise exception 'a break-glass grant is revoked once'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger break_glass_grants_guard
before insert or update or delete on public.break_glass_grants
for each row
execute function public.break_glass_grant_guard();

create trigger break_glass_grants_no_truncate
before truncate on public.break_glass_grants
for each statement
execute function public.break_glass_grant_guard();

-- ---------------------------------------------------------------------------
-- Privileges: writes are function-only and the record is restricted (no direct read or write by any API role).
-- ---------------------------------------------------------------------------

revoke all on table public.break_glass_grants
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Callers (internal).
-- ---------------------------------------------------------------------------

-- The calling staff member (an active User with an active Staff Profile, at aal2), with their User locked FOR SHARE and
-- their Staff Profile FOR NO KEY UPDATE (two requests of one staff member serialize); null otherwise.
create function public.break_glass_lock_requester()
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_user uuid;
  v_state text;
begin
  if public.current_session_aal2() is not true then
    return null;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return null;
  end if;
  select s.staff_state into v_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for no key update;
  if not found or v_state is distinct from 'active' then
    return null;
  end if;
  return v_user;
end;
$function$;

-- The calling staff member when they hold approve_break_glass for the given grant's resource jurisdiction, locked
-- (User, Staff Profile, grant), with whether the grant exists and that jurisdiction. The grant's resource is an
-- immutable fact, read before any lock; for an unknown grant a global grant is needed.
create function public.break_glass_lock_approver(
  p_break_glass_id uuid,
  out staff_user_id uuid,
  out grant_known boolean,
  out jurisdiction_id uuid
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  select true, public.break_glass_resource_jurisdiction(g.resource_type, g.resource_id)
  into grant_known, jurisdiction_id
  from public.break_glass_grants as g
  where g.id = p_break_glass_id;
  grant_known := coalesce(grant_known, false);
  staff_user_id := public.lock_current_capability_staff('approve_break_glass', jurisdiction_id);
end;
$function$;

-- The calling staff member (an active User with an active Staff Profile, at aal2), without locks; null otherwise.
create function public.break_glass_reader()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select u.id
  from public.users as u
  join public.staff_profiles as s on s.user_id = u.id
  where public.current_session_aal2() is true
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and s.staff_state = 'active';
$function$;

-- ---------------------------------------------------------------------------
-- Commands (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Outcomes: requested (with the new grant's id), existing (with the id of the caller's grant for that Consultation that
-- is requested or active; nothing is recorded), invalid, denied, not_found.
create function public.staff_request_break_glass(p_consultation_id uuid, p_reason text)
returns table (outcome text, break_glass_grant_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_reason text;
  v_staff uuid;
  v_now timestamptz;
  v_existing uuid;
  v_grant uuid;
begin
  v_reason := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if p_consultation_id is null
     or v_reason is null
     or v_reason = ''
     or not public.professional_text_within(v_reason, 2000) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.break_glass_lock_requester();
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if not exists (select 1 from public.consultations as c where c.id = p_consultation_id) then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  v_now := clock_timestamp();
  select g.id into v_existing
  from public.break_glass_grants as g
  where g.requested_by_user_id = v_staff
    and g.resource_type = 'consultation'
    and g.resource_id = p_consultation_id
    and public.break_glass_state(g.approved_at, g.expires_at, g.revoked_at, v_now) in ('requested', 'active')
  order by g.requested_at desc, g.id
  limit 1;
  if v_existing is not null then
    return query select 'existing'::text, v_existing;
    return;
  end if;
  insert into public.break_glass_grants (
    requested_by_user_id, resource_type, resource_id, reason, requested_at
  ) values (
    v_staff, 'consultation', p_consultation_id, v_reason, v_now
  )
  returning id into v_grant;
  perform public.decision_audit(
    v_staff, 'staff', 'break_glass_grant.requested', 'break_glass_grant', v_grant,
    null,
    jsonb_build_object('resource_type', 'consultation', 'resource_id', p_consultation_id, 'state', 'requested'),
    null, null, public.break_glass_resource_jurisdiction('consultation', p_consultation_id)
  );
  return query select 'requested'::text, v_grant;
end;
$function$;

-- Approves a requested grant for p_duration_seconds (1 to 86,400; no default): the access starts at once. Outcomes:
-- approved, invalid, denied, not_found, own_request (the approver is the requester), already_active, already_expired,
-- already_revoked (nothing changes).
create function public.staff_approve_break_glass(p_break_glass_id uuid, p_duration_seconds integer)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_before public.break_glass_grants;
  v_now timestamptz;
  v_state text;
  v_expires timestamptz;
begin
  if p_break_glass_id is null
     or p_duration_seconds is null
     or p_duration_seconds not between 1 and 86400 then
    return 'invalid';
  end if;
  select l.* into v_lock from public.break_glass_lock_approver(p_break_glass_id) as l;
  if v_lock.staff_user_id is null then
    return 'denied';
  end if;
  if not v_lock.grant_known then
    return 'not_found';
  end if;
  select g.* into v_before
  from public.break_glass_grants as g
  where g.id = p_break_glass_id
  for update;
  if v_before.requested_by_user_id = v_lock.staff_user_id then
    return 'own_request';
  end if;
  v_now := clock_timestamp();
  v_state := public.break_glass_state(v_before.approved_at, v_before.expires_at, v_before.revoked_at, v_now);
  if v_state <> 'requested' then
    return 'already_' || v_state;
  end if;
  v_expires := v_now + make_interval(secs => p_duration_seconds);
  update public.break_glass_grants as g
  set approved_by_user_id = v_lock.staff_user_id,
      approved_at = v_now,
      expires_at = v_expires
  where g.id = p_break_glass_id;
  perform public.decision_audit(
    v_lock.staff_user_id, 'staff', 'break_glass_grant.approved', 'break_glass_grant', p_break_glass_id,
    jsonb_build_object('state', 'requested'),
    jsonb_build_object(
      'state', 'active',
      'resource_type', v_before.resource_type,
      'resource_id', v_before.resource_id,
      'duration_seconds', p_duration_seconds,
      'expires_at', v_expires
    ),
    null, null, v_lock.jurisdiction_id
  );
  return 'approved';
end;
$function$;

-- Revokes a grant: a request that was never approved is refused (refused), an active grant ends (ended). Outcomes:
-- refused, ended, invalid, denied, not_found, already_revoked, already_expired (nothing changes).
create function public.staff_revoke_break_glass(p_break_glass_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_before public.break_glass_grants;
  v_now timestamptz;
  v_state text;
begin
  if p_break_glass_id is null then
    return 'invalid';
  end if;
  select l.* into v_lock from public.break_glass_lock_approver(p_break_glass_id) as l;
  if v_lock.staff_user_id is null then
    return 'denied';
  end if;
  if not v_lock.grant_known then
    return 'not_found';
  end if;
  select g.* into v_before
  from public.break_glass_grants as g
  where g.id = p_break_glass_id
  for update;
  v_now := clock_timestamp();
  v_state := public.break_glass_state(v_before.approved_at, v_before.expires_at, v_before.revoked_at, v_now);
  if v_state in ('revoked', 'expired') then
    return 'already_' || v_state;
  end if;
  update public.break_glass_grants as g
  set revoked_by_user_id = v_lock.staff_user_id,
      revoked_at = v_now
  where g.id = p_break_glass_id;
  perform public.decision_audit(
    v_lock.staff_user_id, 'staff',
    case v_state when 'requested' then 'break_glass_grant.refused' else 'break_glass_grant.revoked' end,
    'break_glass_grant', p_break_glass_id,
    jsonb_build_object('state', v_state),
    jsonb_build_object(
      'state', 'revoked',
      'resource_type', v_before.resource_type,
      'resource_id', v_before.resource_id
    ),
    null, null, v_lock.jurisdiction_id
  );
  return case v_state when 'requested' then 'refused' else 'ended' end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reads (EXECUTE for authenticated only; aal2).
-- ---------------------------------------------------------------------------

-- The caller's own grants (an active User with an active Staff Profile), the most recent first, at most 200, each with
-- its state derived at the statement's instant.
create function public.staff_break_glass_grants_mine()
returns table (
  break_glass_grant_id uuid,
  resource_type text,
  resource_id uuid,
  reason text,
  state text,
  requested_at timestamptz,
  approved_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    g.id, g.resource_type, g.resource_id, g.reason,
    public.break_glass_state(g.approved_at, g.expires_at, g.revoked_at, statement_timestamp()),
    g.requested_at, g.approved_at, g.expires_at, g.revoked_at
  from public.break_glass_grants as g
  where g.requested_by_user_id = public.break_glass_reader()
  order by g.requested_at desc, g.id
  limit 200;
$function$;

-- One page (25 rows, plus one) of the grants in one derived state (requested, active, expired, revoked), the oldest
-- request first, whose resource jurisdiction the caller holds approve_break_glass for (a global grant for none).
create function public.staff_break_glass_queue(p_state text, p_offset integer)
returns table (
  break_glass_grant_id uuid,
  resource_type text,
  resource_id uuid,
  jurisdiction_id uuid,
  reason text,
  state text,
  requested_at timestamptz,
  approved_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  requested_by_me boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    g.id, g.resource_type, g.resource_id, x.jurisdiction_id, g.reason, x.state,
    g.requested_at, g.approved_at, g.expires_at, g.revoked_at,
    g.requested_by_user_id is not distinct from public.break_glass_reader()
  from public.break_glass_grants as g
  cross join lateral (
    select
      public.break_glass_resource_jurisdiction(g.resource_type, g.resource_id) as jurisdiction_id,
      public.break_glass_state(g.approved_at, g.expires_at, g.revoked_at, statement_timestamp()) as state
  ) as x
  where p_state in ('requested', 'active', 'expired', 'revoked')
    and p_offset between 0 and 100000
    and x.state = p_state
    and public.has_staff_capability('approve_break_glass', x.jurisdiction_id, false)
  order by g.requested_at, g.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One grant, for its requester (an active staff member) or a holder of approve_break_glass for its resource
-- jurisdiction; no row for anyone else or an unknown id.
create function public.staff_break_glass_grant(p_break_glass_id uuid)
returns table (
  break_glass_grant_id uuid,
  resource_type text,
  resource_id uuid,
  jurisdiction_id uuid,
  reason text,
  state text,
  requested_at timestamptz,
  approved_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  requested_by_me boolean,
  may_decide boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    g.id, g.resource_type, g.resource_id, x.jurisdiction_id, g.reason, x.state,
    g.requested_at, g.approved_at, g.expires_at, g.revoked_at,
    g.requested_by_user_id is not distinct from x.reader,
    x.holder
  from public.break_glass_grants as g
  cross join lateral (
    select
      public.break_glass_resource_jurisdiction(g.resource_type, g.resource_id) as jurisdiction_id,
      public.break_glass_state(g.approved_at, g.expires_at, g.revoked_at, statement_timestamp()) as state,
      public.break_glass_reader() as reader,
      public.has_staff_capability(
        'approve_break_glass', public.break_glass_resource_jurisdiction(g.resource_type, g.resource_id), false
      ) as holder
  ) as x
  where g.id = p_break_glass_id
    and x.reader is not null
    and (g.requested_by_user_id = x.reader or x.holder);
$function$;

-- ---------------------------------------------------------------------------
-- The break-glass access path (PS-A6 section 2 rule 7).
-- ---------------------------------------------------------------------------

-- The read-only view of the one Consultation the caller's own active grant names, with one audit event per access;
-- no row otherwise (another staff member's grant, a grant that is requested, expired or revoked, an unknown id, and a
-- caller who is not an active staff member at aal2 alike). Messages: the visible ones, newest 500 (shown oldest
-- first). Documents: the current version of each available document of the Consultation, newest 200 (shown oldest
-- first), metadata only.
create function public.staff_break_glass_consultation(p_break_glass_id uuid)
returns table (
  break_glass_grant_id uuid,
  expires_at timestamptz,
  consultation_id uuid,
  consultation_state text,
  request_path text,
  modality text,
  duration_minutes integer,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text,
  messages jsonb,
  older_messages_not_shown boolean,
  documents jsonb,
  older_documents_not_shown boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_state text;
  v_grant public.break_glass_grants;
  v_context record;
  v_outcome text;
  v_messages jsonb;
  v_more_messages boolean;
  v_documents jsonb;
  v_more_documents boolean;
begin
  if p_break_glass_id is null or public.current_session_aal2() is not true then
    return;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return;
  end if;
  select s.staff_state into v_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for share;
  if not found or v_state is distinct from 'active' then
    return;
  end if;
  select g.* into v_grant
  from public.break_glass_grants as g
  where g.id = p_break_glass_id
    and g.requested_by_user_id = v_user
  for share;
  if not found
     or v_grant.resource_type is distinct from 'consultation'
     or public.break_glass_state(v_grant.approved_at, v_grant.expires_at, v_grant.revoked_at, clock_timestamp())
        is distinct from 'active' then
    return;
  end if;
  select x.* into v_context from public.consultation_context(v_grant.resource_id) as x;
  if v_context.consultation_id is null then
    return;
  end if;
  select c.outcome_code into v_outcome from public.consultations as c where c.id = v_grant.resource_id;
  with recent as (
    select m.id, m.sender_user_id, m.body, m.sent_at
    from public.messages as m
    where m.consultation_id = v_grant.resource_id
      and m.visibility_state = 'visible'
    order by m.sent_at desc, m.id desc
    limit 501
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'message_id', r.id,
          'sender_role', case when r.sender_user_id = v_context.client_user_id then 'client' else 'attorney' end,
          'body', r.body,
          'sent_at', r.sent_at
        )
        order by r.sent_at, r.id
      ) filter (where r.n <= 500),
      '[]'::jsonb
    ),
    count(*) > 500
  into v_messages, v_more_messages
  from (
    select x.*, row_number() over (order by x.sent_at desc, x.id desc) as n from recent as x
  ) as r;
  with recent as (
    select
      d.id as document_id, r.id as resource_id, d.version_label, r.mime_type, r.byte_size, r.created_at,
      r.owner_user_id,
      (
        select case
          when g.id is null then 'none'
          when g.granted_at <= statement_timestamp()
               and (g.expires_at is null or g.expires_at > statement_timestamp())
               and (g.revoked_at is null or g.revoked_at > statement_timestamp()) then 'active'
          else 'revoked'
        end
        from (select 1) as one
        left join lateral (
          select s.*
          from public.resource_sharing_grants as s
          where s.resource_id = r.id
            and s.context_type = 'consultation'
            and s.context_id = r.consultation_id
          order by s.granted_at desc, s.id desc
          limit 1
        ) as g on true
      ) as sharing
    from public.resources as r
    join public.documents as d on d.resource_id = r.id
    where r.consultation_id = v_grant.resource_id
      and r.resource_kind = 'document'
      and r.visibility_state = 'available'
      and not exists (select 1 from public.documents as successor where successor.supersedes_document_id = d.id)
    order by r.created_at desc, r.id desc
    limit 201
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'document_id', r.document_id,
          'resource_id', r.resource_id,
          'version_label', r.version_label,
          'mime_type', r.mime_type,
          'byte_size', r.byte_size,
          'created_at', r.created_at,
          'uploaded_by', case when r.owner_user_id = v_context.client_user_id then 'client' else 'attorney' end,
          'sharing', r.sharing
        )
        order by r.created_at, r.resource_id
      ) filter (where r.n <= 200),
      '[]'::jsonb
    ),
    count(*) > 200
  into v_documents, v_more_documents
  from (
    select x.*, row_number() over (order by x.created_at desc, x.resource_id desc) as n from recent as x
  ) as r;
  perform public.decision_audit(
    v_user, 'staff', 'break_glass.accessed', 'break_glass_grant', v_grant.id,
    null,
    jsonb_build_object('resource_type', v_grant.resource_type, 'resource_id', v_grant.resource_id),
    null, null, v_context.jurisdiction_id
  );
  return query select
    v_grant.id,
    v_grant.expires_at,
    v_context.consultation_id,
    v_context.state,
    v_context.request_path,
    v_context.modality,
    v_context.duration_minutes,
    v_context.slot_start_at,
    v_context.slot_end_at,
    v_context.started_at,
    v_context.ended_at,
    v_outcome,
    v_messages,
    v_more_messages,
    v_documents,
    v_more_documents;
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
    'public.break_glass_state(timestamptz, timestamptz, timestamptz, timestamptz)',
    'public.break_glass_resource_jurisdiction(text, uuid)',
    'public.break_glass_grant_guard()',
    'public.break_glass_lock_requester()',
    'public.break_glass_lock_approver(uuid)',
    'public.break_glass_reader()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.staff_request_break_glass(uuid, text)',
    'public.staff_approve_break_glass(uuid, integer)',
    'public.staff_revoke_break_glass(uuid)',
    'public.staff_break_glass_grants_mine()',
    'public.staff_break_glass_queue(text, integer)',
    'public.staff_break_glass_grant(uuid)',
    'public.staff_break_glass_consultation(uuid)'
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

comment on table public.break_glass_grants is
  'PS-A6 section 2 (MVP-001 S11): a staff member''s request for time-limited read access to one Consultation, with its reason, its approval by another holder of approve_break_glass and its revocation. The state is computed when read (no state column). Rows are kept forever; the request facts are fixed; approval and revocation are each written once. Writes go through functions only and no API role holds a privilege. It confers no capability; only staff_break_glass_consultation reads through it.';
comment on column public.break_glass_grants.resource_type is
  'PS-A6 section 2 rule 1: S11 admits only consultation.';
comment on column public.break_glass_grants.reason is
  'PS-A6 section 2 rule 5: why the requester needs the access (1 to 2,000 characters, not only whitespace); fixed when the request is recorded and never copied into an audit event.';
comment on column public.break_glass_grants.expires_at is
  'PS-A6 section 2 rule 3: written with the approval; after approved_at and no more than 24 hours later.';
comment on function public.break_glass_state(timestamptz, timestamptz, timestamptz, timestamptz) is
  'PS-A6 section 2 rule 2 (internal): the derived Domain Model state of a Break-Glass Grant at an instant: revoked, requested, active or expired.';
comment on function public.break_glass_resource_jurisdiction(text, uuid) is
  'PS-A6 (internal): the jurisdiction of a Break-Glass Grant''s resource (a Consultation''s Referral''s), or null.';
comment on function public.break_glass_grant_guard() is
  'PS-A6 section 2 (every role): refuses deletion and truncation, an insert that already carries an approval or a revocation or names no existing Consultation, any change of the request facts, and a second approval or revocation.';
comment on function public.break_glass_lock_requester() is
  'PS-A6 (internal): the calling staff member (active User and Staff Profile, aal2), with the Staff Profile locked FOR NO KEY UPDATE; null otherwise.';
comment on function public.break_glass_lock_approver(uuid) is
  'PS-A6 (internal): the calling staff member, locked, when they hold approve_break_glass for the grant''s resource jurisdiction (a global grant for none or an unknown grant), with whether the grant exists.';
comment on function public.break_glass_reader() is
  'PS-A6 (internal): the calling staff member (active User and Staff Profile, aal2) without locks, or null.';
comment on function public.staff_request_break_glass(uuid, text) is
  'PS-A6 section 2: an active staff member (aal2) requests break-glass access to one existing Consultation with a reason; a repeated request while one is requested or active answers that grant; audited without the reason. Outcomes: requested, existing, invalid, denied, not_found.';
comment on function public.staff_approve_break_glass(uuid, integer) is
  'PS-A6 section 2: a holder of approve_break_glass for the Consultation''s jurisdiction (aal2) other than the requester approves a requested grant for 1 second to 24 hours; the access starts at once; audited. Outcomes: approved, invalid, denied, not_found, own_request, already_active, already_expired, already_revoked.';
comment on function public.staff_revoke_break_glass(uuid) is
  'PS-A6 section 2: a holder of approve_break_glass for the Consultation''s jurisdiction (aal2) refuses a requested grant or ends an active one; audited. Outcomes: refused, ended, invalid, denied, not_found, already_revoked, already_expired.';
comment on function public.staff_break_glass_grants_mine() is
  'PS-A6 section 2: the calling staff member''s own Break-Glass Grants (aal2) with their derived state; at most 200.';
comment on function public.staff_break_glass_queue(text, integer) is
  'PS-A6 section 2: one page of the Break-Glass Grants in one derived state whose resource jurisdiction the caller holds approve_break_glass for (aal2; a global grant for none).';
comment on function public.staff_break_glass_grant(uuid) is
  'PS-A6 section 2: one Break-Glass Grant for its requester or a holder of approve_break_glass in scope (aal2).';
comment on function public.staff_break_glass_consultation(uuid) is
  'PS-A6 section 2 rule 7: the dedicated break-glass read, answered only for the caller''s own grant while it is active and only for its Consultation: record, visible Messages and current document metadata, with one audit event per answered call. Writes nothing else; no Storage access or download.';
