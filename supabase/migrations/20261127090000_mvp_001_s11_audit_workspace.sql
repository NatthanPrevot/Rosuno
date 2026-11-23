-- MVP-001 S11 pass 2 (9 of 16): the read-only audit workspace (MVP-001 Packet S11 "reconciliation and audit
-- workspaces"; MBS sections 16 "Operations" (inspect audit and security events) and 18.4 "security / audit"; TA
-- sections 18 "audit search", 40 and 41; PS sections 25 and 30.4; MB section 106).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). public.audit_events (PS section 25)
-- stays append-only, server-generated and never client-writable: nothing here changes its rows, its guard trigger or
-- its grants. Who can write it was examined for this pass: every application audit row is written inside a security
-- definer function, but service_role keeps the P1 INSERT and SELECT grant (20260921051204) because two earlier
-- proofs pin it (m4 AUD-1 and P3-904 PRIV-2); anon and authenticated hold no privilege on the relation at all. The
-- S11 operations proof shows a direct insert refused for anon and authenticated and records the retained
-- service_role grant.
--
-- Reads (EXECUTE for authenticated only; security definer; search_path pinned; view_audit_events at aal2 with an
-- active User and Staff Profile, through audit_view_scope). A global grant reads every event; a jurisdiction-scoped
-- grant reads only the events recorded with one of its jurisdictions, so an event without a jurisdiction needs a
-- global grant (TA section 41: minimum necessary). Without a grant, with an aal1 session, or for anyone else, the
-- reads answer nothing; an event outside the caller's scope answers exactly as an unknown id does.
-- - staff_audit_events: one page (25 rows, plus one that says another page follows) of events, newest first
--   (occurred_at, then id), filtered by any of: a time range [from, until), an action code, a resource type and
--   identifier, an actor type and an actor User, and the fixed security group. The list carries identifiers, codes
--   and times only, never a snapshot;
-- - staff_audit_event: one event with its recorded snapshots and policy references exactly as stored.
-- The security group is a fixed filter over action codes that already exist (no new storage): the sign-in abuse
-- control events of S2 (security.rate_limited, security.suspicious_login, security.protection_unavailable) and the
-- capability changes of S1 (capability_grant.granted, capability_grant.revoked). No existing action code records a
-- step-up or a privileged denial (step-up is verified by the identity provider and a denial is a fixed answer that
-- changes nothing), so the group lists none: an owner question, recorded with the S11 report.
--
-- Each read is itself audited, once per request by a caller holding the capability with well-formed input: one
-- event (actor staff, action audit_events.viewed or audit_event.viewed) recording the filter facts or the requested
-- identifier, the page offset and the number of rows answered; never a snapshot, a reason text or any other content.
-- The reads are therefore volatile (they write that one event) and bound their lock waits.

-- ---------------------------------------------------------------------------
-- The caller's audit read scope (internal).
-- ---------------------------------------------------------------------------

-- The calling staff User and the scope of their current view_audit_events grants (a global grant, and the
-- jurisdictions of their jurisdiction-scoped grants), or a null User when the session is not aal2, the User or Staff
-- Profile is not active, or no grant is current.
create function public.audit_view_scope(out user_id uuid, out global_grant boolean, out jurisdictions uuid[])
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_user uuid;
  v_global boolean;
  v_jurisdictions uuid[];
  v_grants bigint;
begin
  user_id := null;
  global_grant := false;
  jurisdictions := array[]::uuid[];
  if public.current_session_aal2() is not true then
    return;
  end if;
  select u.id into v_user
  from public.users as u
  join public.staff_profiles as s on s.user_id = u.id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and s.staff_state = 'active';
  if v_user is null then
    return;
  end if;
  select
    coalesce(bool_or(g.jurisdiction_id is null), false),
    coalesce(array_agg(distinct g.jurisdiction_id) filter (where g.jurisdiction_id is not null), array[]::uuid[]),
    count(*)
  into v_global, v_jurisdictions, v_grants
  from public.capability_grants as g
  where g.user_id = v_user
    and g.capability_code = 'view_audit_events'
    and g.granted_at <= statement_timestamp()
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > statement_timestamp())
    and g.resource_scope is null;
  if v_grants = 0 then
    return;
  end if;
  user_id := v_user;
  global_grant := v_global;
  jurisdictions := v_jurisdictions;
end;
$function$;

-- The fixed security group: the action codes of the existing sign-in abuse control and capability change events.
create function public.audit_security_action_codes()
returns text[]
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select array[
    'security.rate_limited',
    'security.suspicious_login',
    'security.protection_unavailable',
    'capability_grant.granted',
    'capability_grant.revoked'
  ]::text[];
$function$;

-- Whether a filter code is well formed: absent, or a lower-snake code (dotted segments allowed for action codes).
create function public.audit_filter_code_valid(p_code text, p_dotted boolean)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select p_code is null
    or (
      char_length(p_code) <= 100
      and case
        when p_dotted then p_code collate "C" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
        else p_code collate "C" ~ '^[a-z][a-z0-9_]{1,63}$'
      end
    );
$function$;

-- ---------------------------------------------------------------------------
-- The reads.
-- ---------------------------------------------------------------------------

