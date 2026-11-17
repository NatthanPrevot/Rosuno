-- MVP-001 S3 (1 of 3): the protected Storage foundation (MVP-001 Packet S3 "private bucket and server-issued
-- short-lived signed URLs after principal, capability, relationship, grant and legal-hold checks"; IMP section 13;
-- TA sections 21, 22 and 57; PS sections 19, 26.2 and 29; MBS section 20).
--
-- public.resources, public.documents, public.voice_memos, public.resource_sharing_grants and public.legal_holds
-- exist since P1 (20260918060600, 20260921051204). This migration adds no relation and no column (Packet rule
-- 16); it adds implementation constraints, guard triggers and functions on the existing relations
-- (DL-ENG-1 R9):
-- - the private bucket rosuno-private-resources, created only where the Supabase storage schema exists. It is
--   not public, admits only the content types and byte ceiling the application stores, and no storage.objects
--   policy grants anon or authenticated anything, so no browser can read, list or write an object directly,
--   even with its exact path. Objects are written and signed only by the application's server-only privileged
--   storage port, at a path the server derives from the resource id;
-- - the relational record is canonical (PS section 29.3): every resource lives at exactly
--   resources/<resource id>/original in that bucket, carries its server-measured content type, byte size and
--   SHA-256 digest, and moves only pending -> available or pending -> rejected; nothing else about it changes;
-- - storage existence is never authorization: resource_authorize_access decides, for the caller's own
--   authenticated identity, the principal, its capability, the resource relationship, any active Resource
--   Sharing Grant, the visibility and retention state, and active Legal Holds, and only then answers the object
--   path the server may sign for a short lifetime. Each authorization is audited atomically;
-- - intake resources are never disclosed to attorneys before acceptance (counsel-gated, REG-CA-035
--   equivalent): neither a grant nor any other relationship gives an attorney access to a resource of an Intake;
-- - verification artifacts are disclosed only to staff holding the verification scope for the jurisdiction of
--   the finding that references them, never to the attorney concerned and never through a sharing grant;
-- - an active Legal Hold blocks every deletion of a resource and of its document or voice memo record (PS
--   section 26.2), and, failing closed while no policy decides otherwise, every new access authorization (PS
--   section 29, "where policy requires"). A hold applies when its scope id is the resource, its Intake, its
--   Consultation or a finding that references it, and it has not been released; no scope or status vocabulary
--   is invented here. There is no deletion feature: DOC-DEL stays unresolved and no executor exists;
-- - writes are function-only: anon, authenticated and service_role hold no DML on resources, documents or
--   voice_memos; authenticated keeps the P1 metadata reads under row policies, now also closed to attorneys for
--   intake resources and to grant recipients for verification artifacts.
--
-- The byte ceiling (1 000 000 bytes) and the content-type allowlists are fixed technical security bounds of the
-- upload path, not business policy. The voice-memo duration limit is server configuration (Packet section 3
-- gate) and is not encoded here. Retention periods and disposition stay counsel/policy-driven; the only
-- retention state written is 'active'. No bucket object, resource, grant, hold or business row is inserted.

-- ---------------------------------------------------------------------------
-- The private bucket (only where the Supabase storage schema exists).
-- ---------------------------------------------------------------------------

do $bucket$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'MVP-001 S3: no storage schema in this database; the private bucket is not created';
    return;
  end if;
  execute $create$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'rosuno-private-resources',
      'rosuno-private-resources',
      false,
      1000000,
      array['audio/webm', 'audio/mp4', 'application/pdf', 'image/png', 'image/jpeg']
    )
  $create$;
end;
$bucket$;

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relation.
-- ---------------------------------------------------------------------------

alter table public.resources
  add constraint resources_kind_v1_check
    check (resource_kind in ('voice_memo', 'verification_artifact')),
  add constraint resources_storage_location_check
    check (
      storage_bucket = 'rosuno-private-resources'
      and storage_object_path = 'resources/' || id::text || '/original'
    ),
  add constraint resources_visibility_lifecycle_check
    check (visibility_state in ('pending', 'available', 'rejected')),
  add constraint resources_retention_active_check
    check (retention_state = 'active'),
  add constraint resources_content_metadata_check
    check (
      mime_type is not null
      and byte_size between 1 and 1000000
      and content_digest is not null
      and content_digest collate "C" ~ '^sha256:[0-9a-f]{64}$'
    ),
  add constraint resources_kind_context_check
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
    );

-- ---------------------------------------------------------------------------
-- Legal Hold predicate (internal).
-- ---------------------------------------------------------------------------

