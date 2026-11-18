-- MVP-001 S9 (1 of 3): Consultation outcome, Media Room, provider session and participation evidence integrity on the
-- existing Physical 1H relations (MVP-001 Packet S9 "one media room per consultation", "provider sessions",
-- "participation evidence", "no recording"; MBS section 14 rules and failure tests; TA sections 16.2, 46, 48 and 53;
-- PS sections 17, 18 and 38; DM section 2.4; Packet section 4 "append-only evidence").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). This migration adds
-- implementation constraints, one idempotency index and guard triggers on the relations P1-008 created
-- (20260917045031), and narrows service_role so that from now on every media_rooms, media_sessions and
-- session_participation_records write is one of the S9 database functions (20261125020000, 20261125030000). Each guard
-- applies to every role, the database owner included:
-- - consultations.outcome_code (the completion reason recorded with a terminal state, DM section 2.4): a lower-snake
--   code, present only in a terminal state. Which code each S11 completion type records is S11's; S9 records only
--   'normal' (PM row 20), from consultation_end;
-- - media_rooms (one stable logical media context per Consultation; the P1 unique key keeps exactly one per
--   Consultation): never deleted or truncated. A Media Room is created in state pending, for a Consultation that is
--   ready or live, with the Consultation's modality; its Consultation, modality, identity and creation time never
--   change. It moves forward only: pending -> open (the provider room exists) | closing (the Consultation became
--   terminal first), open -> closing (the Consultation became terminal; the provider room is being deleted, which
--   ejects participants: TA section 46), closing -> closed (the provider room is gone). ended_at is recorded exactly
--   when it is closed, once; a closed Media Room never changes. The provider room name is derived from the Media
--   Room id (no column; 20261125020000), so a provider room is never a second logical room;
-- - media_sessions (provider session correlation and infrastructure state; never a second Consultation, PS section
--   18): never deleted or truncated; a lower-snake provider code; a provider session reference of letters, digits,
--   underscores and hyphens (3 to 255); a start time; provider_state ongoing or ended, ended exactly when ended_at is
--   recorded. Its Media Room, provider code, reference, identity and creation time never change; started_at only moves
--   earlier (an older observation of the same session), ended_at is recorded once, and an ended session never becomes
--   ongoing again (TA section 53: a stale observation never overwrites newer facts);
-- - session_participation_records (durable attendance evidence across reconnects; never completes a Consultation): the
--   P1 append-only rule now holds for every role (no update, delete or truncate). Every record carries a join time, a
--   provider observation reference (the provider's participant session reference) and a JSON object of minimized
--   observation facts. At most one record of a joined observation (left_at null) and one of a completed presence
--   (left_at recorded) exist per provider session and participant reference: a duplicate or replayed observation adds
--   nothing (idempotency index below). A later or corrected observation is a new evidence row, never an edit; the
--   derived reads take the earliest join and the latest departure of each participant reference.
-- The P1 participant consistency trigger (only the Consultation's client or attorney User) is unchanged.

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relations.
-- ---------------------------------------------------------------------------

alter table public.consultations
  add constraint consultations_outcome_v1_check
    check (
      outcome_code is null
      or (
        outcome_code collate "C" ~ '^[a-z][a-z0-9_]{1,63}$'
        and state in ('completed', 'cancelled', 'no_show', 'technical_failure')
      )
    );

alter table public.media_rooms
  add constraint media_rooms_state_v1_check
    check (state in ('pending', 'open', 'closing', 'closed')),
  add constraint media_rooms_ended_v1_check
    check ((ended_at is not null) = (state = 'closed')),
  add constraint media_rooms_ended_order_v1_check
    check (ended_at is null or ended_at >= created_at),
  add constraint media_rooms_modality_v1_check
    check (modality collate "C" ~ '^[a-z][a-z0-9_]{1,31}$');

alter table public.media_sessions
  add constraint media_sessions_provider_code_v1_check
    check (provider_code collate "C" ~ '^[a-z][a-z0-9_]{1,31}$'),
  add constraint media_sessions_reference_v1_check
    check (provider_session_reference collate "C" ~ '^[A-Za-z0-9_-]{3,255}$'),
  add constraint media_sessions_state_v1_check
    check (provider_state in ('ongoing', 'ended')),
  add constraint media_sessions_started_v1_check
    check (started_at is not null),
  add constraint media_sessions_ended_v1_check
    check ((ended_at is not null) = (provider_state = 'ended'));

alter table public.session_participation_records
  add constraint session_participation_records_reference_v1_check
    check (
      provider_observation_reference is not null
      and provider_observation_reference collate "C" ~ '^[A-Za-z0-9_-]{3,255}$'
    ),
  add constraint session_participation_records_joined_v1_check
    check (joined_at is not null),
  add constraint session_participation_records_observation_v1_check
    check (observed_participation is not null and jsonb_typeof(observed_participation) = 'object');

-- Idempotency (TA section 53 duplicate and replayed observations): one joined record and one completed-presence
-- record per provider session and participant reference.
create unique index session_participation_records_observation_unique_idx
  on public.session_participation_records (media_session_id, provider_observation_reference, (left_at is not null));

create index media_sessions_room_started_idx
  on public.media_sessions (media_room_id, started_at, id);

create index media_rooms_state_idx
  on public.media_rooms (state, created_at, id);

-- ---------------------------------------------------------------------------
-- Media Rooms.
-- ---------------------------------------------------------------------------

create function public.media_room_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.media_rooms rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'pending' or new.ended_at is not null then
      raise exception 'a media room is created pending, never ended'
        using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.consultations as c
      where c.id = new.consultation_id
        and c.state in ('ready', 'live')
        and c.modality = new.modality
    ) then
      raise exception 'a media room exists only for a ready or live consultation, with its modality'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.consultation_id is distinct from old.consultation_id
     or new.modality is distinct from old.modality
     or new.created_at is distinct from old.created_at then
    raise exception 'a media room keeps its consultation, modality and identity'
      using errcode = '55000';
  end if;
  if old.state = 'closed' and (to_jsonb(new) is distinct from to_jsonb(old)) then
    raise exception 'a closed media room is immutable'
      using errcode = '55000';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'a media room end is recorded once'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'pending' and new.state in ('open', 'closing'))
       or (old.state = 'open' and new.state = 'closing')
       or (old.state = 'closing' and new.state = 'closed')
     ) then
    raise exception 'media room transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger media_rooms_change_guard
