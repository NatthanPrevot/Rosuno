-- P5-001 Client Intake Foundation (M5, first slice).
--
-- Implements Physical Specification bounded amendment PS-A1 (intake content
-- revisions and versioned intake question configuration), referenced by
-- identifier and SHA-256 only. Client-provided intake content is held as
-- immutable, append-only snapshots; intake questions are immutable published
-- configuration versions. Every write is an operation-specific SECURITY
-- DEFINER function whose actor comes only from auth.uid(). Nothing here
-- publishes a question set or inserts catalog, grant, or business rows.
-- Intake content is never copied into audit events. Jurisdiction and
-- practice category stay client statements and suggestions: nothing here
-- classifies, routes, or determines eligibility or governing law.

-- ---------------------------------------------------------------------------
-- Capability catalog: publication authority for intake configuration.
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values ('manage_intake_configuration');

-- ---------------------------------------------------------------------------
-- PS-A1 section 1: intake_question_sets (immutable published versions).
-- ---------------------------------------------------------------------------

create table public.intake_question_sets (
  id uuid primary key default gen_random_uuid(),
  version_key text not null,
  definition jsonb not null,
  published_at timestamptz not null,
  constraint intake_question_sets_version_key_key unique (version_key),
  constraint intake_question_sets_published_at_key unique (published_at),
  constraint intake_question_sets_version_key_check
    check (version_key ~ '^[a-z][a-z0-9-]{2,63}$'),
  constraint intake_question_sets_definition_check
    check (jsonb_typeof(definition) = 'object')
);

alter table public.intake_question_sets enable row level security;

-- ---------------------------------------------------------------------------
-- PS-A1 section 2: intake_revisions (immutable complete snapshots).
-- The column ceilings are fixed technical security invariants; the
-- adjustable limits live in each question-set version.
-- ---------------------------------------------------------------------------

create table public.intake_revisions (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null,
  revision_number integer not null,
  question_set_id uuid not null,
  practice_area_id uuid,
  description text,
  structured_answers jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint intake_revisions_intake_revision_key
    unique (intake_id, revision_number),
  constraint intake_revisions_intake_id_fkey
    foreign key (intake_id)
    references public.intakes (id)
    on update restrict
    on delete restrict,
  constraint intake_revisions_question_set_id_fkey
    foreign key (question_set_id)
    references public.intake_question_sets (id)
    on update restrict
    on delete restrict,
  constraint intake_revisions_practice_area_id_fkey
    foreign key (practice_area_id)
    references public.practice_areas (id)
    on update restrict
    on delete restrict,
  constraint intake_revisions_revision_number_check
    check (revision_number >= 1),
  constraint intake_revisions_description_check
    check (
      description is null
      or (btrim(description) <> '' and char_length(description) <= 20000)
    ),
  constraint intake_revisions_structured_answers_check
    check (
      jsonb_typeof(structured_answers) = 'object'
      and octet_length(structured_answers::text) <= 16384
    ),
  constraint intake_revisions_content_check
    check (
      practice_area_id is not null
      or description is not null
      or structured_answers <> '{}'::jsonb
    )
);

alter table public.intake_revisions enable row level security;

-- ---------------------------------------------------------------------------
-- Immutability: no UPDATE, DELETE, or TRUNCATE of either relation, for any
-- role. A change is a new revision or a new published version.
-- ---------------------------------------------------------------------------

create function public.intake_reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  raise exception 'public.% rows are immutable', tg_table_name
    using errcode = '55000';
end;
$function$;

create trigger intake_question_sets_immutable
before update or delete on public.intake_question_sets
for each row
execute function public.intake_reject_mutation();

create trigger intake_question_sets_no_truncate
before truncate on public.intake_question_sets
for each statement
execute function public.intake_reject_mutation();

create trigger intake_revisions_immutable
before update or delete on public.intake_revisions
for each row
execute function public.intake_reject_mutation();

create trigger intake_revisions_no_truncate
before truncate on public.intake_revisions
for each statement
execute function public.intake_reject_mutation();

-- ---------------------------------------------------------------------------
-- Privileges and row policies. No API role writes either relation directly.
-- ---------------------------------------------------------------------------

revoke all on table public.intake_question_sets
  from public, anon, authenticated, service_role;
grant select on table public.intake_question_sets to authenticated;

revoke all on table public.intake_revisions
  from public, anon, authenticated, service_role;
grant select on table public.intake_revisions to authenticated;

