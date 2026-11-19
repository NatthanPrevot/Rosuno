-- MVP-001 S10 (2 of 4): the provider-neutral Notification lifecycle, the outbox from canonical business events, durable
-- email delivery through the S2 job protocol, provider observations and the notification center (MVP-001 Packet S10
-- "notification lifecycle, Resend adapter, durable delivery attempts, retries, observations and a notification center";
-- MBS section 15 deliverable 12C and its failure tests; IMP section 26; TA sections 23, 27 and 47; PS sections 20 and 24;
-- ROS section 15; MB sections 97 to 99).
--
-- No relation, column or policy type is added (Packet rules 8 and 16). Business Event -> Notification -> Operational
-- Job -> Provider Adapter -> Provider Observation (ROS section 15): the Notification owns the communication lifecycle,
-- the Operational Job owns execution and retry, and neither duplicates the other's state. Nothing here knows a
-- provider: the adapter names its own provider code, provider references are stored only on attempts and receipts,
-- and provider events arrive already mapped into Rosuno's observation vocabulary.
--
-- The outbox (TA section 27; MB section 97: pages never call a provider). A canonical business event creates, in its
-- own transaction, one in-app and one email Notification per recipient (notification_emit, internal), and the email
-- Notification enqueues exactly one notification.deliver job (S2 job_enqueue; 8 attempts, a fixed technical bound:
-- with the S2 backoff of 30 seconds doubling per attempt, capped at one hour, the eighth attempt comes no earlier than
-- about 63.5 minutes after the first, so a provider outage of about an hour does not permanently fail the emails
-- created during it; it is not a policy value). No provider is called inside a business transaction, and creation is
-- exception-guarded: a Notification that cannot be created never fails the business event. The failure (including a
-- transient one such as a deadlock, serialization failure or lock timeout) rolls back that whole emission, both
-- channels, and is audited as notification.not_created with what operations need to emit it again: the recipient
-- User id, the notification type, the channel whose step failed, the source event type and id, and the SQLSTATE
-- (identifiers and codes only, never content). The S10 event list (MB section 98 events whose source exists by S10;
-- staff notifications are not part of S10):
--   request_awaiting_decision -> the attorney, when a Consultation Request enters awaiting_attorney (S6/S7);
--   request_accepted, request_declined, request_expired -> the client, when the Request becomes accepted, declined
--     (S8) or expired (S6);
--   consultation_ready -> the client and the attorney, when the Consultation becomes ready (S8 instant, S9 scheduled);
--   message_received -> the Message's recipient (20261126030000);
--   document_shared -> the grant's recipient, when a document is shared (20261126040000).
-- Triggers on consultation_requests and consultations emit the request and readiness events whichever S6 to S9 path
-- changes the state.
--
-- Configuration (Packet rule 6; no new policy type, rule 8): two optional keys of the existing notification policy
-- type, global scope (no jurisdiction, no Regulatory Mode), selected by the environment-anchored resolver (PS-A2: a
-- development-only version is never selectable in a production-class database):
--   critical_notification_types: an array of distinct S10 notification types whose Notifications are critical;
--   acknowledgement_required_types: an array of distinct S10 notification types whose in-app Notifications need the
--     recipient's acknowledgement.
-- Absent, unselectable (none, a conflict, an unrecorded environment) or malformed configuration means no type is
-- critical and none needs acknowledgement; delivery state stays observable either way. The flags are fixed on each
-- Notification when it is created. Approval validation (policy_parameters_approvable, replaced forward) refuses a
-- notification version carrying a malformed key; the other policy types are unchanged.
--
-- Email delivery (the worker; service_role only). notification_job_context answers what a running notification.deliver
-- job is to do: act (an email Notification still pending or retrying, with its type, the recipient's notification
-- center path and the recipient's email address read at send time from the identity provider's auth.users through
-- this security definer function: never stored in a Rosuno table, logged or audited), nothing_to_do (the Notification
-- is no longer deliverable), no_recipient (no active User, no address, or an address outside the one fixed address
-- rule shared with the application and the email adapter: an RFC 5322 dot-atom-style local part of atext characters
-- and dots, apostrophe included, and a host name of letters, digits and inner hyphens, within 3 to 320 characters) or
-- not_running.
-- notification_record_attempt appends one attempt row per Rosuno delivery attempt, which may stop before any provider
-- call (provider code, provider reference, a provider-neutral result, failure code), and moves the Notification:
-- accepted -> sent; failed_transient -> retrying (the job is reported failed and the S2 protocol retries it with
-- backoff), or permanently_failed on the job's last attempt; failed_permanent -> permanently_failed; not_sent (nothing
-- reached a provider) -> retrying for provider_unconfigured (configuration may still arrive; permanently_failed on the
-- last attempt), else permanently_failed (recipient_unavailable, recipient_address_unsupported, invalid_request). A job
-- that escalates for any other reason (its lease expired on the last attempt, or its answer was never recorded), or
-- that staff cancel (S2 staff_cancel_job; failure code delivery_cancelled), moves a still pending or retrying
-- Notification to permanently_failed (trigger on operational_jobs). Permanent failure is always observable (state,
-- failed_at, one system audit event with its fixed failure code) and, for a critical Notification, opens one high
-- notification_delivery_failed Reconciliation Exception (decision_open_review, S8) for staff (MB section 99 escalation).
-- The business event that caused a Notification is never read or changed by any of this.
--
-- Provider observations (the webhook; service_role only; the route verified the provider signature first):
-- notification_record_provider_event records the receipt first, unique per (provider, event reference) in
-- external_event_receipts (a replay or concurrent duplicate is a no-op answered duplicate), with only the validated
-- minimized observation (kind and provider reference; never an address, subject or body) and the payload digest; the
-- provider reference is matched to its Notification through its accepted attempt, and the observation applied in the
-- same transaction, monotonically: delivered (sent -> delivered), bounced or suppressed (sent -> permanently_failed),
-- failed (sent -> failed), accepted, delivery_delayed and complained (no change), ignored; a duplicate observation of
-- the current state is no_effect, one that would regress a terminal state is stale, and a reference no accepted attempt
-- carries yet is unmatched. An event can arrive before its accepted attempt is recorded (the recording failed
-- transiently and the job is backing off); its receipt keeps its unmatched outcome (receipts record their outcome
-- once), and when the first accepted attempt with that provider reference is recorded, the reference's earlier
-- unmatched receipts are re-applied in provider event time order through the same monotonic path (each re-application
-- audited as notification.observation_replayed; a duplicate stays no_effect). The attempt recording and the event
-- recording of one provider reference serialize on one transaction-scoped advisory lock taken before the Notification
-- row, so neither can miss the other. Every authenticated event is therefore recorded once and never repeats or
-- regresses canonical state (MBS section 15 failure test). Not covered: an email the provider accepted whose accepted
-- attempt is never recorded (every recording of the job's final attempt failed, or the job was cancelled while
-- running); its Notification ends permanently_failed and its events stay unmatched.
--
-- The notification center (EXECUTE for authenticated only): notification_center answers the caller's own in-app
-- Notifications (newest first, at most 100) with each one's link path and the delivery state of its email twin;
-- notification_acknowledge acknowledges one that requires it (audited). A caller holding an Attorney or Staff Profile
-- must be at aal2 (their workspaces' step-up rule); a client any aal. Another user's, an unknown and a malformed id
-- answer alike. The P1 recipient-only read policy on notifications is unchanged.

-- ---------------------------------------------------------------------------
-- Configuration: the two optional notification keys and their approval validation.
-- ---------------------------------------------------------------------------

-- The S10 notification types (the notifications_type_v1_check vocabulary).
create function public.notification_types()
returns text[]
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select array[
    'request_awaiting_decision', 'request_accepted', 'request_declined', 'request_expired',
    'consultation_ready', 'message_received', 'document_shared'
  ]::text[];
$function$;

-- Whether a value is an array of distinct S10 notification types.
create function public.notification_type_list_valid(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_value) = 'array'
    and jsonb_array_length(p_value) <= 7
    and not exists (
      select 1 from jsonb_array_elements(p_value) as e
      where jsonb_typeof(e) is distinct from 'string'
        or not ((e #>> '{}') = any (public.notification_types()))
    )
    and (select count(distinct e #>> '{}') from jsonb_array_elements(p_value) as e) = jsonb_array_length(p_value),
    false);
$function$;

-- Whether notification parameters carry only well-formed S10 keys (both optional; other keys are left alone).
create function public.notification_parameters_valid(p_parameters jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_parameters) = 'object'
    and (
      not (p_parameters ? 'critical_notification_types')
      or public.notification_type_list_valid(p_parameters -> 'critical_notification_types')
    )
    and (
      not (p_parameters ? 'acknowledgement_required_types')
      or public.notification_type_list_valid(p_parameters -> 'acknowledgement_required_types')
    ),
    false);
$function$;

-- The configured critical and acknowledgement-required types at an instant (see the header); empty arrays when
-- nothing applicable and well-formed is selected.
create function public.notification_configured_types(p_as_of timestamptz)
returns table (critical_types text[], acknowledgement_types text[], policy_version_id uuid)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_outcome text;
  v_id uuid;
  v_raw jsonb;
begin
  select s.outcome, s.policy_version_id into v_outcome, v_id
  from public.policy_select_version('notification', null, null, p_as_of) as s;
  if v_outcome is distinct from 'selected' or v_id is null then
    return query select '{}'::text[], '{}'::text[], null::uuid;
    return;
  end if;
  select v.parameters into v_raw from public.policy_versions as v where v.id = v_id;
  if not public.notification_parameters_valid(v_raw) then
    return query select '{}'::text[], '{}'::text[], v_id;
    return;
  end if;
  return query select
    coalesce(
      (select array_agg(e order by e) from jsonb_array_elements_text(v_raw -> 'critical_notification_types') as e),
      '{}'::text[]),
    coalesce(
      (select array_agg(e order by e) from jsonb_array_elements_text(v_raw -> 'acknowledgement_required_types') as e),
      '{}'::text[]),
    v_id;
end;
$function$;

-- Approval validation (PS section 8.4): the S9 function with the notification keys added (unchanged otherwise).
create or replace function public.policy_parameters_approvable(
  p_policy_type_code text,
  p_jurisdiction_id uuid,
  p_parameters jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_policy_type_code
    when 'fee' then
      case
        when p_jurisdiction_id is null then public.pricing_platform_parameters_valid(p_parameters)
        else public.pricing_fee_parameters_valid(p_parameters)
      end
    when 'referral' then
      coalesce(
        jsonb_typeof(p_parameters) = 'object'
        and (
          not (p_parameters ? 'request_message_maximum_characters')
          or public.pricing_integer_within(p_parameters -> 'request_message_maximum_characters', 1, 20000)
        ),
        false)
    when 'payment_flow' then public.payment_flow_parameters_valid(p_parameters)
    when 'engagement' then public.engagement_parameters_valid(p_parameters)
    when 'scheduling' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or (
          (
            not (p_parameters ? 'consultation_join_window_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_join_window_seconds', 0, 86400)
          )
          and (
            not (p_parameters ? 'consultation_overrun_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_overrun_seconds', 0, 86400)
          )
        ),
        false)
    when 'notification' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or public.notification_parameters_valid(p_parameters),
        false)
    else true
  end;
$function$;

-- ---------------------------------------------------------------------------
-- The outbox.
-- ---------------------------------------------------------------------------

-- One in-app and one email Notification for a recipient and a business event, the email one with its delivery job
-- (8 attempts; see the header), created in the caller's transaction at the instant of the emission (so the events of
-- one transaction keep their order). Exception-guarded: a failure rolls back the whole emission, is audited with the
-- identifiers needed to emit it again (recipient, type, the failing channel, source event, SQLSTATE) and never fails
-- the business event.
create function public.notification_emit(
  p_recipient uuid,
  p_type text,
  p_source_event_type text,
  p_source_event_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_types record;
  v_now timestamptz;
  v_email uuid;
  v_channel text := 'in_app';
begin
  begin
    if p_recipient is null or p_source_event_id is null then
      raise exception 'a Notification needs a recipient and a source event'
        using errcode = '22023';
    end if;
    v_now := clock_timestamp();
    select t.* into v_types from public.notification_configured_types(v_now) as t;
    insert into public.notifications (
      recipient_user_id, notification_type, source_event_type, source_event_id, channel, state, critical,
      ack_required, sent_at, delivered_at, failed_at, created_at
    ) values (
      p_recipient, p_type, p_source_event_type, p_source_event_id, 'in_app', 'delivered',
      p_type = any (v_types.critical_types), p_type = any (v_types.acknowledgement_types), v_now, v_now, null, v_now
    )
    on conflict (recipient_user_id, channel, notification_type, source_event_type, source_event_id) do nothing;
    v_channel := 'email';
    insert into public.notifications (
      recipient_user_id, notification_type, source_event_type, source_event_id, channel, state, critical,
      ack_required, sent_at, delivered_at, failed_at, created_at
    ) values (
      p_recipient, p_type, p_source_event_type, p_source_event_id, 'email', 'pending',
      p_type = any (v_types.critical_types), false, null, null, null, v_now
    )
    on conflict (recipient_user_id, channel, notification_type, source_event_type, source_event_id) do nothing
    returning id into v_email;
    if v_email is not null then
      perform public.job_enqueue('notification.deliver', 'notification', v_email, v_now, 8);
    end if;
  exception
    when others then
      insert into public.audit_events (
        actor_user_id, actor_type, action_code, resource_type, resource_id,
        before_snapshot, after_snapshot, reason_code, policy_references,
        jurisdiction_id, occurred_at
      ) values (
        null, 'system', 'notification.not_created', 'notification', null,
        null,
        jsonb_build_object(
          'recipient_user_id', p_recipient,
          'notification_type', p_type,
          'channel', v_channel,
          'source_event_type', p_source_event_type,
          'source_event_id', p_source_event_id,
          'sqlstate', sqlstate
        ),
        'notification_not_created', null, null, clock_timestamp()
      );
  end;
end;
$function$;

-- Consultation Request events (trigger): awaiting_attorney -> the attorney; accepted, declined, expired -> the client.
create function public.notification_request_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_recipient uuid;
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    return null;
  end if;
  if new.state = 'awaiting_attorney' then
    select ap.user_id into v_recipient from public.attorney_profiles as ap where ap.id = new.selected_attorney_id;
    perform public.notification_emit(
      v_recipient, 'request_awaiting_decision', 'consultation_request.awaiting_attorney', new.id
    );
  elsif new.state in ('accepted', 'declined', 'expired') then
    select cp.user_id into v_recipient from public.client_profiles as cp where cp.id = new.client_id;
    perform public.notification_emit(
      v_recipient, 'request_' || new.state, 'consultation_request.' || new.state, new.id
    );
  end if;
  return null;
end;
$function$;

create trigger consultation_requests_notification_events
after insert or update of state on public.consultation_requests
for each row
when (new.state in ('awaiting_attorney', 'accepted', 'declined', 'expired'))
execute function public.notification_request_events();

-- Consultation readiness (trigger): ready -> the client and the attorney.
create function public.notification_consultation_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_client uuid;
  v_attorney uuid;
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    return null;
  end if;
  select cp.user_id into v_client from public.client_profiles as cp where cp.id = new.client_id;
  select ap.user_id into v_attorney from public.attorney_profiles as ap where ap.id = new.attorney_id;
  perform public.notification_emit(v_client, 'consultation_ready', 'consultation.ready', new.id);
  perform public.notification_emit(v_attorney, 'consultation_ready', 'consultation.ready', new.id);
  return null;
end;
$function$;

create trigger consultations_notification_events
after insert or update of state on public.consultations
for each row
when (new.state = 'ready')
execute function public.notification_consultation_events();

-- ---------------------------------------------------------------------------
-- Derived facts of one Notification (internal).
-- ---------------------------------------------------------------------------

-- The Consultation a Notification concerns, or null (Request notifications).
create function public.notification_consultation_of(p_notification public.notifications)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_notification.notification_type
    when 'consultation_ready' then p_notification.source_event_id
    when 'message_received' then
      (select m.consultation_id from public.messages as m where m.id = p_notification.source_event_id)
    when 'document_shared' then
      (select g.context_id from public.resource_sharing_grants as g
       where g.id = p_notification.source_event_id and g.context_type = 'consultation')
  end;
$function$;

-- The recipient's role in the event: client or attorney, or null when it no longer adds up.
create function public.notification_recipient_role(p_notification public.notifications)
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
begin
  if p_notification.notification_type = 'request_awaiting_decision' then
    return 'attorney';
  end if;
  if p_notification.notification_type in ('request_accepted', 'request_declined', 'request_expired') then
    return 'client';
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

-- The in-app link of a Notification: the recipient's own Request or Consultation page, or null.
create function public.notification_link_path(p_notification public.notifications)
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
  v_consultation := public.notification_consultation_of(p_notification);
  if v_consultation is null then
    return null;
  end if;
  return '/' || v_role || '/consultations/' || v_consultation::text;
end;
$function$;

-- One system audit event about one Notification (identifiers, states, types and codes only).
create function public.notification_audit(
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_notification uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text
)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    p_actor, p_actor_type, p_action, 'notification', p_notification,
    p_before, p_after, p_reason, null, null, clock_timestamp()
  );
$function$;

-- A locked email Notification that is pending, retrying or sent becomes permanently_failed: observable, audited and,
-- when critical, escalated.
create function public.notification_fail_permanently(
  p_notification public.notifications,
  p_failure_code text,
  p_reason text
)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  update public.notifications as n
  set state = 'permanently_failed',
      failed_at = clock_timestamp()
  where n.id = p_notification.id;
  perform public.notification_audit(
    null, 'system', 'notification.permanently_failed', p_notification.id,
    jsonb_build_object('state', p_notification.state),
    jsonb_build_object(
      'state', 'permanently_failed',
      'channel', p_notification.channel,
      'notification_type', p_notification.notification_type,
      'critical', p_notification.critical,
      'failure_code', p_failure_code
    ),
    p_reason
  );
  if p_notification.critical then
    perform public.decision_open_review(
      'notification_delivery_failed', 'notification', p_notification.id, 'high', null,
      jsonb_build_object(
        'notification_type', p_notification.notification_type,
        'channel', p_notification.channel,
        'failure_code', p_failure_code
      )
    );
  end if;
end;
$function$;

-- A notification.deliver job that ends without a recorded result (trigger on operational_jobs): escalated (failure
-- code: the job's last error code, else attempts_exhausted) or cancelled by staff or its subject's end (S2
-- staff_cancel_job, job_cancel_for_subject; failure code delivery_cancelled). Its still pending or retrying Notification
-- is permanently failed the same way as every other terminal failure (state, failed_at, audit with the fixed code, and
-- the exception when critical); a Notification already sent or terminal is left as it is.
create function public.notification_job_escalated()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_notification public.notifications;
begin
  select n.* into v_notification
  from public.notifications as n
  where n.id = new.subject_id
  for update;
  if found and v_notification.channel = 'email' and v_notification.state in ('pending', 'retrying') then
    if new.state = 'cancelled' then
      perform public.notification_fail_permanently(v_notification, 'delivery_cancelled', 'delivery_job_cancelled');
    else
      perform public.notification_fail_permanently(
        v_notification, coalesce(new.last_error_code, 'attempts_exhausted'), 'delivery_job_escalated'
      );
    end if;
  end if;
  return null;
end;
$function$;

create trigger operational_jobs_notification_escalation
after update of state on public.operational_jobs
for each row
when (
  new.state in ('escalated', 'cancelled') and old.state is distinct from new.state
  and new.job_type = 'notification.deliver' and new.subject_type = 'notification'
)
execute function public.notification_job_escalated();

-- ---------------------------------------------------------------------------
-- The worker (service_role only).
-- ---------------------------------------------------------------------------

create function public.notification_job_context(p_job_id uuid)
returns table (
  outcome text,
  notification_id uuid,
  notification_type text,
  center_path text,
  recipient_address text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_job public.operational_jobs;
  v_notification public.notifications;
  v_role text;
  v_address text;
begin
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
    and j.state = 'running'
    and j.job_type = 'notification.deliver'
    and j.subject_type = 'notification';
  if not found then
    return query select 'not_running'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;
  select n.* into v_notification from public.notifications as n where n.id = v_job.subject_id;
  if not found or v_notification.channel is distinct from 'email' then
    return query select 'not_running'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;
  if v_notification.state not in ('pending', 'retrying') then
    return query select 'nothing_to_do'::text, v_notification.id, v_notification.notification_type, null::text,
      null::text;
    return;
  end if;
  v_role := public.notification_recipient_role(v_notification);
  select a.email into v_address
  from public.users as u
  join auth.users as a on a.id = u.auth_user_id
  where u.id = v_notification.recipient_user_id
    and u.account_state = 'active';
  -- The one fixed address rule (shared with the application's isEmailAddress and the email adapter): atext and dots
  -- (apostrophe included) in the local part, letters, digits and inner hyphens in each host label.
  if v_role is null
     or v_address is null
     or char_length(v_address) not between 3 and 320
     or v_address collate "C" !~ (
       '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}'
       || '@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
     ) then
    return query select 'no_recipient'::text, v_notification.id, v_notification.notification_type, null::text,
      null::text;
    return;
  end if;
  return query select 'act'::text, v_notification.id, v_notification.notification_type,
    '/' || v_role || '/notifications', v_address;
end;
$function$;

-- Records one Rosuno delivery attempt of a running notification.deliver job, which may have stopped before any
-- provider call (not_sent; see the header). Answers sent, retrying, permanently_failed, no_effect (the Notification was
-- no longer pending or retrying; the attempt is kept as evidence), invalid or not_running. The first accepted attempt
-- of a provider reference re-applies that reference's earlier unmatched provider events (the answer stays the
-- attempt's own: sent or no_effect). Lock order: the provider reference's advisory lock (accepted only), then the
-- Notification row.
create function public.notification_record_attempt(
  p_job_id uuid,
  p_provider_code text,
  p_result text,
  p_provider_reference text,
  p_failure_code text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_job public.operational_jobs;
  v_notification public.notifications;
  v_first boolean := false;
begin
  if p_job_id is null
     or p_provider_code is null or p_provider_code collate "C" !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_result is null or p_result not in ('accepted', 'failed_transient', 'failed_permanent', 'not_sent')
     or (p_result = 'accepted' and (
       p_provider_reference is null
       or p_provider_reference collate "C" !~ '^[A-Za-z0-9._:-]{1,255}$'
       or p_failure_code is not null
     ))
     or (p_result <> 'accepted' and (
       p_provider_reference is not null
       or p_failure_code is null
       or p_failure_code collate "C" !~ '^[a-z][a-z0-9_]{1,63}$'
     ))
     or (p_result = 'not_sent' and p_failure_code not in (
       'provider_unconfigured', 'recipient_unavailable', 'recipient_address_unsupported', 'invalid_request'
     )) then
    return 'invalid';
  end if;
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
    and j.state = 'running'
    and j.job_type = 'notification.deliver'
    and j.subject_type = 'notification';
  if not found then
    return 'not_running';
  end if;
  if p_result = 'accepted' then
    -- Serializes with notification_record_provider_event for the same reference (see the header).
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('notification-reference|' || p_provider_code || '|' || p_provider_reference), 7310
    );
    v_first := not exists (
      select 1 from public.notification_attempts as a
      where a.provider_code = p_provider_code
        and a.provider_reference = p_provider_reference
        and a.result = 'accepted'
    );
  end if;
  select n.* into v_notification
  from public.notifications as n
  where n.id = v_job.subject_id
  for update;
  if not found or v_notification.channel is distinct from 'email' then
    return 'not_running';
  end if;
  -- A provider reference names one Notification only.
  if p_result = 'accepted' and exists (
    select 1 from public.notification_attempts as a
    where a.provider_code = p_provider_code
      and a.provider_reference = p_provider_reference
      and a.notification_id <> v_notification.id
  ) then
    return 'invalid';
  end if;
  insert into public.notification_attempts (
    notification_id, provider_code, provider_reference, attempted_at, result, failure_code
  ) values (
    v_notification.id, p_provider_code, p_provider_reference, clock_timestamp(), p_result, p_failure_code
  );
  if v_notification.state not in ('pending', 'retrying') then
    if v_first then
      perform public.notification_replay_unmatched_events(v_notification.id, p_provider_code, p_provider_reference);
    end if;
    return 'no_effect';
  end if;
  if p_result = 'accepted' then
    update public.notifications as n
    set state = 'sent',
        sent_at = clock_timestamp()
    where n.id = v_notification.id;
    perform public.notification_audit(
      null, 'system', 'notification.sent', v_notification.id,
      jsonb_build_object('state', v_notification.state),
      jsonb_build_object(
        'state', 'sent',
        'channel', 'email',
        'notification_type', v_notification.notification_type,
        'provider_code', p_provider_code,
        'attempt', v_job.attempt_count
      ),
      'provider_accepted'
    );
    if v_first then
      perform public.notification_replay_unmatched_events(v_notification.id, p_provider_code, p_provider_reference);
    end if;
    return 'sent';
  end if;
  if p_result = 'failed_permanent' then
    perform public.notification_fail_permanently(v_notification, p_failure_code, 'delivery_refused');
    return 'permanently_failed';
  end if;
  -- not_sent: nothing reached a provider; only a missing configuration may still change (retried like a transient
  -- failure), every other reason is final.
  if p_result = 'not_sent' and p_failure_code <> 'provider_unconfigured' then
    perform public.notification_fail_permanently(v_notification, p_failure_code, 'delivery_not_sendable');
    return 'permanently_failed';
  end if;
  if v_job.attempt_count >= v_job.max_attempts then
    perform public.notification_fail_permanently(v_notification, p_failure_code, 'attempts_exhausted');
    return 'permanently_failed';
  end if;
  if v_notification.state = 'pending' then
    update public.notifications as n set state = 'retrying' where n.id = v_notification.id;
    perform public.notification_audit(
      null, 'system', 'notification.retrying', v_notification.id,
      jsonb_build_object('state', 'pending'),
      jsonb_build_object(
        'state', 'retrying',
        'channel', 'email',
        'notification_type', v_notification.notification_type,
        'provider_code', p_provider_code,
        'result', p_result,
        'failure_code', p_failure_code,
        'attempt', v_job.attempt_count
      ),
      'delivery_failed_transient'
    );
  end if;
  return 'retrying';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Provider observations (service_role only).
-- ---------------------------------------------------------------------------

-- Whether an observation has exactly the allowed shape: {kind, provider_reference}; ignored carries a null reference.
create function public.notification_observation_valid(p_observation jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_observation) = 'object'
    and (select count(*) from jsonb_object_keys(p_observation)) = 2
    and p_observation ?& array['kind', 'provider_reference']
    and jsonb_typeof(p_observation -> 'kind') = 'string'
    and (
      (
        (p_observation ->> 'kind') = 'ignored'
        and jsonb_typeof(p_observation -> 'provider_reference') = 'null'
      )
      or (
        (p_observation ->> 'kind') in (
          'accepted', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'suppressed', 'failed'
        )
        and jsonb_typeof(p_observation -> 'provider_reference') = 'string'
        and (p_observation ->> 'provider_reference') collate "C" ~ '^[A-Za-z0-9._:-]{1,255}$'
      )
    ),
    false);
$function$;

-- Applies one observation to its locked email Notification (see the header): applied, no_effect or stale.
create function public.notification_apply_observation(p_notification public.notifications, p_kind text)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if p_kind in ('accepted', 'delivery_delayed', 'complained') then
    return case
      when p_notification.state in ('sent', 'delivered') or p_kind = 'complained' then 'no_effect'
      else 'stale'
    end;
  end if;
  if p_kind = 'delivered' then
    if p_notification.state = 'delivered' then
      return 'no_effect';
    end if;
    if p_notification.state <> 'sent' then
      return 'stale';
    end if;
    update public.notifications as n
    set state = 'delivered',
        delivered_at = clock_timestamp()
    where n.id = p_notification.id;
    perform public.notification_audit(
      null, 'system', 'notification.delivered', p_notification.id,
      jsonb_build_object('state', 'sent'),
      jsonb_build_object(
        'state', 'delivered', 'channel', 'email', 'notification_type', p_notification.notification_type
      ),
      'provider_observation'
    );
    return 'applied';
  end if;
  if p_kind in ('bounced', 'suppressed') then
    if p_notification.state = 'permanently_failed' then
      return 'no_effect';
    end if;
    if p_notification.state <> 'sent' then
      return 'stale';
    end if;
    perform public.notification_fail_permanently(p_notification, p_kind, 'provider_observation');
    return 'applied';
  end if;
  if p_kind = 'failed' then
    if p_notification.state = 'failed' then
      return 'no_effect';
    end if;
    if p_notification.state <> 'sent' then
      return 'stale';
    end if;
    update public.notifications as n
    set state = 'failed',
        failed_at = clock_timestamp()
    where n.id = p_notification.id;
    perform public.notification_audit(
      null, 'system', 'notification.failed', p_notification.id,
      jsonb_build_object('state', 'sent'),
      jsonb_build_object(
        'state', 'failed',
        'channel', 'email',
        'notification_type', p_notification.notification_type,
        'critical', p_notification.critical,
        'failure_code', 'failed'
      ),
      'provider_observation'
    );
    if p_notification.critical then
      perform public.decision_open_review(
        'notification_delivery_failed', 'notification', p_notification.id, 'high', null,
        jsonb_build_object(
          'notification_type', p_notification.notification_type,
          'channel', 'email',
          'failure_code', 'failed'
        )
      );
    end if;
    return 'applied';
  end if;
  return 'no_effect';
end;
$function$;

-- Re-applies, in provider event time order, the unmatched provider events recorded for one provider reference before
-- its first accepted attempt, to that attempt's locked Notification, through the same monotonic path; each is audited
-- (receipt id, observation kind, outcome). The receipts keep their recorded unmatched outcome. Answers how many.
create function public.notification_replay_unmatched_events(
  p_notification_id uuid,
  p_provider_code text,
  p_provider_reference text
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_receipt record;
  v_notification public.notifications;
  v_outcome text;
  v_count integer := 0;
begin
  for v_receipt in
    select x.id, x.minimal_payload ->> 'kind' as kind
    from public.external_event_receipts as x
    where x.provider_code = p_provider_code
      and x.processing_state = 'unmatched'
      and (x.minimal_payload ->> 'provider_reference') = p_provider_reference
    order by (x.minimal_payload ->> 'provider_created_at')::timestamptz, x.received_at, x.id
  loop
    select n.* into v_notification
    from public.notifications as n
    where n.id = p_notification_id
    for update;
    v_outcome := public.notification_apply_observation(v_notification, v_receipt.kind);
    perform public.notification_audit(
      null, 'system', 'notification.observation_replayed', p_notification_id,
      null,
      jsonb_build_object('receipt_id', v_receipt.id, 'observation', v_receipt.kind, 'outcome', v_outcome),
      'provider_observation_replayed'
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- The unmatched receipts of one provider reference, for the re-application above.
create index external_event_receipts_unmatched_reference_idx
  on public.external_event_receipts (provider_code, (minimal_payload ->> 'provider_reference'))
  where processing_state = 'unmatched';

-- Records one authenticated provider notification event: the receipt first, unique per (provider, event reference),
-- then the observation applied to its Notification in the same transaction. Outcomes: recorded (with the processing
-- outcome), duplicate (with the first delivery's outcome), invalid. Lock order: the provider reference's advisory lock,
-- then the Notification row.
create function public.notification_record_provider_event(
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
  v_notification public.notifications;
  v_target uuid;
  v_state text;
begin
  if p_provider_code is null or p_provider_code collate "C" !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_event_reference is null or p_event_reference collate "C" !~ '^[A-Za-z0-9_]{3,255}$'
     or p_event_type is null or p_event_type collate "C" !~ '^[a-z][a-z0-9_.]{2,99}$'
     or p_occurred_at is null
     or p_payload_digest is null or p_payload_digest collate "C" !~ '^sha256:[0-9a-f]{64}$'
     or not public.notification_observation_valid(p_observation) then
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
    -- Serializes with notification_record_attempt for the same reference (see the header): an accepted attempt being
    -- recorded now is either seen here once it commits, or sees this receipt as unmatched and re-applies it.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('notification-reference|' || p_provider_code || '|' || (p_observation ->> 'provider_reference')),
      7310
    );
    select a.notification_id into v_target
    from public.notification_attempts as a
    where a.provider_code = p_provider_code
      and a.provider_reference = (p_observation ->> 'provider_reference')
      and a.result = 'accepted'
    order by a.attempted_at, a.id
    limit 1;
    if v_target is not null then
      select n.* into v_notification
      from public.notifications as n
      where n.id = v_target
      for update;
    end if;
    if v_notification.id is null then
      v_state := 'unmatched';
    else
      v_state := public.notification_apply_observation(v_notification, v_kind);
    end if;
  end if;
  update public.external_event_receipts as x
  set processing_state = v_state,
      processed_at = clock_timestamp(),
      correlation_reference = v_notification.id::text
  where x.id = v_receipt;
  return query select 'recorded'::text, v_state;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The notification center (authenticated only).
-- ---------------------------------------------------------------------------

-- The caller's active User when it may read its notifications: any aal for a client, aal2 for a User holding an
-- Attorney or Staff Profile; otherwise null.
create function public.notification_caller()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select u.id
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and (
      public.current_session_aal2() is true
      or (
        not exists (select 1 from public.attorney_profiles as p where p.user_id = u.id)
        and not exists (select 1 from public.staff_profiles as s where s.user_id = u.id)
      )
    );
$function$;

create function public.notification_center()
returns table (
  notification_id uuid,
  notification_type text,
  state text,
  critical boolean,
  ack_required boolean,
  created_at timestamptz,
  link_path text,
  email_state text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_user uuid;
begin
  v_user := public.notification_caller();
  if v_user is null then
    return;
  end if;
  return query
    select
      n.id,
      n.notification_type,
      n.state,
      n.critical,
      n.ack_required,
      n.created_at,
      public.notification_link_path(n),
      e.state
    from public.notifications as n
    left join public.notifications as e
      on e.recipient_user_id = n.recipient_user_id
      and e.channel = 'email'
      and e.notification_type = n.notification_type
      and e.source_event_type = n.source_event_type
      and e.source_event_id = n.source_event_id
    where n.recipient_user_id = v_user
      and n.channel = 'in_app'
    order by n.created_at desc, n.id desc
    limit 100;
end;
$function$;

-- Acknowledges one of the caller's own in-app Notifications that requires it. Outcomes: acknowledged,
-- already_acknowledged, not_required, not_found.
create function public.notification_acknowledge(p_notification_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_user uuid;
  v_notification public.notifications;
begin
  if p_notification_id is null then
    return 'not_found';
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null or public.notification_caller() is distinct from v_user then
    return 'not_found';
  end if;
  select n.* into v_notification
  from public.notifications as n
  where n.id = p_notification_id
    and n.recipient_user_id = v_user
    and n.channel = 'in_app'
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_notification.state = 'acknowledged' then
    return 'already_acknowledged';
  end if;
  if not v_notification.ack_required then
    return 'not_required';
  end if;
  update public.notifications as n set state = 'acknowledged' where n.id = v_notification.id;
  perform public.notification_audit(
    v_user, coalesce(public.notification_recipient_role(v_notification), 'user'), 'notification.acknowledged',
    v_notification.id,
    jsonb_build_object('state', 'delivered'),
    jsonb_build_object(
      'state', 'acknowledged', 'channel', 'in_app', 'notification_type', v_notification.notification_type
    ),
    null
  );
  return 'acknowledged';
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
    'public.notification_types()',
    'public.notification_type_list_valid(jsonb)',
    'public.notification_parameters_valid(jsonb)',
    'public.notification_configured_types(timestamptz)',
    'public.policy_parameters_approvable(text, uuid, jsonb)',
    'public.notification_emit(uuid, text, text, uuid)',
    'public.notification_request_events()',
    'public.notification_consultation_events()',
    'public.notification_consultation_of(public.notifications)',
    'public.notification_recipient_role(public.notifications)',
    'public.notification_link_path(public.notifications)',
    'public.notification_audit(uuid, text, text, uuid, jsonb, jsonb, text)',
    'public.notification_fail_permanently(public.notifications, text, text)',
    'public.notification_job_escalated()',
    'public.notification_observation_valid(jsonb)',
    'public.notification_apply_observation(public.notifications, text)',
    'public.notification_replay_unmatched_events(uuid, text, text)',
    'public.notification_caller()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.notification_job_context(uuid)',
    'public.notification_record_attempt(uuid, text, text, text, text)',
    'public.notification_record_provider_event(text, text, text, timestamptz, text, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.notification_center()',
    'public.notification_acknowledge(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

comment on function public.notification_emit(uuid, text, text, uuid) is
  'Internal outbox (MVP-001 S10; TA section 27): one in-app and one email Notification per recipient and business event, the email one with one notification.deliver job (8 attempts); exception-guarded so a Notification never fails its business event (audited notification.not_created with the recipient, type, channel and source event to emit it again). Executable by no API role.';
comment on function public.notification_job_context(uuid) is
  'Worker (service_role only; MVP-001 S10): what a running notification.deliver job is to do (act | nothing_to_do | no_recipient | not_running), with the type, the recipient''s notification center path and the recipient''s address read at send time from auth.users (never stored, logged or audited).';
comment on function public.notification_record_attempt(uuid, text, text, text, text) is
  'Worker (service_role only; MVP-001 S10): appends one provider-neutral Rosuno delivery attempt (accepted | failed_transient | failed_permanent | not_sent, the last stopping before any provider call) and moves the email Notification (sent | retrying | permanently_failed | no_effect | invalid | not_running); the first accepted attempt of a provider reference re-applies its earlier unmatched events; permanent failure of a critical Notification opens a Reconciliation Exception.';
comment on function public.notification_record_provider_event(text, text, text, timestamptz, text, jsonb) is
  'Webhook (service_role only; MVP-001 S10): receipt first, unique per event; the provider-neutral observation applied monotonically to the Notification of its accepted attempt (applied | no_effect | stale | unmatched | ignored); an unmatched one is re-applied when its accepted attempt is recorded.';
comment on function public.notification_center() is
  'MVP-001 S10 notification center: the caller''s own in-app Notifications (newest 100) with link path and email delivery state; aal2 for a User holding an Attorney or Staff Profile.';
comment on function public.notification_acknowledge(uuid) is
  'MVP-001 S10: acknowledges one of the caller''s own in-app Notifications that requires acknowledgement; audited.';
