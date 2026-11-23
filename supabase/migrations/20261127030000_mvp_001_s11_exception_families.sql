-- MVP-001 S11 (3 of 7): review exception families (MVP-001 Packet S11 "reconciliation and audit workspaces",
-- "compliance workspace", "operations dashboard"; MBS section 16 "Operations"; TA sections 18, 26 and 41; PS sections
-- 22.5 and 30.4 "staff access is not one universal staff policy ... reconciliation staff -> financial reconciliation";
-- PM INV-11).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). reconciliation_exceptions (PS
-- section 22.5: "payment, media and other provider/canonical discrepancies") stays the one open / assign / resolve
-- review record. Since S8 it also carries reviews that are not financial (the eligibility and jurisdiction change
-- reviews, the S9 media discrepancies, the S10 delivery escalation), and until now one capability,
-- manage_financial_operations, read and resolved all of them. From now on every exception type belongs to one family
-- and each family to one capability (PS section 30.4; TA section 41 "financial data: restricted by capability"):
--   financial   manage_financial_operations     every S7 payment, ledger and provider discrepancy type, the S9
--                                               capture_unavailable_at_completion, and the S11 cancellation, outcome
--                                               and retained-funds reviews (20261127020000);
--   compliance  manage_compliance_reviews       eligibility_change_review, jurisdiction_change_review (S8; PM rows 37
--                                               to 45);
--   operations  manage_consultation_operations  the S9 media types (media_session_mismatch,
--                                               media_activity_outside_consultation, media_unrecognized_participant,
--                                               media_room_missing, media_unknown_room) and the S10
--                                               notification_delivery_failed.
-- A type no family lists stays financial: the family every earlier slice assumed, so an unknown or future type is
-- never left without a reader and never widens the compliance or operations readers.
--
-- A staff member sees and acts only on the families they hold the capability for (a global grant at aal2, as S7
-- requires for the finance workspace):
-- - staff_finance_exceptions (S7, replaced forward): the financial family only;
-- - staff_review_exceptions (new): one family by name, for the holder of that family's capability;
-- - staff_assign_reconciliation_exception and staff_resolve_reconciliation_exception (S7, replaced forward): the
--   capability of the exception's own family. An exception of a family the caller does not hold answers not_found,
--   exactly as an unknown id does (no existence oracle); a caller holding no family at all answers denied, as before.
--   Their signatures, outcome vocabularies and audit events are unchanged.
-- Opening an exception is unchanged (payment_open_exception, decision_open_review): nothing here changes what is
-- detected, its severity, its evidence or its one-open-item-per-type-and-source rule.

-- ---------------------------------------------------------------------------
-- The family of an exception type and its capability (internal).
-- ---------------------------------------------------------------------------

