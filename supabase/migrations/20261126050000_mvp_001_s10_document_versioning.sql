-- MVP-001 S10 (5 of 5): consultation document versioning under PS-A5 (MVP-001 Packet S10 "documents, voice memos,
-- sharing grants, versioning and secure access"; MBS section 15 deliverable 12B: replacing a document creates a new
-- version rather than destroying historical truth; PS-A5, owner-adopted; TA section 57; PS sections 19, 26.2 and 29;
-- ROS section 12.4).
--
-- Schema (PS-A5 only; no other relation, column or policy type, Packet rules 8 and 16): one nullable column
-- documents.supersedes_document_id, a self-reference to the Document a new version supersedes (on update and on delete
-- restrict), with a check that a Document never supersedes itself and a partial unique index so that at most one
-- Document supersedes a given Document (a linear history). Existing rows keep null: each is version v1 of its own
-- history. This migration inserts, updates and deletes no row.
--
-- Rules enforced in the database for every role, the owner included (documents_version_guard, before insert; the S3
-- documents_record_guard already refuses every update and guards every delete):
-- - the lineage reference is written only when a Document is inserted and never changes (the S3 guard refuses any
--   update of a Document; the foreign key restricts deleting a superseded Document);
-- - a superseding Document belongs to the same document and context: its Resource has the same Consultation and the
--   same Intake as the superseded Document's Resource, and it has the same document_type (both null or equal); both
--   Resources are consultation documents (voice memos and verification artifacts are never versioned);
-- - a superseding Document exists only with an available Resource and supersedes only a Document whose Resource is
--   available, so an abandoned, rejected or failed replacement upload never takes the single successor slot;
-- - version_label is assigned by the server, never supplied: v1 without a predecessor, otherwise the predecessor's
--   number plus one (v2, v3, ...); a predecessor without a label is v1 of its own history; any supplied label is
--   refused, and a predecessor whose label is not of the form v<n> cannot be superseded (fails closed);
-- - nothing about the superseded Document or its Resource changes: both stay readable under their existing
--   authorization with their content, metadata, sharing grants and audit history; the current version is the Document
--   no other Document supersedes (no column records currentness).
--
-- The replacement flow (authenticated only; the S3 and S10 pipeline, the same participant, window and validation rules
-- as a new S10 upload; the uploader of the current version only):
-- 1. document_begin_replacement(Consultation, Document, ...): the uploader of an available, current consultation
--    document of exactly the named Consultation (client any aal; attorney at aal2 with an approved profile; everyone
--    else, unknown ids and a Document of another Consultation answer alike, not_found) starts one pending resource of
--    kind document in that Consultation from server-measured metadata (PDF, PNG or JPEG; 1 to 1 000 000 bytes;
--    digest), at its own opaque path, with no Document row yet; the start is audited with the Document it would
--    replace. Outcomes: created (with the resource id), invalid, not_found, denied, closed, window_unavailable,
--    not_current (a later version already exists);
-- 2. the application stores the bytes at the resource's own path through its server-only storage port;
-- 3. document_finalize_replacement(Consultation, resource, Document): for a pending resource of exactly the named
--    Consultation, bound to its start (below), in the canonical lock order (the uploader's own rows, the Consultation FOR SHARE,
--    the new resource FOR UPDATE, then the superseded Document FOR UPDATE, which serializes every replacement of the
--    same version), while communication is still open (otherwise not_editable) and, where the storage schema exists,
--    the object is stored at its exact path (otherwise not_stored), the new resource becomes available, its Document
--    row is inserted superseding the predecessor (label assigned by the guard), and in the same transaction the new
--    version gets its own recipient-specific grant to the Consultation's other participant (consultation context,
--    purpose consultation_document_exchange, granted by the uploader, no expiry) and that participant's document_shared
--    Notifications. The predecessor's grants are untouched. A replacement that finds the predecessor already
--    superseded (a concurrent replacement won) answers already_superseded and its own pending resource ends rejected
--    in the same call (audited), so nothing partial remains. Outcomes: available, already_superseded, not_found,
--    denied, not_pending, not_editable, not_stored. An abandoned replacement (resource_abandon_upload) ends rejected
--    and takes no slot.
-- The start/finish binding (an owner-visible design choice: PS-A5 admits no column to record it): completion reads the
-- immutable resource_upload_started audit event of the same flow, which must exist for exactly this pending resource,
-- name exactly this Document as the one it replaces and have been recorded for the caller as its actor; the resource
-- must also have no Document row yet. Absent or different, the binding fails closed: not_found, nothing changes.
-- resource_finalize_upload completes plain uploads only: a pending document without its v1 Document row (a replacement
-- in progress) is not_found there (document_finalize_upload replaced forward); document_begin_upload is replaced
-- forward so its v1 label comes from the guard.
--
-- Per-version sharing and access (PS-A5 sharing rule; unchanged S10 functions): a grant names one Resource and one
-- recipient, so a grant on an earlier version never extends to a later one; resource_authorize_access decides per
-- version (the uploader, or the recipient of an active consultation grant on that version's resource, each a
-- participant of its Consultation, the attorney at aal2; available, retention active, no active Legal Hold on the
-- resource or its Consultation); document_revoke_sharing revokes one version's grant only. Retention, disposition and
-- Legal Hold are unchanged: a hold on the Consultation stops access to every version and deletion of any.
--
-- Reads (authenticated only; stable security definer; the S10 participant reader rule):
-- - consultation_documents (re-created with four more columns) answers the current version of each lineage the caller
--   may know about, with its Document id, the lineage's first Document id (a stable identity across replacements), its
--   version label and whether an earlier version of the lineage is still shared (for the uploader: with the other
--   participant; for a recipient: with them);
-- - document_versions answers one document's lineage in version order (Document and resource ids, label, type, size,
--   time, the uploader's role, whether it is the current version, the grant state and whether the caller may open it
--   now), only the versions the caller may know about: the uploader their whole lineage, a recipient the versions they
--   hold or held a grant for (a revoked one marked revoked); at most the newest 500 of them, with a flag on every row
--   saying whether older versions exist that are not shown (never silently truncated). The Document must belong to
--   the given Consultation; unknown, unauthorized and foreign ids answer alike: no row.
-- Lineages are walked without a depth bound: they are acyclic by construction (a Document only ever supersedes an
-- existing, older Document, written once at insert and never changed), so every walk ends at the first version. The
-- list stays linear: candidate rows are the current versions only (an index probe each on the one-successor index), the
-- newest 201 are cut first, and only the at most 200 shown rows walk their lineages (primary-key steps), so a page costs
-- at most the number of versions of the lineages it shows, never a walk per version per row.