-- True when an unreleased Legal Hold names the resource, its Intake, its Consultation, or a verification finding
-- that references it. Any scope type and any status count while released_at is unset or in the future, so an
-- unknown vocabulary fails closed.
create function public.resource_under_legal_hold(p_resource_id uuid)
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
    where r.id = p_resource_id
      and (h.released_at is null or h.released_at > statement_timestamp())
  );
$function$;

revoke all on function public.resource_under_legal_hold(uuid)
  from public, anon, authenticated, service_role;

comment on function public.resource_under_legal_hold(uuid) is
  'Internal (MVP-001 S3): true when an unreleased Legal Hold names the resource, its Intake, its Consultation or a verification finding referencing it. Unknown scope or status vocabularies fail closed. Executable by no API role.';

-- ---------------------------------------------------------------------------
-- Guard triggers: lifecycle, immutability, and Legal Hold before deletion.
-- ---------------------------------------------------------------------------

create function public.resource_record_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  v_resource uuid;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'public.% cannot be truncated; disposition is not available', tg_table_name
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    if tg_table_name = 'resources' then
      v_resource := old.id;
    else
      v_resource := old.resource_id;
    end if;
    if public.resource_under_legal_hold(v_resource) then
      raise exception 'an active Legal Hold blocks deletion of this resource'
        using errcode = '55000';
    end if;
    return old;
  end if;
  if tg_table_name = 'resources' then
    if new.id is distinct from old.id
       or new.resource_kind is distinct from old.resource_kind
       or new.owner_user_id is distinct from old.owner_user_id
       or new.intake_id is distinct from old.intake_id
       or new.consultation_id is distinct from old.consultation_id
       or new.storage_bucket is distinct from old.storage_bucket
       or new.storage_object_path is distinct from old.storage_object_path
       or new.mime_type is distinct from old.mime_type
       or new.byte_size is distinct from old.byte_size
       or new.content_digest is distinct from old.content_digest
       or new.retention_state is distinct from old.retention_state
       or new.created_at is distinct from old.created_at then
      raise exception 'a resource''s identity, location and content metadata are immutable'
        using errcode = '23514';
    end if;
    if new.visibility_state is distinct from old.visibility_state
       and not (
         old.visibility_state = 'pending'
         and new.visibility_state in ('available', 'rejected')
       ) then
      raise exception 'a resource moves only from pending to available or rejected'
        using errcode = '23514';
    end if;
    return new;
  end if;
  raise exception 'public.% rows are immutable', tg_table_name
    using errcode = '55000';
end;
$function$;

revoke all on function public.resource_record_guard()
  from public, anon, authenticated, service_role;

create trigger resources_record_guard
before update or delete on public.resources
for each row
execute function public.resource_record_guard();

create trigger resources_no_truncate
before truncate on public.resources
for each statement
execute function public.resource_record_guard();

create trigger voice_memos_record_guard
before update or delete on public.voice_memos
for each row
execute function public.resource_record_guard();

create trigger voice_memos_no_truncate
before truncate on public.voice_memos
for each statement
execute function public.resource_record_guard();

create trigger documents_record_guard
before update or delete on public.documents
for each row
execute function public.resource_record_guard();

create trigger documents_no_truncate
before truncate on public.documents
for each statement
execute function public.resource_record_guard();

-- ---------------------------------------------------------------------------
-- Privileges: writes are function-only.
-- ---------------------------------------------------------------------------

revoke all on table public.resources from service_role;
revoke all on table public.documents from service_role;
revoke all on table public.voice_memos from service_role;

-- ---------------------------------------------------------------------------
-- Metadata reads (row policies): closed to attorneys for intake resources and
-- to grant recipients for verification artifacts.
-- ---------------------------------------------------------------------------

create or replace function public.has_resource_metadata_access(required_resource_id uuid)
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
        or (
          r.resource_kind <> 'verification_artifact'
          and not (
            r.intake_id is not null
            and exists (
              select 1
              from public.attorney_profiles as p
              where p.user_id = caller.id
            )
          )
          and exists (
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
      )
  );
$function$;

revoke all on function public.has_resource_metadata_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.has_resource_metadata_access(uuid)
  to authenticated;

comment on function public.has_resource_metadata_access(uuid) is
  'Read-only current-caller Resource-metadata predicate: direct owner, Client-owned Intake relationship, or currently valid recipient-specific Sharing Grant, except that no grant discloses an Intake resource to an attorney (counsel-gated, MVP-001 S3) or a verification artifact to anyone. It does not authorize Storage bytes and does not expose raw Storage paths.';

