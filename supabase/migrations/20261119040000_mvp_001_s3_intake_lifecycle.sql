-- MVP-001 S3 (4 of 6): the Intake lifecycle and its expiry evaluation (MVP-001 Packet S3 "intake expiry and
-- active / expired / superseded transitions, and post-submission semantics, as configuration"; Packet section 3
-- gate D-3; DM sections 2.8 and 6; PS section 12.1; ROS sections 6.2 and 8.2; MBS section 8; TA section 7).
--
-- No relation or column is added (Packet rule 16). public.intakes keeps its P1 columns; this migration adds one
-- implementation constraint, guard triggers and functions on it (DL-ENG-1 R9):
-- - lifecycle integrity: an Intake is never deleted or truncated, its identity, client and creation time never
--   change, and its state moves only along the Domain Model lifecycle: draft -> submitted | closed | expired;
--   submitted -> active | closed | expired | superseded; active -> closed | expired | superseded. expired,
--   superseded and closed have no exit here (a returning client's confirmation, and revision versus a new Intake,
--   are the PROPOSED rules of gate D-3 and stay unconfigured). closed_at is set exactly when the state is closed.
--   expires_at changes only while the Intake is open (draft, submitted or active);
-- - expiry is keyed on intakes.expires_at alone. Its period is an owner decision (gate D-3; DM section 13 item 13)
--   and no constant, default, enum value, seed or constraint here encodes it: nothing in this migration or in any
--   application path sets expires_at, so expiry stays off. An open Intake whose expires_at has passed is expired
--   by the first command that touches it (intake_expire_if_due, audited as a system action), so correctness never
--   depends on a scheduler; a database-only sweep (intake_expiry_sweep, scheduled where pg_cron exists) only makes
--   it prompt. Content is preserved: nothing touches a revision, an assessment or a resource;
-- - every client command on an Intake evaluates expiry first: client_save_intake_revision, client_submit_intake
--   and client_close_intake (20261115140653) and resource_begin_voice_memo and resource_finalize_upload
--   (20261119020000, 20261119010000) are replaced with their existing definitions and only that step added: the
--   same signature, parameter names, return type, volatility, security mode, search_path, lock order, outcomes
--   and privileges. An Intake that has just expired answers exactly as one already expired;
-- - post-submission changes (a revision after submission, a replacement Intake that supersedes it, a returning
--   client's confirmation after expiry) are refused with the fixed outcome 'not_configured' by one client
--   function, client_request_intake_change, until the owner decides gate D-3 and its configuration home. It
--   writes nothing else.
-- The Intake survives decline and retry: nothing here deletes or rewrites an Intake or its revisions.

-- ---------------------------------------------------------------------------
-- Implementation constraint on the existing relation.
-- ---------------------------------------------------------------------------

alter table public.intakes
  add constraint intakes_closed_at_lifecycle_check
    check ((state = 'closed') = (closed_at is not null));

-- ---------------------------------------------------------------------------
-- Lifecycle integrity (any role, the owner included).
-- ---------------------------------------------------------------------------

create function public.intake_lifecycle_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.intakes rows are never deleted'
      using errcode = '55000';
  end if;
  if new.id is distinct from old.id
     or new.client_id is distinct from old.client_id
     or new.created_at is distinct from old.created_at then
    raise exception 'an Intake keeps its identity, client and creation time'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
    (old.state = 'draft' and new.state in ('submitted', 'closed', 'expired'))
    or (old.state = 'submitted'
        and new.state in ('active', 'closed', 'expired', 'superseded'))
    or (old.state = 'active' and new.state in ('closed', 'expired', 'superseded'))
  ) then
    raise exception 'an Intake moves only along its lifecycle'
      using errcode = '55000';
  end if;
  if old.closed_at is not null and new.closed_at is distinct from old.closed_at then
    raise exception 'an Intake keeps its closing time'
      using errcode = '55000';
  end if;
  if new.expires_at is distinct from old.expires_at
     and old.state not in ('draft', 'submitted', 'active') then
    raise exception 'the expiry time of an ended Intake is fixed'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger intakes_lifecycle_guard
before update or delete on public.intakes
for each row
execute function public.intake_lifecycle_guard();

create trigger intakes_no_truncate
before truncate on public.intakes
for each statement
execute function public.intake_lifecycle_guard();

-- ---------------------------------------------------------------------------
-- Expiry evaluation (internal; executable by no API role).
-- ---------------------------------------------------------------------------

-- The Intake's state after evaluating its expiry, or null when it does not exist. An open Intake (draft,
-- submitted or active) whose expires_at is set and has passed is moved to expired, with one system audit event,
-- and 'expired' is answered; any other Intake is left exactly as it is. The row is locked FOR UPDATE only when the
-- expiry is due, so a caller holding it FOR SHARE takes no stronger lock otherwise. The caller decides whose
-- Intake it is before calling.
create function public.intake_expire_if_due(p_intake_id uuid)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_state text;
  v_expires timestamptz;
