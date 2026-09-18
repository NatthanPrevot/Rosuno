-- P1-009 local candidate. Unreviewed and unapplied.
-- Physical 1I Resources / Communications foundation only.
--
-- D1 explicit Document lineage remains deferred: the locked documents shape is
-- implemented exactly and no replacement-lineage field/relation is introduced.
--
-- D3 Resource subtype exclusivity / resource_kind taxonomy remains deferred:
-- no cross-table Document/Voice-Memo exclusivity and no closed resource_kind
-- vocabulary is introduced.
--
-- DOC-DEL remains unresolved. This migration implements no deletion/purge/
-- erasure executor, retention timer, or Legal Hold behavior.
--
-- Raw Storage bucket/path columns are withheld from ordinary authenticated
-- reads. Storage-byte access remains a separate later server-authorized
-- signed-URL operation.
--
-- G-1 and G-5 remain unresolved and untouched. No 1J/1K/1L relation is pulled
-- forward.

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  resource_kind text not null,
  owner_user_id uuid not null,
  intake_id uuid,
  consultation_id uuid,
  storage_bucket text not null,
  storage_object_path text not null,
  mime_type text,
  byte_size bigint,
  content_digest text,
  visibility_state text not null,
  retention_state text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint resources_storage_identity_key
    unique (storage_bucket, storage_object_path),
  constraint resources_owner_user_id_fkey
    foreign key (owner_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint resources_intake_id_fkey
    foreign key (intake_id)
    references public.intakes (id)
    on update restrict
    on delete restrict,
  constraint resources_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint resources_resource_kind_check
    check (btrim(resource_kind) <> ''),
  constraint resources_storage_bucket_check
    check (btrim(storage_bucket) <> ''),
  constraint resources_storage_object_path_check
    check (btrim(storage_object_path) <> ''),
  constraint resources_visibility_state_check
    check (btrim(visibility_state) <> ''),
  constraint resources_retention_state_check
    check (btrim(retention_state) <> ''),
  constraint resources_byte_size_check
    check (byte_size is null or byte_size >= 0)
);

alter table public.resources enable row level security;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  document_type text,
  version_label text,
  created_at timestamptz not null default statement_timestamp(),
  constraint documents_resource_id_key
    unique (resource_id),
  constraint documents_resource_id_fkey
    foreign key (resource_id)
    references public.resources (id)
    on update restrict
    on delete restrict,
  constraint documents_document_type_check
    check (document_type is null or btrim(document_type) <> ''),
  constraint documents_version_label_check
    check (version_label is null or btrim(version_label) <> '')
);

alter table public.documents enable row level security;

create table public.voice_memos (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  intake_id uuid not null,
  duration_seconds integer,
  created_at timestamptz not null default statement_timestamp(),
  constraint voice_memos_resource_id_key
    unique (resource_id),
  constraint voice_memos_resource_id_fkey
    foreign key (resource_id)
    references public.resources (id)
    on update restrict
    on delete restrict,
  constraint voice_memos_intake_id_fkey
    foreign key (intake_id)
    references public.intakes (id)
    on update restrict
    on delete restrict,
  constraint voice_memos_duration_seconds_check
    check (
      duration_seconds is null
      or duration_seconds between 0 and 60
    )
);

alter table public.voice_memos enable row level security;