-- ---------------------------------------------------------------------------
-- Schema: the PS-A5 lineage column, its constraints and its index.
-- ---------------------------------------------------------------------------

alter table public.documents
  add column supersedes_document_id uuid null;

alter table public.documents
  add constraint documents_supersedes_document_id_fkey
    foreign key (supersedes_document_id)
    references public.documents (id)
    on update restrict
    on delete restrict,
  add constraint documents_supersedes_not_self_check
    check (supersedes_document_id is null or supersedes_document_id <> id);

create unique index documents_one_successor_idx
  on public.documents (supersedes_document_id)
  where supersedes_document_id is not null;

comment on column public.documents.supersedes_document_id is
  'MVP-001 S10 (PS-A5): the Document this version supersedes; null for v1 of a history. Written only on insert, never changed; at most one Document supersedes a given Document, never itself; same Consultation, Intake and document_type. The current version is the Document no other supersedes.';

-- ---------------------------------------------------------------------------
-- Guard: lineage, context and server-assigned labels (every role).
-- ---------------------------------------------------------------------------

create function public.document_version_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_predecessor public.documents;
  v_resource public.resources;
  v_predecessor_resource public.resources;
  v_number integer;
begin
  if new.version_label is not null then
    raise exception 'a document''s version label is assigned by the server'
      using errcode = '23514';
  end if;
  if new.supersedes_document_id is null then
    new.version_label := 'v1';
    return new;
  end if;
  if new.supersedes_document_id = new.id then
    raise exception 'a document never supersedes itself'
      using errcode = '23514';
  end if;
  select d.* into v_predecessor
  from public.documents as d
  where d.id = new.supersedes_document_id;
  if not found then
    raise exception 'the superseded document does not exist'
      using errcode = '23503';
  end if;
  select r.* into v_resource from public.resources as r where r.id = new.resource_id;
  select r.* into v_predecessor_resource from public.resources as r where r.id = v_predecessor.resource_id;
  if v_resource.resource_kind is distinct from 'document'
     or v_predecessor_resource.resource_kind is distinct from 'document' then
    raise exception 'only consultation documents have versions'
      using errcode = '23514';
  end if;
  if v_resource.consultation_id is distinct from v_predecessor_resource.consultation_id
     or v_resource.intake_id is distinct from v_predecessor_resource.intake_id
     or new.document_type is distinct from v_predecessor.document_type then
    raise exception 'a new version keeps its document''s Consultation, Intake and document type'
      using errcode = '23514';
  end if;
  if v_resource.visibility_state is distinct from 'available'
     or v_predecessor_resource.visibility_state is distinct from 'available' then
    raise exception 'a version supersedes an available version with an available resource'
      using errcode = '23514';
  end if;
  if v_predecessor.version_label is null then
    v_number := 1;
  elsif v_predecessor.version_label collate "C" ~ '^v[1-9][0-9]{0,8}$' then
    v_number := substr(v_predecessor.version_label, 2)::integer;
  else
    raise exception 'the superseded document has no version number'
      using errcode = '23514';
  end if;
  new.version_label := 'v' || (v_number + 1)::text;
  return new;
