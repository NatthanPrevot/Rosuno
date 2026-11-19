-- MVP-001 S10 (3 of 4): consultation-scoped Messages with a configured post-consultation window (MVP-001 Packet S10
-- "consultation-scoped messages with a configurable post-consultation window"; MBS section 15 deliverable 12A and its
-- rules; IMP section 26; MB sections 51 to 53; MB-A1 section 1; PS section 20; DM: Message content immutable once sent).
--
-- No relation, column or policy type is added (Packet rules 8 and 16). Messages exist only inside a Consultation: there
-- is no pre-booking inbox and no channel outside the Consultation (Intake text and voice memos before a Consultation
-- belong to the Intake workflow, never to Messages). Messages and Notifications stay separate truths: a Message causes
-- its recipient's Notifications in the same transaction (notification_emit, 20261126020000), never becomes one.
--
-- Configuration seam (MB-A1 section 1; Packet rule 6; no new policy type, rule 8): one optional key of the existing
-- engagement policy type (communication inside the attorney-client engagement relationship):
--   post_consultation_message_window_seconds (an integer within 0..31536000, a wide sanity bound, not a value): how long
--   after a Consultation's completion its participants may still send Messages. Any whole JSON number the validator
--   admits (3600, 3600.0, 3.6e3) is read through numeric, so every reader answers rather than failing on the cast.
-- No schema default, constraint, enum, seed, migration or code constant supplies it. The governing version is the one
-- the Consultation recorded (engagement_policy_version_id, TA section 63), else the one the environment-anchored
-- resolver selects for the Consultation's jurisdiction and its single active Regulatory Mode now. Missing, unselectable
-- or malformed, an unrecorded environment, or, in a production-class database, a development version or a closed
-- four-way gate for the engagement policy type (media_production_problem, S9) -> window_unavailable: after completion
-- nothing is sent and the thread is read-only (fails honestly, never assumes a period). engagement_parameters_valid is
-- replaced forward so every S8 version (exactly the two S8 keys) stays valid and approvable and the key stays optional;
-- a version carrying a malformed window is invalid as a whole (S8 then reads it as policy_incomplete, as for any
-- malformed engagement version).
--
-- When Messages may be sent (communication_window): while the Consultation is created, scheduled, ready or live; after
-- it is completed only before its ended_at plus the configured window; never after it is cancelled, a no-show or a
-- technical failure (those completion types are S11's; fail closed). Reading stays open to both participants.
--
-- message_send (EXECUTE for authenticated only): the Consultation's client (an active User, any aal) or attorney (an
-- approved Attorney Profile of an active User at aal2, through lock_current_attorney_profile); everyone else, an
-- attorney at aal1 and an unknown id answer alike, not_found (a participant attorney whose profile is no longer
-- approved: denied). The recipient is the other participant, derived, never supplied. The body loses its surrounding
-- whitespace and must then be non-empty and within the fixed 20 000-character technical ceiling of client free text
-- (PS-A1). Lock order (the canonical order
-- of S4 to S9): the caller's own rows (client: lock_current_client; attorney: User and Attorney Profile FOR SHARE) ->
-- the Consultation FOR SHARE (so a send and consultation_end, which locks it FOR UPDATE, serialize: the send decides on
-- the committed state) -> the new Message, its Notifications and job. Outcomes: sent (with the Message id), invalid,
-- not_found, denied, closed, window_unavailable. Each send appends one audit event (identifiers and the governing
-- engagement version only; never the body).
--
-- Reads (EXECUTE for authenticated only; stable security definer; the same participant rule, no lock):
-- consultation_messages answers the newest 500 Messages of the thread oldest first (id, the sender's role, whether
-- the caller sent it, the body, the sending time) and, on every row, whether older Messages exist that are not shown
-- (older_not_shown; the thread is never silently truncated); consultation_messaging answers whether sending is open,
-- closed or window_unavailable, with the window's end once it is known. No other User's data is answered.

