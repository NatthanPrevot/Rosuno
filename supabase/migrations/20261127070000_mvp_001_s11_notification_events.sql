-- MVP-001 S11 (7 of 7): the S11 notification events on the S10 outbox (MVP-001 Packet S11 capability list; MBS
-- section 15 deliverable 12C; TA sections 27 and 47; PS section 20; ROS section 15; MB section 98, whose client
-- notification list includes "review available"; PM INV-10 "a failed ordinary notification never rolls back a business
-- event").
--
-- No relation, column or policy type is added (Packet rules 8 and 16). The S10 vocabulary (20261126010000,
-- 20261126020000) gains exactly four notification types, each with its one source event:
--   consultation_cancelled         consultation.cancelled         the other participant, when a participant cancels;
--   consultation_outcome_recorded  consultation.outcome_recorded  both participants, when staff record an outcome
--                                                                 (no_show, technical_failure, manual_resolution);
--                                                                 the client alone, when the attorney declares an
--                                                                 early completion by agreement;
--   review_available               consultation.completed         the client, when the Consultation becomes completed
--                                                                 (any completion reason);
--   complaint_received             complaint_case.opened          the complainant (emitted by complaint_open,
--                                                                 20261127060000).
-- Each creates one in-app and one email Notification per recipient through notification_emit (S10, unchanged): the
-- same outbox, delivery job, attempts, observations, center and exception-guarded creation, so a notification problem
-- never fails or changes the business event. The email is the S10 fixed minimal template of its type (the application
-- adapter): no name, no matter detail, no outcome; only a link to the notification center.
--
-- The three Consultation events are emitted by one trigger on consultations, whichever path changes the state, from
-- the committed facts of the row alone (the terminal state and its outcome code); nothing is emitted for a terminal
-- row without an outcome code. Changes on the existing objects, each replaced forward with an equal-or-wider
-- definition:
-- - notifications_type_v1_check -> notifications_type_v2_check: the seven S10 pairs, unchanged, plus the four above;
-- - notification_types and notification_type_list_valid: the list of types a notification policy may name as critical
--   or acknowledgement-required now has eleven entries;
-- - notification_consultation_of, notification_recipient_role and notification_link_path: the three Consultation
--   events link to the recipient's own Consultation page; complaint_received links to the recipient's own complaints
--   page, the recipient's role being the complainant's role in the case.

-- ---------------------------------------------------------------------------
-- The vocabulary.
-- ---------------------------------------------------------------------------

alter table public.notifications
  drop constraint notifications_type_v1_check,
  add constraint notifications_type_v2_check
    check (
      source_event_id is not null
      and (
        (notification_type = 'request_awaiting_decision' and source_event_type = 'consultation_request.awaiting_attorney')
        or (notification_type = 'request_accepted' and source_event_type = 'consultation_request.accepted')
        or (notification_type = 'request_declined' and source_event_type = 'consultation_request.declined')
        or (notification_type = 'request_expired' and source_event_type = 'consultation_request.expired')
        or (notification_type = 'consultation_ready' and source_event_type = 'consultation.ready')
        or (notification_type = 'message_received' and source_event_type = 'message.sent')
        or (notification_type = 'document_shared' and source_event_type = 'resource_sharing_grant.created')
        or (notification_type = 'consultation_cancelled' and source_event_type = 'consultation.cancelled')
        or (notification_type = 'consultation_outcome_recorded' and source_event_type = 'consultation.outcome_recorded')
        or (notification_type = 'review_available' and source_event_type = 'consultation.completed')
        or (notification_type = 'complaint_received' and source_event_type = 'complaint_case.opened')
      )
    );

-- The notification types (the notifications_type_v2_check vocabulary).
create or replace function public.notification_types()
returns text[]
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select array[
    'request_awaiting_decision', 'request_accepted', 'request_declined', 'request_expired',
    'consultation_ready', 'message_received', 'document_shared',
    'consultation_cancelled', 'consultation_outcome_recorded', 'review_available', 'complaint_received'
  ]::text[];
$function$;

-- Whether a value is an array of distinct notification types.
create or replace function public.notification_type_list_valid(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'array'
    and jsonb_array_length(p_value) <= cardinality(public.notification_types())
    and not exists (
      select 1 from jsonb_array_elements(p_value) as e
      where jsonb_typeof(e) is distinct from 'string'
        or not ((e #>> '{}') = any (public.notification_types()))
    )
    and (select count(distinct e #>> '{}') from jsonb_array_elements(p_value) as e) = jsonb_array_length(p_value),
    false);
$function$;

-- ---------------------------------------------------------------------------
-- Derived facts of one Notification (internal).
-- ---------------------------------------------------------------------------

-- The Consultation a Notification concerns, or null (Request and complaint notifications).
create or replace function public.notification_consultation_of(p_notification public.notifications)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_notification.notification_type in (
      'consultation_ready', 'consultation_cancelled', 'consultation_outcome_recorded', 'review_available'
    ) then p_notification.source_event_id
    when p_notification.notification_type = 'message_received' then
      (select m.consultation_id from public.messages as m where m.id = p_notification.source_event_id)
    when p_notification.notification_type = 'document_shared' then
      (select g.context_id from public.resource_sharing_grants as g
       where g.id = p_notification.source_event_id and g.context_type = 'consultation')
  end;
$function$;

-- The recipient's role in the event: client or attorney, or null when it no longer adds up.
create or replace function public.notification_recipient_role(p_notification public.notifications)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_consultation uuid;
  v_client uuid;
  v_attorney uuid;
  v_role text;
begin
  if p_notification.notification_type = 'request_awaiting_decision' then
    return 'attorney';
  end if;
  if p_notification.notification_type in ('request_accepted', 'request_declined', 'request_expired') then
    return 'client';
  end if;
  if p_notification.notification_type = 'complaint_received' then
    -- The complainant's role in the case; only the complainant receives it.
    select public.complaint_complainant_role(k.complainant_user_id, k.consultation_id, k.referral_id) into v_role
    from public.complaint_cases as k
    where k.id = p_notification.source_event_id
      and k.complainant_user_id = p_notification.recipient_user_id;
    return v_role;
  end if;
  v_consultation := public.notification_consultation_of(p_notification);
  select cp.user_id, ap.user_id into v_client, v_attorney
  from public.consultations as c
  join public.client_profiles as cp on cp.id = c.client_id
  join public.attorney_profiles as ap on ap.id = c.attorney_id
  where c.id = v_consultation;
  if p_notification.recipient_user_id = v_client then
    return 'client';
  elsif p_notification.recipient_user_id = v_attorney then
    return 'attorney';
  end if;
  return null;
end;
$function$;

-- The in-app link of a Notification: the recipient's own Request or Consultation page or complaints page, or null.
create or replace function public.notification_link_path(p_notification public.notifications)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_role text;
  v_consultation uuid;
begin
  v_role := public.notification_recipient_role(p_notification);
  if v_role is null then
    return null;
  end if;
  if p_notification.notification_type in (
    'request_awaiting_decision', 'request_accepted', 'request_declined', 'request_expired'
  ) then
    return '/' || v_role || '/requests/' || p_notification.source_event_id::text;
  end if;
  if p_notification.notification_type = 'complaint_received' then
    return '/' || v_role || '/complaints';
  end if;
  v_consultation := public.notification_consultation_of(p_notification);
  if v_consultation is null then
    return null;
  end if;
  return '/' || v_role || '/consultations/' || v_consultation::text;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The outbox trigger of the Consultation outcomes.
-- ---------------------------------------------------------------------------

create function public.notification_consultation_outcome_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_client uuid;
  v_attorney uuid;
begin
  if new.state is not distinct from old.state or new.outcome_code is null then
    return null;
  end if;
  select cp.user_id into v_client from public.client_profiles as cp where cp.id = new.client_id;
  select ap.user_id into v_attorney from public.attorney_profiles as ap where ap.id = new.attorney_id;
  if new.state = 'cancelled' then
    -- The other participant.
    if new.outcome_code = 'client_cancelled' then
      perform public.notification_emit(v_attorney, 'consultation_cancelled', 'consultation.cancelled', new.id);
    elsif new.outcome_code = 'attorney_cancelled' then
      perform public.notification_emit(v_client, 'consultation_cancelled', 'consultation.cancelled', new.id);
    end if;
  elsif new.state in ('no_show', 'technical_failure')
        or (new.state = 'completed' and new.outcome_code = 'manual_resolution') then
    -- An outcome staff recorded: both participants.
    perform public.notification_emit(
      v_client, 'consultation_outcome_recorded', 'consultation.outcome_recorded', new.id
    );
    perform public.notification_emit(
      v_attorney, 'consultation_outcome_recorded', 'consultation.outcome_recorded', new.id
    );
  elsif new.state = 'completed' and new.outcome_code = 'early_by_agreement' then
    -- The attorney's declaration: the client is told the recorded outcome.
    perform public.notification_emit(
      v_client, 'consultation_outcome_recorded', 'consultation.outcome_recorded', new.id
    );
  end if;
  if new.state = 'completed' then
    perform public.notification_emit(v_client, 'review_available', 'consultation.completed', new.id);
  end if;
  return null;
end;
$function$;

create trigger consultations_outcome_notification_events
after update of state on public.consultations
for each row
when (new.state in ('completed', 'cancelled', 'no_show', 'technical_failure'))
execute function public.notification_consultation_outcome_events();

-- ---------------------------------------------------------------------------
-- Function privileges (the replaced functions keep theirs; restated).
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.notification_types()',
    'public.notification_type_list_valid(jsonb)',
    'public.notification_consultation_of(public.notifications)',
    'public.notification_recipient_role(public.notifications)',
    'public.notification_link_path(public.notifications)',
    'public.notification_consultation_outcome_events()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end;
$privileges$;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.notification_types() is
  'MVP-001 S10 (internal; MVP-001 S11: eleven types): the notification type vocabulary: the seven S10 types and consultation_cancelled, consultation_outcome_recorded, review_available and complaint_received.';
comment on function public.notification_type_list_valid(jsonb) is
  'MVP-001 S10 (internal; MVP-001 S11): whether a value is an array of distinct notification types.';
comment on function public.notification_consultation_of(public.notifications) is
  'MVP-001 S10 (internal; MVP-001 S11: the Consultation outcome events): the Consultation a Notification concerns, or null.';
comment on function public.notification_recipient_role(public.notifications) is
  'MVP-001 S10 (internal; MVP-001 S11: complaint_received is the complainant''s role in the case): the recipient''s role in the event (client or attorney), or null when it no longer adds up.';
comment on function public.notification_link_path(public.notifications) is
  'MVP-001 S10 (internal; MVP-001 S11: complaint_received links to the recipient''s complaints page): the recipient''s own Request, Consultation or complaints page, or null.';
comment on function public.notification_consultation_outcome_events() is
  'MVP-001 S11 (trigger): a Consultation reaching a terminal state emits consultation_cancelled to the other participant, consultation_outcome_recorded to both (staff-recorded outcomes) or to the client (early completion by agreement), and review_available to the client when completed; through the exception-guarded S10 outbox.';
