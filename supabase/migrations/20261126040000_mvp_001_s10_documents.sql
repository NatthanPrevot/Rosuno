-- MVP-001 S10 (4 of 4): consultation documents, their sharing grants and secure access (MVP-001 Packet S10 "documents,
-- voice memos, sharing grants, versioning and secure access"; MBS section 15 deliverable 12B and its failure tests;
-- IMP section 26; TA section 57; PS sections 19, 26.2 and 29; ROS section 12.4; MB section 54).
--
-- No relation, column or policy type is added (Packet rules 8 and 16). The S3 protected Storage foundation
-- (20261119010000 to 20261119040000) is reused and extended forward, never duplicated: the private bucket, the opaque
-- path resources/<id>/original, the server-measured content metadata, the pending -> available | rejected lifecycle, the
-- Legal Hold predicate and the deletion guard, the audited access decision and the short-lived signed URL.
--
-- Upload (TA section 57: upload intent -> authorization -> type and size validation -> safe storage intake ->
-- availability -> sharing authorization). The application has already received the file's bytes on the server,
-- recognized the type from the bytes (PDF, PNG or JPEG: the S3 allowlist of the bucket), enforced the S3 byte ceiling
-- (1 000 000 bytes) and computed the digest; then:
-- 1. document_begin_upload (EXECUTE for authenticated only): a Consultation participant (client any aal; attorney at
--    aal2 with an approved profile; everyone else and unknown ids answer alike, not_found; the communication rule of
--    20261126030000: open while the Consultation is not terminal, after completion only inside the configured window,
--    never after another ending) creates one pending resource of kind document in the Consultation, owned by the
--    uploader, and its document record (document_type unset; version_label 'v1'), audited. No upload count limit is
--    imposed (upload rate limiting is an open owner question, not an implementation default). Outcomes: created (with
--    the resource id), invalid, not_found, denied, closed, window_unavailable;
-- 2. the application stores the bytes at the resource's own path through its server-only storage port;
-- 3. resource_finalize_upload (replaced forward; the voice memo and verification artifact behaviour of 20261119040000
--    is unchanged): for a document, in the canonical lock order (the uploader's own rows, the Consultation FOR SHARE,
--    then the resource FOR UPDATE), the uploader's still pending document becomes available while communication is
--    still open (otherwise not_editable) and, where the storage schema exists, its object is stored at its exact path
--    with its recorded size and type (otherwise not_stored); in the same transaction exactly one Resource Sharing Grant
--    shares it with the Consultation's other participant (context 'consultation', the Consultation, purpose
--    'consultation_document_exchange', granted by the uploader, no expiry; ROS section 12.4) and that participant's
--    Notifications are emitted (document_shared). Audited (upload completed, grant created);
-- resource_abandon_upload (replaced forward) records the uploader's role for a document.
--
-- Access (resource_authorize_access, replaced forward; the voice memo and verification artifact rules are unchanged:
-- no grant or relationship discloses an Intake resource to an attorney). A document is answered only to its uploader or
-- to the recipient of an active (granted, unexpired, unrevoked) consultation grant for it, each a participant of the
-- document's own Consultation, the attorney at aal2 with an approved profile; then the S3 conditions hold: available,
-- retention active, no active Legal Hold (the resource or its Consultation). The recipient's grant rows are first
-- locked FOR SHARE by their identity alone, then read again and compared with clock_timestamp(), so an access and a
-- revocation of the same grant serialize and a revocation that committed while the access waited for the lock is
-- always honoured (even when the access's statement began before the revocation): once a revocation has committed no
-- new access is authorized.
-- Unknown, another attorney, another client and every unauthorized caller get the same refused. Each authorization is
-- audited; the application then signs only that resource's own path for the S3 lifetime (60 seconds). Object paths are
-- never authorization (no storage.objects policy grants anon or authenticated anything).
-- has_resource_metadata_access (replaced forward) also requires aal2 of an attorney for a document's metadata, and pins
-- the house search_path (pg_catalog, pg_temp).
--
-- document_revoke_sharing (EXECUTE for authenticated only): the uploader revokes the active grant of their own document
-- (revoked_at set once; the grant's history stays; audited). Revocation is protective and is accepted whenever the
-- uploader is still a participant, inside or after the communication window. Outcomes: revoked, already_revoked,
-- not_found, denied.
--
-- consultation_documents (EXECUTE for authenticated only; stable security definer; the participant reader rule): the
-- Consultation's available documents the caller uploaded or was ever granted, with type, size, upload time, the
-- uploader's role, whether the caller uploaded it, the grant's state (active | revoked) and whether the caller may open
-- it now (the access decision is still made again by resource_authorize_access). The newest 200, oldest first, each
-- row saying whether older documents exist that are not shown (older_not_shown; the list is never silently
-- truncated).
--
-- Legal Hold (PS section 26.2): documents inherit the S3 predicate and deletion guard: no role deletes a resource or
-- document record under an active hold of the resource or its Consultation, and there is no deletion feature (DOC-DEL
-- unresolved). Versioning: replacing a document with a new version needs the PS-A5 lineage amendment, which is not
-- adopted; no replacement flow exists and every document is version 'v1'.

-- ---------------------------------------------------------------------------
-- Upload start (authenticated only).
-- ---------------------------------------------------------------------------

create function public.document_begin_upload(
  p_consultation_id uuid,
  p_mime_type text,
  p_byte_size bigint,
  p_content_digest text
)
returns table (outcome text, resource_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_participant record;
  v_window record;
  v_resource uuid;
begin
  if p_consultation_id is null
     or p_mime_type is null
     or p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_byte_size is null
     or p_byte_size not between 1 and 1000000
     or p_content_digest is null
     or p_content_digest collate "C" !~ '^sha256:[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select p.* into v_participant from public.communication_participant(p_consultation_id) as p;
  if v_participant.outcome is distinct from 'ok' then
    return query select coalesce(v_participant.outcome, 'not_found'), null::uuid;
    return;
  end if;
  select w.* into v_window from public.communication_window(p_consultation_id, clock_timestamp()) as w;
  if v_window.outcome in ('closed', 'window_unavailable') then
    return query select v_window.outcome, null::uuid;
    return;
  end if;
  if v_window.outcome is distinct from 'open' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  v_resource := gen_random_uuid();
  insert into public.resources (
    id, resource_kind, owner_user_id, intake_id, consultation_id,
    storage_bucket, storage_object_path, mime_type, byte_size, content_digest,
    visibility_state, retention_state
  ) values (
    v_resource, 'document', v_participant.user_id, null, p_consultation_id,
    'rosuno-private-resources', 'resources/' || v_resource::text || '/original',
    p_mime_type, p_byte_size, p_content_digest,
    'pending', 'active'
  );
  insert into public.documents (resource_id, document_type, version_label)
  values (v_resource, null, 'v1');
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_participant.user_id, v_participant.participant_role, 'resource_upload_started', 'resource', v_resource,
    null,
    jsonb_build_object(
      'resource_kind', 'document',
      'visibility_state', 'pending',
      'mime_type', p_mime_type,
      'byte_size', p_byte_size,
      'consultation_id', p_consultation_id
    ),
    null, null, null, statement_timestamp()
  );
  return query select 'created'::text, v_resource;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Upload completion (internal document branch, then resource_finalize_upload replaced forward).
-- ---------------------------------------------------------------------------

-- The document branch of resource_finalize_upload (see the header). Answers available, not_found, denied,
-- not_pending, not_editable or not_stored.
create function public.document_finalize_upload(p_resource_id uuid, p_consultation_id uuid)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_participant record;
  v_resource public.resources;
  v_window record;
  v_stored boolean;
  v_grant uuid;
begin
  select p.* into v_participant from public.communication_participant(p_consultation_id) as p;
  if v_participant.outcome is distinct from 'ok' then
    return coalesce(v_participant.outcome, 'not_found');
  end if;
  select r.* into v_resource
  from public.resources as r
  where r.id = p_resource_id
    and r.owner_user_id = v_participant.user_id
    and r.consultation_id = p_consultation_id
    and r.resource_kind = 'document'
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_resource.visibility_state <> 'pending' then
    return 'not_pending';
  end if;
  select w.* into v_window from public.communication_window(p_consultation_id, clock_timestamp()) as w;
  if v_window.outcome is distinct from 'open' then
    return 'not_editable';
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
    v_participant.user_id, v_participant.participant_role, 'resource_upload_completed', 'resource', v_resource.id,
    jsonb_build_object('visibility_state', 'pending'),
    jsonb_build_object(
      'resource_kind', 'document',
      'visibility_state', 'available'
    ),
    null, null, null, clock_timestamp()
  );
  insert into public.resource_sharing_grants (
    resource_id, recipient_user_id, context_type, context_id, purpose_code, granted_at, expires_at, revoked_at,
    granted_by_user_id
  ) values (
    v_resource.id, v_participant.counterpart_user_id, 'consultation', p_consultation_id,
    'consultation_document_exchange', clock_timestamp(), null, null, v_participant.user_id
  )
  returning id into v_grant;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_participant.user_id, v_participant.participant_role, 'resource_sharing_grant.created', 'resource_sharing_grant',
    v_grant,
    null,
    jsonb_build_object(
      'resource_id', v_resource.id,
      'context_type', 'consultation',
      'context_id', p_consultation_id,
      'purpose_code', 'consultation_document_exchange',
      'state', 'active'
    ),
    null, null, null, clock_timestamp()
  );
  perform public.notification_emit(
    v_participant.counterpart_user_id, 'document_shared', 'resource_sharing_grant.created', v_grant
  );
  return 'available';