create table public.resource_sharing_grants (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  recipient_user_id uuid not null,
  context_type text not null,
  context_id uuid not null,
  purpose_code text not null,
  granted_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  granted_by_user_id uuid not null,
  constraint resource_sharing_grants_resource_id_fkey
    foreign key (resource_id)
    references public.resources (id)
    on update restrict
    on delete restrict,
  constraint resource_sharing_grants_recipient_user_id_fkey
    foreign key (recipient_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint resource_sharing_grants_granted_by_user_id_fkey
    foreign key (granted_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint resource_sharing_grants_context_type_check
    check (btrim(context_type) <> ''),
  constraint resource_sharing_grants_purpose_code_check
    check (btrim(purpose_code) <> ''),
  constraint resource_sharing_grants_expiry_check
    check (expires_at is null or expires_at > granted_at),
  constraint resource_sharing_grants_revocation_check
    check (revoked_at is null or revoked_at >= granted_at)
);

alter table public.resource_sharing_grants enable row level security;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null,
  sender_user_id uuid not null,
  recipient_user_id uuid not null,
  body text not null,
  sent_at timestamptz not null,
  visibility_state text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint messages_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint messages_sender_user_id_fkey
    foreign key (sender_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint messages_recipient_user_id_fkey
    foreign key (recipient_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint messages_body_check
    check (btrim(body) <> ''),
  constraint messages_visibility_state_check
    check (btrim(visibility_state) <> ''),
  constraint messages_distinct_participants_check
    check (sender_user_id <> recipient_user_id)
);

alter table public.messages enable row level security;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null,
  notification_type text not null,
  source_event_type text not null,
  source_event_id uuid,
  channel text not null,
  state text not null,
  critical boolean not null default false,
  ack_required boolean not null default false,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint notifications_recipient_user_id_fkey
    foreign key (recipient_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint notifications_notification_type_check
    check (btrim(notification_type) <> ''),
  constraint notifications_source_event_type_check
    check (btrim(source_event_type) <> ''),
  constraint notifications_channel_check
    check (btrim(channel) <> ''),
  constraint notifications_state_check
    check (btrim(state) <> '')
);

alter table public.notifications enable row level security;

create table public.notification_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null,
  provider_code text not null,
  provider_reference text,
  attempted_at timestamptz not null,
  result text not null,
  failure_code text,
  created_at timestamptz not null default statement_timestamp(),
  constraint notification_attempts_notification_id_fkey
    foreign key (notification_id)
    references public.notifications (id)
    on update restrict
    on delete restrict,
  constraint notification_attempts_provider_code_check
    check (btrim(provider_code) <> ''),
  constraint notification_attempts_provider_reference_check
    check (
      provider_reference is null
      or btrim(provider_reference) <> ''
    ),
  constraint notification_attempts_result_check
    check (btrim(result) <> ''),
  constraint notification_attempts_failure_code_check
    check (
      failure_code is null
      or btrim(failure_code) <> ''
    )
);

alter table public.notification_attempts enable row level security;

create table public.operational_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  subject_type text,
  subject_id uuid,
  state text not null,
  available_at timestamptz not null,
  locked_at timestamptz,
  locked_by text,
  attempt_count integer not null default 0,
  max_attempts integer not null,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint operational_jobs_job_type_check
    check (btrim(job_type) <> ''),
  constraint operational_jobs_state_check
    check (btrim(state) <> ''),
  constraint operational_jobs_attempt_count_check
    check (attempt_count >= 0),
  constraint operational_jobs_max_attempts_check
    check (max_attempts > 0),
  constraint operational_jobs_attempt_limit_check
    check (attempt_count <= max_attempts),
  constraint operational_jobs_locked_by_check
    check (locked_by is null or btrim(locked_by) <> '')
);

alter table public.operational_jobs enable row level security;

create function public.enforce_voice_memo_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  violation_exists boolean := false;
begin
  if tg_table_name = 'voice_memos' then
    select exists (
      select 1
      from public.voice_memos as vm
      join public.resources as r
        on r.id = vm.resource_id
      join public.intakes as i
        on i.id = vm.intake_id
      join public.client_profiles as c
        on c.id = i.client_id
      where vm.id = new.id
        and (
          r.intake_id is null
          or r.intake_id <> vm.intake_id
          or r.owner_user_id <> c.user_id
        )
    )
    into violation_exists;
  elsif tg_table_name = 'resources' then
    select exists (
      select 1
      from public.voice_memos as vm
      join public.intakes as i
        on i.id = vm.intake_id
      join public.client_profiles as c
        on c.id = i.client_id
      where vm.resource_id = new.id
        and (
          new.intake_id is null
          or new.intake_id <> vm.intake_id
          or new.owner_user_id <> c.user_id
        )
    )
    into violation_exists;
  elsif tg_table_name = 'intakes' then
    select exists (
      select 1
      from public.voice_memos as vm
      join public.resources as r
        on r.id = vm.resource_id
      join public.intakes as i
        on i.id = vm.intake_id
      join public.client_profiles as c
        on c.id = i.client_id
      where vm.intake_id = new.id
        and (
          r.intake_id is null
          or r.intake_id <> vm.intake_id
          or r.owner_user_id <> c.user_id
        )
    )
    into violation_exists;
  elsif tg_table_name = 'client_profiles' then
    select exists (
      select 1
      from public.intakes as i
      join public.voice_memos as vm
        on vm.intake_id = i.id
      join public.resources as r
        on r.id = vm.resource_id
      join public.client_profiles as c
        on c.id = i.client_id
      where i.client_id = new.id
        and (
          r.intake_id is null
          or r.intake_id <> vm.intake_id
          or r.owner_user_id <> c.user_id
        )
    )
    into violation_exists;
  else
    raise exception
      'unsupported Voice Memo consistency trigger source: %',
      tg_table_name;
  end if;

  if violation_exists then
    raise exception
      'Voice Memo Resource must preserve Intake identity and Intake-client ownership'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_message_relationships()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  consultation_client_user_id uuid;
  consultation_attorney_user_id uuid;
begin
  if tg_op = 'UPDATE'
     and (
       new.consultation_id is distinct from old.consultation_id
       or new.sender_user_id is distinct from old.sender_user_id
       or new.recipient_user_id is distinct from old.recipient_user_id
       or new.body is distinct from old.body
       or new.sent_at is distinct from old.sent_at
     ) then
    raise exception
      'sent Message identity/content is immutable'
      using errcode = '23514';
  end if;

  select
    client_profile.user_id,
    attorney_profile.user_id
  into
    consultation_client_user_id,
    consultation_attorney_user_id
  from public.consultations as consultation
  join public.client_profiles as client_profile
    on client_profile.id = consultation.client_id
  join public.attorney_profiles as attorney_profile
    on attorney_profile.id = consultation.attorney_id
  where consultation.id = new.consultation_id;

  if not found then
    raise exception
      'Message Consultation relationship does not exist'
      using errcode = '23503';
  end if;

  if not (
    (
      new.sender_user_id = consultation_client_user_id
      and new.recipient_user_id = consultation_attorney_user_id
    )
    or
    (
      new.sender_user_id = consultation_attorney_user_id
      and new.recipient_user_id = consultation_client_user_id
    )
  ) then
    raise exception
      'Message participants must be the Consultation client and actual attorney'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_resource_sharing_grant_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  new_authorization_end timestamptz;
begin
  if tg_op = 'UPDATE' then
    if (
      new.resource_id is distinct from old.resource_id
      or new.recipient_user_id is distinct from old.recipient_user_id
      or new.context_type is distinct from old.context_type
      or new.context_id is distinct from old.context_id
      or new.purpose_code is distinct from old.purpose_code
      or new.granted_at is distinct from old.granted_at
      or new.expires_at is distinct from old.expires_at
      or new.granted_by_user_id is distinct from old.granted_by_user_id
    ) then
      raise exception
        'Resource Sharing Grant identity/terms are immutable after creation'
        using errcode = '23514';
    end if;

    if old.revoked_at is not null
       and new.revoked_at is distinct from old.revoked_at then
      raise exception
        'Resource Sharing Grant revocation cannot be cleared or rewritten'
        using errcode = '23514';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      new.resource_id::text
      || '|' || new.recipient_user_id::text
      || '|' || new.context_type
      || '|' || new.context_id::text
      || '|' || new.purpose_code
    ),
    7009
  );

  new_authorization_end := least(
    coalesce(new.expires_at, 'infinity'::timestamptz),
    coalesce(new.revoked_at, 'infinity'::timestamptz)
  );

  if new_authorization_end > new.granted_at
     and exists (
       select 1
       from public.resource_sharing_grants as existing
       where existing.id <> new.id
         and existing.resource_id = new.resource_id
         and existing.recipient_user_id = new.recipient_user_id
         and existing.context_type = new.context_type
         and existing.context_id = new.context_id
         and existing.purpose_code = new.purpose_code
         and pg_catalog.tstzrange(
           existing.granted_at,
           least(
             coalesce(existing.expires_at, 'infinity'::timestamptz),
             coalesce(existing.revoked_at, 'infinity'::timestamptz)
           ),
           '[)'
         ) && pg_catalog.tstzrange(
           new.granted_at,
           new_authorization_end,
           '[)'
         )
     ) then
    raise exception
      'duplicate Resource Sharing Grants may not simultaneously authorize access'
      using errcode = '23P01';
  end if;

  return new;