-- ---------------------------------------------------------------------------
-- Upload completion (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Fixed outcomes: available, not_found, not_pending, not_editable, already_exists, denied, not_stored.
-- The caller must own the pending resource. A voice memo's Intake must still be the caller's own draft and hold
-- no other available voice memo; a verification artifact's owner must still hold a verification scope. Where
-- the storage schema exists the object must be stored at the resource's exact path with its recorded byte size
-- and content type; a database without the storage schema (disposable plain PostgreSQL) has no objects to
-- check. Nothing else about the resource changes.
create function public.resource_finalize_upload(p_resource_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_user uuid;
  v_client uuid;
  v_actor_type text;
  v_resource public.resources;
  v_intake_state text;
  v_stored boolean;
begin
  if p_resource_id is null then
    return 'not_found';
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return 'not_found';
  end if;
  select r.* into v_resource
  from public.resources as r
  where r.id = p_resource_id
    and r.owner_user_id = v_user
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_resource.visibility_state <> 'pending' then
    return 'not_pending';
  end if;
  if v_resource.resource_kind = 'voice_memo' then
    select l.client_id into v_client from public.lock_current_client() as l;
    if v_client is null then
      return 'not_found';
    end if;
    select i.state into v_intake_state
    from public.intakes as i
    where i.id = v_resource.intake_id
      and i.client_id = v_client
    for share;
    if not found then
      return 'not_found';
    end if;
    if v_intake_state <> 'draft' then
      return 'not_editable';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('voice_memo|' || v_resource.intake_id::text), 7301
    );
    if exists (
      select 1
      from public.resources as other
      where other.intake_id = v_resource.intake_id
        and other.resource_kind = 'voice_memo'
        and other.visibility_state = 'available'
    ) then
      return 'already_exists';
    end if;
    v_actor_type := 'client';
  else
    if public.has_manage_attorney_verification_scope(null, true) is not true then
      return 'denied';
    end if;
    v_actor_type := 'staff';
  end if;
  if to_regclass('storage.objects') is not null then
    execute
      'select exists (select 1 from storage.objects as o where o.bucket_id = $1 and o.name = $2 '
      || 'and o.metadata ->> ''size'' = $3 and o.metadata ->> ''mimetype'' = $4)'
      into v_stored
      using v_resource.storage_bucket, v_resource.storage_object_path,
        v_resource.byte_size::text, v_resource.mime_type;
    if v_stored is not true then
      return 'not_stored';
    end if;
  end if;
  update public.resources
  set visibility_state = 'available'
  where id = v_resource.id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, v_actor_type, 'resource_upload_completed', 'resource', v_resource.id,
    jsonb_build_object('visibility_state', 'pending'),
    jsonb_build_object(
      'resource_kind', v_resource.resource_kind,
      'visibility_state', 'available'
    ),
    null, null, null, statement_timestamp()
  );
  return 'available';
end;
$function$;