end;
$function$;

-- 20261119040000 definition; a document is completed through document_finalize_upload in the canonical lock order
-- (its uploader's own rows and the Consultation before the resource).
create or replace function public.resource_finalize_upload(p_resource_id uuid)
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
  v_kind text;
  v_consultation uuid;
begin
  if p_resource_id is null then
    return 'not_found';
  end if;
  select r.resource_kind, r.consultation_id into v_kind, v_consultation
  from public.resources as r
  where r.id = p_resource_id;
  if v_kind = 'document' then
    return public.document_finalize_upload(p_resource_id, v_consultation);
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
    v_intake_state := public.intake_expire_if_due(v_resource.intake_id);
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
  elsif v_resource.resource_kind = 'verification_artifact' then
    if public.has_manage_attorney_verification_scope(null, true) is not true then
      return 'denied';
    end if;
    v_actor_type := 'staff';
  else
    return 'not_found';
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

-- 20261119010000 definition; the actor of a document's abandonment is its uploader's role in the Consultation.
create or replace function public.resource_abandon_upload(p_resource_id uuid)
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
  v_actor_type text;
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
  v_actor_type := case v_resource.resource_kind
    when 'voice_memo' then 'client'
    when 'verification_artifact' then 'staff'
    else (
      select case when x.client_user_id = v_user then 'client' else 'attorney' end
      from public.consultation_context(v_resource.consultation_id) as x
    )
  end;
  update public.resources
  set visibility_state = 'rejected'
  where id = v_resource.id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user,
    coalesce(v_actor_type, 'client'),
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
-- Access (resource_authorize_access and the metadata predicate, replaced forward).
-- ---------------------------------------------------------------------------

-- 20261119010000 definition with the document kind added (see the header); the voice memo and verification artifact
-- rules are unchanged.
create or replace function public.resource_authorize_access(p_resource_id uuid, p_resource_kind text)
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
  v_context record;
begin
  if p_resource_id is null
     or p_resource_kind is null
     or p_resource_kind not in ('voice_memo', 'verification_artifact', 'document') then
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
  elsif v_resource.resource_kind = 'document' then
    select x.* into v_context from public.consultation_context(v_resource.consultation_id) as x;
    if v_user = v_context.client_user_id then
      v_actor_type := 'client';
    elsif v_user = v_context.attorney_user_id
          and public.current_session_aal2() is true
          and exists (
            select 1 from public.attorney_profiles as p
            where p.id = v_context.attorney_id and p.user_id = v_user and p.profile_state = 'approved'
          ) then
      v_actor_type := 'attorney';
    end if;
    if v_actor_type is not null then
      v_jurisdiction := v_context.jurisdiction_id;
      if v_resource.owner_user_id = v_user then
        v_authorized := true;
      else
        -- The recipient's grants of this document are locked by identity alone (waiting for a revocation in
        -- progress), then read again at clock_timestamp(): a revocation committed while this access waited is honoured.
        perform 1
        from public.resource_sharing_grants as g
        where g.resource_id = v_resource.id
          and g.recipient_user_id = v_user
          and g.context_type = 'consultation'
          and g.context_id = v_resource.consultation_id
          and g.purpose_code = 'consultation_document_exchange'
        for share;
        v_authorized := exists (
          select 1
          from public.resource_sharing_grants as g
          where g.resource_id = v_resource.id
            and g.recipient_user_id = v_user
            and g.context_type = 'consultation'
            and g.context_id = v_resource.consultation_id
            and g.purpose_code = 'consultation_document_exchange'
            and g.granted_at <= clock_timestamp()
            and (g.expires_at is null or g.expires_at > clock_timestamp())
            and (g.revoked_at is null or g.revoked_at > clock_timestamp())
        );
      end if;
    end if;
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

