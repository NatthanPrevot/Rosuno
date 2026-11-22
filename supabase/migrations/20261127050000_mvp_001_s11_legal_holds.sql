-- MVP-001 S11 (5 of 7): Legal Hold guards, the staff commands and the coverage of the complaint-case and user scopes
-- (MVP-001 Packet S11 "legal-hold linkage"; MBS section 16 "Legal Hold linkage where required" and section 17
-- "retention/legal-hold foundation"; TA sections 40 and 51; ROS section 16.3; PS sections 26.2, 29.4 and 30.4; PM rows
-- 47 and 48).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). public.legal_holds exists since P1
-- (20260921051204) with the PS section 26.2 columns; S3 (20261119010000) made an unreleased hold block every deletion
-- of a resource and of its document or voice-memo record and every new access authorization, and S10 (20261126040000)
-- kept that for consultation documents. All of that stays exactly as it is: a hold attaches to the records in its
-- scope, prevents their ordinary disposition and changes no business state. This migration adds:
--
-- Guards, for every role, the database owner included:
-- - a Legal Hold is never deleted or truncated;
-- - its scope, reason, start, creator and creation instant never change (the P1 trigger, unchanged, which fires
--   first);
-- - it changes exactly once, by its release: released_at and released_by_user_id are set together (the P1 pair
--   check), a released hold never changes again, and an unreleased one changes in no other way;
-- - its reason holds at most 2,000 characters (a technical bound; the P1 check already refuses a blank one);
-- - status vocabulary: a hold of one of the S11 scope types (below) is active or released, released exactly when its
--   release is recorded, and is created unreleased. Holds of any other scope type keep what S3 gave them: whatever
--   their scope type or status says, they bind while unreleased, so an unknown vocabulary still fails closed. (S3 and
--   S10 plant such holds in their proofs; no API role can write the relation at all.)
--
-- Scope types of the staff command (a closed technical vocabulary; the scope row must exist): consultation, intake,
-- resource, complaint_case and user.
--
-- Coverage (resource_under_legal_hold, replaced forward with its signature, volatility, security mode and
-- search_path; every S3 rule is kept word for word): an unreleased hold covers a resource when its scope id is the
-- resource, its Intake, its Consultation or a verification finding that references it (S3, any scope type), and now
-- also when it is
-- - a complaint_case hold whose Complaint Case links the resource's Consultation (the evidence of the matter the
--   complaint is about stays preserved while the case needs it: PM row 47);
-- - a user hold of the resource's owner, of the client of its Intake, or of the client or the attorney of its
--   Consultation (PM row 48: a hold on a person prevents deletion of what belongs to their matters).
-- Deletion refused and new access authorization refused follow from that one predicate, as before.
--
-- Staff commands (EXECUTE for authenticated only; manage_legal_holds as a global grant at aal2, because a hold can
-- name a user or a record of any jurisdiction): staff_place_legal_hold (scope type, scope id, reason) and
-- staff_release_legal_hold. The reason is stored on the hold only; audit events carry identifiers, the scope and the
-- status, never the reason. staff_legal_holds lists holds by whether they are released, with their scope, status and
-- reason, for the same capability. More than one hold may name the same scope (two matters may each need one); each
-- is released on its own, and the scope stays covered until the last one is.

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relation.
-- ---------------------------------------------------------------------------

alter table public.legal_holds
  add constraint legal_holds_reason_v1_check
    check (char_length(reason) <= 2000),
  add constraint legal_holds_status_v1_check
    check (
      scope_type not in ('consultation', 'intake', 'resource', 'complaint_case', 'user')
      or (
        status in ('active', 'released')
        and (status = 'released') = (released_at is not null)
      )
    );

create index legal_holds_unreleased_started_idx
  on public.legal_holds (started_at desc, id)
  where released_at is null;

-- ---------------------------------------------------------------------------
-- The guard (every role). Named to fire after the P1 integrity trigger.
-- ---------------------------------------------------------------------------

create function public.legal_hold_record_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.legal_holds rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.scope_type in ('consultation', 'intake', 'resource', 'complaint_case', 'user')
       and new.released_at is not null then
      raise exception 'a Legal Hold is placed unreleased'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if to_jsonb(new) is not distinct from to_jsonb(old) then
    return new;
  end if;
  if old.released_at is not null then
    raise exception 'a released Legal Hold is final'
      using errcode = '55000';
  end if;
  if new.released_at is null then
    raise exception 'a Legal Hold changes only by its release'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger legal_holds_record_guard
