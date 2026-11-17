-- MVP-001 S4 (1 of 3): scheduling integrity on the existing Physical 1G relations (MVP-001 Packet S4; MBS
-- section 9 invariants 1-6; DM sections 2.6, 2.7 and 8; PS sections 6, 16, 32 and 34; TA sections 10, 11 and 24).
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). This migration
-- adds implementation constraints and guard triggers on the relations P1-007 created, and narrows service_role to
-- SELECT on them, so from now on every scheduling write is one of the S4 database functions (20261120020000 and
-- 20261120030000) or a later slice's function built on them (DL-ENG-1 R9). Each guard applies to every role, the
-- database owner included (the Hold and Booking guards are named to fire before the P1 conflict triggers):
-- - slot_holds: a Hold is never deleted or truncated; it changes only once, when it ends: released_at and
--   release_reason are set together from null, with the reason converted, released or expired (DM section 8 Hold
--   lifecycle held -> converted | released | expired). Its attorney, request, times and server expiry never change,
--   so a Hold's expires_at, fixed when it is acquired, is never extended (DM sections 2.6 and 8; TA section 24);
-- - bookings: a Booking is never deleted or truncated; it is created confirmed, for its Consultation's attorney and
--   client and only once that Consultation's Request is accepted (DM section 2.7: no Booking before acceptance);
--   its status then moves only from confirmed to superseded, cancelled or completed, with only that transition's
--   timestamp; nothing else changes;
-- - availability_rules: a rule is never deleted or truncated and its content never changes; it can only be
--   deactivated (active true -> false, updated_at maintained). A changed schedule is a new rule (PS section 34:
--   the rule's time zone context is preserved as recorded);
-- - blackouts: a Blackout is never updated or truncated; it is deleted only before it starts (no API role holds
--   DELETE; the attorney's removal function audits it), so a Blackout that has begun stays as history;
-- - instant_availability_intents: never deleted or truncated; the attorney, the application session and the
--   creation time never change. One row per application session (P1 unique key) is switched in place: enabling
--   sets enabled_at (moving forward) and clears revoked_at; disabling sets revoked_at; expires_at only moves
--   forward, and the P1 binding trigger keeps it within its live session (PS section 6);
-- - application_sessions: never deleted or truncated; the user, the provider session reference, the start and the
--   creation time never change; expires_at only moves forward and is fixed once the session has ended or been
--   revoked; ended_at and revoked_at are each set once;
-- - bookability_evaluations: append-only evidence (MBS section 2.1; Packet section 4): never updated, deleted or
--   truncated. The result is bookable or not_bookable, and the context is the referral or consultation request
--   the decision was made for (MBS section 2.4 decision points), always identified. The presence trust method
--   recorded with a decision is an owner-gated value (DM section 13; Packet section 3) and is deliberately not
--   constrained here.

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relations.
-- ---------------------------------------------------------------------------

alter table public.slot_holds
  add constraint slot_holds_release_reason_v1_check
    check (release_reason is null or release_reason in ('converted', 'released', 'expired')),
  add constraint slot_holds_release_pair_v1_check
    check ((released_at is null) = (release_reason is null));

alter table public.bookability_evaluations
  add constraint bookability_evaluations_result_v1_check
    check (result in ('bookable', 'not_bookable')),
  add constraint bookability_evaluations_context_v1_check
    check (context_type in ('referral', 'consultation_request') and context_id is not null);

-- ---------------------------------------------------------------------------
-- Slot Holds.
-- ---------------------------------------------------------------------------

create function public.slot_hold_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.slot_holds rows are never deleted'
      using errcode = '55000';
  end if;
  if old.released_at is not null and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'an ended slot hold is immutable'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'released_at' - 'release_reason')
     is distinct from (to_jsonb(old) - 'released_at' - 'release_reason') then
    raise exception 'a slot hold changes only by ending once'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger slot_holds_change_guard
before update or delete on public.slot_holds
for each row
execute function public.slot_hold_integrity();

create trigger slot_holds_no_truncate
before truncate on public.slot_holds
for each statement
execute function public.slot_hold_integrity();

-- ---------------------------------------------------------------------------
-- Bookings.
-- ---------------------------------------------------------------------------

create function public.booking_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.bookings rows are never deleted'
      using errcode = '55000';
  end if;
  if old.status <> 'confirmed' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'an ended booking is immutable'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'status' - 'superseded_at' - 'cancelled_at')
     is distinct from (to_jsonb(old) - 'status' - 'superseded_at' - 'cancelled_at') then
    raise exception 'a booking changes only by its status'
      using errcode = '55000';
  end if;
  if new.status is distinct from old.status
     and new.status not in ('superseded', 'cancelled', 'completed') then
    raise exception 'a confirmed booking moves only to superseded, cancelled or completed'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger bookings_change_guard