create function public.exception_family(p_exception_type text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_exception_type in ('eligibility_change_review', 'jurisdiction_change_review') then 'compliance'
    when p_exception_type in (
      'media_session_mismatch', 'media_activity_outside_consultation', 'media_unrecognized_participant',
      'media_room_missing', 'media_unknown_room', 'notification_delivery_failed'
    ) then 'operations'
    else 'financial'
  end;
$function$;

create function public.exception_family_capability(p_family text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_family
    when 'financial' then 'manage_financial_operations'
    when 'compliance' then 'manage_compliance_reviews'
    when 'operations' then 'manage_consultation_operations'
  end;
$function$;

-- The calling staff member (User, Staff Profile and grant locked FOR SHARE, as lock_current_capability_staff takes
-- them) when they hold the family capability of the given exception; otherwise null, with p_other_family telling
-- whether they hold another family's capability (so the caller answers not_found instead of denied).
create function public.exception_lock_staff(p_exception_id uuid, out staff_user_id uuid, out other_family boolean)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_type text;
  v_capability text;
begin
  staff_user_id := null;
  other_family := false;
  -- The exception type is a detection fact and never changes (S7 lifecycle guard): read before any lock.
  select e.exception_type into v_type from public.reconciliation_exceptions as e where e.id = p_exception_id;
  if found then
    staff_user_id := public.lock_current_capability_staff(
      public.exception_family_capability(public.exception_family(v_type)), null
    );
    if staff_user_id is not null then
      return;
    end if;
  end if;
  foreach v_capability in array array[
    'manage_financial_operations', 'manage_compliance_reviews', 'manage_consultation_operations'
  ]
  loop
    if public.lock_current_capability_staff(v_capability, null) is not null then
      other_family := true;
      return;
    end if;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reads.
-- ---------------------------------------------------------------------------

-- One page (25 rows, plus one) of the financial family's Reconciliation Exceptions by status (the S7 function with
-- the family condition added; unchanged otherwise).
create or replace function public.staff_finance_exceptions(p_status text, p_offset integer)
returns table (
  exception_id uuid,
  exception_type text,
  severity text,
  status text,
  source_type text,
  source_id uuid,
  canonical_type text,
  canonical_id uuid,
  detected_at timestamptz,
  evidence_reference jsonb,
  assigned_to_user_id uuid,
  assigned_to_me boolean,
  resolved_at timestamptz,
  resolution_notes text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    e.id, e.exception_type, e.severity, e.status, e.source_type, e.source_id, e.canonical_type, e.canonical_id,
    e.detected_at, e.evidence_reference, e.assigned_to_user_id,
    coalesce(e.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false),
    e.resolved_at, e.resolution_notes
  from public.reconciliation_exceptions as e
  where public.has_staff_capability('manage_financial_operations', null, false)
    and public.exception_family(e.exception_type) = 'financial'
    and p_status in ('open', 'resolved')
    and e.status = p_status
    and p_offset between 0 and 100000
  order by e.detected_at desc, e.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One page (25 rows, plus one) of one family's Reconciliation Exceptions by status, for the holder of that family's
-- capability (a global grant at aal2). The assignee's User id is not answered: only whether it is the caller.
create function public.staff_review_exceptions(p_family text, p_status text, p_offset integer)
returns table (
  exception_id uuid,
  exception_type text,
  severity text,
  status text,
  source_type text,
  source_id uuid,
  canonical_type text,
  canonical_id uuid,
  detected_at timestamptz,
  evidence_reference jsonb,
  assigned boolean,
  assigned_to_me boolean,
  resolved_at timestamptz,
  resolution_notes text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    e.id, e.exception_type, e.severity, e.status, e.source_type, e.source_id, e.canonical_type, e.canonical_id,
    e.detected_at, e.evidence_reference, e.assigned_to_user_id is not null,
    coalesce(e.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false),
    e.resolved_at, e.resolution_notes
  from public.reconciliation_exceptions as e
  where p_family in ('financial', 'compliance', 'operations')
    and public.has_staff_capability(public.exception_family_capability(p_family), null, false)
    and public.exception_family(e.exception_type) = p_family
    and p_status in ('open', 'resolved')
    and e.status = p_status
    and p_offset between 0 and 100000
  order by e.detected_at desc, e.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- ---------------------------------------------------------------------------
-- Assignment and resolution: the capability of the exception's own family.
-- ---------------------------------------------------------------------------

-- Assigns an open exception to the calling staff member (p_assign true) or clears its assignment (false). No User id
-- is taken as input: the assignee is always the caller. Outcomes: applied, invalid, denied, not_found,
-- invalid_transition (resolved).
create or replace function public.staff_assign_reconciliation_exception(p_exception_id uuid, p_assign boolean)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_staff uuid;
  v_before public.reconciliation_exceptions;
begin
  if p_exception_id is null or p_assign is null then
    return 'invalid';
  end if;
  select l.* into v_lock from public.exception_lock_staff(p_exception_id) as l;
  v_staff := v_lock.staff_user_id;
  if v_staff is null then
    return case when v_lock.other_family then 'not_found' else 'denied' end;
  end if;
  select e.* into v_before from public.reconciliation_exceptions as e where e.id = p_exception_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.status <> 'open' then
    return 'invalid_transition';
  end if;
  update public.reconciliation_exceptions as e
  set assigned_to_user_id = case when p_assign then v_staff else null end
  where e.id = p_exception_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'reconciliation_exception.assigned', 'reconciliation_exception', p_exception_id,
    jsonb_build_object('assigned_to_user_id', v_before.assigned_to_user_id),
    jsonb_build_object('assigned_to_user_id', case when p_assign then v_staff else null end),
    null, null, null, clock_timestamp()
  );
  return 'applied';
end;
$function$;

-- Resolves an open exception once, with the staff member's notes (bounded plain text stored on the exception; the
-- audit event carries the status change only). Outcomes: applied, invalid, denied, not_found, invalid_transition.
create or replace function public.staff_resolve_reconciliation_exception(p_exception_id uuid, p_notes text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_lock record;
  v_staff uuid;
  v_before public.reconciliation_exceptions;
begin
  if p_exception_id is null or p_notes is null or not public.professional_text_within(p_notes, 2000) then
    return 'invalid';
  end if;
  select l.* into v_lock from public.exception_lock_staff(p_exception_id) as l;
  v_staff := v_lock.staff_user_id;
  if v_staff is null then
    return case when v_lock.other_family then 'not_found' else 'denied' end;
  end if;
  select e.* into v_before from public.reconciliation_exceptions as e where e.id = p_exception_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.status <> 'open' then
    return 'invalid_transition';
  end if;
  update public.reconciliation_exceptions as e
  set status = 'resolved',
      resolved_at = clock_timestamp(),
      resolution_notes = p_notes
  where e.id = p_exception_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'reconciliation_exception.resolved', 'reconciliation_exception', p_exception_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'resolved', 'exception_type', v_before.exception_type),
    null, null, null, clock_timestamp()
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges (the replaced functions keep theirs; restated for clarity).
-- ---------------------------------------------------------------------------

revoke all on function public.exception_family(text)
  from public, anon, authenticated, service_role;
revoke all on function public.exception_family_capability(text)
  from public, anon, authenticated, service_role;
revoke all on function public.exception_lock_staff(uuid)
  from public, anon, authenticated, service_role;

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.staff_finance_exceptions(text, integer)',
    'public.staff_review_exceptions(text, text, integer)',
    'public.staff_assign_reconciliation_exception(uuid, boolean)',
    'public.staff_resolve_reconciliation_exception(uuid, text)'
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

comment on function public.exception_family(text) is
  'MVP-001 S11 (internal): the family of a Reconciliation Exception type: compliance (eligibility_change_review, jurisdiction_change_review), operations (the S9 media types and notification_delivery_failed), financial (every other type, an unknown one included).';
comment on function public.exception_family_capability(text) is
  'MVP-001 S11 (internal): the capability that reads, assigns and resolves a family: financial manage_financial_operations, compliance manage_compliance_reviews, operations manage_consultation_operations.';
comment on function public.exception_lock_staff(uuid) is
  'MVP-001 S11 (internal): the calling staff member, locked, when they hold (global grant, aal2) the capability of the given exception''s family; otherwise null, with whether they hold another family''s capability.';
comment on function public.staff_finance_exceptions(text, integer) is
  'MVP-001 S7 finance workspace (MVP-001 S11: the financial family only): one page of Reconciliation Exceptions by status for staff holding manage_financial_operations (global grant, aal2).';
comment on function public.staff_review_exceptions(text, text, integer) is
  'MVP-001 S11: one page of one family''s Reconciliation Exceptions (financial, compliance or operations) by status, for staff holding that family''s capability (global grant, aal2); whether an exception is assigned and whether to the caller, never the assignee''s User id.';
comment on function public.staff_assign_reconciliation_exception(uuid, boolean) is
  'MVP-001 S7 (MVP-001 S11: the capability of the exception''s own family): assigns an open Reconciliation Exception to the caller or clears its assignment; audited. An exception of a family the caller does not hold answers not_found. Outcomes: applied, invalid, denied, not_found, invalid_transition.';
comment on function public.staff_resolve_reconciliation_exception(uuid, text) is
  'MVP-001 S7 (MVP-001 S11: the capability of the exception''s own family): resolves an open Reconciliation Exception once with bounded notes; audited. An exception of a family the caller does not hold answers not_found. Outcomes: applied, invalid, denied, not_found, invalid_transition.';