before insert or update or delete on public.legal_holds
for each row
execute function public.legal_hold_record_guard();

create trigger legal_holds_no_truncate
before truncate on public.legal_holds
for each statement
execute function public.legal_hold_record_guard();

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only. No API role reads the relation directly.
-- ---------------------------------------------------------------------------

revoke all on table public.legal_holds
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Coverage (internal; replaced forward).
-- ---------------------------------------------------------------------------

-- True when an unreleased Legal Hold covers the resource: it names the resource, its Intake, its Consultation or a
-- verification finding that references it (any scope type and any status count while released_at is unset or in the
-- future, so an unknown vocabulary fails closed: S3, unchanged), or it is a complaint_case hold whose case links the
-- resource's Consultation, or a user hold of the resource's owner, of its Intake's client or of its Consultation's
-- client or attorney (MVP-001 S11).
create or replace function public.resource_under_legal_hold(p_resource_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select exists (
    select 1
    from public.resources as r
    join public.legal_holds as h
      on h.scope_id = r.id
      or h.scope_id = r.intake_id
      or h.scope_id = r.consultation_id
      or h.scope_id in (
        select e.id
        from public.verification_evidence as e
        where e.source_type = 'uploaded_artifact'
          and e.source_reference = r.id::text
      )
      or (
        h.scope_type = 'complaint_case'
        and r.consultation_id is not null
        and exists (
          select 1
          from public.complaint_cases as k
          where k.id = h.scope_id
            and k.consultation_id = r.consultation_id
        )
      )
      or (
        h.scope_type = 'user'
        and (
          h.scope_id = r.owner_user_id
          or exists (
            select 1
            from public.intakes as i
            join public.client_profiles as cp on cp.id = i.client_id
            where i.id = r.intake_id
              and cp.user_id = h.scope_id
          )
          or exists (
            select 1
            from public.consultations as c
            join public.client_profiles as cp on cp.id = c.client_id
            join public.attorney_profiles as ap on ap.id = c.attorney_id
            where c.id = r.consultation_id
              and (cp.user_id = h.scope_id or ap.user_id = h.scope_id)
          )
        )
      )
    where r.id = p_resource_id
      and (h.released_at is null or h.released_at > statement_timestamp())
  );
$function$;

revoke all on function public.resource_under_legal_hold(uuid)
  from public, anon, authenticated, service_role;

-- Whether the row a scope names exists (the five S11 scope types; false for any other).
create function public.legal_hold_scope_exists(p_scope_type text, p_scope_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_scope_type
    when 'consultation' then exists (select 1 from public.consultations as c where c.id = p_scope_id)
    when 'intake' then exists (select 1 from public.intakes as i where i.id = p_scope_id)
    when 'resource' then exists (select 1 from public.resources as r where r.id = p_scope_id)
    when 'complaint_case' then exists (select 1 from public.complaint_cases as k where k.id = p_scope_id)
    when 'user' then exists (select 1 from public.users as u where u.id = p_scope_id)
    else false
  end;
$function$;

-- ---------------------------------------------------------------------------
-- Staff commands (EXECUTE for authenticated only; manage_legal_holds, global grant, aal2).
-- ---------------------------------------------------------------------------

-- Places one Legal Hold on an existing scope row. Outcomes: placed (with the hold id), invalid, denied, not_found.
create function public.staff_place_legal_hold(p_scope_type text, p_scope_id uuid, p_reason text)
returns table (outcome text, legal_hold_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_hold uuid;
begin
  if p_scope_type is null
     or p_scope_type not in ('consultation', 'intake', 'resource', 'complaint_case', 'user')
     or p_scope_id is null
     or p_reason is null
     or not public.professional_text_within(p_reason, 2000) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_legal_holds', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if not public.legal_hold_scope_exists(p_scope_type, p_scope_id) then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  insert into public.legal_holds (scope_type, scope_id, status, reason, started_at, created_by_user_id)
  values (p_scope_type, p_scope_id, 'active', p_reason, clock_timestamp(), v_staff)
  returning id into v_hold;
  perform public.decision_audit(
    v_staff, 'staff', 'legal_hold.placed', 'legal_hold', v_hold,
    null,
    jsonb_build_object('scope_type', p_scope_type, 'scope_id', p_scope_id, 'status', 'active'),
    null, null, null
  );
  return query select 'placed'::text, v_hold;
end;
$function$;

-- Releases one Legal Hold, once. Outcomes: released, invalid, denied, not_found, already_released.
create function public.staff_release_legal_hold(p_legal_hold_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.legal_holds;
begin
  if p_legal_hold_id is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_legal_holds', null);
  if v_staff is null then
    return 'denied';
  end if;
  select h.* into v_before from public.legal_holds as h where h.id = p_legal_hold_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_before.released_at is not null then
    return 'already_released';
  end if;
  update public.legal_holds as h
  set status = 'released',
      released_at = clock_timestamp(),
      released_by_user_id = v_staff
  where h.id = p_legal_hold_id;
  perform public.decision_audit(
    v_staff, 'staff', 'legal_hold.released', 'legal_hold', p_legal_hold_id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('scope_type', v_before.scope_type, 'scope_id', v_before.scope_id, 'status', 'released'),
    null, null, null
  );
  return 'released';
end;
$function$;

-- One page (25 rows, plus one) of the Legal Holds that are unreleased (p_status active) or released, the most
-- recently started first, with their scope, status and reason.
create function public.staff_legal_holds(p_status text, p_offset integer)
returns table (
  legal_hold_id uuid,
  scope_type text,
  scope_id uuid,
  status text,
  reason text,
  started_at timestamptz,
  released_at timestamptz,
  placed_by_me boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    h.id, h.scope_type, h.scope_id, h.status, h.reason, h.started_at, h.released_at,
    coalesce(h.created_by_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false)
  from public.legal_holds as h
  where public.has_staff_capability('manage_legal_holds', null, false)
    and p_status in ('active', 'released')
    and (h.released_at is null) = (p_status = 'active')
    and p_offset between 0 and 100000
  order by h.started_at desc, h.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.legal_hold_record_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.legal_hold_scope_exists(text, uuid)
  from public, anon, authenticated, service_role;

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.staff_place_legal_hold(text, uuid, text)',
    'public.staff_release_legal_hold(uuid)',
    'public.staff_legal_holds(text, integer)'
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

comment on function public.legal_hold_record_guard() is
  'MVP-001 S11 (every role): a Legal Hold is never deleted or truncated; it changes exactly once, by its release, and a released hold never changes; a hold of an S11 scope type is placed unreleased.';
comment on function public.resource_under_legal_hold(uuid) is
  'Internal (MVP-001 S3; MVP-001 S11: complaint_case and user scopes): true when an unreleased Legal Hold names the resource, its Intake, its Consultation or a verification finding referencing it (any scope type or status: unknown vocabularies fail closed), or is a complaint_case hold whose case links the resource''s Consultation, or a user hold of the resource''s owner, its Intake''s client or its Consultation''s client or attorney. Executable by no API role.';
comment on function public.legal_hold_scope_exists(text, uuid) is
  'MVP-001 S11 (internal): whether the row a Legal Hold scope names exists (consultation, intake, resource, complaint_case, user); false for any other scope type.';
comment on function public.staff_place_legal_hold(text, uuid, text) is
  'MVP-001 S11: staff holding manage_legal_holds (global grant, aal2) place one Legal Hold on an existing consultation, intake, resource, complaint_case or user, with a reason of at most 2,000 characters stored on the hold only; audited with identifiers only. A hold changes no business state. Outcomes: placed, invalid, denied, not_found.';
comment on function public.staff_release_legal_hold(uuid) is
  'MVP-001 S11: staff holding manage_legal_holds (global grant, aal2) release one Legal Hold, once; audited. Outcomes: released, invalid, denied, not_found, already_released.';
comment on function public.staff_legal_holds(text, integer) is
  'MVP-001 S11: one page of the unreleased (active) or released Legal Holds with their scope, status and reason, for staff holding manage_legal_holds (global grant, aal2).';
comment on column public.legal_holds.status is
  'MVP-001 S11: active or released for the S11 scope types (consultation, intake, resource, complaint_case, user), released exactly when the release is recorded. A hold binds while released_at is unset, whatever its status says.';
comment on column public.legal_holds.scope_type is
  'MVP-001 S11 staff vocabulary: consultation, intake, resource, complaint_case or user. A hold of any other scope type still binds the record its scope id names (S3).';
