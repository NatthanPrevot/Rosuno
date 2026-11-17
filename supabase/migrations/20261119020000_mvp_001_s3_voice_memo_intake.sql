-- MVP-001 S3 (2 of 3): the client voice memo of an Intake (MVP-001 Packet S3 "voice memo with a server-enforced,
-- configured limit"; MBS section 8; MB sections 35 and 55; TA section 57; PS sections 19.3 and 29).
--
-- No relation or column is added (Packet rule 16). One operation-specific function starts a voice memo upload for
-- the caller's own draft Intake: the application has already received the recording's bytes on the server,
-- recognized the container, measured its duration from the bytes, enforced the configured limit and a byte
-- ceiling, and computed its digest, and only then asks for a pending resource. The pending resource and its
-- voice memo record are created together; the application stores the bytes at the resource's own path through
-- its privileged storage port and completes the upload with resource_finalize_upload (20261119010000), or marks
-- it rejected with resource_abandon_upload when the bytes could not be stored.
--
-- The duration limit is server configuration and is never encoded or defaulted here (Packet section 3 gate;
-- MB's 60 seconds is not a default). The existing P1 constraint voice_memos_duration_seconds_check (0..60) stays
-- the physical ceiling. Nothing about the Intake or its revisions changes: a refused, failed or abandoned upload
-- leaves them exactly as they were (Intake survives decline and retry). In this slice an Intake holds at most one
-- available voice memo, attached while it is still a draft (post-submission changes stay with gate D-3), and at
-- most ten upload attempts, a fixed abuse bound of the upload path.

create function public.resource_begin_voice_memo(
  p_intake_id uuid,
  p_mime_type text,
  p_byte_size bigint,
  p_content_digest text,
  p_duration_seconds integer
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
  v_user uuid;
  v_client uuid;
  v_state text;
  v_resource uuid;
begin
  if p_intake_id is null
     or p_mime_type is null
     or p_mime_type not in ('audio/webm', 'audio/mp4')
     or p_byte_size is null
     or p_byte_size not between 1 and 1000000
     or p_content_digest is null
     or p_content_digest collate "C" !~ '^sha256:[0-9a-f]{64}$'
     or p_duration_seconds is null
     or p_duration_seconds not between 1 and 60 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select i.state
  into v_state
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for share;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_state <> 'draft' then
    return query select 'not_editable'::text, null::uuid;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('voice_memo|' || p_intake_id::text), 7301
  );
  if exists (
    select 1
    from public.resources as r
    where r.intake_id = p_intake_id
      and r.resource_kind = 'voice_memo'
      and r.visibility_state = 'available'
  ) then
    return query select 'already_exists'::text, null::uuid;
    return;
  end if;
  if (
    select count(*)
    from public.resources as r
    where r.intake_id = p_intake_id
      and r.resource_kind = 'voice_memo'
  ) >= 10 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  v_resource := gen_random_uuid();
  insert into public.resources (
    id, resource_kind, owner_user_id, intake_id, consultation_id,
    storage_bucket, storage_object_path, mime_type, byte_size, content_digest,
    visibility_state, retention_state
  ) values (
    v_resource, 'voice_memo', v_user, p_intake_id, null,
    'rosuno-private-resources', 'resources/' || v_resource::text || '/original',
    p_mime_type, p_byte_size, p_content_digest,
    'pending', 'active'
  );
  insert into public.voice_memos (resource_id, intake_id, duration_seconds)
  values (v_resource, p_intake_id, p_duration_seconds);
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'resource_upload_started', 'resource', v_resource,
    null,
    jsonb_build_object(
      'resource_kind', 'voice_memo',
      'visibility_state', 'pending',
      'mime_type', p_mime_type,
      'byte_size', p_byte_size,
      'duration_seconds', p_duration_seconds
    ),
    null, null, null, statement_timestamp()
  );
  return query select 'created'::text, v_resource;
end;
$function$;

revoke all on function public.resource_begin_voice_memo(uuid, text, bigint, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_begin_voice_memo(uuid, text, bigint, text, integer)
  to authenticated;

comment on function public.resource_begin_voice_memo(uuid, text, bigint, text, integer) is
  'MVP-001 S3: starts one voice memo upload for the caller''s own draft Intake from server-measured metadata (type, size, digest, duration): a pending resource at its own opaque path and its voice memo record, audited. Fixed outcomes: created, invalid, not_found, not_editable, already_exists, rate_limited. The Intake is never changed.';