end;
$function$;

create trigger documents_version_guard
before insert on public.documents
for each row
execute function public.document_version_guard();

-- ---------------------------------------------------------------------------
-- Plain uploads (replaced forward: the v1 label comes from the guard; completion only for a v1 Document).
-- ---------------------------------------------------------------------------

-- 20261126040000 definition; the Document row no longer names its label (the guard assigns v1).
create or replace function public.document_begin_upload(
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
  insert into public.documents (resource_id, document_type)
  values (v_resource, null);
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

-- One version's own recipient-specific grant to the Consultation's other participant, audited, with that
-- participant's document_shared Notifications (the S10 outbox). Answers the grant id.
create function public.document_share_version(
  p_resource_id uuid,
  p_consultation_id uuid,
  p_uploader uuid,
  p_uploader_role text,
  p_recipient uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_grant uuid;
begin
  insert into public.resource_sharing_grants (
    resource_id, recipient_user_id, context_type, context_id, purpose_code, granted_at, expires_at, revoked_at,
    granted_by_user_id
  ) values (
    p_resource_id, p_recipient, 'consultation', p_consultation_id,
    'consultation_document_exchange', clock_timestamp(), null, null, p_uploader
  )
  returning id into v_grant;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    p_uploader, p_uploader_role, 'resource_sharing_grant.created', 'resource_sharing_grant',
    v_grant,
    null,
    jsonb_build_object(
      'resource_id', p_resource_id,
      'context_type', 'consultation',
      'context_id', p_consultation_id,
      'purpose_code', 'consultation_document_exchange',
      'state', 'active'
    ),
    null, null, null, clock_timestamp()
  );
  perform public.notification_emit(
    p_recipient, 'document_shared', 'resource_sharing_grant.created', v_grant
  );
  return v_grant;
end;
$function$;

-- 20261126040000 definition with one more rule: only a pending v1 Document (its Document row exists and supersedes
-- nothing) completes here; a replacement in progress completes only through document_finalize_replacement. The
-- sharing step is document_share_version (the same rows and order as before).
create or replace function public.document_finalize_upload(p_resource_id uuid, p_consultation_id uuid)
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
  if not exists (
    select 1 from public.documents as d
    where d.resource_id = v_resource.id
      and d.supersedes_document_id is null
  ) then
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
  perform public.document_share_version(
    v_resource.id, p_consultation_id, v_participant.user_id, v_participant.participant_role,
    v_participant.counterpart_user_id
  );
  return 'available';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Replacement (authenticated only).
-- ---------------------------------------------------------------------------

create function public.document_begin_replacement(
  p_consultation_id uuid,
  p_document_id uuid,
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
  v_document public.documents;
  v_current public.resources;
  v_participant record;
  v_window record;
  v_resource uuid;
begin
  if p_consultation_id is null
     or p_document_id is null
     or p_mime_type is null
     or p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_byte_size is null
     or p_byte_size not between 1 and 1000000
     or p_content_digest is null
     or p_content_digest collate "C" !~ '^sha256:[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select d.* into v_document from public.documents as d where d.id = p_document_id;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select r.* into v_current from public.resources as r where r.id = v_document.resource_id;
  if v_current.resource_kind is distinct from 'document'
     or v_current.consultation_id is distinct from p_consultation_id then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select p.* into v_participant from public.communication_participant(v_current.consultation_id) as p;
  if v_participant.outcome is distinct from 'ok' then
    return query select coalesce(v_participant.outcome, 'not_found'), null::uuid;
    return;
  end if;
  if v_current.owner_user_id is distinct from v_participant.user_id
     or v_current.visibility_state is distinct from 'available' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select w.* into v_window from public.communication_window(v_current.consultation_id, clock_timestamp()) as w;
  if v_window.outcome in ('closed', 'window_unavailable') then
    return query select v_window.outcome, null::uuid;
    return;
  end if;
  if v_window.outcome is distinct from 'open' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if exists (select 1 from public.documents as x where x.supersedes_document_id = v_document.id) then
    return query select 'not_current'::text, null::uuid;
    return;
  end if;
  v_resource := gen_random_uuid();
  insert into public.resources (
    id, resource_kind, owner_user_id, intake_id, consultation_id,
    storage_bucket, storage_object_path, mime_type, byte_size, content_digest,
    visibility_state, retention_state
  ) values (
    v_resource, 'document', v_participant.user_id, null, v_current.consultation_id,
    'rosuno-private-resources', 'resources/' || v_resource::text || '/original',
    p_mime_type, p_byte_size, p_content_digest,
    'pending', 'active'
  );
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
      'consultation_id', v_current.consultation_id,
      'replaces_document_id', v_document.id
    ),
    null, null, null, clock_timestamp()
  );
  return query select 'created'::text, v_resource;