-- ---------------------------------------------------------------------------
-- Configuration: the optional engagement key (S8's validator replaced forward).
-- ---------------------------------------------------------------------------

create or replace function public.engagement_parameters_valid(p_parameters jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if jsonb_typeof(p_parameters) is distinct from 'object' then
    return false;
  end if;
  if not (p_parameters ?& array['consultation_creation', 'engagement_effective'])
     or exists (
       select 1 from jsonb_object_keys(p_parameters) as k
       where k not in ('consultation_creation', 'engagement_effective', 'post_consultation_message_window_seconds')
     ) then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'consultation_creation') is distinct from 'string'
     or (p_parameters ->> 'consultation_creation') not in (
       'attorney_acceptance',
       'attorney_acceptance_and_payment_authorized',
       'attorney_acceptance_and_payment_captured',
       'attorney_acceptance_and_engagement_effective'
     ) then
    return false;
  end if;
  if jsonb_typeof(p_parameters -> 'engagement_effective') is distinct from 'string'
     or (p_parameters ->> 'engagement_effective') not in (
       'at_request', 'at_attorney_acceptance', 'at_payment_capture', 'at_consultation_start'
     ) then
    return false;
  end if;
  if p_parameters ? 'post_consultation_message_window_seconds'
     and not public.pricing_integer_within(p_parameters -> 'post_consultation_message_window_seconds', 0, 31536000) then
    return false;
  end if;
  return true;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Internal helpers.
-- ---------------------------------------------------------------------------

-- Whether a Consultation's participants may communicate at an instant (see the header): ('open', null, null) while it
-- is not terminal; ('open' | 'closed', window end, governing version) after completion; ('closed', null, null) after any
-- other ending; ('window_unavailable', null, version or null) when the window cannot be decided; ('not_found', ...).
create function public.communication_window(p_consultation_id uuid, p_as_of timestamptz)
returns table (outcome text, closes_at timestamptz, policy_version_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_context record;
  v_version uuid;
  v_mode uuid;
  v_selection record;
  v_raw jsonb;
  v_closes timestamptz;
begin
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  if v_context.consultation_id is null or p_as_of is null then
    return query select 'not_found'::text, null::timestamptz, null::uuid;
    return;
  end if;
  if v_context.state in ('created', 'scheduled', 'ready', 'live') then
    return query select 'open'::text, null::timestamptz, null::uuid;
    return;
  end if;
  if v_context.state is distinct from 'completed' then
    return query select 'closed'::text, null::timestamptz, null::uuid;
    return;
  end if;
  if public.rosuno_environment_status() <> 'ok' or v_context.ended_at is null then
    return query select 'window_unavailable'::text, null::timestamptz, null::uuid;
    return;
  end if;
  v_version := v_context.engagement_policy_version_id;
  if v_version is null then
    select m.outcome, m.regulatory_mode_id into v_selection
    from public.payment_regulatory_mode(v_context.jurisdiction_id, p_as_of) as m;
    if v_selection.outcome is distinct from 'selected' then
      return query select 'window_unavailable'::text, null::timestamptz, null::uuid;
      return;
    end if;
    select s.outcome, s.policy_version_id into v_selection
    from public.policy_select_version('engagement', v_context.jurisdiction_id, v_selection.regulatory_mode_id, p_as_of)
      as s;
    if v_selection.outcome is distinct from 'selected' or v_selection.policy_version_id is null then
      return query select 'window_unavailable'::text, null::timestamptz, null::uuid;
      return;
    end if;
    v_version := v_selection.policy_version_id;
  end if;
  select v.parameters, v.regulatory_mode_id into v_raw, v_mode
  from public.policy_versions as v
  where v.id = v_version
    and v.policy_type_code = 'engagement';
  if not coalesce(public.engagement_parameters_valid(v_raw), false)
     or not (v_raw ? 'post_consultation_message_window_seconds') then
    return query select 'window_unavailable'::text, null::timestamptz, v_version;
    return;
  end if;
  if public.media_production_problem(
       v_context.jurisdiction_id,
       jsonb_build_array(jsonb_build_object(
         'policy_type_code', 'engagement', 'policy_version_id', v_version, 'regulatory_mode_id', v_mode
       )),
       p_as_of
     ) is not null then
    return query select 'window_unavailable'::text, null::timestamptz, v_version;
    return;
  end if;
  -- Read through numeric: the validator admits any whole JSON number (3600, 3600.0, 3.6e3), and a direct integer cast
  -- of '3600.0' would raise 22P02 instead of answering.
  v_closes := v_context.ended_at
    + make_interval(secs => ((v_raw ->> 'post_consultation_message_window_seconds')::numeric)::integer);
  return query select
    case when p_as_of < v_closes then 'open' else 'closed' end,
    v_closes,
    v_version;
end;
$function$;

-- The caller as a participant of a Consultation, locked in the canonical order (the caller's own rows, then the
-- Consultation FOR SHARE): ('ok', role, User, the other participant's User), ('denied', ...) for a participant attorney
-- whose profile is no longer approved, or ('not_found', ...) for everyone else, an attorney at aal1 and an unknown id.
create function public.communication_participant(p_consultation_id uuid)
returns table (outcome text, participant_role text, user_id uuid, counterpart_user_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_locked uuid;
  v_context record;
  v_profile public.attorney_profiles;
begin
  if p_consultation_id is null then
    return query select 'not_found'::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  select u.id into v_user
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
  select x.* into v_context from public.consultation_context(p_consultation_id) as x;
  if v_user is null or v_context.consultation_id is null then
    return query select 'not_found'::text, null::text, null::uuid, null::uuid;
    return;
  end if;
  if v_user = v_context.client_user_id then
    select l.user_id into v_locked from public.lock_current_client() as l;
    if v_locked is distinct from v_user then
      return query select 'not_found'::text, null::text, null::uuid, null::uuid;
      return;
    end if;
    perform 1 from public.consultations as c where c.id = p_consultation_id for share;
    return query select 'ok'::text, 'client'::text, v_user, v_context.attorney_user_id;
    return;
  end if;
  if v_user = v_context.attorney_user_id then
    v_profile := public.lock_current_attorney_profile(false);
    if v_profile.id is distinct from v_context.attorney_id then
      return query select 'not_found'::text, null::text, null::uuid, null::uuid;
      return;
    end if;
    if v_profile.profile_state is distinct from 'approved' then
      return query select 'denied'::text, null::text, null::uuid, null::uuid;
      return;
    end if;
    perform 1 from public.consultations as c where c.id = p_consultation_id for share;
    return query select 'ok'::text, 'attorney'::text, v_user, v_context.client_user_id;
    return;
  end if;
  return query select 'not_found'::text, null::text, null::uuid, null::uuid;
end;
$function$;

-- The caller as a reader of a Consultation's communication (no lock): (role, User, the other participant's User) for
-- the client (an active User, any aal) or the attorney (an approved profile of an active User at aal2); no row
-- otherwise.
create function public.communication_reader(p_consultation_id uuid)
returns table (participant_role text, user_id uuid, counterpart_user_id uuid)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    case when u.id = x.client_user_id then 'client' else 'attorney' end,
    u.id,
    case when u.id = x.client_user_id then x.attorney_user_id else x.client_user_id end
  from public.users as u
  cross join lateral public.consultation_context(p_consultation_id) as x
  where p_consultation_id is not null
    and x.consultation_id is not null
    and u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and (
      u.id = x.client_user_id
      or (
        u.id = x.attorney_user_id
        and public.current_session_aal2() is true
        and exists (
          select 1 from public.attorney_profiles as p
          where p.id = x.attorney_id and p.user_id = u.id and p.profile_state = 'approved'
        )
      )
    );
$function$;

-- ---------------------------------------------------------------------------
-- Sending and reading (authenticated only).
-- ---------------------------------------------------------------------------

create function public.message_send(p_consultation_id uuid, p_body text)
returns table (outcome text, message_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_body text;
  v_participant record;
  v_window record;
  v_now timestamptz;
  v_message uuid;
  v_jurisdiction uuid;
begin
  if p_consultation_id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  v_body := regexp_replace(p_body, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if v_body is null or v_body = '' or char_length(v_body) > 20000 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select p.* into v_participant from public.communication_participant(p_consultation_id) as p;
  if v_participant.outcome is distinct from 'ok' then
    return query select coalesce(v_participant.outcome, 'not_found'), null::uuid;
    return;
  end if;
  v_now := clock_timestamp();
  select w.* into v_window from public.communication_window(p_consultation_id, v_now) as w;
  if v_window.outcome in ('closed', 'window_unavailable') then
    return query select v_window.outcome, null::uuid;
    return;
  end if;
  if v_window.outcome is distinct from 'open' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  insert into public.messages (consultation_id, sender_user_id, recipient_user_id, body, sent_at, visibility_state)
  values (p_consultation_id, v_participant.user_id, v_participant.counterpart_user_id, v_body, v_now, 'visible')
  returning id into v_message;
  perform public.notification_emit(v_participant.counterpart_user_id, 'message_received', 'message.sent', v_message);
  select x.jurisdiction_id into v_jurisdiction from public.consultation_context(p_consultation_id) as x;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_participant.user_id, v_participant.participant_role, 'message.sent', 'message', v_message,
    null,
    jsonb_build_object('consultation_id', p_consultation_id, 'sender_role', v_participant.participant_role),
    null,
    case
      when v_window.policy_version_id is null then null
      else jsonb_build_array(jsonb_build_object(
        'policy_type_code', 'engagement', 'policy_version_id', v_window.policy_version_id
      ))
    end,
    v_jurisdiction, clock_timestamp()
  );
  return query select 'sent'::text, v_message;
end;
$function$;

create function public.consultation_messages(p_consultation_id uuid)
returns table (
  message_id uuid,
  sender_role text,
  mine boolean,
  body text,
  sent_at timestamptz,
  older_not_shown boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_reader record;
begin
  select r.* into v_reader from public.communication_reader(p_consultation_id) as r;
  if v_reader.user_id is null then
    return;
  end if;
  -- One more than shown, so the answer says whether older Messages exist.
  return query
    with recent as (
      select m.id, m.sender_user_id, m.body, m.sent_at
      from public.messages as m
      where m.consultation_id = p_consultation_id
        and m.visibility_state = 'visible'
      order by m.sent_at desc, m.id desc
      limit 501
    ),
    shown as (
      select r.id, r.sender_user_id, r.body, r.sent_at
      from recent as r
      order by r.sent_at desc, r.id desc
      limit 500
    )
    select
      t.id,
      case
        when t.sender_user_id = v_reader.user_id then v_reader.participant_role
        when v_reader.participant_role = 'client' then 'attorney'
        else 'client'
      end,
      t.sender_user_id = v_reader.user_id,
      t.body,
      t.sent_at,
      (select count(*) from recent) > 500
    from shown as t
    order by t.sent_at, t.id;
end;
$function$;

create function public.consultation_messaging(p_consultation_id uuid)
returns table (status text, closes_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_reader record;
  v_window record;
begin
  select r.* into v_reader from public.communication_reader(p_consultation_id) as r;
  if v_reader.user_id is null then
    return;
  end if;
  select w.* into v_window from public.communication_window(p_consultation_id, clock_timestamp()) as w;
  if v_window.outcome not in ('open', 'closed', 'window_unavailable') then
    return;
  end if;
  return query select v_window.outcome, v_window.closes_at;
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
    'public.engagement_parameters_valid(jsonb)',
    'public.communication_window(uuid, timestamptz)',
    'public.communication_participant(uuid)',
    'public.communication_reader(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.message_send(uuid, text)',
    'public.consultation_messages(uuid)',
    'public.consultation_messaging(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

comment on function public.communication_window(uuid, timestamptz) is
  'Internal (MVP-001 S10; MB-A1 section 1): open while the Consultation is not terminal; after completion open until ended_at plus the configured post_consultation_message_window_seconds of the governing engagement version, then closed; closed after any other ending; window_unavailable when the period cannot be decided (never assumed).';
comment on function public.message_send(uuid, text) is
  'MVP-001 S10: one Message from a Consultation participant (client any aal; attorney aal2) to the other participant, inside the communication window, with the recipient''s Notifications in the same transaction; audited without the body. Outcomes: sent, invalid, not_found, denied, closed, window_unavailable.';
comment on function public.consultation_messages(uuid) is
  'MVP-001 S10: the newest 500 Messages of a Consultation thread for its participants (client any aal; attorney aal2), oldest first, each row saying whether older Messages exist that are not shown.';
comment on function public.consultation_messaging(uuid) is
  'MVP-001 S10: whether a participant may send Messages now (open | closed | window_unavailable) and the window''s end once known.';
comment on table public.messages is
  'Consultation-scoped user communication (MVP-001 S10). Pre-Consultation/open-inbox messaging is structurally excluded; a sent Message is immutable and never deleted; writes and reads go only through message_send, consultation_messages and consultation_messaging.';