before update or delete on public.bookings
for each row
execute function public.booking_integrity();

create trigger bookings_no_truncate
before truncate on public.bookings
for each statement
execute function public.booking_integrity();

-- A Booking is created confirmed, for exactly its Consultation's attorney and client, and only while that
-- Consultation's Request is accepted (DM section 2.7; MBS section 9 invariant 5).
create function public.booking_consultation_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_attorney uuid;
  v_client uuid;
  v_request_state text;
begin
  select c.attorney_id, c.client_id, r.state
  into v_attorney, v_client, v_request_state
  from public.consultations as c
  join public.consultation_requests as r on r.id = c.consultation_request_id
  where c.id = new.consultation_id;
  if not found then
    raise exception 'booking consultation does not exist'
      using errcode = '23503';
  end if;
  if new.attorney_id is distinct from v_attorney or new.client_id is distinct from v_client then
    raise exception 'booking attorney and client must be its consultation''s'
      using errcode = '23514';
  end if;
  if v_request_state is distinct from 'accepted' then
    raise exception 'a booking requires an accepted consultation request'
      using errcode = '23514';
  end if;
  if new.status is distinct from 'confirmed' then
    raise exception 'a booking is created confirmed'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger bookings_consultation_consistency
before insert on public.bookings
for each row
execute function public.booking_consultation_consistency();

-- ---------------------------------------------------------------------------
-- Availability rules and Blackouts.
-- ---------------------------------------------------------------------------

create function public.availability_rule_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.availability_rules rows are never deleted'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'active' - 'updated_at') is distinct from (to_jsonb(old) - 'active' - 'updated_at') then
    raise exception 'an availability rule is never edited; it is deactivated and replaced'
      using errcode = '55000';
  end if;
  if new.active and not old.active then
    raise exception 'an inactive availability rule stays inactive'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger availability_rules_integrity
before update or delete on public.availability_rules
for each row
execute function public.availability_rule_integrity();

create trigger availability_rules_no_truncate
before truncate on public.availability_rules
for each statement
execute function public.availability_rule_integrity();

create function public.blackout_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'public.blackouts is never truncated'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'a blackout is never edited'
      using errcode = '55000';
  end if;
  if old.starts_at <= clock_timestamp() then
    raise exception 'a blackout that has started is never removed'
      using errcode = '55000';
  end if;
  return old;
end;
$function$;

create trigger blackouts_integrity
before update or delete on public.blackouts
for each row
execute function public.blackout_integrity();

create trigger blackouts_no_truncate
before truncate on public.blackouts
for each statement
execute function public.blackout_integrity();

-- ---------------------------------------------------------------------------
-- Instant Availability Intents and application sessions.
-- ---------------------------------------------------------------------------

create function public.instant_intent_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.instant_availability_intents rows are never deleted'
      using errcode = '55000';
  end if;
  if new.id is distinct from old.id
     or new.attorney_id is distinct from old.attorney_id
     or new.application_session_id is distinct from old.application_session_id
     or new.created_at is distinct from old.created_at then
    raise exception 'an instant intent keeps its attorney, session and creation time'
      using errcode = '55000';
  end if;
  if new.expires_at < old.expires_at then
    raise exception 'an instant intent expiry only moves forward'
      using errcode = '55000';
  end if;
  if new.enabled_at < old.enabled_at then
    raise exception 'an instant intent enabling time only moves forward'
      using errcode = '55000';
  end if;
  if new.enabled_at > old.enabled_at and new.revoked_at is not null then
    raise exception 'enabling an instant intent clears its revocation'
      using errcode = '55000';
  end if;
  if old.revoked_at is not null
     and new.revoked_at is distinct from old.revoked_at
     and not (new.revoked_at is null and new.enabled_at > old.enabled_at) then
    raise exception 'an instant intent revocation is cleared only by enabling it again'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger instant_availability_intents_integrity