before insert or update or delete on public.media_rooms
for each row
execute function public.media_room_integrity();

create trigger media_rooms_no_truncate
before truncate on public.media_rooms
for each statement
execute function public.media_room_integrity();

-- ---------------------------------------------------------------------------
-- Media Sessions.
-- ---------------------------------------------------------------------------

create function public.media_session_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.media_sessions rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.media_room_id is distinct from old.media_room_id
     or new.provider_code is distinct from old.provider_code
     or new.provider_session_reference is distinct from old.provider_session_reference
     or new.created_at is distinct from old.created_at then
    raise exception 'a media session keeps its media room, provider and reference'
      using errcode = '55000';
  end if;
  if new.started_at > old.started_at then
    raise exception 'a media session start only moves earlier'
      using errcode = '55000';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'a media session end is recorded once'
      using errcode = '55000';
  end if;
  if old.provider_state = 'ended' and new.provider_state is distinct from 'ended' then
    raise exception 'an ended media session never becomes ongoing again'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger media_sessions_change_guard
before insert or update or delete on public.media_sessions
for each row
execute function public.media_session_integrity();

create trigger media_sessions_no_truncate
before truncate on public.media_sessions
for each statement
execute function public.media_session_integrity();

-- ---------------------------------------------------------------------------
-- Session participation records: append-only for every role.
-- ---------------------------------------------------------------------------

create function public.session_participation_append_only()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'public.session_participation_records rows are append-only evidence'
    using errcode = '55000';
end;
$function$;

create trigger session_participation_records_append_only
before update or delete on public.session_participation_records
for each row
execute function public.session_participation_append_only();

create trigger session_participation_records_no_truncate
before truncate on public.session_participation_records
for each statement
execute function public.session_participation_append_only();

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only (Packet section 1 RLS impact). SELECT grants and the P1 participant row
-- policies are unchanged; no API role may write any of the three relations.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.media_rooms,
  public.media_sessions,
  public.session_participation_records
from public, anon, authenticated, service_role;

revoke all on function public.media_room_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.media_session_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.session_participation_append_only()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.media_room_integrity() is
  'MVP-001 S9: a Media Room is never deleted or truncated; it is created pending for a ready or live Consultation with its modality; its Consultation, modality and identity never change; it moves only forward (pending -> open | closing, open -> closing, closing -> closed), ended_at is recorded once at closed, and a closed Media Room never changes.';
comment on function public.media_session_integrity() is
  'MVP-001 S9: a provider Media Session is never deleted or truncated; its room, provider code and reference never change; started_at only moves earlier, ended_at is recorded once and an ended session never becomes ongoing again.';
comment on function public.session_participation_append_only() is
  'MVP-001 S9: participation evidence is append-only for every role (no update, delete or truncate).';
comment on column public.consultations.outcome_code is
  'The completion reason recorded with a terminal state (DM section 2.4), a lower-snake code present only in a terminal state. MVP-001 S9 records normal (PM row 20); the other completion types are S11''s.';
comment on column public.media_rooms.state is
  'MVP-001 S9: pending (the provider room is being created), open, closing (the Consultation is terminal; the provider room is being deleted) or closed. Provider state never derives Consultation state.';
comment on column public.media_sessions.provider_state is
  'MVP-001 S9: ongoing or ended, as last observed from the provider; infrastructure correlation only, never Consultation state (PS section 38).';
