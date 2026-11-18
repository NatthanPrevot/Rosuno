-- MVP-001 S9 (3 of 3): the media provider boundary, provider sessions, durable participation evidence, provider
-- disagreement and the participants' Consultation reads (MVP-001 Packet S9 "Daily adapter", "provider sessions",
-- "participation evidence", "reconnect handling", "client and attorney workspaces", "waiting room"; MBS section 14 rules
-- and failure tests; IMP section 25 exit; TA sections 16.2, 26, 53 and 66; PS sections 18, 23.1 and 38; Packet section 2
-- rule 12; PM section 1 INV-11 and INV-13).
--
-- No relation, column or policy type is added (Packet rules 8 and 16). Provider-neutral (TA section 66: replacing the
-- provider touches only the adapter and configuration): every recording function takes the provider code the adapter
-- names, and provider observations arrive in Rosuno's own vocabulary (media_observation_valid). Provider observations
-- are evidence, never Consultation state (MBS section 14; PS section 38; PM INV-13): nothing here changes a
-- Consultation, payment or Engagement.
--
-- The worker (service_role only): media_job_context answers what a running media job is to do now, from canonical state
-- only (act, nothing_to_do, wait, not_running): media.room_create acts for a pending Media Room of a ready or live
-- Consultation inside its window, with the provider room's expiry at the window end (and waits while the timing
-- configuration or, in production, the gate is missing: the S2 protocol retries and escalates visibly);
-- media.room_update acts for an open Media Room (the expiry moves when an instant Consultation starts);
-- media.room_delete acts for a closing Media Room and waits while its creation job is running (so a room being created
-- is deleted after it exists);
-- media.observe acts for any Media Room that is open, closing or closed. media_record_operation records each provider
-- call's result as an observation of that job's Media Room (the kinds each job may report are fixed): room_created
-- (pending -> open), room_updated (no state), room_deleted (closing -> closed, then one more observation job),
-- room_missing and meetings_observed (evidence, below). room_created and room_updated carry the expiry the provider room
-- now has (the adapter sets the job's expiry on a room that already existed before reporting it): when it is not the
-- window end the room must carry now (the window moved while the job ran, for example an instant Consultation started
-- while its room was still pending or being created), room_created enqueues one media.room_update job and
-- room_updated answers outdated, so the job runs again with the window end read afresh. The provider room therefore
-- never ejects participants (eject at room expiry) while the Consultation is live inside its window.
--
-- The webhook (service_role only; the route verified the provider signature first): media_record_provider_event
-- records the receipt first, unique per (provider, event reference) in external_event_receipts (PS section 23.1; a
-- replay or concurrent duplicate is a no-op answered duplicate), with only the validated minimized observation and the
-- payload digest; then, in the same transaction, the provider room name is matched to its Media Room and the
-- observation applied. A room name of Rosuno's form that names no Media Room opens a medium media_unknown_room item
-- (source the receipt); any other room name is unmatched. Participant events also enqueue one observation job for the
-- room, so the provider's own session records follow.
--
-- Evidence (media_apply_observation, the Media Room locked FOR UPDATE so evidence of one room is written serially; the
-- Consultation is only read): a provider session is recorded once per (provider, session reference) in media_sessions
-- (its start only moves earlier, its end is recorded once, ongoing never follows ended: TA section 53, a stale
-- observation never overwrites newer facts); a participant observation of the Consultation's client or attorney User
-- (the meeting token's user id) is one append-only session_participation_records row: a joined observation (left_at
-- null) and a completed presence (joined and left), at most one of each per provider session and participant reference
-- (the S9 idempotency index; duplicates and replays add nothing). observed_participation holds only the role, the kind
-- of observation and its source type; never a name, a provider payload or a token. Disagreement opens a Reconciliation
-- Exception through decision_open_review (S8: one open item per type and Consultation, minimized evidence, audited once;
-- staff resolve it in the finance workspace), and is never silently corrected:
-- - media_unrecognized_participant (critical): a participant whose user id is not the Consultation's client or
--   attorney User, or who presented none (nothing is recorded as participation);
-- - media_activity_outside_consultation (high): a provider session start or a participant join more than 60 seconds
--   (a fixed clock-skew bound, not a policy value) before the Media Room existed (the Consultation became ready) or
--   after the Consultation became terminal (the evidence is still recorded);
-- - media_room_missing (high): the provider reports no room while the Media Room is open for a ready or live
--   Consultation whose permitted window has not ended (a provider room past its expiry is expected to be gone, so no
--   item is opened after the window end, or while the window is not known);
-- - media_session_mismatch (high): a provider session reference already recorded for another Media Room.
-- Provider outage: a media job's provider call fails, the S2 protocol retries with backoff and escalates when its
-- attempts are used up (visible to staff, audited); canonical state is untouched (MBS section 14 failure test).
--
-- Derived reads (EXECUTE for authenticated only; stable security definer): client_consultation (the Consultation's own
-- client, an active User), attorney_consultation and attorney_consultations (the attorney's own, an approved Attorney
-- Profile of an active User at aal2; the list holds scheduled, ready and live Consultations, at most 200: live first,
-- then those whose window is open, then upcoming ones, soonest first, and those whose window has passed last, so a
-- stale ready row never ranks ahead of an upcoming one). Each answers
-- the stored state and the server-derived ready_due flag (a scheduled Consultation whose window has opened; the next
-- command records it), the path, modality, duration, the Booking's times, the permitted window (null without the timing
-- configuration), the start, end and completion reason, the Media Room's state and the derived participation
-- evidence: when the attorney and the client first joined and last left, whether they were both present at the same
-- time, whether either left, the number of provider sessions and of reconnections (participant references beyond the
-- first per role). Runtime presence never substitutes for this historical evidence. Another participant's, an unknown
-- and a malformed id answer alike: no row. These S9 read functions answer no provider reference (room name, session
-- or participant reference), no token and nothing of the other participant's identity. They do not narrow what the
-- participants can read directly: the P1 participant SELECT policies on consultations, media_rooms, media_sessions and
-- session_participation_records (20260917045031) are unchanged and out of S9's scope, so a participant's direct read
-- of those relations still returns their stored columns (for example a provider session reference, or the
-- participant User of a participation record); the S9 workspaces read only these functions.