-- Fixed outcomes: rejected, not_found, not_pending. The owner of a pending resource whose bytes could not be
-- stored or confirmed marks it rejected; it is never disclosed and never becomes available.
create function public.resource_abandon_upload(p_resource_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_user uuid;
  v_resource public.resources;
begin
  if p_resource_id is null then
    return 'not_found';
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return 'not_found';
  end if;
  select r.* into v_resource
  from public.resources as r
  where r.id = p_resource_id
    and r.owner_user_id = v_user
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_resource.visibility_state <> 'pending' then
    return 'not_pending';
  end if;
  update public.resources
  set visibility_state = 'rejected'
  where id = v_resource.id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user,
    case when v_resource.resource_kind = 'voice_memo' then 'client' else 'staff' end,
    'resource_upload_abandoned', 'resource', v_resource.id,
    jsonb_build_object('visibility_state', 'pending'),
    jsonb_build_object(
      'resource_kind', v_resource.resource_kind,
      'visibility_state', 'rejected'
    ),
    null, null, null, statement_timestamp()
  );
  return 'rejected';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Access authorization (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Fixed outcomes: authorized (with the object path), not_available, held, refused. The caller names the kind
-- it expects; a resource of another kind, an unknown id and every unauthorized caller get the same 'refused',
-- so nothing about a resource the caller may not see is revealed. Authorization is by the relational record and
-- the caller's own identity, never by path knowledge:
-- - voice memo: the client owning its Intake, or a currently valid Sharing Grant recipient who is not an
--   attorney (no attorney sees an Intake resource before acceptance; counsel-gated);
-- - verification artifact: a stepped-up (aal2) staff member holding the verification scope for the
--   jurisdiction of a finding that references it, who is not the attorney that finding concerns. Grants and
--   ownership give no access.
-- An authorized caller then needs an available, active resource without an active Legal Hold. Each
-- authorization appends one audit event in the same transaction.
create function public.resource_authorize_access(p_resource_id uuid, p_resource_kind text)
returns table (outcome text, object_path text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_user uuid;
  v_resource public.resources;
  v_authorized boolean := false;
  v_actor_type text;
  v_jurisdiction uuid;
begin
  if p_resource_id is null
     or p_resource_kind is null
     or p_resource_kind not in ('voice_memo', 'verification_artifact') then
    return query select 'refused'::text, null::text;
    return;
  end if;
  v_user := public.lock_current_active_user();
  if v_user is null then
    return query select 'refused'::text, null::text;
    return;
  end if;
  select r.* into v_resource
  from public.resources as r
  where r.id = p_resource_id
    and r.resource_kind = p_resource_kind
  for share;
  if not found then
    return query select 'refused'::text, null::text;
    return;
  end if;
  if v_resource.resource_kind = 'voice_memo' then
    v_actor_type := 'client';
    v_authorized := exists (
      select 1
      from public.intakes as i
      join public.client_profiles as c on c.id = i.client_id
      where i.id = v_resource.intake_id
        and c.user_id = v_user
    ) or (
      not exists (
        select 1 from public.attorney_profiles as p where p.user_id = v_user
      )
      and exists (
        select 1
        from public.resource_sharing_grants as g
        where g.resource_id = v_resource.id
          and g.recipient_user_id = v_user
          and g.granted_at <= statement_timestamp()
          and (g.expires_at is null or g.expires_at > statement_timestamp())
          and (g.revoked_at is null or g.revoked_at > statement_timestamp())
      )
    );
  else
    v_actor_type := 'staff';
    select e.jurisdiction_id into v_jurisdiction
    from public.verification_evidence as e
    where e.source_type = 'uploaded_artifact'
      and e.source_reference = v_resource.id::text
      and public.has_manage_attorney_verification_scope(e.jurisdiction_id, false)
      and not exists (
        select 1
        from public.verification_evidence_subjects as s
        join public.attorney_profiles as p
          on p.id = coalesce(
            (select l.attorney_id from public.licenses as l where l.id = s.license_id),
            (select x.attorney_id from public.insurance_records as x where x.id = s.insurance_record_id),
            (select d.attorney_id from public.discipline_records as d where d.id = s.discipline_record_id),
            (select a.attorney_id from public.practice_area_authorisations as a
              where a.id = s.practice_area_authorisation_id)
          )
        where s.verification_evidence_id = e.id
          and p.user_id = v_user
      )
    limit 1;
    v_authorized := found;
  end if;
  if not v_authorized then
    return query select 'refused'::text, null::text;
    return;
  end if;
  if v_resource.visibility_state <> 'available' or v_resource.retention_state <> 'active' then
    return query select 'not_available'::text, null::text;
    return;
  end if;
  if public.resource_under_legal_hold(v_resource.id) then
    return query select 'held'::text, null::text;
    return;
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, v_actor_type, 'resource_access_authorized', 'resource', v_resource.id,
    null,
    jsonb_build_object(
      'resource_kind', v_resource.resource_kind,
      'access', 'signed_url'
    ),
    null, null, v_jurisdiction, statement_timestamp()
  );
  return query select 'authorized'::text, v_resource.storage_object_path;
end;
$function$;

revoke all on function public.resource_finalize_upload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_finalize_upload(uuid) to authenticated;

revoke all on function public.resource_abandon_upload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_abandon_upload(uuid) to authenticated;

revoke all on function public.resource_authorize_access(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_authorize_access(uuid, text) to authenticated;

comment on function public.resource_finalize_upload(uuid) is
  'MVP-001 S3: the caller''s own pending resource becomes available once its context is still valid and (where the storage schema exists) its object is stored at its exact path with its recorded size and type. Audited.';

comment on function public.resource_abandon_upload(uuid) is
  'MVP-001 S3: the caller''s own pending resource is marked rejected when its bytes could not be stored or confirmed. Audited.';

comment on function public.resource_authorize_access(uuid, text) is
  'MVP-001 S3 (PS section 29; IMP section 13): decides access to one resource for the caller''s own identity (principal, capability, relationship, active grant, visibility, retention, Legal Hold) and only then answers its object path for a short-lived signed URL. Unknown and unauthorized look alike. Audited.';

comment on table public.resources is
  'Canonical relational substrate for protected stored resources (PS section 29.3). Each resource lives at resources/<id>/original in the private bucket rosuno-private-resources and moves only pending -> available | rejected. Storage-object existence or path knowledge is never authorization: bytes are reached only through resource_authorize_access and a short-lived server-issued signed URL.';