end;
$function$;

create function public.document_finalize_replacement(
  p_consultation_id uuid,
  p_resource_id uuid,
  p_document_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_consultation uuid;
  v_kind text;
  v_participant record;
  v_resource public.resources;
  v_window record;
  v_stored boolean;
  v_predecessor public.documents;
  v_predecessor_resource public.resources;
  v_document uuid;
  v_label text;
begin
  if p_consultation_id is null or p_resource_id is null or p_document_id is null then
    return 'not_found';
  end if;
  select r.resource_kind, r.consultation_id into v_kind, v_consultation
  from public.resources as r
  where r.id = p_resource_id;
  if v_kind is distinct from 'document' or v_consultation is distinct from p_consultation_id then
    return 'not_found';
  end if;
  select p.* into v_participant from public.communication_participant(v_consultation) as p;
  if v_participant.outcome is distinct from 'ok' then
    return coalesce(v_participant.outcome, 'not_found');
  end if;
  select r.* into v_resource
  from public.resources as r
  where r.id = p_resource_id
    and r.owner_user_id = v_participant.user_id
    and r.consultation_id = v_consultation
    and r.resource_kind = 'document'
  for update;
  if not found then
    return 'not_found';
  end if;
  -- The binding (see the header): no Document row yet, and the immutable start event of this flow, recorded for the
  -- caller, names exactly this Document. Absent or different: not_found.
  if exists (select 1 from public.documents as d where d.resource_id = v_resource.id)
     or not exists (
       select 1 from public.audit_events as a
       where a.resource_type = 'resource'
         and a.resource_id = v_resource.id
         and a.action_code = 'resource_upload_started'
         and a.actor_user_id = v_participant.user_id
         and a.after_snapshot ->> 'replaces_document_id' = p_document_id::text
     ) then
    return 'not_found';
  end if;
  if v_resource.visibility_state <> 'pending' then
    return 'not_pending';
  end if;
  select w.* into v_window from public.communication_window(v_consultation, clock_timestamp()) as w;
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
  -- Every replacement of one version serializes here.
  select d.* into v_predecessor
  from public.documents as d
  where d.id = p_document_id
  for update;
  if not found then
    return 'not_found';
  end if;
  select r.* into v_predecessor_resource
  from public.resources as r
  where r.id = v_predecessor.resource_id;
  if v_predecessor_resource.resource_kind is distinct from 'document'
     or v_predecessor_resource.owner_user_id is distinct from v_participant.user_id
     or v_predecessor_resource.consultation_id is distinct from v_consultation
     or v_predecessor_resource.visibility_state is distinct from 'available' then
    return 'not_found';
  end if;
  if exists (select 1 from public.documents as x where x.supersedes_document_id = v_predecessor.id) then
    update public.resources
    set visibility_state = 'rejected'
    where id = v_resource.id;
    insert into public.audit_events (
      actor_user_id, actor_type, action_code, resource_type, resource_id,
      before_snapshot, after_snapshot, reason_code, policy_references,
      jurisdiction_id, occurred_at
    ) values (
      v_participant.user_id, v_participant.participant_role, 'resource_upload_abandoned', 'resource', v_resource.id,
      jsonb_build_object('visibility_state', 'pending'),
      jsonb_build_object(
        'resource_kind', 'document',
        'visibility_state', 'rejected',
        'replaces_document_id', v_predecessor.id
      ),
      'already_superseded', null, null, clock_timestamp()
    );
    return 'already_superseded';
  end if;
  update public.resources
  set visibility_state = 'available'
  where id = v_resource.id;
  insert into public.documents (resource_id, document_type, supersedes_document_id)
  values (v_resource.id, v_predecessor.document_type, v_predecessor.id)
  returning id, version_label into v_document, v_label;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_participant.user_id, v_participant.participant_role, 'resource_upload_completed', 'resource', v_resource.id,
    jsonb_build_object('visibility_state', 'pending'),
    jsonb_build_object(
      'resource_kind', 'document',
      'visibility_state', 'available',
      'document_id', v_document,
      'supersedes_document_id', v_predecessor.id,
      'version_label', v_label
    ),
    null, null, null, clock_timestamp()
  );
  perform public.document_share_version(
    v_resource.id, v_consultation, v_participant.user_id, v_participant.participant_role,
    v_participant.counterpart_user_id
  );
  return 'available';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reads (authenticated only): the current versions and one document's history.