begin
  select i.state, i.expires_at
  into v_state, v_expires
  from public.intakes as i
  where i.id = p_intake_id;
  if not found then
    return null;
  end if;
  if v_state not in ('draft', 'submitted', 'active')
     or v_expires is null
     or v_expires > clock_timestamp() then
    return v_state;
  end if;
  select i.state, i.expires_at
  into v_state, v_expires
  from public.intakes as i
  where i.id = p_intake_id
  for update;
  if v_state not in ('draft', 'submitted', 'active')
     or v_expires is null
     or v_expires > clock_timestamp() then
    return v_state;
  end if;
  update public.intakes as i
  set state = 'expired'
  where i.id = p_intake_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'intake_expired', 'intake', p_intake_id,
    jsonb_build_object('state', v_state),
    jsonb_build_object('state', 'expired'),
    'expires_at_reached', null, null, clock_timestamp()
  );
  return 'expired';
end;
$function$;

-- The database-only sweep (no API role; pg_cron runs it as the owner). It expires at most 500 due Intakes per
-- run, skipping any row another transaction holds, and writes nothing else; the next run, or the next command
-- on an Intake, continues.
create function public.intake_expiry_sweep()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_id uuid;
  v_expired integer := 0;
begin
  for v_id in
    select i.id
    from public.intakes as i
    where i.state in ('draft', 'submitted', 'active')
      and i.expires_at is not null
      and i.expires_at <= clock_timestamp()
    order by i.expires_at, i.id
    limit 500
    for update of i skip locked
  loop
    if public.intake_expire_if_due(v_id) = 'expired' then
      v_expired := v_expired + 1;
    end if;
  end loop;
  return jsonb_build_object('expired', v_expired);
end;
$function$;

-- ---------------------------------------------------------------------------
-- The client commands, replaced with their existing definitions and the expiry step only.
-- ---------------------------------------------------------------------------

-- 20261115140653 definition; expiry is evaluated once the caller's own Intake is locked (an expired Intake is
-- not editable).
create or replace function public.client_save_intake_revision(
  p_intake_id uuid,
  p_expected_revision integer,
  p_question_set_id uuid,
  p_practice_area_id uuid,
  p_description text,
  p_answers jsonb
)
returns table (outcome text, revision_number integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_client uuid;
  v_state text;
  v_latest public.intake_revisions%rowtype;
  v_current uuid;
  v_definition jsonb;
  v_current_limits jsonb;
  v_number integer;
begin
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null or p_intake_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;
  select i.state
  into v_state
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for update;
  if not found then
    return query select 'not_found'::text, null::integer;
    return;
  end if;
  v_state := public.intake_expire_if_due(p_intake_id);
  if v_state <> 'draft' then
    return query select 'not_editable'::text, null::integer;
    return;
  end if;
  select r.*
  into v_latest
  from public.intake_revisions as r
  where r.intake_id = p_intake_id
  order by r.revision_number desc
  limit 1;
  if p_expected_revision is distinct from v_latest.revision_number then
    return query select 'conflict'::text, null::integer;
    return;
  end if;
  select s.id, s.definition -> 'limits'
  into v_current, v_current_limits
  from public.intake_question_sets as s
  order by s.published_at desc
  limit 1;
  if v_current is null then
    return query select 'unavailable'::text, null::integer;
    return;
  end if;
  -- Version selection (PS-A1 section 3.1): the Intake's governing version
  -- or the current version, never any other.
  if p_question_set_id is null
     or (p_question_set_id <> v_current
         and p_question_set_id is distinct from v_latest.question_set_id) then
    return query select 'version_not_allowed'::text, null::integer;
    return;
  end if;
  select s.definition
  into v_definition
  from public.intake_question_sets as s
  where s.id = p_question_set_id;
  if p_description is not null and (
    btrim(p_description) = ''
    or char_length(p_description)
       > (v_definition -> 'limits' ->> 'description_max_characters')::integer
    or p_description ~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]'
  ) then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if p_practice_area_id is not null and not exists (
    select 1
    from public.practice_areas as pa
    where pa.id = p_practice_area_id
      and pa.active
  ) then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if public.intake_answers_problem(
       v_definition, p_answers, p_practice_area_id, false
     ) is not null
     or (p_practice_area_id is null
         and p_description is null
         and p_answers = '{}'::jsonb) then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if v_latest.revision_number is not null
     and v_latest.question_set_id = p_question_set_id
     and v_latest.practice_area_id is not distinct from p_practice_area_id
     and v_latest.description is not distinct from p_description
     and v_latest.structured_answers = p_answers then
    return query select 'unchanged'::text, null::integer;
    return;
  end if;
  if public.intake_rate_exceeded(
    v_client, 'revision_saves_per_client', v_current_limits
  ) then
    return query select 'rate_limited'::text, null::integer;
    return;
  end if;
  v_number := coalesce(v_latest.revision_number, 0) + 1;
  insert into public.intake_revisions (
    intake_id, revision_number, question_set_id, practice_area_id,
    description, structured_answers
  ) values (
    p_intake_id, v_number, p_question_set_id, p_practice_area_id,
    p_description, p_answers
  );
  return query select 'saved'::text, v_number;