-- 20261119010000 definition; a document's metadata also needs aal2 of an attorney caller; the house search_path.
create or replace function public.has_resource_metadata_access(required_resource_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select exists (
    select 1
    from public.resources as r
    join public.users as caller
      on caller.auth_user_id = auth.uid()
    where r.id = required_resource_id
      and (
        r.resource_kind <> 'document'
        or public.current_session_aal2() is true
        or not exists (
          select 1 from public.attorney_profiles as p where p.user_id = caller.id
        )
      )
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

-- ---------------------------------------------------------------------------
-- Revocation and the document list (authenticated only).
-- ---------------------------------------------------------------------------

create function public.document_revoke_sharing(p_resource_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_kind text;
  v_owner uuid;
  v_consultation uuid;
  v_participant record;
  v_grant uuid;
  v_jurisdiction uuid;
begin
  if p_resource_id is null then
    return 'not_found';
  end if;
  select r.resource_kind, r.owner_user_id, r.consultation_id into v_kind, v_owner, v_consultation
  from public.resources as r
  where r.id = p_resource_id;
  if v_kind is distinct from 'document' then
    return 'not_found';
  end if;
  select p.* into v_participant from public.communication_participant(v_consultation) as p;
  if v_participant.outcome is distinct from 'ok' then
    return coalesce(v_participant.outcome, 'not_found');
  end if;
  if v_participant.user_id is distinct from v_owner then
    return 'not_found';
  end if;
  perform 1 from public.resources as r where r.id = p_resource_id for share;
  update public.resource_sharing_grants as g
  set revoked_at = clock_timestamp()
  where g.id = (
    select x.id
    from public.resource_sharing_grants as x
    where x.resource_id = p_resource_id
      and x.context_type = 'consultation'
      and x.context_id = v_consultation
      and x.revoked_at is null
    order by x.granted_at, x.id
    limit 1
    for update
  )
  returning g.id into v_grant;
  if v_grant is null then
    return 'already_revoked';
  end if;
  select x.jurisdiction_id into v_jurisdiction from public.consultation_context(v_consultation) as x;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_participant.user_id, v_participant.participant_role, 'resource_sharing_grant.revoked', 'resource_sharing_grant',
    v_grant,
    jsonb_build_object('state', 'active'),
    jsonb_build_object(
      'state', 'revoked',
      'resource_id', p_resource_id,
      'context_type', 'consultation',
      'context_id', v_consultation
    ),
    null, null, v_jurisdiction, clock_timestamp()
  );
  return 'revoked';
end;
$function$;

create function public.consultation_documents(p_consultation_id uuid)
returns table (
  resource_id uuid,
  mime_type text,
  byte_size bigint,
  created_at timestamptz,
  uploaded_by text,
  mine boolean,
  sharing text,
  accessible boolean,
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
  -- The newest 201 (one more than shown, so the answer says whether older documents exist), shown oldest first.
  return query
    with recent as (
      select
        r.id,
        r.mime_type,
        r.byte_size,
        r.created_at,
        r.owner_user_id,
        g.recipient_user_id as recipient,
        (
          g.granted_at <= statement_timestamp()
          and (g.expires_at is null or g.expires_at > statement_timestamp())
          and (g.revoked_at is null or g.revoked_at > statement_timestamp())
        ) as active
      from public.resources as r
      join lateral (
        select x.*
        from public.resource_sharing_grants as x
        where x.resource_id = r.id
          and x.context_type = 'consultation'
          and x.context_id = r.consultation_id
        order by x.granted_at desc, x.id desc
        limit 1
      ) as g on true
      where r.consultation_id = p_consultation_id
        and r.resource_kind = 'document'
        and r.visibility_state = 'available'
        and (r.owner_user_id = v_reader.user_id or g.recipient_user_id = v_reader.user_id)
      order by r.created_at desc, r.id desc
      limit 201
    ),
    shown as (
      select x.*
      from recent as x
      order by x.created_at desc, x.id desc
      limit 200
    )
    select
      d.id,
      d.mime_type,
      d.byte_size,
      d.created_at,
      case
        when d.owner_user_id = v_reader.user_id then v_reader.participant_role
        when v_reader.participant_role = 'client' then 'attorney'
        else 'client'
      end,
      d.owner_user_id = v_reader.user_id,
      case when d.active then 'active' else 'revoked' end,
      d.owner_user_id = v_reader.user_id or (d.active and d.recipient = v_reader.user_id),
      (select count(*) from recent) > 200
    from shown as d
    order by d.created_at, d.id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  revoke all on function public.document_finalize_upload(uuid, uuid) from public, anon, authenticated, service_role;
  foreach v_signature in array array[
    'public.document_begin_upload(uuid, text, bigint, text)',
    'public.resource_finalize_upload(uuid)',
    'public.resource_abandon_upload(uuid)',
    'public.resource_authorize_access(uuid, text)',
    'public.has_resource_metadata_access(uuid)',
    'public.document_revoke_sharing(uuid)',
    'public.consultation_documents(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

comment on function public.document_begin_upload(uuid, text, bigint, text) is
  'MVP-001 S10: starts one document upload for a Consultation participant (client any aal; attorney aal2) inside the communication window, from server-measured metadata (PDF, PNG or JPEG; at most 1 000 000 bytes; digest): a pending resource at its own opaque path and its document record (v1), audited. Outcomes: created, invalid, not_found, denied, closed, window_unavailable.';
comment on function public.resource_finalize_upload(uuid) is
  'MVP-001 S3 and S10: the caller''s own pending resource becomes available once its context is still valid and (where the storage schema exists) its object is stored at its exact path with its recorded size and type; a document is then shared with the Consultation''s other participant through one grant and that participant is notified. Audited.';
comment on function public.resource_abandon_upload(uuid) is
  'MVP-001 S3 and S10: the caller''s own pending resource is marked rejected when its bytes could not be stored or confirmed. Audited with the uploader''s role.';
comment on function public.resource_authorize_access(uuid, text) is
  'MVP-001 S3 and S10 (PS section 29; IMP section 13): decides access to one resource for the caller''s own identity (principal, capability, relationship, active grant locked FOR SHARE and read again at clock time, visibility, retention, Legal Hold) and only then answers its object path for a short-lived signed URL. A document: its uploader or the recipient of an active consultation grant, each a participant of its Consultation, the attorney at aal2. Unknown and unauthorized look alike. Audited.';
comment on function public.document_revoke_sharing(uuid) is
  'MVP-001 S10: the uploader revokes the active consultation grant of their own document (history preserved; audited). Outcomes: revoked, already_revoked, not_found, denied.';
comment on function public.consultation_documents(uuid) is
  'MVP-001 S10: the available documents of a Consultation the caller uploaded or was granted (client any aal; attorney aal2), with type, size, time, uploader role, grant state and whether the caller may open it now; the newest 200, oldest first, each row saying whether older documents exist that are not shown.';