-- ---------------------------------------------------------------------------

-- 20261126040000 definition re-created with the Document id, the lineage's first Document id, the version label and
-- whether an earlier version is still shared, answering only the current version of each lineage (the Document no
-- other Document supersedes).
drop function public.consultation_documents(uuid);

create function public.consultation_documents(p_consultation_id uuid)
returns table (
  resource_id uuid,
  document_id uuid,
  lineage_id uuid,
  version_label text,
  mime_type text,
  byte_size bigint,
  created_at timestamptz,
  uploaded_by text,
  mine boolean,
  sharing text,
  accessible boolean,
  earlier_versions_shared boolean,
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
  -- The current versions only, newest 201 first (one more than shown, so the answer says whether older documents
  -- exist); only the at most 200 shown rows then walk their lineages (see the header), shown oldest first.
  return query
    with recent as materialized (
      select
        r.id,
        doc.id as doc_id,
        doc.version_label as doc_label,
        doc.supersedes_document_id as doc_previous,
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
      join public.documents as doc on doc.resource_id = r.id
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
        and not exists (
          select 1 from public.documents as successor where successor.supersedes_document_id = doc.id
        )
      order by r.created_at desc, r.id desc
      limit 201
    ),
    shown as materialized (
      select x.*
      from recent as x
      order by x.created_at desc, x.id desc
      limit 200
    )
    select
      d.id,
      d.doc_id,
      lineage.root,
      d.doc_label,
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
      lineage.earlier_shared,
      (select count(*) from recent) > 200
    from shown as d
    cross join lateral (
      -- The shown version's earlier versions (no depth bound: lineages are acyclic by construction).
      with recursive earlier (id, resource, previous) as (
        select e.id, e.resource_id, e.supersedes_document_id
        from public.documents as e
        where e.id = d.doc_previous
        union all
        select e.id, e.resource_id, e.supersedes_document_id
        from earlier as a
        join public.documents as e on e.id = a.previous
      )
      select
        coalesce((select a.id from earlier as a where a.previous is null), d.doc_id) as root,
        exists (
          select 1
          from earlier as a
          join public.resource_sharing_grants as grant_row on grant_row.resource_id = a.resource
          where grant_row.context_type = 'consultation'
            and grant_row.context_id = p_consultation_id
            and (d.owner_user_id = v_reader.user_id or grant_row.recipient_user_id = v_reader.user_id)
            and grant_row.granted_at <= statement_timestamp()
            and (grant_row.expires_at is null or grant_row.expires_at > statement_timestamp())
            and (grant_row.revoked_at is null or grant_row.revoked_at > statement_timestamp())
        ) as earlier_shared
    ) as lineage
    order by d.created_at, d.id;
end;
$function$;

create function public.document_versions(p_consultation_id uuid, p_document_id uuid)
returns table (
  document_id uuid,
  resource_id uuid,
  version_label text,
  mime_type text,
  byte_size bigint,
  created_at timestamptz,
  uploaded_by text,
  mine boolean,
  is_current boolean,
  sharing text,
  accessible boolean,
  older_versions_not_shown boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_reader record;
  v_root uuid;
begin
  if p_consultation_id is null or p_document_id is null then
    return;
  end if;
  if not exists (
    select 1
    from public.documents as d
    join public.resources as r on r.id = d.resource_id
    where d.id = p_document_id
      and r.resource_kind = 'document'
      and r.consultation_id = p_consultation_id
      and r.visibility_state = 'available'
  ) then
    return;
  end if;
  select r.* into v_reader from public.communication_reader(p_consultation_id) as r;
  if v_reader.user_id is null then
    return;
  end if;
  -- The lineage's first version (no depth bound: lineages are acyclic by construction).
  with recursive ancestry (id, supersedes) as (
    select d.id, d.supersedes_document_id
    from public.documents as d
    where d.id = p_document_id
    union all
    select d.id, d.supersedes_document_id
    from ancestry as a
    join public.documents as d on d.id = a.supersedes
  )
  select a.id into v_root from ancestry as a where a.supersedes is null;
  -- The versions the caller may know about, numbered from the first; the newest 500 are answered in version order,
  -- each row saying whether older ones exist that are not shown.
  return query
    with recursive lineage (id, resource, label, number) as (
      select d.id, d.resource_id, d.version_label, 1::bigint
      from public.documents as d
      where d.id = v_root
      union all
      select d.id, d.resource_id, d.version_label, l.number + 1
      from lineage as l
      join public.documents as d on d.supersedes_document_id = l.id
    ),
    versions as materialized (
      select
        l.id,
        l.resource,
        l.label,
        l.number,
        r.mime_type,
        r.byte_size,
        r.created_at,
        r.owner_user_id,
        not exists (
          select 1 from public.documents as successor where successor.supersedes_document_id = l.id
        ) as current_version,
        g.recipient_user_id as recipient,
        (
          g.granted_at <= statement_timestamp()
          and (g.expires_at is null or g.expires_at > statement_timestamp())
          and (g.revoked_at is null or g.revoked_at > statement_timestamp())
        ) as active
      from lineage as l
      join public.resources as r on r.id = l.resource
      left join lateral (
        select x.*
        from public.resource_sharing_grants as x
        where x.resource_id = r.id
          and x.context_type = 'consultation'
          and x.context_id = r.consultation_id
        order by x.granted_at desc, x.id desc
        limit 1
      ) as g on true
      where r.resource_kind = 'document'
        and r.consultation_id = p_consultation_id
        and r.visibility_state = 'available'
        and (r.owner_user_id = v_reader.user_id or g.recipient_user_id = v_reader.user_id)
    ),
    newest as materialized (
      select v.*
      from versions as v
      order by v.number desc
      limit 500
    )
    select
      v.id,
      v.resource,
      v.label,
      v.mime_type,
      v.byte_size,
      v.created_at,
      case
        when v.owner_user_id = v_reader.user_id then v_reader.participant_role
        when v_reader.participant_role = 'client' then 'attorney'
        else 'client'
      end,
      v.owner_user_id = v_reader.user_id,
      v.current_version,
      case when v.recipient is null then null when v.active then 'active' else 'revoked' end,
      v.owner_user_id = v_reader.user_id or (coalesce(v.active, false) and v.recipient = v_reader.user_id),
      (select count(*) from versions) > 500
    from newest as v
    where exists (select 1 from versions as asked where asked.id = p_document_id)
    order by v.number;
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
    'public.document_version_guard()',
    'public.document_share_version(uuid, uuid, uuid, text, uuid)',
    'public.document_finalize_upload(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.document_begin_upload(uuid, text, bigint, text)',
    'public.document_begin_replacement(uuid, uuid, text, bigint, text)',
    'public.document_finalize_replacement(uuid, uuid, uuid)',
    'public.consultation_documents(uuid)',
    'public.document_versions(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

comment on function public.document_version_guard() is
  'MVP-001 S10 (PS-A5): a new Document supersedes at most an available consultation document of the same Consultation, Intake and document type, with an available resource of its own; its version label is assigned here (v1, or the predecessor''s number plus one) and never supplied. Executable by no API role.';
comment on function public.document_share_version(uuid, uuid, uuid, text, uuid) is
  'Internal (MVP-001 S10): one version''s own recipient-specific consultation grant to the other participant, audited, with that participant''s document_shared Notifications. Executable by no API role.';
comment on function public.document_begin_upload(uuid, text, bigint, text) is
  'MVP-001 S10: starts one document upload for a Consultation participant (client any aal; attorney aal2) inside the communication window, from server-measured metadata (PDF, PNG or JPEG; at most 1 000 000 bytes; digest): a pending resource at its own opaque path and its v1 Document record (label assigned by the guard), audited. Outcomes: created, invalid, not_found, denied, closed, window_unavailable.';
comment on function public.document_begin_replacement(uuid, uuid, text, bigint, text) is
  'MVP-001 S10 (PS-A5): the uploader of an available, current consultation document of the named Consultation (client any aal; attorney aal2) starts a replacement upload inside the communication window: a pending resource in the same Consultation at its own opaque path, no Document row yet; audited with the Document it would replace. Outcomes: created, invalid, not_found, denied, closed, window_unavailable, not_current.';
comment on function public.document_finalize_replacement(uuid, uuid, uuid) is
  'MVP-001 S10 (PS-A5): completes a replacement upload of the named Consultation bound to its own start (the immutable start audit event, recorded for the caller, naming this Document; fails closed): the new resource becomes available and its Document supersedes the still current predecessor (server-assigned label), with its own grant to the other participant and that participant''s Notifications; the predecessor and its grants are untouched. A lost race answers already_superseded and rejects the pending upload. Outcomes: available, already_superseded, not_found, denied, not_pending, not_editable, not_stored.';
comment on function public.consultation_documents(uuid) is
  'MVP-001 S10: the current version of each document lineage of a Consultation the caller uploaded or was granted (client any aal; attorney aal2), with its Document id, its lineage''s first Document id, version label and whether an earlier version is still shared, type, size, time, uploader role, grant state and whether the caller may open it now; the newest 200, oldest first, each row saying whether older documents exist that are not shown.';
comment on function public.document_versions(uuid, uuid) is
  'MVP-001 S10 (PS-A5): one document''s version history in its Consultation for a participant (client any aal; attorney aal2): the uploader sees the whole lineage, a recipient the versions they hold or held a grant for; label, type, size, time, uploader role, current flag, grant state and whether the caller may open it now; the newest 500 in version order, each row saying whether older versions exist that are not shown. Unknown, unauthorized and foreign ids answer alike: no row.';