end;
$function$;

-- 20261115140653 definition; expiry is evaluated once the caller's own Intake is locked (an expired Intake is
-- not editable).
create or replace function public.client_submit_intake(
  p_intake_id uuid,
  p_expected_revision integer
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_client uuid;
  v_state text;
  v_latest public.intake_revisions%rowtype;
  v_definition jsonb;
  v_version_key text;
  v_jurisdiction_question text;
  v_stated jsonb;
begin
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null or p_intake_id is null then
    return 'not_found';
  end if;
  select i.state
  into v_state
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for update;
  if not found then
    return 'not_found';
  end if;
  v_state := public.intake_expire_if_due(p_intake_id);
  select r.*
  into v_latest
  from public.intake_revisions as r
  where r.intake_id = p_intake_id
  order by r.revision_number desc
  limit 1;
  if v_state in ('submitted', 'active') then
    return case
      when p_expected_revision is not distinct from v_latest.revision_number
        then 'already_submitted'
      else 'conflict'
    end;
  end if;
  if v_state <> 'draft' then
    return 'not_editable';
  end if;
  if v_latest.revision_number is null then
    return 'incomplete';
  end if;
  if p_expected_revision is distinct from v_latest.revision_number then
    return 'conflict';
  end if;
  select s.definition, s.version_key
  into v_definition, v_version_key
  from public.intake_question_sets as s
  where s.id = v_latest.question_set_id;
  -- A selected practice area must still be active. An explicit "not sure"
  -- needs none and yields no classification or routing outcome.
  if v_latest.practice_area_id is not null and not exists (
    select 1
    from public.practice_areas as pa
    where pa.id = v_latest.practice_area_id
      and pa.active
  ) then
    return 'needs_update';
  end if;
  if public.intake_answers_problem(
       v_definition, v_latest.structured_answers, v_latest.practice_area_id,
       true
     ) is not null
     or (v_definition -> 'description' -> 'required' = 'true'::jsonb
         and v_latest.description is null) then
    return 'incomplete';
  end if;

  update public.intakes
  set state = 'submitted'
  where id = p_intake_id;

  select q ->> 'id'
  into v_jurisdiction_question
  from jsonb_array_elements(v_definition -> 'questions') as q
  where q ->> 'kind' = 'jurisdictions';
  v_stated := v_latest.structured_answers -> v_jurisdiction_question;
  if v_jurisdiction_question is not null
     and jsonb_typeof(v_stated) = 'array' then
    insert into public.jurisdiction_assessments (
      intake_id, jurisdiction_id, assessment_basis, source_type,
      ai_suggestion_id, review_status
    )
    select
      p_intake_id,
      (stated.value #>> '{}')::uuid,
      format(
        'client_statement:intake_revision:%s:question_set:%s',
        v_latest.revision_number,
        v_version_key
      ),
      'client_statement',
      null,
      'unreviewed'
    from jsonb_array_elements(v_stated) with ordinality as stated (value, position)
    order by stated.position;
  end if;

  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'client_intake_submitted', 'intake', p_intake_id,
    jsonb_build_object('state', 'draft'),
    jsonb_build_object(
      'state', 'submitted',
      'revision_number', v_latest.revision_number,
      'question_set', v_version_key
    ),
    null, null, null, statement_timestamp()
  );
  return 'submitted';
end;
$function$;

-- 20261115140653 definition; expiry is evaluated once the caller's own Intake is locked (an expired Intake is
-- not closable: 'unavailable', as before for every ended Intake).
create or replace function public.client_close_intake(p_intake_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_client uuid;
  v_state text;
begin
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null or p_intake_id is null then
    return 'not_found';
  end if;
  select i.state
  into v_state
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for update;
  if not found then
    return 'not_found';
  end if;
  v_state := public.intake_expire_if_due(p_intake_id);
  if v_state = 'closed' then
    return 'already_closed';
  end if;
  if v_state not in ('draft', 'submitted', 'active') then
    return 'unavailable';
  end if;
  update public.intakes
  set state = 'closed',
      closed_at = statement_timestamp()
  where id = p_intake_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'client_intake_closed', 'intake', p_intake_id,
    jsonb_build_object('state', v_state),
    jsonb_build_object('state', 'closed'),
    null, null, null, statement_timestamp()
  );
  return 'closed';
