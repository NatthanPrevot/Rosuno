-- MVP-001 S10 (1 of 4): integrity of the communication relations (MVP-001 Packet S10 "consultation-scoped messages",
-- "documents, voice memos, sharing grants, versioning and secure access", "notification lifecycle ... durable delivery
-- attempts"; MBS section 15 deliverables 12A to 12C; TA sections 23, 27, 47 and 57; PS sections 19, 20 and 29; ROS
-- sections 12 and 15; MB sections 51 to 55 and 97 to 99).
--
-- public.messages, public.notifications, public.notification_attempts, public.resources, public.documents and
-- public.resource_sharing_grants exist since P1 (20260918060600; S3 20261119010000 made resources, documents and voice
-- memos function-only). This migration adds no relation, no column and no policy type (Packet rules 8 and 16); it adds
-- implementation constraints, guard triggers, two indexes for idempotency and reads, and narrows privileges so every
-- write is function-only (Packet section 1 RLS impact):
--
-- Messages (12A; MB sections 51 to 53): a sent Message never changes and is never deleted or truncated (the P1 trigger
-- already fixed its participants and content; moderation is S11, which may replace the guard); visibility_state is
-- 'visible' only; the body is the text without surrounding whitespace, within the fixed 20 000-character technical
-- ceiling of client free text (PS-A1), never empty. No API role writes messages; authenticated no longer reads the relation directly: both
-- participants read through consultation_messages (20261126030000), which requires aal2 of the attorney. service_role
-- keeps SELECT only.
--
-- Notifications (12C; ROS section 15; MB sections 98 and 99): the Notification owns the communication lifecycle and
-- carries no provider concept. Channels in S10: in_app and email. An in-app Notification is delivered when it is
-- created and moves only to acknowledged, and only when acknowledgement is required. An email Notification is created
-- pending and moves forward only: pending -> sent | retrying | permanently_failed; retrying -> sent |
-- permanently_failed; sent -> delivered | failed | permanently_failed; delivered, failed and permanently_failed are
-- terminal (the first terminal observation wins, so a duplicate or stale provider observation never regresses or
-- repeats canonical state). sent_at, delivered_at and failed_at are each set once with their state. The identity
-- (recipient, type, source event, channel, critical, acknowledgement) never changes; nothing is deleted or truncated.
-- One Notification per recipient, channel, type and source event (a unique index: an event emitted twice creates
-- nothing new). The seven S10 notification types and their source events are listed in the type check. No API role
-- writes notifications; authenticated keeps the P1 recipient-only read policy; service_role keeps SELECT only.
--
-- Notification attempts (ROS section 15: the Operational Job owns execution and retry): an attempt row records one
-- Rosuno delivery attempt of an email Notification, which may stop before any provider call. It holds the email
-- adapter's provider code and the provider's own reference only (no address, body or payload), a provider-neutral
-- result and a lower-snake failure code for every result but accepted: accepted (the provider took the message; its
-- reference), failed_transient or failed_permanent (the provider was called, or may have been, and failed), or not_sent
-- (Rosuno stopped before any provider call, with one of the fixed codes provider_unconfigured, recipient_unavailable,
-- recipient_address_unsupported or invalid_request). Append-only; no API role writes them; service_role keeps SELECT
-- only. A lookup index maps a provider reference back to its Notification for provider observations.
--
-- Resources (12B): resource_kind 'document' is admitted, always in a Consultation (consultation_id set, intake_id
-- null), with the content types and the byte ceiling S3 already fixed for the private bucket (PDF, PNG and JPEG;
-- 1 000 000 bytes). The S3 kind and context checks are replaced by equal-or-stricter v2 checks that keep every S3 rule.
-- An index serves the Consultation's document list.
--
-- Resource Sharing Grants (ROS section 12.4: one grant is one resource, one recipient, one context and purpose, a
-- defined period and status, with its history preserved): grants are never deleted or truncated (the P1 trigger
-- already fixes their terms and revocation); a document is shared only in its own Consultation's context
-- ('consultation', the Consultation id, purpose 'consultation_document_exchange'), by its uploader, with the
-- Consultation's other participant. service_role loses its direct INSERT and UPDATE: grants are written only by the S10
-- document functions (20261126040000).

