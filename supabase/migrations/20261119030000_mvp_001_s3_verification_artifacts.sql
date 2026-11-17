-- MVP-001 S3 (3 of 3): verification-evidence upload (MVP-001 Packet S3 "verification-evidence upload (M4)";
-- PS sections 11.1, 19.1, 29 and 30.4; TA section 21).
--
-- No relation or column is added (Packet rule 16). A staff member holding the verification scope for a
-- professional record's jurisdiction may upload one artifact (PDF, PNG or JPEG, received and checked by the
-- application on the server) while recording a source-grounded finding for that record. The artifact is a
-- resource of kind verification_artifact, owned by the uploading staff member, stored at its own opaque path in
-- the private bucket and completed with resource_finalize_upload (20261119010000). The finding's evidence refers
-- to it through the existing source fields: source_type 'uploaded_artifact' and source_reference the resource
-- id. The database validates that reference on every evidence row that makes it: the resource exists, is a
-- verification artifact, is available and active, was uploaded by the reviewer recording the finding, that
-- reviewer still holds the verification scope for the finding's jurisdiction, and no other finding refers to
-- it. The evidence functions keep their outcomes: a failed check is 'invalid' and a second reference 'conflict'.
-- Only staff holding the verification scope for that finding's jurisdiction obtain access
-- (resource_authorize_access); the attorney concerned, clients, and grant recipients never do.

create function public.resource_begin_verification_artifact(
  p_subject_kind text,
  p_subject_id uuid,
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
  v_attorney uuid;
  v_jurisdiction uuid;
  v_staff uuid;
  v_target public.attorney_profiles;
  v_resource uuid;
begin
  if p_subject_kind is null
     or p_subject_kind not in (
       'license', 'insurance', 'discipline', 'practice_area_authorisation'
     )
     or p_subject_id is null
     or p_mime_type is null
     or p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_byte_size is null
     or p_byte_size not between 1 and 1000000
     or p_content_digest is null
     or p_content_digest collate "C" !~ '^sha256:[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select r.record_attorney, r.record_jurisdiction
  into v_attorney, v_jurisdiction
  from public.professional_record_of(p_subject_kind, p_subject_id, 'none') as r;
  if v_attorney is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  v_staff := public.lock_current_verification_staff(v_jurisdiction);
  if v_staff is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  select p.* into v_target
  from public.attorney_profiles as p
  where p.id = v_attorney
  for share;
  if not found or v_target.user_id = v_staff then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  if v_target.profile_state not in ('under_review', 'approved', 'suspended') then
    return query select 'locked'::text, null::uuid;
    return;
  end if;
  v_resource := gen_random_uuid();
  insert into public.resources (
    id, resource_kind, owner_user_id, intake_id, consultation_id,
    storage_bucket, storage_object_path, mime_type, byte_size, content_digest,
    visibility_state, retention_state
  ) values (
    v_resource, 'verification_artifact', v_staff, null, null,
    'rosuno-private-resources', 'resources/' || v_resource::text || '/original',
    p_mime_type, p_byte_size, p_content_digest,
    'pending', 'active'
  );
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'resource_upload_started', 'resource', v_resource,
    null,
    jsonb_build_object(
      'resource_kind', 'verification_artifact',
      'visibility_state', 'pending',
      'mime_type', p_mime_type,
      'byte_size', p_byte_size,
      'subject_kind', p_subject_kind,
      'subject_id', p_subject_id
    ),
    null, null, v_jurisdiction, statement_timestamp()
  );
  return query select 'created'::text, v_resource;
end;
$function$;

revoke all on function public.resource_begin_verification_artifact(text, uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_begin_verification_artifact(text, uuid, text, bigint, text)
  to authenticated;

comment on function public.resource_begin_verification_artifact(text, uuid, text, bigint, text) is
  'MVP-001 S3: starts one verification artifact upload (PDF, PNG or JPEG, server-checked type, size and digest) for a professional record in a finding stage, by a stepped-up staff member holding the verification scope for its jurisdiction who is not its attorney: a pending resource at its own opaque path, audited. Fixed outcomes: created, invalid, denied, locked.';

-- ---------------------------------------------------------------------------
-- The evidence reference to an uploaded artifact.
-- ---------------------------------------------------------------------------

create function public.verification_evidence_artifact_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  v_resource public.resources;
begin
  if tg_op = 'UPDATE'
     and (
       old.source_type is not distinct from new.source_type
       and old.source_reference is not distinct from new.source_reference
       and old.retrieved_by_user_id is not distinct from new.retrieved_by_user_id
       and old.jurisdiction_id is not distinct from new.jurisdiction_id
     ) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.source_type is not distinct from 'uploaded_artifact' then
    raise exception 'an evidence reference to an uploaded artifact is immutable'
      using errcode = '23514';
  end if;
  if new.source_type is distinct from 'uploaded_artifact' then
    return new;
  end if;
  if new.source_reference is null
     or new.source_reference collate "C"
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'an uploaded-artifact reference must be a resource id'
      using errcode = '23514';
  end if;
  select r.* into v_resource
  from public.resources as r
  where r.id = new.source_reference::uuid
  for share;
  if not found
     or v_resource.resource_kind <> 'verification_artifact'
     or v_resource.visibility_state <> 'available'
     or v_resource.retention_state <> 'active'
     or new.retrieved_by_user_id is distinct from v_resource.owner_user_id
     or not exists (
       select 1
       from public.users as u
       join public.staff_profiles as s on s.user_id = u.id
       join public.capability_grants as g on g.user_id = u.id
       where u.id = v_resource.owner_user_id
         and u.account_state = 'active'
         and s.staff_state = 'active'
         and g.capability_code = 'manage_attorney_verification'
         and g.granted_at <= statement_timestamp()
         and g.revoked_at is null
         and (g.expires_at is null or g.expires_at > statement_timestamp())
         and g.resource_scope is null
         and (g.jurisdiction_id is null or g.jurisdiction_id = new.jurisdiction_id)
     ) then
    raise exception 'the uploaded artifact is not an available artifact of this reviewer within scope'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.verification_evidence_artifact_guard()
  from public, anon, authenticated, service_role;

create trigger verification_evidence_artifact_guard
before insert or update on public.verification_evidence
for each row
execute function public.verification_evidence_artifact_guard();

-- At most one finding refers to one uploaded artifact.
create unique index verification_evidence_uploaded_artifact_key
  on public.verification_evidence (source_reference)
  where source_type = 'uploaded_artifact';