end;
$function$;

-- 20261119020000 definition; expiry is evaluated once the caller's own Intake is locked (an expired Intake is
-- not editable).
create or replace function public.resource_begin_voice_memo(
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
  v_state := public.intake_expire_if_due(p_intake_id);
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

-- 20261119010000 definition; for a voice memo, expiry is evaluated once the caller's own Intake is locked (an
-- expired Intake is not editable).
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

-- ---------------------------------------------------------------------------
-- Post-submission changes (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Fixed outcomes: not_configured, not_applicable, expired, not_found, invalid. p_change names the change the
-- client asks for: 'revise' (the same matter with changed facts, after submission), 'replace' (a different legal
-- need, superseding a submitted Intake) or 'resume' (a returning client confirming an expired Intake). Each is a
-- PROPOSED rule of gate D-3 without a configuration home, so an applicable request is answered 'not_configured'.
-- Expiry is evaluated first. Nothing else is written.
create function public.client_request_intake_change(
  p_intake_id uuid,
  p_change text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_client uuid;
  v_state text;
begin
  if p_change is null or p_change not in ('revise', 'replace', 'resume') then
    return 'invalid';
  end if;
  select l.client_id
  into v_client
  from public.lock_current_client() as l;
  if v_client is null or p_intake_id is null then
    return 'not_found';
  end if;
  perform 1
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for update;
  if not found then
    return 'not_found';
  end if;
  v_state := public.intake_expire_if_due(p_intake_id);
  if p_change = 'resume' then
    return case when v_state = 'expired' then 'not_configured' else 'not_applicable' end;
  end if;
  if v_state = 'expired' then
    return 'expired';
  end if;
  if v_state in ('submitted', 'active') then
    return 'not_configured';
  end if;
  return 'not_applicable';
end;
$function$;

-- ---------------------------------------------------------------------------
-- The database-only sweep schedule (only where pg_cron exists).
-- ---------------------------------------------------------------------------

do $scheduler$
begin
  if not exists (
    select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice 'pg_cron is not available: no intake expiry schedule registered (commands still evaluate expiry)';
    return;
  end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute $unschedule$
    select cron.unschedule(j.jobid)
    from cron.job as j
    where j.jobname = 'rosuno_intake_expiry_sweep'
  $unschedule$;
  execute $schedule$
    select cron.schedule(
      'rosuno_intake_expiry_sweep',
      '*/5 * * * *',
      'select public.intake_expiry_sweep();'
    )
  $schedule$;
end;
$scheduler$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.intake_lifecycle_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.intake_expire_if_due(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.intake_expiry_sweep()
  from public, anon, authenticated, service_role;

revoke all on function public.client_save_intake_revision(
  uuid, integer, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.client_save_intake_revision(
  uuid, integer, uuid, uuid, text, jsonb
) to authenticated;
revoke all on function public.client_submit_intake(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.client_submit_intake(uuid, integer)
  to authenticated;
revoke all on function public.client_close_intake(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_close_intake(uuid) to authenticated;
revoke all on function public.resource_begin_voice_memo(uuid, text, bigint, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_begin_voice_memo(uuid, text, bigint, text, integer)
  to authenticated;
revoke all on function public.resource_finalize_upload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resource_finalize_upload(uuid) to authenticated;

revoke all on function public.client_request_intake_change(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.client_request_intake_change(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.intake_lifecycle_guard() is
  'MVP-001 S3: Intakes are never deleted or truncated; identity, client and creation time are fixed; the state moves only along the Domain Model lifecycle (no exit from expired, superseded or closed while gate D-3 is open); closed_at is fixed once set; expires_at changes only while the Intake is open.';
comment on function public.intake_expire_if_due(uuid) is
  'Internal (MVP-001 S3): moves an open Intake whose expires_at has passed to expired with one system audit event and answers its resulting state. expires_at is never set by any application path while the expiry period (gate D-3) is undecided. Executable by no API role.';
comment on function public.intake_expiry_sweep() is
  'MVP-001 S3: database-only sweep (pg_cron, as the owner) expiring at most 500 due Intakes per run with skip-locked semantics. Correctness does not depend on it: every command evaluates expiry itself. Executable by no API role.';
comment on function public.client_request_intake_change(uuid, text) is
  'MVP-001 S3: the post-submission change seam for the caller''s own Intake (revise, replace, resume). Each is a PROPOSED rule of gate D-3 without a configuration home, so an applicable request answers not_configured; otherwise not_applicable, expired, not_found or invalid. Expiry is evaluated first; nothing else is written.';