-- ---------------------------------------------------------------------------
-- Observation vocabulary (provider-neutral).
-- ---------------------------------------------------------------------------

-- Whether a JSON value is an object with exactly these keys.
create function public.media_exact_keys(p_value jsonb, p_keys text[])
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(p_value) as k)
        = (select array_agg(k order by k) from unnest(p_keys) as k),
    false);
$function$;

-- A UTC instant as the adapter writes it (ISO 8601, milliseconds optional, Z), within 2020..2100.
create function public.media_instant_valid(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') collate "C" ~ '^20[2-9][0-9]-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$',
    false);
$function$;

create function public.media_reference_valid(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') collate "C" ~ '^[A-Za-z0-9_-]{3,255}$',
    false);
$function$;

create function public.media_user_reference_valid(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'null'
    or (
      jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') collate "C" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    false);
$function$;

create function public.media_room_name_valid(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') collate "C" ~ '^[A-Za-z0-9_-]{1,128}$',
    false);
$function$;

-- Whether an observation has exactly the allowed shape: a kind of the vocabulary and only its own members, each of its
-- own form (at most 50 sessions of at most 50 participants each). The minimal payload of a media receipt is exactly
-- such an observation (never a name, a token or the provider payload).
create function public.media_observation_valid(p_observation jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_kind text;
  v_session jsonb;
  v_participant jsonb;
begin
  if jsonb_typeof(p_observation) is distinct from 'object' or jsonb_typeof(p_observation -> 'kind') is distinct from 'string' then
    return false;
  end if;
  v_kind := p_observation ->> 'kind';
  if v_kind = 'ignored' then
    return public.media_exact_keys(p_observation, array['kind']);
  end if;
  if not public.media_room_name_valid(p_observation -> 'room_name') then
    return false;
  end if;
  case v_kind
    when 'room_created', 'room_updated' then
      return public.media_exact_keys(p_observation, array['kind', 'room_name', 'expires_at'])
        and public.media_instant_valid(p_observation -> 'expires_at');
    when 'room_deleted', 'room_missing' then
      return public.media_exact_keys(p_observation, array['kind', 'room_name']);
    when 'meeting_started' then
      return public.media_exact_keys(p_observation, array['kind', 'room_name', 'session_reference', 'started_at'])
        and public.media_reference_valid(p_observation -> 'session_reference')
        and public.media_instant_valid(p_observation -> 'started_at');
    when 'meeting_ended' then
      return public.media_exact_keys(p_observation, array['kind', 'room_name', 'session_reference', 'started_at', 'ended_at'])
        and public.media_reference_valid(p_observation -> 'session_reference')
        and public.media_instant_valid(p_observation -> 'started_at')
        and public.media_instant_valid(p_observation -> 'ended_at');
    when 'participant_joined' then
      return public.media_exact_keys(
               p_observation, array['kind', 'room_name', 'participant_reference', 'user_id', 'joined_at'])
        and public.media_reference_valid(p_observation -> 'participant_reference')
        and public.media_user_reference_valid(p_observation -> 'user_id')
        and public.media_instant_valid(p_observation -> 'joined_at');
    when 'participant_left' then
      return public.media_exact_keys(
               p_observation, array['kind', 'room_name', 'participant_reference', 'user_id', 'joined_at', 'left_at'])
        and public.media_reference_valid(p_observation -> 'participant_reference')
        and public.media_user_reference_valid(p_observation -> 'user_id')
        and public.media_instant_valid(p_observation -> 'joined_at')
        and public.media_instant_valid(p_observation -> 'left_at');
    when 'meetings_observed' then
      if not public.media_exact_keys(p_observation, array['kind', 'room_name', 'sessions'])
         or jsonb_typeof(p_observation -> 'sessions') is distinct from 'array'
         or jsonb_array_length(p_observation -> 'sessions') > 50 then
        return false;
      end if;
      for v_session in select x from jsonb_array_elements(p_observation -> 'sessions') as x loop
        if not public.media_exact_keys(v_session, array['session_reference', 'started_at', 'ended_at', 'participants'])
           or not public.media_reference_valid(v_session -> 'session_reference')
           or not public.media_instant_valid(v_session -> 'started_at')
           or not (jsonb_typeof(v_session -> 'ended_at') = 'null' or public.media_instant_valid(v_session -> 'ended_at'))
           or jsonb_typeof(v_session -> 'participants') is distinct from 'array'
           or jsonb_array_length(v_session -> 'participants') > 50 then
          return false;
        end if;
        for v_participant in select y from jsonb_array_elements(v_session -> 'participants') as y loop
          if not public.media_exact_keys(v_participant, array['participant_reference', 'user_id', 'joined_at', 'left_at'])
             or not public.media_reference_valid(v_participant -> 'participant_reference')
             or not public.media_user_reference_valid(v_participant -> 'user_id')
             or not public.media_instant_valid(v_participant -> 'joined_at')
             or not (jsonb_typeof(v_participant -> 'left_at') = 'null' or public.media_instant_valid(v_participant -> 'left_at')) then
            return false;
          end if;
        end loop;
      end loop;
      return true;
    else
      return false;
  end case;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Evidence recording (internal).
-- ---------------------------------------------------------------------------

-- The more significant of two recording results: contradiction, applied, stale, no_effect.
create function public.media_result_max(p_left text, p_right text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when 'contradiction' in (p_left, p_right) then 'contradiction'
    when 'applied' in (p_left, p_right) then 'applied'
    when 'stale' in (p_left, p_right) then 'stale'
    else 'no_effect'
  end;
$function$;

-- Records one provider session of a (locked) Media Room: new -> applied; an earlier start or a first end -> applied; an
-- ongoing observation of an ended session or an end before the start -> stale; nothing new -> no_effect. A session start
-- outside the Consultation (see the header) or a reference of another Media Room opens an item -> contradiction.
create function public.media_record_session(
  p_room public.media_rooms,
  p_provider_code text,
  p_reference text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_jurisdiction uuid,
  p_terminal_at timestamptz,
  p_consultation_state text,
  p_source_type text,
  p_source_id uuid
)
returns table (result text, media_session_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_session public.media_sessions;
  v_id uuid;
  v_result text := 'no_effect';
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_ended_at is not null and p_ended_at < p_started_at then
    return query select 'stale'::text, null::uuid;
    return;
  end if;
  insert into public.media_sessions (
    media_room_id, provider_code, provider_session_reference, started_at, ended_at, provider_state
  ) values (
    p_room.id, p_provider_code, p_reference, p_started_at, p_ended_at,
    case when p_ended_at is null then 'ongoing' else 'ended' end
  )
  on conflict (provider_code, provider_session_reference) do nothing
  returning id into v_id;
  if v_id is not null then
    v_result := 'applied';
  else
    select s.* into v_session
    from public.media_sessions as s
    where s.provider_code = p_provider_code
      and s.provider_session_reference = p_reference
    for update;
    v_id := v_session.id;
    if v_session.media_room_id is distinct from p_room.id then
      perform public.decision_open_review(
        'media_session_mismatch', 'consultation', p_room.consultation_id, 'high', p_jurisdiction,
        jsonb_build_object(
          'media_room_id', p_room.id,
          'media_session_id', v_session.id,
          'consultation_state', p_consultation_state,
          'source_type', p_source_type,
          'source_id', p_source_id
        )
      );
      return query select 'contradiction'::text, null::uuid;
      return;
    end if;
    v_start := least(v_session.started_at, p_started_at);
    v_end := v_session.ended_at;
    if v_end is null and p_ended_at is not null and p_ended_at >= v_start then
      v_end := p_ended_at;
    end if;
    if v_start is distinct from v_session.started_at or v_end is distinct from v_session.ended_at then
      update public.media_sessions as s
      set started_at = v_start,
          ended_at = v_end,
          provider_state = case when v_end is null then 'ongoing' else 'ended' end
      where s.id = v_session.id;
      v_result := 'applied';
    elsif (p_ended_at is null and v_session.ended_at is not null)
          or (p_ended_at is not null and p_ended_at is distinct from v_session.ended_at) then
      v_result := 'stale';
    end if;
  end if;
  if p_started_at < p_room.created_at - interval '60 seconds'
     or (p_terminal_at is not null and p_started_at > p_terminal_at + interval '60 seconds') then
    perform public.decision_open_review(
      'media_activity_outside_consultation', 'consultation', p_room.consultation_id, 'high', p_jurisdiction,
      jsonb_build_object(
        'media_room_id', p_room.id,
        'media_session_id', v_id,
        'observed', 'session_started',
        'consultation_state', p_consultation_state,
        'source_type', p_source_type,
        'source_id', p_source_id
      )
    );
    v_result := 'contradiction';
  end if;
  return query select v_result, v_id;
end;
$function$;

-- Records one participant observation of a (locked) Media Room in one provider session (or none known yet): the
-- Consultation's client or attorney User only (anyone else opens a critical item and records nothing); a joined
-- observation and a completed presence each once per session and participant reference. Answers applied, no_effect,
-- stale or contradiction.
create function public.media_record_participant(
  p_room public.media_rooms,
  p_session_id uuid,
  p_client_user uuid,
  p_attorney_user uuid,
  p_reference text,
  p_user_id uuid,
  p_joined_at timestamptz,
  p_left_at timestamptz,
  p_jurisdiction uuid,
  p_terminal_at timestamptz,
  p_consultation_state text,
  p_source_type text,
  p_source_id uuid
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_role text;
  v_id uuid;
  v_result text := 'no_effect';
begin
  v_role := case
    when p_user_id is null then null
    when p_user_id = p_client_user then 'client'
    when p_user_id = p_attorney_user then 'attorney'
  end;
  if v_role is null then
    perform public.decision_open_review(
      'media_unrecognized_participant', 'consultation', p_room.consultation_id, 'critical', p_jurisdiction,
      jsonb_build_object(
        'media_room_id', p_room.id,
        'media_session_id', p_session_id,
        'participant_reference', p_reference,
        'user_id_presented', p_user_id is not null,
        'consultation_state', p_consultation_state,
        'source_type', p_source_type,
        'source_id', p_source_id
      )
    );
    return 'contradiction';
  end if;
  if p_left_at is not null and p_left_at < p_joined_at then
    return 'stale';
  end if;
  if p_session_id is not null then
    insert into public.session_participation_records (
      media_session_id, participant_user_id, joined_at, left_at, observed_participation, provider_observation_reference
    ) values (
      p_session_id, p_user_id, p_joined_at, p_left_at,
      jsonb_build_object(
        'participant_role', v_role,
        'observation', case when p_left_at is null then 'joined' else 'left' end,
        'source_type', p_source_type
      ),
      p_reference
    )
    on conflict (media_session_id, provider_observation_reference, (left_at is not null)) do nothing
    returning id into v_id;
    if v_id is not null then
      v_result := 'applied';
    end if;
  end if;
  if p_joined_at < p_room.created_at - interval '60 seconds'
     or (p_terminal_at is not null and p_joined_at > p_terminal_at + interval '60 seconds') then
    perform public.decision_open_review(
      'media_activity_outside_consultation', 'consultation', p_room.consultation_id, 'high', p_jurisdiction,
      jsonb_build_object(
        'media_room_id', p_room.id,
        'media_session_id', p_session_id,
        'observed', 'participant_joined',
        'participant_role', v_role,
        'consultation_state', p_consultation_state,
        'source_type', p_source_type,
        'source_id', p_source_id
      )
    );
    v_result := 'contradiction';
  end if;
  return v_result;
end;
$function$;

-- Applies one validated evidence observation to one Media Room (locked FOR UPDATE; the Consultation is only read).
-- Answers applied, no_effect, stale or contradiction; never changes a Consultation, payment or Engagement.
create function public.media_apply_observation(
  p_room_id uuid,
  p_provider_code text,
  p_observation jsonb,
  p_source_type text,
  p_source_id uuid
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_room public.media_rooms;
  v_context record;
  v_timing record;
  v_terminal timestamptz;
  v_kind text;
  v_result text := 'no_effect';
  v_session jsonb;
  v_participant jsonb;
  v_recorded record;
  v_session_id uuid;
  v_joined timestamptz;
begin
  select m.* into v_room from public.media_rooms as m where m.id = p_room_id for update;
  if v_room.id is null then
    return 'no_effect';
  end if;
  select x.* into v_context from public.consultation_context(v_room.consultation_id) as x;
  v_terminal := case
    when v_context.state in ('completed', 'cancelled', 'no_show', 'technical_failure')
      then coalesce(v_context.ended_at, v_context.updated_at)
  end;
  v_kind := p_observation ->> 'kind';
  if v_kind = 'room_missing' then
    -- A provider room past its expiry is expected to be gone: a missing room is a disagreement only while the
    -- Consultation's permitted window has not ended (and is known); never after it.
    select t.* into v_timing from public.consultation_timing(v_room.consultation_id, clock_timestamp()) as t;
    if v_room.state = 'open' and v_context.state in ('ready', 'live')
       and v_timing.outcome = 'selected' and clock_timestamp() < v_timing.closes_at then
      perform public.decision_open_review(
        'media_room_missing', 'consultation', v_room.consultation_id, 'high', v_context.jurisdiction_id,
        jsonb_build_object(
          'media_room_id', v_room.id,
          'media_room_state', v_room.state,
          'consultation_state', v_context.state,
          'source_type', p_source_type,
          'source_id', p_source_id
        )
      );
      return 'contradiction';
    end if;
    return 'no_effect';
  end if;
  if v_kind = 'meetings_observed' then
    for v_session in select x from jsonb_array_elements(p_observation -> 'sessions') as x loop
      select r.result, r.media_session_id into v_recorded
      from public.media_record_session(
        v_room, p_provider_code, v_session ->> 'session_reference', (v_session ->> 'started_at')::timestamptz,
        (v_session ->> 'ended_at')::timestamptz, v_context.jurisdiction_id, v_terminal, v_context.state,
        p_source_type, p_source_id
      ) as r;
      v_result := public.media_result_max(v_result, v_recorded.result);
      for v_participant in select y from jsonb_array_elements(v_session -> 'participants') as y loop
        v_result := public.media_result_max(v_result, public.media_record_participant(
          v_room, v_recorded.media_session_id, v_context.client_user_id, v_context.attorney_user_id,
          v_participant ->> 'participant_reference', (v_participant ->> 'user_id')::uuid,
          (v_participant ->> 'joined_at')::timestamptz, (v_participant ->> 'left_at')::timestamptz,
          v_context.jurisdiction_id, v_terminal, v_context.state, p_source_type, p_source_id
        ));
      end loop;
    end loop;
    return v_result;
  end if;
  if v_kind in ('meeting_started', 'meeting_ended') then
    select r.result into v_result
    from public.media_record_session(
      v_room, p_provider_code, p_observation ->> 'session_reference', (p_observation ->> 'started_at')::timestamptz,
      (p_observation ->> 'ended_at')::timestamptz, v_context.jurisdiction_id, v_terminal, v_context.state,
      p_source_type, p_source_id
    ) as r;
    return v_result;
  end if;
  if v_kind in ('participant_joined', 'participant_left') then
    -- A participant event names no provider session: it belongs to the room's session that was running at the join
    -- (within the fixed 60-second skew bound), if one is known; otherwise only the recognition and timing checks apply
    -- and the room's observation job brings the provider's session records.
    v_joined := (p_observation ->> 'joined_at')::timestamptz;
    select s.id into v_session_id
    from public.media_sessions as s
    where s.media_room_id = v_room.id
      and s.provider_code = p_provider_code
      and s.started_at <= v_joined + interval '60 seconds'
      and (s.ended_at is null or s.ended_at >= v_joined - interval '60 seconds')
    order by s.started_at desc, s.id desc
    limit 1;
    return public.media_record_participant(
      v_room, v_session_id, v_context.client_user_id, v_context.attorney_user_id,
      p_observation ->> 'participant_reference', (p_observation ->> 'user_id')::uuid, v_joined,
      (p_observation ->> 'left_at')::timestamptz, v_context.jurisdiction_id, v_terminal, v_context.state,
      p_source_type, p_source_id
    );
  end if;
  return 'no_effect';
end;
$function$;

-- ---------------------------------------------------------------------------
-- The worker and the webhook (service_role only: the server-only privileged credential).
-- ---------------------------------------------------------------------------

create function public.media_job_context(p_job_id uuid)
returns table (
  outcome text,
  operation text,
  media_room_id uuid,
  room_name text,
  room_state text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_job public.operational_jobs;
  v_operation text;
  v_room public.media_rooms;
  v_context record;
  v_timing record;
  v_now timestamptz;
  v_outcome text := 'nothing_to_do';
  v_expires timestamptz;
begin
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
    and j.state = 'running'
    and j.subject_type = 'media_room'
    and j.job_type in ('media.room_create', 'media.room_update', 'media.room_delete', 'media.observe');
  if not found then
    return query select 'not_running'::text, null::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;
  v_operation := substring(v_job.job_type from 7);
  select m.* into v_room from public.media_rooms as m where m.id = v_job.subject_id;
  if not found then
    return query select 'not_running'::text, v_operation, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;
  select x.* into v_context from public.consultation_context(v_room.consultation_id) as x;
  v_now := clock_timestamp();
  if v_operation in ('room_create', 'room_update') then
    if (v_operation = 'room_create' and v_room.state = 'pending' or v_operation = 'room_update' and v_room.state = 'open')
       and v_context.state in ('ready', 'live') then
      select t.* into v_timing from public.consultation_timing(v_room.consultation_id, v_now) as t;
      if v_timing.outcome is distinct from 'selected'
         or public.media_production_problem(
              v_context.jurisdiction_id,
              jsonb_build_array(jsonb_build_object(
                'policy_type_code', 'scheduling', 'policy_version_id', v_timing.policy_version_id,
                'regulatory_mode_id', null
              )),
              v_now
            ) is not null then
        v_outcome := case when v_operation = 'room_create' then 'wait' else 'nothing_to_do' end;
      elsif v_timing.closes_at > v_now + interval '60 seconds' then
        v_outcome := 'act';
        v_expires := v_timing.closes_at;
      end if;
    end if;
  elsif v_operation = 'room_delete' then
    if v_room.state = 'closing' then
      if exists (
        select 1 from public.operational_jobs as j
        where j.job_type = 'media.room_create'
          and j.subject_type = 'media_room'
          and j.subject_id = v_room.id
          and j.state = 'running'
      ) then
        v_outcome := 'wait';
      else
        v_outcome := 'act';
      end if;
    end if;
  elsif v_operation = 'observe' then
    if v_room.state in ('open', 'closing', 'closed') then
      v_outcome := 'act';
    end if;
  end if;
  return query select
    v_outcome,
    v_operation,
    v_room.id,
    public.media_room_provider_name(v_room.id),
    v_room.state,
    v_expires;
end;
$function$;

-- Records the result of one provider call made by a running media job (the kinds each job may report are fixed).
-- Answers applied, no_effect, stale, contradiction (an item is open), outdated (a room update whose expiry is no
-- longer the window end: the job runs again), invalid or not_running.
create function public.media_record_operation(p_job_id uuid, p_provider_code text, p_observation jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_job public.operational_jobs;
  v_kind text;
  v_room public.media_rooms;
  v_jurisdiction uuid;
  v_context record;
  v_timing record;
  v_now timestamptz;
  v_outdated boolean := false;
begin
  if p_job_id is null
     or p_provider_code is null or p_provider_code collate "C" !~ '^[a-z][a-z0-9_]{1,31}$'
     or not public.media_observation_valid(p_observation) then
    return 'invalid';
  end if;
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
    and j.state = 'running'
    and j.subject_type = 'media_room'
    and j.job_type in ('media.room_create', 'media.room_update', 'media.room_delete', 'media.observe');
  if not found then
    return 'not_running';
  end if;
  v_kind := p_observation ->> 'kind';
  if not (
    (v_job.job_type = 'media.room_create' and v_kind = 'room_created')
    or (v_job.job_type = 'media.room_update' and v_kind in ('room_updated', 'room_missing'))
    or (v_job.job_type = 'media.room_delete' and v_kind = 'room_deleted')
    or (v_job.job_type = 'media.observe' and v_kind in ('room_missing', 'meetings_observed'))
  ) or (p_observation ->> 'room_name') is distinct from public.media_room_provider_name(v_job.subject_id) then
    return 'invalid';
  end if;
  if v_kind in ('room_missing', 'meetings_observed') then
    return public.media_apply_observation(v_job.subject_id, p_provider_code, p_observation, 'operational_job', v_job.id);
  end if;
  select m.* into v_room from public.media_rooms as m where m.id = v_job.subject_id for update;
  if v_room.id is null then
    return 'not_running';
  end if;
  select f.jurisdiction_id into v_jurisdiction
  from public.consultations as c
  join public.consultation_requests as r on r.id = c.consultation_request_id
  join public.referrals as f on f.id = r.referral_id
  where c.id = v_room.consultation_id;
  if v_kind in ('room_created', 'room_updated') then
    -- The expiry the provider room now carries (the job's report, whole seconds) against the window end the room must
    -- carry now: they differ when the window moved while the job ran (an instant Consultation started meanwhile, or a
    -- room created before the start was recorded) or when an existing provider room kept an older expiry. The room
    -- must never eject participants while the Consultation is live inside its window.
    select x.* into v_context from public.consultation_context(v_room.consultation_id) as x;
    if v_context.state in ('ready', 'live') then
      v_now := clock_timestamp();
      select t.* into v_timing from public.consultation_timing(v_room.consultation_id, v_now) as t;
      v_outdated := v_timing.outcome = 'selected'
        and v_timing.closes_at > v_now + interval '60 seconds'
        and floor(extract(epoch from v_timing.closes_at))
          <> floor(extract(epoch from (p_observation ->> 'expires_at')::timestamptz));
    end if;
  end if;
  if v_kind = 'room_created' then
    if v_room.state not in ('pending', 'open') then
      return 'no_effect';
    end if;
    -- An open room (a repeated creation) still gets the expiry update when its reported expiry is outdated.
    if v_outdated then
      perform public.job_enqueue('media.room_update', 'media_room', v_room.id, clock_timestamp(), 8);
    end if;
    if v_room.state = 'open' then
      return 'no_effect';
    end if;
    update public.media_rooms as m set state = 'open' where m.id = v_room.id;
    perform public.decision_audit(
      null, 'system', 'media_room.opened', 'media_room', v_room.id,
      jsonb_build_object('state', 'pending'),
      jsonb_build_object('state', 'open', 'consultation_id', v_room.consultation_id, 'provider_code', p_provider_code),
      'provider_room_created', null, v_jurisdiction
    );
    return 'applied';
  end if;
  if v_kind = 'room_deleted' then
    if v_room.state is distinct from 'closing' then
      return 'no_effect';
    end if;
    update public.media_rooms as m set state = 'closed', ended_at = clock_timestamp() where m.id = v_room.id;
    perform public.decision_audit(
      null, 'system', 'media_room.closed', 'media_room', v_room.id,
      jsonb_build_object('state', 'closing'),
      jsonb_build_object('state', 'closed', 'consultation_id', v_room.consultation_id, 'provider_code', p_provider_code),
      'provider_room_deleted', null, v_jurisdiction
    );
    perform public.job_enqueue('media.observe', 'media_room', v_room.id, clock_timestamp(), 3);
    return 'applied';
  end if;
  -- room_updated: the provider's expiry moved; no Rosuno state. When the window moved again while the update ran, the
  -- job is not finished (outdated: the S2 protocol runs it again and it reads the window end afresh).
  if v_outdated and v_room.state = 'open' then
    return 'outdated';
  end if;
  return 'no_effect';
end;
$function$;

-- Records one authenticated provider media event (the webhook route verified its signature first): the receipt first,
-- unique per (provider, event reference), then the observation applied to its Media Room in the same transaction.
-- Outcomes: recorded (with the processing outcome), duplicate (with the first delivery's outcome), invalid.
create function public.media_record_provider_event(
  p_provider_code text,
  p_event_reference text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload_digest text,
  p_observation jsonb
)
returns table (outcome text, processing_state text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_receipt uuid;
  v_kind text;
  v_room uuid;
  v_state text;
begin
  if p_provider_code is null or p_provider_code collate "C" !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_event_reference is null or p_event_reference collate "C" !~ '^[A-Za-z0-9_]{3,255}$'
     or p_event_type is null or p_event_type collate "C" !~ '^[a-z][a-z0-9_.]{2,99}$'
     or p_occurred_at is null
     or p_payload_digest is null or p_payload_digest collate "C" !~ '^sha256:[0-9a-f]{64}$'
     or not public.media_observation_valid(p_observation)
     or (p_observation ->> 'kind') not in (
       'meeting_started', 'meeting_ended', 'participant_joined', 'participant_left', 'ignored'
     ) then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  insert into public.external_event_receipts (
    provider_code, provider_event_reference, event_type, received_at, processed_at, processing_state,
    correlation_reference, payload_digest, minimal_payload
  ) values (
    p_provider_code, p_event_reference, p_event_type, clock_timestamp(), null, 'received',
    null, p_payload_digest,
    p_observation || jsonb_build_object('provider_created_at', p_occurred_at)
  )
  on conflict (provider_code, provider_event_reference) do nothing
  returning id into v_receipt;
  if v_receipt is null then
    return query
      select 'duplicate'::text, x.processing_state
      from public.external_event_receipts as x
      where x.provider_code = p_provider_code
        and x.provider_event_reference = p_event_reference;
    return;
  end if;
  v_kind := p_observation ->> 'kind';
  if v_kind = 'ignored' then
    v_state := 'ignored';
  else
    v_room := public.media_room_of_provider_name(p_observation ->> 'room_name');
    if v_room is not null and not exists (select 1 from public.media_rooms as m where m.id = v_room) then
      perform public.decision_open_review(
        'media_unknown_room', 'external_event_receipt', v_receipt, 'medium', null,
        jsonb_build_object('event_type', p_event_type, 'observation_kind', v_kind)
      );
      v_room := null;
    end if;
    if v_room is null then
      v_state := 'unmatched';
    else
      v_state := public.media_apply_observation(v_room, p_provider_code, p_observation, 'external_event_receipt', v_receipt);
      if v_kind in ('participant_joined', 'participant_left') then
        perform public.job_enqueue('media.observe', 'media_room', v_room, clock_timestamp(), 3);
      end if;
    end if;
  end if;
  update public.external_event_receipts as x
  set processing_state = v_state,
      processed_at = clock_timestamp(),
      correlation_reference = v_room::text
  where x.id = v_receipt;
  return query select 'recorded'::text, v_state;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Derived participation evidence and the participants' reads.
-- ---------------------------------------------------------------------------

-- The derived participation evidence of one Consultation (internal; see the header).
create function public.consultation_participation(p_consultation_id uuid)
returns table (
  attorney_joined_at timestamptz,
  attorney_left_at timestamptz,
  client_joined_at timestamptz,
  client_left_at timestamptz,
  both_present boolean,
  either_left boolean,
  provider_sessions integer,
  reconnections integer
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  with refs as (
    select
      p.provider_observation_reference as reference,
      p.media_session_id,
      case when p.participant_user_id = cp.user_id then 'client' else 'attorney' end as role,
      min(p.joined_at) as joined_at,
      max(p.left_at) as left_at
    from public.session_participation_records as p
    join public.media_sessions as s on s.id = p.media_session_id
    join public.media_rooms as m on m.id = s.media_room_id
    join public.consultations as c on c.id = m.consultation_id
    join public.client_profiles as cp on cp.id = c.client_id
    where m.consultation_id = p_consultation_id
    group by 1, 2, 3
  )
  select
    (select min(r.joined_at) from refs as r where r.role = 'attorney'),
    (select max(r.left_at) from refs as r where r.role = 'attorney'),
    (select min(r.joined_at) from refs as r where r.role = 'client'),
    (select max(r.left_at) from refs as r where r.role = 'client'),
    exists (
      select 1
      from refs as a
      join refs as k on a.role = 'attorney' and k.role = 'client'
      where a.joined_at < coalesce(k.left_at, 'infinity'::timestamptz)
        and k.joined_at < coalesce(a.left_at, 'infinity'::timestamptz)
    ),
    exists (select 1 from refs as r where r.left_at is not null),
    (
      select count(*)::integer
      from public.media_sessions as s
      join public.media_rooms as m on m.id = s.media_room_id
      where m.consultation_id = p_consultation_id
    ),
    (
      greatest((select count(*) from refs as r where r.role = 'attorney') - 1, 0)
      + greatest((select count(*) from refs as r where r.role = 'client') - 1, 0)
    )::integer;
$function$;

-- One Consultation as its participants see it (internal; the caller checks the participant).
create function public.consultation_view(p_consultation_id uuid)
returns table (
  consultation_id uuid,
  state text,
  ready_due boolean,
  request_path text,
  modality text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text,
  media_state text,
  attorney_joined_at timestamptz,
  attorney_left_at timestamptz,
  client_joined_at timestamptz,
  client_left_at timestamptz,
  both_present boolean,
  either_left boolean,
  provider_sessions integer,
  reconnections integer
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    x.consultation_id,
    x.state,
    x.state = 'scheduled'
      and t.outcome = 'selected'
      and t.opens_at <= clock_timestamp()
      and clock_timestamp() < t.closes_at,
    x.request_path,
    x.modality,
    x.duration_minutes,
    x.slot_start_at,
    x.slot_end_at,
    t.opens_at,
    t.closes_at,
    x.started_at,
    x.ended_at,
    c.outcome_code,
    x.media_room_state,
    p.attorney_joined_at,
    p.attorney_left_at,
    p.client_joined_at,
    p.client_left_at,
    p.both_present,
    p.either_left,
    p.provider_sessions,
    p.reconnections
  from public.consultation_context(p_consultation_id) as x
  join public.consultations as c on c.id = x.consultation_id
  cross join lateral public.consultation_timing(x.consultation_id, clock_timestamp()) as t
  cross join lateral public.consultation_participation(x.consultation_id) as p;
$function$;

create function public.client_consultation(p_consultation_id uuid)
returns table (
  consultation_id uuid,
  state text,
  ready_due boolean,
  request_path text,
  modality text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text,
  media_state text,
  attorney_joined_at timestamptz,
  attorney_left_at timestamptz,
  client_joined_at timestamptz,
  client_left_at timestamptz,
  both_present boolean,
  either_left boolean,
  provider_sessions integer,
  reconnections integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select v.*
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultations as c on c.client_id = cp.id and c.id = p_consultation_id
  cross join lateral public.consultation_view(c.id) as v
  where p_consultation_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

create function public.attorney_consultation(p_consultation_id uuid)
returns table (
  consultation_id uuid,
  state text,
  ready_due boolean,
  request_path text,
  modality text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text,
  media_state text,
  attorney_joined_at timestamptz,
  attorney_left_at timestamptz,
  client_joined_at timestamptz,
  client_left_at timestamptz,
  both_present boolean,
  either_left boolean,
  provider_sessions integer,
  reconnections integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select v.*
  from public.users as u
  join public.attorney_profiles as ap on ap.user_id = u.id
  join public.consultations as c on c.attorney_id = ap.id and c.id = p_consultation_id
  cross join lateral public.consultation_view(c.id) as v
  where p_consultation_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and ap.profile_state = 'approved'
    and public.current_session_aal2() is true;
$function$;

create function public.attorney_consultations()
returns table (
  consultation_id uuid,
  state text,
  ready_due boolean,
  request_path text,
  modality text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  started_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    v.consultation_id,
    v.state,
    v.ready_due,
    v.request_path,
    v.modality,
    v.duration_minutes,
    v.booking_starts_at,
    v.booking_ends_at,
    v.opens_at,
    v.closes_at,
    v.started_at
  from public.users as u
  join public.attorney_profiles as ap on ap.user_id = u.id
  join public.consultations as c on c.attorney_id = ap.id and c.state in ('scheduled', 'ready', 'live')
  cross join lateral public.consultation_view(c.id) as v
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and ap.profile_state = 'approved'
    and public.current_session_aal2() is true
  -- Live first; then those whose window is open now (ready, or due), then upcoming ones (window not yet open or not
  -- known), each soonest first; Consultations whose window has passed (stale until S11 settles them) last, the most
  -- recent first, so they never rank ahead of upcoming ones.
  order by
    case
      when v.state = 'live' then 0
      when v.closes_at is not null and v.closes_at <= clock_timestamp() then 3
      when v.opens_at is not null and v.opens_at <= clock_timestamp() then 1
      else 2
    end,
    case
      when v.state <> 'live' and v.closes_at is not null and v.closes_at <= clock_timestamp() then null
      else coalesce(v.booking_starts_at, c.created_at)
    end asc nulls last,
    coalesce(v.booking_starts_at, c.created_at) desc,
    v.consultation_id
  limit 200;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.media_exact_keys(jsonb, text[])',
    'public.media_instant_valid(jsonb)',
    'public.media_reference_valid(jsonb)',
    'public.media_user_reference_valid(jsonb)',
    'public.media_room_name_valid(jsonb)',
    'public.media_observation_valid(jsonb)',
    'public.media_result_max(text, text)',
    'public.media_record_session(public.media_rooms, text, text, timestamptz, timestamptz, uuid, timestamptz, text, text, uuid)',
    'public.media_record_participant(public.media_rooms, uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, uuid, timestamptz, text, text, uuid)',
    'public.media_apply_observation(uuid, text, jsonb, text, uuid)',
    'public.consultation_participation(uuid)',
    'public.consultation_view(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.client_consultation(uuid)',
    'public.attorney_consultation(uuid)',
    'public.attorney_consultations()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.media_job_context(uuid)',
    'public.media_record_operation(uuid, text, jsonb)',
    'public.media_record_provider_event(text, text, text, timestamptz, text, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$privileges$;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.media_observation_valid(jsonb) is
  'MVP-001 S9 (internal): whether a media observation has exactly an allowed shape (room_created, room_updated, room_deleted, room_missing, meetings_observed, meeting_started, meeting_ended, participant_joined, participant_left, ignored); never a name, token or provider payload.';
comment on function public.media_record_session(public.media_rooms, text, text, timestamptz, timestamptz, uuid, timestamptz, text, text, uuid) is
  'MVP-001 S9 (internal): records one provider session of a locked Media Room idempotently (start only earlier, end once, never ongoing after ended); a start outside the Consultation or a reference of another room opens a Reconciliation Exception.';
comment on function public.media_record_participant(public.media_rooms, uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, uuid, timestamptz, text, text, uuid) is
  'MVP-001 S9 (internal): records one participant observation as append-only evidence (the Consultation''s client or attorney only; once per session, reference and kind); an unrecognized participant (critical) or a join outside the Consultation (high) opens a Reconciliation Exception.';
comment on function public.media_apply_observation(uuid, text, jsonb, text, uuid) is
  'MVP-001 S9 (internal): applies one evidence observation to one Media Room (locked); never changes a Consultation, payment or Engagement. Answers applied, no_effect, stale or contradiction.';
comment on function public.media_job_context(uuid) is
  'MVP-001 S9 (service_role only): what a running media job is to do now, from canonical state only (act with the provider room name and expiry, nothing_to_do, wait, not_running).';
comment on function public.media_record_operation(uuid, text, jsonb) is
  'MVP-001 S9 (service_role only): records the result of one provider call of a running media job (room_created and room_updated with the provider room''s expiry, room_deleted, room_missing, meetings_observed); a reported expiry other than the current window end enqueues a room update (room_created) or answers outdated (room_updated). Answers applied, no_effect, stale, contradiction, outdated, invalid or not_running.';
comment on function public.media_record_provider_event(text, text, text, timestamptz, text, jsonb) is
  'MVP-001 S9 (service_role only): records one authenticated provider media event (receipt first, unique per provider event; replays are no-ops) and applies its observation in the same transaction. Outcomes: recorded, duplicate, invalid.';
comment on function public.consultation_participation(uuid) is
  'MVP-001 S9 (internal): the derived participation evidence of one Consultation (first join and last departure per role, both present at once, either left, provider sessions, reconnections).';
comment on function public.consultation_view(uuid) is
  'MVP-001 S9 (internal): one Consultation as its participants see it (state, ready_due, path, modality, duration, Booking, window, times, completion reason, Media Room state, participation evidence).';
comment on function public.client_consultation(uuid) is
  'MVP-001 S9: one of the caller''s own Consultations as its client (active User): state, ready_due, window, times, Media Room state and derived participation evidence; nothing of the provider or the attorney''s contact details.';
comment on function public.attorney_consultation(uuid) is
  'MVP-001 S9: one of the caller''s own Consultations as its attorney (approved, aal2): state, ready_due, window, times, Media Room state and derived participation evidence; nothing of the client''s identity.';
comment on function public.attorney_consultations() is
  'MVP-001 S9: the caller''s scheduled, ready and live Consultations (approved attorney at aal2): live first, then window open, then upcoming, soonest first, window passed last; at most 200.';