create function public.staff_audit_events(
  p_from timestamptz,
  p_until timestamptz,
  p_action_code text,
  p_resource_type text,
  p_resource_id uuid,
  p_performer_type text,
  p_performer_id uuid,
  p_security_only boolean,
  p_offset integer
)
returns table (
  audit_event_id uuid,
  occurred_at timestamptz,
  actor_type text,
  actor_user_id uuid,
  action_code text,
  resource_type text,
  resource_id uuid,
  jurisdiction_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_scope record;
  v_rows integer;
  v_security text[];
begin
  if p_offset is null
     or p_offset < 0
     or p_offset > 100000
     or p_security_only is null
     or (p_from is not null and p_until is not null and p_until <= p_from)
     or not public.audit_filter_code_valid(p_action_code, true)
     or not public.audit_filter_code_valid(p_resource_type, false)
     or not public.audit_filter_code_valid(p_performer_type, false) then
    return;
  end if;
  select s.* into v_scope from public.audit_view_scope() as s;
  if v_scope.user_id is null then
    return;
  end if;
  v_security := public.audit_security_action_codes();
  return query
    select e.id, e.occurred_at, e.actor_type, e.actor_user_id, e.action_code, e.resource_type, e.resource_id,
      e.jurisdiction_id, e.reason_code
    from public.audit_events as e
    where (v_scope.global_grant or e.jurisdiction_id = any (v_scope.jurisdictions))
      and (p_from is null or e.occurred_at >= p_from)
      and (p_until is null or e.occurred_at < p_until)
      and (p_action_code is null or e.action_code = p_action_code)
      and (p_resource_type is null or e.resource_type = p_resource_type)
      and (p_resource_id is null or e.resource_id = p_resource_id)
      and (p_performer_type is null or e.actor_type = p_performer_type)
      and (p_performer_id is null or e.actor_user_id = p_performer_id)
      and (not p_security_only or e.action_code = any (v_security))
    order by e.occurred_at desc, e.id desc
    offset p_offset
    limit 26;
  get diagnostics v_rows = row_count;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_scope.user_id, 'staff', 'audit_events.viewed', 'audit_events', null,
    null,
    jsonb_build_object(
      'filters', jsonb_strip_nulls(jsonb_build_object(
        'from', p_from,
        'until', p_until,
        'action_code', p_action_code,
        'resource_type', p_resource_type,
        'resource_id', p_resource_id,
        'actor_type', p_performer_type,
        'actor_user_id', p_performer_id,
        'security_only', p_security_only
      )),
      'offset', p_offset,
      'rows', v_rows,
      'scope', case when v_scope.global_grant then 'global' else 'jurisdiction' end
    ),
    null, null, null, clock_timestamp()
  );
end;
$function$;

create function public.staff_audit_event(p_audit_event_id uuid)
returns table (
  audit_event_id uuid,
  occurred_at timestamptz,
  created_at timestamptz,
  actor_type text,
  actor_user_id uuid,
  action_code text,
  resource_type text,
  resource_id uuid,
  jurisdiction_id uuid,
  reason_code text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  policy_references jsonb
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_scope record;
  v_rows integer;
begin
  if p_audit_event_id is null then
    return;
  end if;
  select s.* into v_scope from public.audit_view_scope() as s;
  if v_scope.user_id is null then
    return;
  end if;
  return query
    select e.id, e.occurred_at, e.created_at, e.actor_type, e.actor_user_id, e.action_code, e.resource_type,
      e.resource_id, e.jurisdiction_id, e.reason_code, e.before_snapshot, e.after_snapshot, e.policy_references
    from public.audit_events as e
    where e.id = p_audit_event_id
      and (v_scope.global_grant or e.jurisdiction_id = any (v_scope.jurisdictions));
  get diagnostics v_rows = row_count;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_scope.user_id, 'staff', 'audit_event.viewed', 'audit_event', p_audit_event_id,
    null,
    jsonb_build_object(
      'rows', v_rows,
      'scope', case when v_scope.global_grant then 'global' else 'jurisdiction' end
    ),
    null, null, null, clock_timestamp()
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.audit_view_scope()
  from public, anon, authenticated, service_role;
revoke all on function public.audit_security_action_codes()
  from public, anon, authenticated, service_role;
revoke all on function public.audit_filter_code_valid(text, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.staff_audit_events(
  timestamptz, timestamptz, text, text, uuid, text, uuid, boolean, integer
) from public, anon, authenticated, service_role;
grant execute on function public.staff_audit_events(
  timestamptz, timestamptz, text, text, uuid, text, uuid, boolean, integer
) to authenticated;
revoke all on function public.staff_audit_event(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_audit_event(uuid) to authenticated;

comment on function public.audit_view_scope() is
  'MVP-001 S11 (internal): the calling staff User and the scope of their current view_audit_events grants (global, and the jurisdictions of scoped grants), or a null User without an aal2 session, an active User and Staff Profile and a current grant. Executable by no API role.';
comment on function public.audit_security_action_codes() is
  'MVP-001 S11 (internal): the fixed security group of the audit workspace: the existing sign-in abuse control and capability change action codes. Executable by no API role.';
comment on function public.audit_filter_code_valid(text, boolean) is
  'MVP-001 S11 (internal): whether an audit filter code is absent or a well-formed lower-snake code (dotted segments allowed for action codes). Executable by no API role.';
comment on function public.staff_audit_events(timestamptz, timestamptz, text, text, uuid, text, uuid, boolean, integer) is
  'MVP-001 S11 audit workspace: one page (25 rows, plus one) of audit events newest first for staff holding view_audit_events (aal2; a scoped grant reads only its jurisdictions'' events, events without a jurisdiction need a global grant), filtered by time range, action code, resource, actor and the fixed security group; identifiers, codes and times only. Each request is audited once with its filter facts.';
comment on function public.staff_audit_event(uuid) is
  'MVP-001 S11 audit workspace: one audit event with its recorded snapshots exactly as stored, for staff holding view_audit_events covering its jurisdiction (aal2); an event outside the scope answers as an unknown id. Each request is audited once with the requested identifier.';