before update or delete on public.instant_availability_intents
for each row
execute function public.instant_intent_integrity();

create trigger instant_availability_intents_no_truncate
before truncate on public.instant_availability_intents
for each statement
execute function public.instant_intent_integrity();

create function public.application_session_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.application_sessions rows are never deleted'
      using errcode = '55000';
  end if;
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.auth_session_reference is distinct from old.auth_session_reference
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'an application session keeps its user, reference and start'
      using errcode = '55000';
  end if;
  if new.expires_at < old.expires_at then
    raise exception 'an application session expiry only moves forward'
      using errcode = '55000';
  end if;
  if (old.ended_at is not null or old.revoked_at is not null)
     and new.expires_at is distinct from old.expires_at then
    raise exception 'the expiry of an ended application session is fixed'
      using errcode = '55000';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'an application session ends once'
      using errcode = '55000';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'an application session is revoked once'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger application_sessions_integrity
before update or delete on public.application_sessions
for each row
execute function public.application_session_integrity();

create trigger application_sessions_no_truncate
before truncate on public.application_sessions
for each statement
execute function public.application_session_integrity();

-- ---------------------------------------------------------------------------
-- Bookability evidence is append-only.
-- ---------------------------------------------------------------------------

create function public.bookability_evaluation_append_only()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'public.bookability_evaluations is append-only evidence'
    using errcode = '55000';
end;
$function$;

create trigger bookability_evaluations_append_only
before update or delete on public.bookability_evaluations
for each row
execute function public.bookability_evaluation_append_only();

create trigger bookability_evaluations_no_truncate
before truncate on public.bookability_evaluations
for each statement
execute function public.bookability_evaluation_append_only();

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only (Packet section 1 RLS impact). SELECT grants are unchanged.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.availability_rules,
  public.blackouts,
  public.slot_holds,
  public.bookings,
  public.instant_availability_intents,
  public.bookability_evaluations,
  public.application_sessions
from public, anon, authenticated, service_role;

revoke all on function public.slot_hold_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.booking_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.booking_consultation_consistency()
  from public, anon, authenticated, service_role;
revoke all on function public.availability_rule_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.blackout_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.instant_intent_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.application_session_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.bookability_evaluation_append_only()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.slot_hold_integrity() is
  'MVP-001 S4: a Slot Hold is never deleted or truncated and changes only once, when it ends (released_at and release_reason together); its attorney, request, slot and server expiry never change.';
comment on function public.booking_integrity() is
  'MVP-001 S4: a Booking is never deleted or truncated; its status moves only from confirmed to superseded, cancelled or completed with that transition''s timestamp, and nothing else changes.';
comment on function public.booking_consultation_consistency() is
  'MVP-001 S4: a Booking is created confirmed, for its Consultation''s attorney and client, and only while that Consultation''s Request is accepted (no Booking before acceptance).';
comment on function public.availability_rule_integrity() is
  'MVP-001 S4: an availability rule is never deleted, truncated or edited; it can only be deactivated.';
comment on function public.blackout_integrity() is
  'MVP-001 S4: a Blackout is never edited or truncated, and is deleted only before it starts.';
comment on function public.instant_intent_integrity() is
  'MVP-001 S4: an Instant Availability Intent keeps its attorney, session and creation time, is never deleted, and is switched in place: enabling moves enabled_at forward and clears revoked_at, disabling sets revoked_at, and expires_at only moves forward.';
comment on function public.application_session_integrity() is
  'MVP-001 S4: an application session keeps its user, provider reference and start; expires_at only moves forward and is fixed once it ends; ended_at and revoked_at are each set once; never deleted.';
comment on function public.bookability_evaluation_append_only() is
  'MVP-001 S4: Bookability Evaluations are append-only evidence.';
comment on column public.slot_holds.release_reason is
  'How the Hold ended: converted (to a Booking), released, or expired at its server deadline. Null while held.';
