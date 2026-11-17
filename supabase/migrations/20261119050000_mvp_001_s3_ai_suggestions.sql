-- MVP-001 S3 (5 of 6): AI Suggestions on a client's own Intake (MVP-001 Packet S3 "AI Suggestion: generate ->
-- persist -> workflow confirmation, behind the adapter"; Packet section 3 gate D-4; MBS section 8 AI boundary; PS
-- sections 12.2 and 13; TA sections 3.3 and 30; ROS rule R17 and section 6.4; MB sections 100 to 103).
--
-- public.ai_suggestions and public.jurisdiction_assessments exist since P1 (20260911062917). No relation or
-- column is added (Packet rule 16); this migration adds implementation constraints, an integrity trigger and
-- functions (DL-ENG-1 R9):
-- - persistence follows PS section 13 and ROS rule R17: a suggestion is stored only when it is presented to the
--   client (generated_at and presented_at are both recorded), never for discarded inference. It is stored only by
--   ai_record_intake_suggestion, executable by service_role alone (the server-only privileged credential), so no
--   browser can forge a suggestion; the server calls it only after the provider answered and the answer passed
--   its strict checks, for the verified client's own draft Intake, and presents only what this function recorded.
--   Each suggestion records its model reference and the revision it was generated from, and is audited in the
--   same transaction as a system action;
-- - suggestion types are limited to the two TA section 30 permitted classes this slice needs: practice_category
--   ("suggest practice categories") and potentially_relevant_jurisdictions ("suggest potentially relevant
--   jurisdictions"); the context is the client's own Intake;
-- - the client confirms or rejects a presented suggestion once (client_confirm_ai_suggestion,
--   client_reject_ai_suggestion; confirmed_at and confirmed_by_user_id, or rejected_at; mutually exclusive). A
--   confirmation writes no canonical Intake state: the client applies a confirmed category or jurisdiction only
--   through the ordinary intake save (MB section 102). Confirming a potentially_relevant_jurisdictions suggestion
--   records one unreviewed jurisdiction assessment per suggested jurisdiction, sourced 'ai_suggestion' and linked
--   to the suggestion: a suggestion with a recorded basis, never a legal conclusion (PS section 12.2; DM section 6);
-- - AI functions write only ai_suggestions, unreviewed jurisdiction_assessments and audit_events. They never write
--   an Intake, a revision, or any attorney, verification, eligibility, policy, referral or payment row; an expired
--   Intake is recognised from expires_at without writing it.
-- The AI provider, its capability and its data authorization are undecided (gate D-4): the application's
-- production adapter reports the provider unavailable without any network call, so nothing is recorded in
-- practice until the owner decides it, and the intake workflow stays fully usable without AI.

-- ---------------------------------------------------------------------------
-- Suggestion value shape (internal; immutable; executable by no API role).
-- ---------------------------------------------------------------------------

-- Null when the value is the exact shape of its type; otherwise a fixed problem code. A practice_category value
-- is {"practice_area_id": <uuid>, "revision_number": <n>}; a potentially_relevant_jurisdictions value is
-- {"jurisdiction_ids": [<uuid>, ...], "revision_number": <n>} with 1 to 10 distinct ids. Catalog identity is
-- checked by the recording function, not here.
create function public.ai_suggestion_value_problem(p_type text, p_value jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_element jsonb;
  v_ids text[] := '{}';
begin
  if jsonb_typeof(p_value) is distinct from 'object' then
    return 'value';
  end if;
  if p_type = 'practice_category' then
    if public.intake_json_keys(p_value) is distinct from
       array['practice_area_id', 'revision_number'] then
      return 'value';
    end if;
    if jsonb_typeof(p_value -> 'practice_area_id') is distinct from 'string'
       or (p_value ->> 'practice_area_id') collate "C"
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return 'practice_area';
    end if;
  elsif p_type = 'potentially_relevant_jurisdictions' then
    if public.intake_json_keys(p_value) is distinct from
       array['jurisdiction_ids', 'revision_number'] then
      return 'value';
    end if;
    if coalesce(
         public.intake_json_array_length(p_value -> 'jurisdiction_ids'), 0
       ) not between 1 and 10 then
      return 'jurisdictions';
    end if;
    for v_element in
      select value from jsonb_array_elements(p_value -> 'jurisdiction_ids')
    loop
      if jsonb_typeof(v_element) is distinct from 'string' then
        return 'jurisdictions';
      end if;
      if (v_element #>> '{}') collate "C"
           !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or (v_element #>> '{}') = any (v_ids) then
        return 'jurisdictions';
      end if;
      v_ids := v_ids || (v_element #>> '{}');
    end loop;
  else
    return 'type';
  end if;
  if not public.intake_json_int_within(p_value -> 'revision_number', 1, 2147483647) then
    return 'revision_number';
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relations.
-- ---------------------------------------------------------------------------

alter table public.ai_suggestions
  add constraint ai_suggestions_context_v1_check
    check (context_type = 'intake'),
  add constraint ai_suggestions_type_v1_check
    check (suggestion_type in ('practice_category', 'potentially_relevant_jurisdictions')),
  add constraint ai_suggestions_value_v1_check
    check (public.ai_suggestion_value_problem(suggestion_type, suggestion_value) is null),
  add constraint ai_suggestions_model_reference_v1_check
    check (
      model_reference is not null
      and model_reference collate "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'
    ),
  add constraint ai_suggestions_presented_v1_check
    check (presented_at is not null and presented_at >= generated_at),
  add constraint ai_suggestions_decision_order_check
    check (
      (confirmed_at is null or confirmed_at >= presented_at)
      and (rejected_at is null or rejected_at >= presented_at)
    );

alter table public.jurisdiction_assessments
  add constraint jurisdiction_assessments_source_v1_check
    check (
      (source_type = 'client_statement' and ai_suggestion_id is null)
      or (source_type = 'ai_suggestion' and ai_suggestion_id is not null)
    ),
  add constraint jurisdiction_assessments_basis_v1_check
    check (
      assessment_basis is not null
      and btrim(assessment_basis) <> ''
      and char_length(assessment_basis) <= 200
    );

-- ---------------------------------------------------------------------------
-- Integrity: a presented suggestion is never deleted, and changes only by one decision.
-- ---------------------------------------------------------------------------

create function public.ai_suggestion_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.ai_suggestions rows are never deleted'
      using errcode = '55000';
  end if;
  if old.confirmed_at is not null or old.rejected_at is not null then
    raise exception 'a decided AI suggestion is immutable'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'confirmed_at' - 'confirmed_by_user_id' - 'rejected_at')
     is distinct from
     (to_jsonb(old) - 'confirmed_at' - 'confirmed_by_user_id' - 'rejected_at') then
    raise exception 'an AI suggestion changes only by its confirmation or rejection'
      using errcode = '55000';
  end if;
  if not (
    (new.confirmed_at is not null and new.confirmed_by_user_id is not null
     and new.rejected_at is null)
    or (new.rejected_at is not null and new.confirmed_at is null
        and new.confirmed_by_user_id is null)
  ) then
    raise exception 'an AI suggestion is confirmed or rejected exactly once'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger ai_suggestions_integrity
before update or delete on public.ai_suggestions
for each row
execute function public.ai_suggestion_integrity();

create trigger ai_suggestions_no_truncate
before truncate on public.ai_suggestions
for each statement
execute function public.ai_suggestion_integrity();

-- ---------------------------------------------------------------------------
-- Recording a presented suggestion (EXECUTE for service_role only).
-- ---------------------------------------------------------------------------

-- Fixed outcomes: recorded (with the suggestion id), invalid, not_found, not_editable, stale, rate_limited.
-- p_user_id is the verified client's User, which the server derived from the request's own authenticated
-- session; p_suggestion_value is the item alone ({"practice_area_id"} or {"jurisdiction_ids"}) and the function
-- adds the revision it was generated from. The Intake must be that client's own draft, not past its expires_at,
-- and its latest revision must be p_revision_number; a suggested practice area must be active and suggested
-- jurisdictions must exist. generated_at is the server's time of the provider answer, accepted up to 30 seconds
-- ahead of the database clock (and then stored as the presentation time) and up to 10 minutes behind it;
-- presented_at is the database time of this call. At most 50 suggestions per Intake (a fixed abuse bound of
-- this path). Nothing but the suggestion and its audit event is written.
create function public.ai_record_intake_suggestion(
  p_user_id uuid,
  p_intake_id uuid,
  p_revision_number integer,
  p_suggestion_type text,
  p_suggestion_value jsonb,
  p_model_reference text,
  p_generated_at timestamptz
)
returns table (outcome text, suggestion_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := statement_timestamp();
  v_account_state text;
  v_client uuid;
  v_state text;
  v_expires timestamptz;
  v_latest integer;
  v_value jsonb;
  v_ids uuid[];
  v_id uuid;
begin
  if p_user_id is null
     or p_intake_id is null
     or p_revision_number is null
     or p_revision_number < 1
     or p_suggestion_type is null
     or p_suggestion_type not in ('practice_category', 'potentially_relevant_jurisdictions')
     or jsonb_typeof(p_suggestion_value) is distinct from 'object'
     or p_suggestion_value ? 'revision_number'
     or p_model_reference is null
     or p_model_reference collate "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'
     or p_generated_at is null
     or p_generated_at > v_now + interval '30 seconds'
     or p_generated_at < v_now - interval '10 minutes' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  v_value := p_suggestion_value || jsonb_build_object('revision_number', p_revision_number);
  if public.ai_suggestion_value_problem(p_suggestion_type, v_value) is not null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select u.account_state
  into v_account_state
  from public.users as u
  where u.id = p_user_id
  for share;
  if not found or v_account_state is distinct from 'active' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select c.id
  into v_client
  from public.client_profiles as c
  where c.user_id = p_user_id
  for no key update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  select i.state, i.expires_at
  into v_state, v_expires
  from public.intakes as i
  where i.id = p_intake_id
    and i.client_id = v_client
  for share;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_state <> 'draft'
     or (v_expires is not null and v_expires <= clock_timestamp()) then
    return query select 'not_editable'::text, null::uuid;
    return;
  end if;
  select max(r.revision_number)
  into v_latest
  from public.intake_revisions as r
  where r.intake_id = p_intake_id;
  if v_latest is distinct from p_revision_number then
    return query select 'stale'::text, null::uuid;
    return;
  end if;
  if p_suggestion_type = 'practice_category' then
    if not exists (
      select 1
      from public.practice_areas as pa
      where pa.id = (v_value ->> 'practice_area_id')::uuid
        and pa.active
    ) then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
  else
    select array_agg((e.value #>> '{}')::uuid)
    into v_ids
    from jsonb_array_elements(v_value -> 'jurisdiction_ids') as e;
    if (
      select count(*) from public.jurisdictions as j where j.id = any (v_ids)
    ) <> cardinality(v_ids) then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
  end if;
  if (
    select count(*)
    from public.ai_suggestions as s
    where s.context_type = 'intake'
      and s.context_id = p_intake_id
  ) >= 50 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  v_id := gen_random_uuid();
  insert into public.ai_suggestions (
    id, context_type, context_id, suggestion_type, suggestion_value,
    generated_at, model_reference, presented_at
  ) values (
    v_id, 'intake', p_intake_id, p_suggestion_type, v_value,
    least(p_generated_at, v_now), p_model_reference, v_now
  );
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    null, 'system', 'ai_suggestion_presented', 'ai_suggestion', v_id,
    null,
    jsonb_build_object(
      'context_type', 'intake',
      'context_id', p_intake_id,
      'suggestion_type', p_suggestion_type,
      'model_reference', p_model_reference,
      'revision_number', p_revision_number,
      'value_sha256', encode(sha256(convert_to(v_value::text, 'UTF8')), 'hex'),
      'requested_by_user_id', p_user_id
    ),
    null, null, null, v_now
  );
  return query select 'recorded'::text, v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The client's decision (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Fixed outcomes: confirmed, already_confirmed, already_rejected, not_found, not_editable. The suggestion must be
-- presented on the caller's own Intake; a decision is taken while that Intake is a draft not past its expires_at.
-- Confirmation records who confirmed it and when, and nothing on the Intake; for a
-- potentially_relevant_jurisdictions suggestion it also records one unreviewed jurisdiction assessment per
-- suggested jurisdiction (source 'ai_suggestion', linked to the suggestion). Audited.
create function public.client_confirm_ai_suggestion(p_suggestion_id uuid)
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
  v_intake uuid;
  v_state text;
  v_expires timestamptz;
  v_suggestion public.ai_suggestions;
  v_recorded integer := 0;
begin
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null or p_suggestion_id is null then
    return 'not_found';
  end if;
  select s.context_id
  into v_intake
  from public.ai_suggestions as s
  where s.id = p_suggestion_id
    and s.context_type = 'intake';
  if not found then
    return 'not_found';
  end if;
  select i.state, i.expires_at
  into v_state, v_expires
  from public.intakes as i
  where i.id = v_intake
    and i.client_id = v_client
  for share;
  if not found then
    return 'not_found';
  end if;
  select s.*
  into v_suggestion
  from public.ai_suggestions as s
  where s.id = p_suggestion_id
  for update;
  if v_suggestion.confirmed_at is not null then
    return 'already_confirmed';
  end if;
  if v_suggestion.rejected_at is not null then
    return 'already_rejected';
  end if;
  if v_state <> 'draft'
     or (v_expires is not null and v_expires <= clock_timestamp()) then
    return 'not_editable';
  end if;
  update public.ai_suggestions as s
  set confirmed_at = statement_timestamp(),
      confirmed_by_user_id = v_user
  where s.id = p_suggestion_id;
  if v_suggestion.suggestion_type = 'potentially_relevant_jurisdictions' then
    insert into public.jurisdiction_assessments (
      intake_id, jurisdiction_id, assessment_basis, source_type,
      ai_suggestion_id, review_status
    )
    select
      v_intake,
      (e.value #>> '{}')::uuid,
      format(
        'ai_suggestion:confirmed_by_client:intake_revision:%s',
        v_suggestion.suggestion_value ->> 'revision_number'
      ),
      'ai_suggestion',
      p_suggestion_id,
      'unreviewed'
    from jsonb_array_elements(v_suggestion.suggestion_value -> 'jurisdiction_ids')
      with ordinality as e (value, position)
    order by e.position;
    get diagnostics v_recorded = row_count;
  end if;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'ai_suggestion_confirmed', 'ai_suggestion', p_suggestion_id,
    jsonb_build_object('decision', null),
    jsonb_build_object(
      'decision', 'confirmed',
      'suggestion_type', v_suggestion.suggestion_type,
      'assessments_recorded', v_recorded
    ),
    null, null, null, statement_timestamp()
  );
  return 'confirmed';
end;
$function$;

-- Fixed outcomes: rejected, already_rejected, already_confirmed, not_found, not_editable. Same rules as the
-- confirmation; a rejection records only when it was rejected (the rejecting client is the Intake's own client and
-- is named in the audit event). Audited.
create function public.client_reject_ai_suggestion(p_suggestion_id uuid)
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
  v_intake uuid;
  v_state text;
  v_expires timestamptz;
  v_suggestion public.ai_suggestions;
begin
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null or p_suggestion_id is null then
    return 'not_found';
  end if;
  select s.context_id
  into v_intake
  from public.ai_suggestions as s
  where s.id = p_suggestion_id
    and s.context_type = 'intake';
  if not found then
    return 'not_found';
  end if;
  select i.state, i.expires_at
  into v_state, v_expires
  from public.intakes as i
  where i.id = v_intake
    and i.client_id = v_client
  for share;
  if not found then
    return 'not_found';
  end if;
  select s.*
  into v_suggestion
  from public.ai_suggestions as s
  where s.id = p_suggestion_id
  for update;
  if v_suggestion.rejected_at is not null then
    return 'already_rejected';
  end if;
  if v_suggestion.confirmed_at is not null then
    return 'already_confirmed';
  end if;
  if v_state <> 'draft'
     or (v_expires is not null and v_expires <= clock_timestamp()) then
    return 'not_editable';
  end if;
  update public.ai_suggestions as s
  set rejected_at = statement_timestamp()
  where s.id = p_suggestion_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'ai_suggestion_rejected', 'ai_suggestion', p_suggestion_id,
    jsonb_build_object('decision', null),
    jsonb_build_object(
      'decision', 'rejected',
      'suggestion_type', v_suggestion.suggestion_type
    ),
    null, null, null, statement_timestamp()
  );
  return 'rejected';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Privileges: function-only writes; the P1 own-row reads for authenticated stay.
-- ---------------------------------------------------------------------------

-- service_role loses every privilege on ai_suggestions, including the P1 column UPDATE grants (a table-level
-- revocation also revokes the column privileges); it reaches the relation only through the recording function.
revoke all on table public.ai_suggestions from service_role;
revoke insert, update, delete, truncate, references, trigger
  on table public.ai_suggestions
  from public, anon, authenticated;

revoke all on function public.ai_suggestion_value_problem(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_suggestion_integrity()
  from public, anon, authenticated, service_role;

revoke all on function public.ai_record_intake_suggestion(
  uuid, uuid, integer, text, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.ai_record_intake_suggestion(
  uuid, uuid, integer, text, jsonb, text, timestamptz
) to service_role;

revoke all on function public.client_confirm_ai_suggestion(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_confirm_ai_suggestion(uuid) to authenticated;
revoke all on function public.client_reject_ai_suggestion(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.client_reject_ai_suggestion(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.ai_suggestion_value_problem(text, jsonb) is
  'Internal (MVP-001 S3): null when an AI suggestion value is the exact shape of its type (practice_category, potentially_relevant_jurisdictions); otherwise a fixed problem code. Executable by no API role.';
comment on function public.ai_suggestion_integrity() is
  'MVP-001 S3: an AI suggestion is never deleted or truncated, and changes only by one confirmation (with its actor) or one rejection.';
comment on function public.ai_record_intake_suggestion(uuid, uuid, integer, text, jsonb, text, timestamptz) is
  'MVP-001 S3 (PS section 13; service_role only): records one AI suggestion presented to the verified client on their own current draft Intake, with its model reference, the revision it was generated from, generated_at and presented_at, and one system audit event. Outcomes: recorded, invalid, not_found, not_editable, stale, rate_limited. Writes nothing else.';
comment on function public.client_confirm_ai_suggestion(uuid) is
  'MVP-001 S3: the client confirms a suggestion presented on their own draft Intake, once. No canonical Intake state is written; a jurisdiction suggestion also records unreviewed ai_suggestion-sourced jurisdiction assessments. Audited.';
comment on function public.client_reject_ai_suggestion(uuid) is
  'MVP-001 S3: the client rejects a suggestion presented on their own draft Intake, once. Audited.';
comment on table public.ai_suggestions is
  'Persisted AI suggestions (PS section 13): stored only when presented to a human, through ai_record_intake_suggestion; decided once by the client; never canonical legal or business state. Never deleted.';