-- ---------------------------------------------------------------------------
-- Messages.
-- ---------------------------------------------------------------------------

alter table public.messages
  add constraint messages_visibility_v1_check
    check (visibility_state = 'visible'),
  add constraint messages_body_v1_check
    check (
      char_length(body) between 1 and 20000
      and body !~ '^[[:space:]]'
      and body !~ '[[:space:]]$'
    );

create function public.message_record_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'a sent Message is immutable and is never deleted or truncated'
    using errcode = '55000';
end;
$function$;

create trigger messages_record_guard
before update or delete on public.messages
for each row
execute function public.message_record_guard();

create trigger messages_no_truncate
before truncate on public.messages
for each statement
execute function public.message_record_guard();

revoke insert, update, delete, truncate, references, trigger on table public.messages
  from public, anon, authenticated, service_role;
revoke select on table public.messages from authenticated;

-- ---------------------------------------------------------------------------
-- Notifications.
-- ---------------------------------------------------------------------------

alter table public.notifications
  add constraint notifications_channel_v1_check
    check (channel in ('in_app', 'email')),
  add constraint notifications_type_v1_check
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
      )
    ),
  add constraint notifications_state_v1_check
    check (
      (channel = 'in_app' and state in ('delivered', 'acknowledged'))
      or (
        channel = 'email'
        and state in ('pending', 'sent', 'delivered', 'failed', 'retrying', 'permanently_failed')
      )
    ),
  add constraint notifications_acknowledgement_v1_check
    check (
      (not ack_required or channel = 'in_app')
      and (state <> 'acknowledged' or ack_required)
    ),
  add constraint notifications_timestamps_v1_check
    check (
      (
        channel = 'in_app'
        and sent_at is not null
        and delivered_at is not null
        and failed_at is null
      )
      or (
        channel = 'email'
        and (
          (state in ('pending', 'retrying') and sent_at is null and delivered_at is null and failed_at is null)
          or (state = 'sent' and sent_at is not null and delivered_at is null and failed_at is null)
          or (state = 'delivered' and sent_at is not null and delivered_at is not null and failed_at is null)
          or (state = 'failed' and sent_at is not null and delivered_at is null and failed_at is not null)
          or (state = 'permanently_failed' and delivered_at is null and failed_at is not null)
        )
      )
    );

-- One Notification per recipient, channel, type and source event: emitting an event twice creates nothing new.
create unique index notifications_source_event_unique
  on public.notifications (recipient_user_id, channel, notification_type, source_event_type, source_event_id);

-- The notification center: a recipient's in-app Notifications, newest first.
create index notifications_in_app_recipient_idx
  on public.notifications (recipient_user_id, created_at desc, id desc)
  where channel = 'in_app';

create function public.notification_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'notifications are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if (new.channel = 'in_app' and new.state is distinct from 'delivered')
       or (new.channel = 'email' and (
         new.state is distinct from 'pending'
         or new.sent_at is not null
         or new.delivered_at is not null
         or new.failed_at is not null
       )) then
      raise exception 'an in-app Notification is created delivered and an email Notification pending'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.recipient_user_id is distinct from old.recipient_user_id
     or new.notification_type is distinct from old.notification_type
     or new.source_event_type is distinct from old.source_event_type
     or new.source_event_id is distinct from old.source_event_id
     or new.channel is distinct from old.channel
     or new.critical is distinct from old.critical
     or new.ack_required is distinct from old.ack_required
     or new.created_at is distinct from old.created_at then
    raise exception 'a Notification keeps its recipient, type, source event, channel and flags'
      using errcode = '55000';
  end if;
  if (old.sent_at is not null and new.sent_at is distinct from old.sent_at)
     or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
     or (old.failed_at is not null and new.failed_at is distinct from old.failed_at) then
    raise exception 'a Notification timestamp is set once'
      using errcode = '55000';
  end if;
  if not (
    (old.channel = 'in_app' and old.state = 'delivered' and new.state = 'acknowledged')
    or (old.channel = 'email' and old.state = 'pending' and new.state in ('sent', 'retrying', 'permanently_failed'))
    or (old.channel = 'email' and old.state = 'retrying' and new.state in ('sent', 'permanently_failed'))
    or (old.channel = 'email' and old.state = 'sent' and new.state in ('delivered', 'failed', 'permanently_failed'))
  ) then
    raise exception 'Notification transition % -> % is not allowed', old.state, new.state
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger notifications_lifecycle
before insert or update or delete on public.notifications
for each row
execute function public.notification_lifecycle();