end;
$function$;

create function public.has_resource_metadata_access(required_resource_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select exists (
    select 1
    from public.resources as r
    join public.users as caller
      on caller.auth_user_id = auth.uid()
    where r.id = required_resource_id
      and (
        r.owner_user_id = caller.id
        or exists (
          select 1
          from public.intakes as i
          join public.client_profiles as c
            on c.id = i.client_id
          where i.id = r.intake_id
            and c.user_id = caller.id
        )
        or exists (
          select 1
          from public.resource_sharing_grants as g
          where g.resource_id = r.id
            and g.recipient_user_id = caller.id
            and g.granted_at <= statement_timestamp()
            and (
              g.expires_at is null
              or g.expires_at > statement_timestamp()
            )
            and (
              g.revoked_at is null
              or g.revoked_at > statement_timestamp()
            )
        )
      )
  );
$function$;

revoke all on function public.enforce_voice_memo_consistency()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_voice_memo_consistency()
  to postgres, service_role;

revoke all on function public.enforce_message_relationships()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_message_relationships()
  to postgres, service_role;

revoke all on function public.enforce_resource_sharing_grant_integrity()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_resource_sharing_grant_integrity()
  to postgres, service_role;

revoke all on function public.has_resource_metadata_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.has_resource_metadata_access(uuid)
  to authenticated;

create constraint trigger voice_memos_relationship_consistency
after insert or update
on public.voice_memos
deferrable initially deferred
for each row
execute function public.enforce_voice_memo_consistency();

create constraint trigger resources_voice_memo_relationship_consistency
after insert or update
on public.resources
deferrable initially deferred
for each row
execute function public.enforce_voice_memo_consistency();

create constraint trigger intakes_voice_memo_relationship_consistency
after update
on public.intakes
deferrable initially deferred
for each row
execute function public.enforce_voice_memo_consistency();

create constraint trigger client_profiles_voice_memo_relationship_consistency
after update
on public.client_profiles
deferrable initially deferred
for each row
execute function public.enforce_voice_memo_consistency();

create trigger resource_sharing_grants_integrity
before insert or update
on public.resource_sharing_grants
for each row
execute function public.enforce_resource_sharing_grant_integrity();

create trigger messages_relationship_consistency
before insert or update
on public.messages
for each row
execute function public.enforce_message_relationships();

create trigger resources_set_updated_at
before update on public.resources
for each row
execute function public.set_updated_at();

create index voice_memos_intake_id_idx
  on public.voice_memos (intake_id);

create index resource_sharing_grants_authorization_lookup_idx
  on public.resource_sharing_grants (
    resource_id,
    recipient_user_id,
    context_type,
    context_id,
    purpose_code
  );

create index messages_consultation_created_at_idx
  on public.messages (consultation_id, created_at);

create index notifications_recipient_state_created_at_idx
  on public.notifications (recipient_user_id, state, created_at);

create index notification_attempts_notification_id_idx
  on public.notification_attempts (notification_id);

revoke all on table public.resources
  from public, anon, authenticated, service_role;

grant select (
  id,
  resource_kind,
  owner_user_id,
  intake_id,
  consultation_id,
  mime_type,
  byte_size,
  content_digest,
  visibility_state,
  retention_state,
  created_at,
  updated_at
) on table public.resources to authenticated;

grant select, insert on table public.resources to service_role;
grant update (
  visibility_state,
  retention_state
) on table public.resources to service_role;

revoke all on table public.documents
  from public, anon, authenticated, service_role;

grant select on table public.documents to authenticated;
grant select, insert on table public.documents to service_role;

revoke all on table public.voice_memos
  from public, anon, authenticated, service_role;

grant select on table public.voice_memos to authenticated;
grant select, insert on table public.voice_memos to service_role;

revoke all on table public.resource_sharing_grants
  from public, anon, authenticated, service_role;

grant select on table public.resource_sharing_grants to authenticated;
grant select, insert on table public.resource_sharing_grants to service_role;
grant update (revoked_at)
  on table public.resource_sharing_grants
  to service_role;

revoke all on table public.messages
  from public, anon, authenticated, service_role;

grant select on table public.messages to authenticated;
grant select, insert on table public.messages to service_role;
grant update (visibility_state)
  on table public.messages
  to service_role;

revoke all on table public.notifications
  from public, anon, authenticated, service_role;

grant select on table public.notifications to authenticated;
grant select, insert on table public.notifications to service_role;
grant update (
  state,
  sent_at,
  delivered_at,
  failed_at
) on table public.notifications to service_role;

revoke all on table public.notification_attempts
  from public, anon, authenticated, service_role;

grant select, insert
  on table public.notification_attempts
  to service_role;

revoke all on table public.operational_jobs
  from public, anon, authenticated, service_role;

grant select, insert
  on table public.operational_jobs
  to service_role;

grant update (
  state,
  available_at,
  locked_at,
  locked_by,
  attempt_count,
  last_error_code,
  last_error_message,
  completed_at,
  failed_at
) on table public.operational_jobs
  to service_role;

create policy resources_select_authorized
on public.resources
for select
to authenticated
using (
  public.has_resource_metadata_access(resources.id)
);

create policy documents_select_authorized_resource
on public.documents
for select
to authenticated
using (
  public.has_resource_metadata_access(documents.resource_id)
);

create policy voice_memos_select_authorized_resource
on public.voice_memos
for select
to authenticated
using (
  public.has_resource_metadata_access(voice_memos.resource_id)
);

create policy resource_sharing_grants_select_owner_or_recipient
on public.resource_sharing_grants
for select
to authenticated
using (
  exists (
    select 1
    from public.users as caller
    where caller.id = resource_sharing_grants.recipient_user_id
      and caller.auth_user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.resources as r
    join public.users as caller
      on caller.id = r.owner_user_id
    where r.id = resource_sharing_grants.resource_id
      and caller.auth_user_id = (select auth.uid())
  )
);

create policy messages_select_participant
on public.messages
for select
to authenticated
using (
  exists (
    select 1
    from public.users as caller
    where caller.auth_user_id = (select auth.uid())
      and caller.id in (
        messages.sender_user_id,
        messages.recipient_user_id
      )
  )
);

create policy notifications_select_recipient
on public.notifications
for select
to authenticated
using (
  exists (
    select 1
    from public.users as caller
    where caller.id = notifications.recipient_user_id
      and caller.auth_user_id = (select auth.uid())
  )
);

comment on table public.resources is
  'Canonical relational substrate for protected stored resources. Storage-object existence or path knowledge is never authorization; actual byte access remains behind the later server-controlled signed-URL boundary.';

comment on table public.documents is
  'Document identity over the shared Resource substrate. P1-009 preserves historical rows but does not introduce explicit replacement-lineage representation.';

comment on table public.voice_memos is
  'Client-provided Voice Memo identity. The backing Resource must preserve the same Intake and the User behind the Intake-owning Client Profile.';

comment on table public.resource_sharing_grants is
  'Recipient-specific Resource disclosure history. For one resource/recipient/context/purpose tuple, no two grants may simultaneously authorize access.';

comment on table public.messages is
  'Consultation-scoped user communication. Pre-Consultation/open-inbox messaging is structurally excluded; sent Message identity/content is immutable.';

comment on table public.notifications is
  'Canonical business communication lifecycle. Ordinary notification-delivery failure does not reverse the underlying business event.';

comment on table public.notification_attempts is
  'Append-only provider delivery-attempt evidence subordinate to Notification lifecycle state.';

comment on table public.operational_jobs is
  'Generalized durable asynchronous execution/retry infrastructure. Operational Job is not Notification or canonical business-domain state.';

comment on function public.has_resource_metadata_access(uuid) is
  'Read-only current-caller Resource-metadata predicate: direct owner, Client-owned Intake relationship, or currently valid recipient-specific Sharing Grant. It does not authorize Storage bytes and does not expose raw Storage paths. Trusted grant writers remain responsible for validating grant context/purpose/relationship.';