-- Published versions hold no personal or matter data.
create policy intake_question_sets_select_published
on public.intake_question_sets
for select
to authenticated
using (true);

create policy intake_revisions_select_own
on public.intake_revisions
for select
to authenticated
using (
  exists (
    select 1
    from public.intakes as i
    join public.client_profiles as c on c.id = i.client_id
    join public.users as u on u.id = c.user_id
    where i.id = intake_revisions.intake_id
      and u.auth_user_id = (select auth.uid())
  )
);

-- Retire direct DML on the existing intake relations; SELECT stays for the
-- own-row reads. No application writer of either relation exists.
revoke insert, update, delete, truncate, references, trigger
  on table public.intakes, public.jurisdiction_assessments
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers (executable by no API role).
-- ---------------------------------------------------------------------------

-- A configuration label: a JSON string of 1..max_length characters with no
-- control character and no leading or trailing whitespace.
create function public.intake_label_ok(value jsonb, max_length integer)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $function$
  select coalesce(
    jsonb_typeof(value) = 'string'
    and char_length(value #>> '{}') between 1 and max_length
    and (value #>> '{}') !~ '^[[:space:]]'
    and (value #>> '{}') !~ '[[:space:]]$'
    and (value #>> '{}') !~ '[\u0001-\u001f\u007f]',
    false
  );
$function$;

-- A JSON whole number within [minimum, maximum]. Each step is a separate
-- statement, so no cast runs on a value that failed an earlier check.
create function public.intake_json_int_within(
  value jsonb,
  minimum numeric,
  maximum numeric
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_number numeric;
begin
  if jsonb_typeof(value) is distinct from 'number' then
    return false;
  end if;
  v_number := (value #>> '{}')::numeric;
  return v_number = trunc(v_number) and v_number between minimum and maximum;
end;
$function$;

-- The sorted key set of a JSON object, by byte order; null for a non-object.
create function public.intake_json_keys(value jsonb)
returns text[]
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $function$
begin
  if jsonb_typeof(value) is distinct from 'object' then
    return null;
  end if;
  return coalesce(
    (select array_agg(k collate "C" order by k collate "C")
     from jsonb_object_keys(value) as k),
    '{}'::text[]
  );
end;
$function$;

-- True when value is a JSON object whose keys include every required key and
-- nothing outside the allowed keys.
create function public.intake_json_keys_within(
  value jsonb,
  required_keys text[],
  allowed_keys text[]
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_keys text[] := public.intake_json_keys(value);
begin
  if v_keys is null then
    return false;
  end if;
  return v_keys @> required_keys and allowed_keys @> v_keys;
end;
$function$;

-- The length of a JSON array, or null for any other value.
create function public.intake_json_array_length(value jsonb)
returns integer
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $function$
begin
  if jsonb_typeof(value) is distinct from 'array' then
    return null;
  end if;
  return jsonb_array_length(value);
end;
$function$;

-- Null when the definition is a valid format-1 intake configuration that
-- reuses no published question identifier under a different kind; otherwise
-- a fixed problem code. The ranges are fixed technical ceilings. Every check
-- is its own statement, so malformed input yields a code, never an error.
create function public.intake_definition_problem(p_definition jsonb)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_question jsonb;
  v_choice jsonb;
  v_rate jsonb;
  v_limits jsonb;
  v_description jsonb;
  v_kind text;
  v_rate_key text;
  v_ids text[] := '{}';
  v_choice_ids text[];
  v_practice_area_questions integer := 0;
  v_jurisdiction_questions integer := 0;
begin
  if public.intake_json_keys(p_definition) is distinct from
     array['description', 'format', 'limits', 'questions'] then
    return 'definition';
  end if;
  if p_definition -> 'format' <> '1'::jsonb then
    return 'format';
  end if;
  if coalesce(
       public.intake_json_array_length(p_definition -> 'questions'), 0
     ) not between 1 and 20 then
    return 'questions';
  end if;

  for v_question in
    select value from jsonb_array_elements(p_definition -> 'questions')
  loop
    if not public.intake_json_keys_within(
      v_question,
      array['id', 'kind', 'prompt', 'required'],
      array['id', 'kind', 'prompt', 'help', 'required', 'not_sure_label',
            'choices']
    ) then
      return 'question';
    end if;
    if jsonb_typeof(v_question -> 'id') <> 'string' then
      return 'question_id';
    end if;
    if (v_question ->> 'id') !~ '^[a-z][a-z0-9_]{1,39}$'
       or (v_question ->> 'id') = any (v_ids) then
      return 'question_id';
    end if;
    v_ids := v_ids || (v_question ->> 'id');
    if not public.intake_label_ok(v_question -> 'prompt', 200) then
      return 'question_text';
    end if;
    if v_question ? 'help'
       and not public.intake_label_ok(v_question -> 'help', 500) then
      return 'question_text';
    end if;
    if jsonb_typeof(v_question -> 'required') <> 'boolean' then
      return 'question_text';
    end if;
    v_kind := null;
    if jsonb_typeof(v_question -> 'kind') = 'string' then
      v_kind := v_question ->> 'kind';
    end if;
    if v_kind in ('practice_area', 'jurisdictions') then
      if v_question ? 'choices' then
        return 'catalog_question';
      end if;
      if not public.intake_label_ok(v_question -> 'not_sure_label', 80) then
        return 'catalog_question';
      end if;
      if v_kind = 'practice_area' then
        v_practice_area_questions := v_practice_area_questions + 1;
      else
        v_jurisdiction_questions := v_jurisdiction_questions + 1;
      end if;
    elsif v_kind = 'single_choice' then
      if v_question ? 'not_sure_label' then
        return 'choices';
      end if;
      if coalesce(
           public.intake_json_array_length(v_question -> 'choices'), 0
         ) not between 2 and 20 then
        return 'choices';
      end if;
      v_choice_ids := '{}';
      for v_choice in
        select value from jsonb_array_elements(v_question -> 'choices')
      loop
        if public.intake_json_keys(v_choice) is distinct from
           array['id', 'label'] then
          return 'choice';
        end if;
        if jsonb_typeof(v_choice -> 'id') <> 'string' then
          return 'choice';
        end if;
        if (v_choice ->> 'id') !~ '^[a-z][a-z0-9_]{1,39}$'
           or (v_choice ->> 'id') = any (v_choice_ids) then
          return 'choice';
        end if;
        if not public.intake_label_ok(v_choice -> 'label', 80) then
          return 'choice';
        end if;
        v_choice_ids := v_choice_ids || (v_choice ->> 'id');
      end loop;
    else
      return 'kind';
    end if;
    if exists (
      select 1
      from public.intake_question_sets as s
      cross join lateral jsonb_array_elements(s.definition -> 'questions') as prior
      where prior ->> 'id' = v_question ->> 'id'
        and prior ->> 'kind' is distinct from v_kind
    ) then
      return 'question_kind_reused';
    end if;
  end loop;

  if v_practice_area_questions > 1 or v_jurisdiction_questions > 1 then
    return 'catalog_question_count';
  end if;

  v_description := p_definition -> 'description';
  if not public.intake_json_keys_within(
    v_description,
    array['prompt', 'required'],
    array['prompt', 'help', 'required']
  ) then
    return 'description';
  end if;
  if not public.intake_label_ok(v_description -> 'prompt', 200) then
    return 'description';
  end if;
  if v_description ? 'help'
     and not public.intake_label_ok(v_description -> 'help', 500) then
    return 'description';
  end if;
  if jsonb_typeof(v_description -> 'required') <> 'boolean' then
    return 'description';
  end if;

  v_limits := p_definition -> 'limits';
  if public.intake_json_keys(v_limits) is distinct from array[
    'description_max_characters',
    'intake_starts_per_client',
    'revision_saves_per_client',
    'structured_answers_max_bytes'
  ] then
    return 'limits';
  end if;
  if not public.intake_json_int_within(
       v_limits -> 'description_max_characters', 1, 20000) then
    return 'limits';
  end if;
  if not public.intake_json_int_within(
       v_limits -> 'structured_answers_max_bytes', 256, 16384) then
    return 'limits';
  end if;
  foreach v_rate_key in array array[
    'revision_saves_per_client',
    'intake_starts_per_client'
  ] loop
    v_rate := v_limits -> v_rate_key;
    if public.intake_json_keys(v_rate) is distinct from
       array['max', 'window_seconds'] then
      return 'rate_limit';
    end if;
    if not public.intake_json_int_within(v_rate -> 'max', 1, 10000) then
      return 'rate_limit';
    end if;
    if not public.intake_json_int_within(
         v_rate -> 'window_seconds', 60, 604800) then
      return 'rate_limit';
    end if;
  end loop;

  return null;
end;
$function$;

-- Null when the answers are valid under the definition; otherwise a fixed
-- problem code. A practice-area question is answered by exactly one of a
-- selected practice_area_id or its explicit "not_sure" answer; neither is
-- unanswered; both is invalid. With p_complete, every required question
-- must be answered ("incomplete" otherwise). Practice-area activity is
-- decided by the callers. Every check is its own statement.
create function public.intake_answers_problem(
  p_definition jsonb,
  p_answers jsonb,
  p_practice_area_id uuid,
  p_complete boolean
)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_key text;
  v_value jsonb;
  v_question jsonb;
  v_element jsonb;
  v_ids text[];
  v_length integer;
  v_has_practice_area_question boolean;
begin
  if jsonb_typeof(p_answers) is distinct from 'object' then
    return 'answers';
  end if;
  if octet_length(p_answers::text)
     > (p_definition -> 'limits' ->> 'structured_answers_max_bytes')::integer then
    return 'answers_size';
  end if;
  select exists (
    select 1
    from jsonb_array_elements(p_definition -> 'questions') as q
    where q ->> 'kind' = 'practice_area'
  )
  into v_has_practice_area_question;
  if p_practice_area_id is not null and not v_has_practice_area_question then
    return 'practice_area_question';
  end if;

  for v_key, v_value in select key, value from jsonb_each(p_answers) loop
    select q
    into v_question
    from jsonb_array_elements(p_definition -> 'questions') as q
    where q ->> 'id' = v_key;
    if v_question is null then
      return 'unknown_question';
    end if;
    if v_question ->> 'kind' = 'practice_area' then
      if v_value <> '"not_sure"'::jsonb or p_practice_area_id is not null then
        return 'practice_area_answer';
      end if;
    elsif v_question ->> 'kind' = 'jurisdictions' then
      if v_value <> '"not_sure"'::jsonb then
        v_length := public.intake_json_array_length(v_value);
        if coalesce(v_length, 0) not between 1 and 50 then
          return 'jurisdiction_answer';
        end if;
        v_ids := '{}';
        for v_element in select value from jsonb_array_elements(v_value) loop
          if jsonb_typeof(v_element) <> 'string' then
            return 'jurisdiction_answer';
          end if;
          if (v_element #>> '{}')
               !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             or (v_element #>> '{}') = any (v_ids) then
            return 'jurisdiction_answer';
          end if;
          v_ids := v_ids || (v_element #>> '{}');
        end loop;
        if (
          select count(*)
          from public.jurisdictions as j
          where j.id = any (v_ids::uuid[])
        ) <> cardinality(v_ids) then
          return 'jurisdiction_unknown';
        end if;
      end if;
    else
      if jsonb_typeof(v_value) <> 'string' then
        return 'choice_answer';
      end if;
      if not exists (
        select 1
        from jsonb_array_elements(v_question -> 'choices') as c
        where c ->> 'id' = v_value #>> '{}'
      ) then
        return 'choice_answer';
      end if;
    end if;
  end loop;

  if p_complete then
    for v_question in
      select value from jsonb_array_elements(p_definition -> 'questions')
    loop
      if v_question -> 'required' = 'true'::jsonb then
        if v_question ->> 'kind' = 'practice_area' then
          if p_practice_area_id is null
             and not (p_answers ? (v_question ->> 'id')) then
            return 'incomplete';
          end if;
        elsif not (p_answers ? (v_question ->> 'id')) then
          return 'incomplete';
        end if;
      end if;
    end loop;
  end if;

  return null;
end;
$function$;

-- The caller's active User (FOR SHARE) and Client Profile (FOR NO KEY
-- UPDATE, which serializes one client's intake writes), or no row.
create function public.lock_current_client()
returns table (user_id uuid, client_id uuid)
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_client uuid;
begin
  v_user := public.lock_current_active_user();
  if v_user is null then
    return;
  end if;
  select c.id
  into v_client
  from public.client_profiles as c
  where c.user_id = v_user
  for no key update;
  if not found then
    return;
  end if;
  return query select v_user, v_client;
end;
$function$;

-- The caller's staff User when, on rows locked FOR SHARE in the order User ->
-- Staff Profile -> grant, the User and Staff Profile are active and one
-- global, unrevoked, unexpired manage_intake_configuration grant exists;
-- otherwise null.
create function public.lock_current_intake_configuration_staff()
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_staff_state text;
  v_expires timestamptz;
  v_decided timestamptz;
begin
  v_user := public.lock_current_active_user();
  if v_user is null then
    return null;
  end if;
  select s.staff_state
  into v_staff_state
  from public.staff_profiles as s
  where s.user_id = v_user
  for share;
  if not found or v_staff_state is distinct from 'active' then
    return null;
  end if;
  v_decided := clock_timestamp();
  select g.expires_at
  into v_expires
  from public.capability_grants as g
  where g.user_id = v_user
    and g.capability_code = 'manage_intake_configuration'
    and g.granted_at <= v_decided
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > v_decided)
    and g.resource_scope is null
    and g.jurisdiction_id is null
  order by g.id
  limit 1
  for share;
  if not found then
    return null;
  end if;
  if v_expires is not null and v_expires <= clock_timestamp() then
    return null;
  end if;
  return v_user;
end;
$function$;

-- True when the client has reached the current version's rolling limit.
create function public.intake_rate_exceeded(
  p_client_id uuid,
  p_limit_key text,
  p_limits jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  v_max integer := (p_limits -> p_limit_key ->> 'max')::integer;
  v_since timestamptz := statement_timestamp()
    - make_interval(secs => (p_limits -> p_limit_key ->> 'window_seconds')::integer);
  v_count bigint;
begin
  if p_limit_key = 'intake_starts_per_client' then
    select count(*)
    into v_count
    from public.intakes as i
    where i.client_id = p_client_id
      and i.created_at > v_since;
  elsif p_limit_key = 'revision_saves_per_client' then
    select count(*)
    into v_count
    from public.intake_revisions as r
    join public.intakes as i on i.id = r.intake_id
    where i.client_id = p_client_id
      and r.created_at > v_since;
  else
    return true;
  end if;
  return v_count >= v_max;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Client operations (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.client_create_intake()
returns table (outcome text, intake_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_client uuid;
  v_definition jsonb;
  v_intake uuid;
begin
  select l.user_id, l.client_id
  into v_user, v_client
  from public.lock_current_client() as l;
  if v_client is null then
    return query select 'denied'::text, null::uuid;
    return;
  end if;
  select s.definition
  into v_definition
  from public.intake_question_sets as s
  order by s.published_at desc
  limit 1;
  if v_definition is null then
    return query select 'unavailable'::text, null::uuid;
    return;
  end if;
  if public.intake_rate_exceeded(
    v_client, 'intake_starts_per_client', v_definition -> 'limits'
  ) then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;
  insert into public.intakes (client_id, state)
  values (v_client, 'draft')
  returning id into v_intake;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'client', 'client_intake_created', 'intake', v_intake,
    null, jsonb_build_object('state', 'draft'), null, null,
    null, statement_timestamp()
  );
  return query select 'created'::text, v_intake;
end;
$function$;

create function public.client_save_intake_revision(
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

create function public.client_submit_intake(
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

create function public.client_close_intake(p_intake_id uuid)
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

-- Active practice areas, plus any referenced by the caller's own revisions;
-- nothing for a caller without an active Client Profile.
create function public.client_intake_practice_areas()
returns table (id uuid, code text, name text, active boolean)
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  with caller as (
    select c.id as client_id
    from public.users as u
    join public.client_profiles as c on c.user_id = u.id
    where u.auth_user_id = (select auth.uid())
      and u.account_state = 'active'
  )
  select pa.id, pa.code, pa.name, pa.active
  from public.practice_areas as pa
  where exists (select 1 from caller)
    and (
      pa.active
      or exists (
        select 1
        from public.intake_revisions as r
        join public.intakes as i on i.id = r.intake_id
        join caller on caller.client_id = i.client_id
        where r.practice_area_id = pa.id
      )
    )
  order by pa.name collate "C", pa.code collate "C";
$function$;

-- Jurisdiction identity, code, and name for a caller with an active Client
-- Profile; clients hold no table grant on jurisdictions.
create function public.client_intake_jurisdictions()
returns table (id uuid, code text, name text)
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select j.id, j.code, j.name
  from public.jurisdictions as j
  where exists (
    select 1
    from public.users as u
    join public.client_profiles as c on c.user_id = u.id
    where u.auth_user_id = (select auth.uid())
      and u.account_state = 'active'
  )
  order by j.name collate "C", j.code collate "C";
$function$;

-- ---------------------------------------------------------------------------
-- Configuration publication (EXECUTE for authenticated only; authority is
-- the caller's locked staff state and global capability grant).
-- ---------------------------------------------------------------------------

create function public.staff_publish_intake_question_set(
  p_version_key text,
  p_definition jsonb
)
returns table (outcome text, question_set_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  v_user uuid;
  v_last timestamptz;
  v_published_at timestamptz;
  v_id uuid;
begin
  v_user := public.lock_current_intake_configuration_staff();
  if v_user is null then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;
  lock table public.intake_question_sets in share row exclusive mode;
  if p_version_key is null
     or p_version_key !~ '^[a-z][a-z0-9-]{2,63}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if exists (
    select 1
    from public.intake_question_sets as s
    where s.version_key = p_version_key
  ) then
    return query select 'duplicate_version'::text, null::uuid;
    return;
  end if;
  if public.intake_definition_problem(p_definition) is not null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select max(s.published_at)
  into v_last
  from public.intake_question_sets as s;
  v_published_at := clock_timestamp();
  if v_last is not null and v_published_at <= v_last then
    v_published_at := v_last + interval '1 microsecond';
  end if;
  insert into public.intake_question_sets (version_key, definition, published_at)
  values (p_version_key, p_definition, v_published_at)
  returning id into v_id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_user, 'staff', 'intake_question_set_published', 'intake_question_set',
    v_id, null,
    jsonb_build_object(
      'version_key', p_version_key,
      'definition_sha256',
      encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex')
    ),
    null, null, null, statement_timestamp()
  );
  return query select 'published'::text, v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.intake_reject_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.intake_label_ok(jsonb, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.intake_json_int_within(jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.intake_json_keys(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.intake_json_keys_within(jsonb, text[], text[])
  from public, anon, authenticated, service_role;
revoke all on function public.intake_json_array_length(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.intake_definition_problem(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.intake_answers_problem(jsonb, jsonb, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.lock_current_client()
  from public, anon, authenticated, service_role;
revoke all on function public.lock_current_intake_configuration_staff()
  from public, anon, authenticated, service_role;
revoke all on function public.intake_rate_exceeded(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.client_create_intake()
  from public, anon, authenticated, service_role;
grant execute on function public.client_create_intake() to authenticated;

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

revoke all on function public.client_intake_practice_areas()
  from public, anon, authenticated, service_role;
grant execute on function public.client_intake_practice_areas()
  to authenticated;

revoke all on function public.client_intake_jurisdictions()
  from public, anon, authenticated, service_role;
grant execute on function public.client_intake_jurisdictions()
  to authenticated;

revoke all on function public.staff_publish_intake_question_set(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_publish_intake_question_set(text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on table public.intake_question_sets is
  'PS-A1: immutable published intake question configuration versions; the current version is the latest published_at. Published only through staff_publish_intake_question_set; never edited or deleted.';
comment on table public.intake_revisions is
  'PS-A1: immutable complete snapshots of client-provided intake content; the current content is the latest revision. Written only through client_save_intake_revision; never edited or deleted, and never copied into audit events.';
comment on column public.intake_revisions.practice_area_id is
  'The category the client selected: a client statement, never a legal classification, eligibility, routing, or attorney selection. Null means no category is selected; an explicit "not sure" is recorded under the practice-area question in structured_answers.';
comment on column public.intake_revisions.structured_answers is
  'Answers keyed by question identifier, interpreted only against question_set_id.';
comment on function public.client_create_intake() is
  'P5-001: a new draft Intake for the caller''s own Client Profile, with atomic audit; requires a published question set and the current start rate limit.';
comment on function public.client_save_intake_revision(uuid, integer, uuid, uuid, text, jsonb) is
  'P5-001: appends the next immutable revision of the caller''s own draft when the expected revision is the latest and the version is the governing or current one; validates against that version.';
comment on function public.client_submit_intake(uuid, integer) is
  'P5-001: draft to submitted for the caller''s own Intake, with stated jurisdictions recorded as unreviewed client-statement assessments and atomic audit; an explicit not-sure answer is complete and yields no classification.';
comment on function public.client_close_intake(uuid) is
  'P5-001: closes the caller''s own Intake with atomic audit; content is preserved.';
comment on function public.staff_publish_intake_question_set(text, jsonb) is
  'P5-001: publishes an immutable intake question set version for an active staff User holding a global manage_intake_configuration grant, with atomic audit of the definition digest.';