create trigger notifications_no_truncate
before truncate on public.notifications
for each statement
execute function public.notification_lifecycle();

revoke insert, update, delete, truncate, references, trigger on table public.notifications
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Notification attempts.
-- ---------------------------------------------------------------------------

alter table public.notification_attempts
  add constraint notification_attempts_provider_code_v1_check
    check (provider_code collate "C" ~ '^[a-z][a-z0-9_]{1,31}$'),
  add constraint notification_attempts_result_v1_check
    check (result in ('accepted', 'failed_transient', 'failed_permanent', 'not_sent')),
  add constraint notification_attempts_outcome_v1_check
    check (
      (
        result = 'accepted'
        and provider_reference is not null
        and provider_reference collate "C" ~ '^[A-Za-z0-9._:-]{1,255}$'
        and failure_code is null
      )
      or (
        result in ('failed_transient', 'failed_permanent')
        and provider_reference is null
        and failure_code is not null
        and failure_code collate "C" ~ '^[a-z][a-z0-9_]{1,63}$'
      )
      or (
        result = 'not_sent'
        and provider_reference is null
        and failure_code in (
          'provider_unconfigured', 'recipient_unavailable', 'recipient_address_unsupported', 'invalid_request'
        )
      )
    );

create index notification_attempts_provider_reference_idx
  on public.notification_attempts (provider_code, provider_reference)
  where provider_reference is not null;

create function public.notification_attempt_append_only()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op <> 'INSERT' then
    raise exception 'notification attempts are append-only'
      using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.notifications as n
    where n.id = new.notification_id
      and n.channel = 'email'
  ) then
    raise exception 'a delivery attempt belongs to an email Notification'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger notification_attempts_append_only
before insert or update or delete on public.notification_attempts
for each row
execute function public.notification_attempt_append_only();

create trigger notification_attempts_no_truncate
before truncate on public.notification_attempts
for each statement
execute function public.notification_attempt_append_only();

revoke insert, update, delete, truncate, references, trigger on table public.notification_attempts
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Resources: the document kind (equal-or-stricter replacements of the S3 checks).
-- ---------------------------------------------------------------------------

alter table public.resources
  drop constraint resources_kind_v1_check,
  drop constraint resources_kind_context_check;

alter table public.resources
  add constraint resources_kind_v2_check
    check (resource_kind in ('voice_memo', 'verification_artifact', 'document')),
  add constraint resources_kind_context_v2_check
    check (
      (
        resource_kind = 'voice_memo'
        and mime_type in ('audio/webm', 'audio/mp4')
        and intake_id is not null
        and consultation_id is null
      )
      or (
        resource_kind = 'verification_artifact'
        and mime_type in ('application/pdf', 'image/png', 'image/jpeg')
        and intake_id is null
        and consultation_id is null
      )
      or (
        resource_kind = 'document'
        and mime_type in ('application/pdf', 'image/png', 'image/jpeg')
        and intake_id is null
        and consultation_id is not null
      )
    );

create index resources_consultation_documents_idx
  on public.resources (consultation_id, created_at, id)
  where consultation_id is not null;

-- ---------------------------------------------------------------------------
-- Resource Sharing Grants.
-- ---------------------------------------------------------------------------

-- Grants are never deleted or truncated; a consultation-context grant shares exactly one document of that
-- Consultation, from its uploader to the Consultation's other participant, and a document is shared in no other context.
create function public.resource_sharing_grant_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_resource public.resources;
  v_client uuid;
  v_attorney uuid;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Resource Sharing Grants are never deleted; their history is preserved'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    return new;
  end if;
  select r.* into v_resource from public.resources as r where r.id = new.resource_id;
  if v_resource.resource_kind = 'document' or new.context_type = 'consultation' then
    select cp.user_id, ap.user_id into v_client, v_attorney
    from public.consultations as c
    join public.client_profiles as cp on cp.id = c.client_id
    join public.attorney_profiles as ap on ap.id = c.attorney_id
    where c.id = new.context_id;
    if v_resource.resource_kind is distinct from 'document'
       or new.context_type is distinct from 'consultation'
       or new.purpose_code is distinct from 'consultation_document_exchange'
       or v_resource.consultation_id is distinct from new.context_id
       or v_client is null
       or new.granted_by_user_id is distinct from v_resource.owner_user_id
       or not (
         (v_resource.owner_user_id = v_client and new.recipient_user_id = v_attorney)
         or (v_resource.owner_user_id = v_attorney and new.recipient_user_id = v_client)
       ) then
      raise exception 'a document is shared only by its uploader with the other participant of its own Consultation'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

create trigger resource_sharing_grants_guard
before insert or update or delete on public.resource_sharing_grants
for each row
execute function public.resource_sharing_grant_guard();

create trigger resource_sharing_grants_no_truncate
before truncate on public.resource_sharing_grants
for each statement
execute function public.resource_sharing_grant_guard();

revoke insert, update, delete, truncate, references, trigger on table public.resource_sharing_grants
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Function privileges: every guard is a trigger function executable by no API role.
-- ---------------------------------------------------------------------------

revoke all on function public.message_record_guard() from public, anon, authenticated, service_role;
revoke all on function public.notification_lifecycle() from public, anon, authenticated, service_role;
revoke all on function public.notification_attempt_append_only() from public, anon, authenticated, service_role;
revoke all on function public.resource_sharing_grant_guard() from public, anon, authenticated, service_role;

comment on function public.message_record_guard() is
  'MVP-001 S10: a sent Message is immutable and is never deleted or truncated (moderation is S11).';
comment on function public.notification_lifecycle() is
  'MVP-001 S10: a Notification is never deleted; in-app is created delivered and moves only to acknowledged (when required); email is created pending and moves forward only (pending -> sent | retrying | permanently_failed; retrying -> sent | permanently_failed; sent -> delivered | failed | permanently_failed); identity fixed; timestamps set once.';
comment on function public.notification_attempt_append_only() is
  'MVP-001 S10: delivery attempts are append-only and belong to an email Notification.';
comment on function public.resource_sharing_grant_guard() is
  'MVP-001 S10: grants are never deleted; a document is shared only by its uploader with the other participant of its own Consultation, in the consultation context with purpose consultation_document_exchange.';
comment on table public.notifications is
  'Canonical business communication lifecycle (MVP-001 S10; ROS section 15). Provider-neutral: no provider concept is stored here. Ordinary delivery failure never reverses the underlying business event.';
comment on table public.notification_attempts is
  'Append-only delivery-attempt evidence of an email Notification (MVP-001 S10): one row per Rosuno delivery attempt, which may stop before any provider call (result not_sent); provider code, provider reference, provider-neutral result and failure code only.';
comment on column public.notifications.state is
  'MVP-001 S10: in_app delivered | acknowledged; email pending | sent | delivered | failed | retrying | permanently_failed (MB section 99). failed: the provider reported, after accepting the message, a failure not known to be permanent; permanently_failed: refused permanently, bounced, suppressed, not sendable (no recipient or an unsupported address), attempts exhausted (also while unconfigured) or its delivery job cancelled.';
