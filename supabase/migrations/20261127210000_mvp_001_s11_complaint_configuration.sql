-- MVP-001 S11 PS-A6 (3 of 3): complaint vocabularies as policy configuration, and the statement of a Complaint Case
-- (PS-A6 sections 4, 5 and 8; MVP-001 Packet S11 "complaint foundation" and section 3 "complaint vocabularies:
-- configuration"; MBS section 16; PS sections 8.3, 8.4 and 27.1; PS-A2 section 5; DM section 4 "Policy kinds include
-- Complaint").
--
-- This migration adds exactly one policy type catalog row (reference data: complaint, "Complaint") and one column
-- (public.complaint_cases.statement). No other relation, column, policy type, notification type or business row is
-- added; no vocabulary is seeded and no code is a default. Existing Complaint Cases keep null in statement.
--
-- Complaint vocabularies (PS-A6 section 4):
-- - complaint_parameters_valid (internal): the parameters are an object whose only keys are category_codes and
--   resolution_codes, each an array holding one or more unique codes of the form complaint_cases already checks
--   (lower-snake, 2 to 64 characters);
-- - policy_parameters_approvable (20261127140000, replaced forward with its signature, volatility, security mode,
--   search_path, owner, privileges and comment; every existing branch kept exactly) validates complaint versions with
--   it before approval (PS section 8.4);
-- - complaint_vocabulary (20261127060000, the seam, replaced forward with its signature, volatility, security mode and
--   search_path): the version policy_select_version (the environment-anchored resolver) picks for the jurisdiction
--   recorded on the case, or the platform-scope version (jurisdiction null) for a case without one, with its two code
--   lists; anything else (no applicable version, a conflict, an unrecorded or mismatched environment, a development
--   version in a production-class database, parameters that do not validate) answers configuration_unavailable exactly
--   as before, and classification and resolution then change nothing. staff_classify_complaint and
--   staff_resolve_complaint are unchanged: they record a listed code and already audit the selected version id.
--
-- The complaint statement (PS-A6 section 5):
-- - statement text null: what the complainant writes about the problem; optional, not only whitespace, up to 20,000
--   characters (the PS-A1 client free-text ceiling), fixed when the case is opened: complaint_case_guard
--   (20261127060000, replaced forward with every rule kept) adds it to the case's fixed facts;
-- - complaint_open (dropped and created again, as S6 replaced request_create: the same body, privileges and comment,
--   with the optional p_statement added last with a null default so a call naming two arguments keeps its meaning): a
--   statement is trimmed, an empty one is none, and one longer than 20,000 characters answers invalid;
-- - visible only where the case itself is: complaint_cases_mine answers it to the complainant and staff_complaint_case
--   to holders of manage_complaints in scope (both dropped and created again with the column added last, every other
--   column, rule, privilege and comment kept); never to the other participant, and never in any staff list, log,
--   notification or audit event.
--
-- staff_complaint_case also answers the codes of the vocabulary that governs the case now (category_codes and
-- resolution_codes; empty lists while none is selectable), so the staff page offers them as the choices.

-- ---------------------------------------------------------------------------
-- The policy type catalog row (PS-A6 section 4; reference data).
-- ---------------------------------------------------------------------------

insert into public.policy_types (code, name)
values ('complaint', 'Complaint');

-- ---------------------------------------------------------------------------
-- Complaint vocabularies (PS-A6 section 4).
-- ---------------------------------------------------------------------------

-- Whether complaint parameters hold only category_codes and resolution_codes, each an array of one or more unique
-- lower-snake codes.
create function public.complaint_parameters_valid(p_parameters jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    jsonb_typeof(p_parameters) = 'object'
    and (select count(*) from jsonb_object_keys(p_parameters)) = 2
    and p_parameters ? 'category_codes'
    and p_parameters ? 'resolution_codes'
    and not exists (
      select 1
      from unnest(array['category_codes', 'resolution_codes']) as k(key)
      where jsonb_typeof(p_parameters -> k.key) is distinct from 'array'
         or jsonb_array_length(p_parameters -> k.key) < 1
         or exists (
           select 1 from jsonb_array_elements(p_parameters -> k.key) as c
           where jsonb_typeof(c) <> 'string' or (c #>> '{}') collate "C" !~ '^[a-z][a-z0-9_]{1,63}$'
         )
         or (select count(distinct c) from jsonb_array_elements_text(p_parameters -> k.key) as c)
            <> jsonb_array_length(p_parameters -> k.key)
    ),
    false);
$function$;

-- Approval validation (20261127140000 with the complaint branch added; every other branch unchanged).
create or replace function public.policy_parameters_approvable(
  p_policy_type_code text,
  p_jurisdiction_id uuid,
  p_parameters jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_policy_type_code
    when 'fee' then
      case
        when p_jurisdiction_id is null then public.pricing_platform_parameters_valid(p_parameters)
        else public.pricing_fee_parameters_valid(p_parameters)
      end
    when 'referral' then
      coalesce(
        jsonb_typeof(p_parameters) = 'object'
        and (
          not (p_parameters ? 'request_message_maximum_characters')
          or public.pricing_integer_within(p_parameters -> 'request_message_maximum_characters', 1, 20000)
        )
        and (
          not (p_parameters ? 'outcome_codes')
          or (
            jsonb_typeof(p_parameters -> 'outcome_codes') = 'array'
            and jsonb_array_length(p_parameters -> 'outcome_codes') between 1 and 100
            and not exists (
              select 1 from jsonb_array_elements(p_parameters -> 'outcome_codes') as c
              where jsonb_typeof(c) <> 'string' or (c #>> '{}') collate "C" !~ '^[a-z][a-z0-9_]{1,63}$'
            )
            and (select count(distinct c) from jsonb_array_elements_text(p_parameters -> 'outcome_codes') as c)
                = jsonb_array_length(p_parameters -> 'outcome_codes')
          )
        ),
        false)
    when 'payment_flow' then public.payment_flow_parameters_valid(p_parameters)
    when 'engagement' then public.engagement_parameters_valid(p_parameters)
    when 'scheduling' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or (
          (
            not (p_parameters ? 'consultation_join_window_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_join_window_seconds', 0, 86400)
          )
          and (
            not (p_parameters ? 'consultation_overrun_seconds')
            or public.pricing_integer_within(p_parameters -> 'consultation_overrun_seconds', 0, 86400)
          )
          and public.policy_optional_whole_within(p_parameters, 'hold_response_window_seconds', 1, 2592000)
          and public.policy_optional_whole_within(p_parameters, 'hold_pre_slot_interval_seconds', 0, 2592000)
          and public.policy_optional_whole_within(p_parameters, 'pending_hold_cap', 1, 10000)
          and public.policy_optional_whole_within(p_parameters, 'minimum_notice_seconds', 0, 31536000)
          and public.policy_optional_whole_within(
            p_parameters, 'instant_request_response_window_seconds', 1, 2592000)
          and public.policy_optional_whole_within(
            p_parameters, 'scheduled_request_response_window_seconds', 1, 2592000)
        ),
        false)
    when 'notification' then
      coalesce(
        jsonb_typeof(p_parameters) is distinct from 'object'
        or public.notification_parameters_valid(p_parameters),
        false)
    when 'eligibility' then coalesce(public.eligibility_parameters_valid(p_parameters), false)
    when 'bookability' then
      coalesce(
        jsonb_typeof(p_parameters) = 'object'
        and public.pricing_integer_within(p_parameters -> 'presence_window_seconds', 1, 86400),
        false)
    when 'complaint' then coalesce(public.complaint_parameters_valid(p_parameters), false)
    else true
  end;
$function$;


-- The complaint vocabularies that govern a case at an instant: ('selected', version, category codes, resolution codes)
-- for the version policy_select_version picks for the case's jurisdiction (the platform scope for a case without one),
-- or configuration_unavailable.
create or replace function public.complaint_vocabulary(p_jurisdiction uuid, p_as_of timestamptz)
returns table (outcome text, policy_version_id uuid, category_codes text[], resolution_codes text[])
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_outcome text;
  v_version uuid;
  v_parameters jsonb;
begin
  if p_as_of is not null then
    select s.outcome, s.policy_version_id into v_outcome, v_version
    from public.policy_select_version('complaint', p_jurisdiction, null, p_as_of) as s;
  end if;
  if v_outcome is distinct from 'selected' or v_version is null then
    return query select 'configuration_unavailable'::text, null::uuid, array[]::text[], array[]::text[];
    return;
  end if;
  select v.parameters into v_parameters from public.policy_versions as v where v.id = v_version;
  if not public.complaint_parameters_valid(v_parameters) then
    return query select 'configuration_unavailable'::text, null::uuid, array[]::text[], array[]::text[];
    return;
  end if;
  return query select
    'selected'::text,
    v_version,
    array(select jsonb_array_elements_text(v_parameters -> 'category_codes')),
    array(select jsonb_array_elements_text(v_parameters -> 'resolution_codes'));
end;
$function$;

-- ---------------------------------------------------------------------------
-- The complaint statement (PS-A6 section 5).
-- ---------------------------------------------------------------------------

alter table public.complaint_cases
  add column statement text,
  add constraint complaint_cases_statement_v1_check
    check (statement is null or (char_length(statement) <= 20000 and statement ~ '[^[:space:]]'));

-- The guard (20261127060000 with the statement added to the facts that never change; every other rule unchanged).
create or replace function public.complaint_case_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.complaint_cases rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'opened'
       or new.category_code is not null
       or new.resolution_code is not null
       or new.resolved_at is not null
       or new.assigned_to_user_id is not null then
      raise exception 'a complaint case is recorded opened, unassigned and unclassified'
        using errcode = '23514';
    end if;
    if new.consultation_id is not null
       and new.referral_id is not null
       and not exists (
         select 1
         from public.consultations as c
         join public.consultation_requests as r on r.id = c.consultation_request_id
         where c.id = new.consultation_id
           and r.referral_id = new.referral_id
       ) then
      raise exception 'a complaint case''s consultation and referral belong together'
        using errcode = '23514';
    end if;
    if new.jurisdiction_id is distinct from
       public.complaint_linkage_jurisdiction(new.consultation_id, new.referral_id) then
      raise exception 'a complaint case''s jurisdiction is its linkage''s'
        using errcode = '23514';
    end if;
    if public.complaint_complainant_role(new.complainant_user_id, new.consultation_id, new.referral_id) is null then
      raise exception 'a complainant is the client or the attorney of the linked matter'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.complainant_user_id is distinct from old.complainant_user_id
     or new.consultation_id is distinct from old.consultation_id
     or new.referral_id is distinct from old.referral_id
     or new.jurisdiction_id is distinct from old.jurisdiction_id
     or new.opened_at is distinct from old.opened_at
     or new.created_at is distinct from old.created_at
     or new.statement is distinct from old.statement then
    raise exception 'a complaint case keeps its complainant, linkage, jurisdiction, opening and statement'
      using errcode = '55000';
  end if;
  if old.state = 'resolved'
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'a resolved complaint case is final'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'opened' and new.state = 'in_review')
       or (old.state = 'in_review' and new.state in ('opened', 'escalated', 'resolved'))
       or (old.state = 'escalated' and new.state in ('in_review', 'resolved'))
     ) then
    raise exception 'complaint case transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

-- Intake: the optional statement added (see the header).
drop function public.complaint_open(uuid, uuid);

create function public.complaint_open(p_consultation_id uuid, p_referral_id uuid, p_statement text default null)
returns table (outcome text, complaint_case_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_caller record;
  v_jurisdiction uuid;
  v_case uuid;
  v_statement text;
begin
  v_statement := nullif(regexp_replace(p_statement, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if (p_consultation_id is not null and p_referral_id is not null)
     or char_length(v_statement) > 20000 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select c.* into v_caller from public.complaint_caller(p_consultation_id, p_referral_id) as c;
  if v_caller.outcome is distinct from 'ok' then
    return query select coalesce(v_caller.outcome, 'not_found'), null::uuid;
    return;
  end if;
  v_jurisdiction := public.complaint_linkage_jurisdiction(p_consultation_id, p_referral_id);
  insert into public.complaint_cases (
    complainant_user_id, consultation_id, referral_id, jurisdiction_id, state, opened_at, statement
  ) values (
    v_caller.user_id, p_consultation_id, p_referral_id, v_jurisdiction, 'opened', clock_timestamp(), v_statement
  )
  on conflict (
    complainant_user_id,
    (coalesce(consultation_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(referral_id, '00000000-0000-0000-0000-000000000000'::uuid))
  ) where state <> 'resolved'
  do nothing
  returning id into v_case;
  if v_case is null then
    return query select 'already_open'::text, null::uuid;
    return;
  end if;
  perform public.notification_emit(v_caller.user_id, 'complaint_received', 'complaint_case.opened', v_case);
  perform public.decision_audit(
    v_caller.user_id, v_caller.complainant_role, 'complaint_case.opened', 'complaint_case', v_case,
    null,
    jsonb_build_object(
      'state', 'opened',
      'complainant_role', v_caller.complainant_role,
      'consultation_id', p_consultation_id,
      'referral_id', p_referral_id
    ),
    null, null, v_jurisdiction
  );
  return query select 'opened'::text, v_case;
end;
$function$;

-- The complainant's own cases, with their statement.
drop function public.complaint_cases_mine();

create function public.complaint_cases_mine()
returns table (
  complaint_case_id uuid,
  state text,
  consultation_id uuid,
  referral_id uuid,
  opened_at timestamptz,
  resolved_at timestamptz,
  statement text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select k.id, k.state, k.consultation_id, k.referral_id, k.opened_at, k.resolved_at, k.statement
  from public.complaint_cases as k
  where k.complainant_user_id = public.notification_caller()
  order by k.opened_at desc, k.id
  limit 200;
$function$;

-- One case for staff in scope, with its statement and the codes of the vocabulary that governs it now.
drop function public.staff_complaint_case(uuid);

create function public.staff_complaint_case(p_complaint_case_id uuid)
returns table (
  complaint_case_id uuid,
  jurisdiction_id uuid,
  state text,
  category_code text,
  resolution_code text,
  opened_at timestamptz,
  resolved_at timestamptz,
  assigned_to_me boolean,
  complainant_role text,
  consultation_id uuid,
  consultation_state text,
  consultation_outcome_code text,
  referral_id uuid,
  referral_outcome_code text,
  attorney_joined boolean,
  client_joined boolean,
  both_present boolean,
  either_left boolean,
  payment_state text,
  active_legal_holds integer,
  statement text,
  category_codes text[],
  resolution_codes text[]
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    k.id,
    k.jurisdiction_id,
    k.state,
    k.category_code,
    k.resolution_code,
    k.opened_at,
    k.resolved_at,
    coalesce(k.assigned_to_user_id = (
      select u.id from public.users as u where u.auth_user_id = auth.uid()
    ), false),
    public.complaint_complainant_role(k.complainant_user_id, k.consultation_id, k.referral_id),
    k.consultation_id,
    c.state,
    c.outcome_code,
    k.referral_id,
    f.outcome_code,
    case when c.id is not null then p.attorney_joined_at is not null end,
    case when c.id is not null then p.client_joined_at is not null end,
    case when c.id is not null then coalesce(p.both_present, false) end,
    case when c.id is not null then coalesce(p.either_left, false) end,
    (
      select pt.state
      from public.payment_transactions as pt
      where pt.consultation_request_id = c.consultation_request_id
      order by pt.created_at desc, pt.id desc
      limit 1
    ),
    (
      select count(*)::integer
      from public.legal_holds as h
      where (h.released_at is null or h.released_at > statement_timestamp())
        and (
          (h.scope_type = 'complaint_case' and h.scope_id = k.id)
          or (k.consultation_id is not null and h.scope_id = k.consultation_id)
        )
    ),
    k.statement,
    v.category_codes,
    v.resolution_codes
  from public.complaint_cases as k
  left join public.consultations as c on c.id = k.consultation_id
  left join public.referrals as f on f.id = k.referral_id
  left join lateral public.consultation_participation(c.id) as p on c.id is not null
  cross join lateral public.complaint_vocabulary(k.jurisdiction_id, statement_timestamp()) as v
  where k.id = p_complaint_case_id
    and public.has_staff_capability('manage_complaints', k.jurisdiction_id, false);
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges (the replaced functions keep theirs; the created ones receive their earlier ones).
-- ---------------------------------------------------------------------------

revoke all on function public.complaint_parameters_valid(jsonb)
  from public, anon, authenticated, service_role;

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.complaint_open(uuid, uuid, text)',
    'public.complaint_cases_mine()',
    'public.staff_complaint_case(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.complaint_parameters_valid(jsonb) is
  'PS-A6 section 4 (internal): whether complaint policy parameters hold only category_codes and resolution_codes, each an array of one or more unique lower-snake codes. Executable by no API role.';
comment on function public.complaint_vocabulary(uuid, timestamptz) is
  'PS-A6 section 4 (internal): the category and resolution codes of the complaint version policy_select_version picks for a case''s jurisdiction (the platform scope for a case without one) at an instant; configuration_unavailable when none is selectable or its parameters fail validation. No vocabulary is seeded or defaulted.';
comment on column public.complaint_cases.statement is
  'PS-A6 section 5: what the complainant wrote about the problem (optional, up to 20,000 characters), fixed when the case is opened; answered only to the complainant and to manage_complaints holders in scope, never in a list, log, notification or audit event.';
comment on function public.complaint_case_guard() is
  'MVP-001 S11 (every role): a Complaint Case is never deleted or truncated; it is recorded opened, unassigned and unclassified, by a participant of its linked matter, with its linkage''s jurisdiction; its complainant, linkage, jurisdiction, opening and statement (PS-A6 section 5) never change; it moves only opened -> in_review, in_review -> opened | escalated | resolved, escalated -> in_review | resolved, and a resolved case never changes.';
comment on function public.complaint_open(uuid, uuid, text) is
  'MVP-001 S11: a client (any aal) or an attorney (approved, aal2) opens one Complaint Case, optionally linked to a Consultation they participate in or a Referral of their own, with an optional statement (PS-A6 section 5: at most 20,000 characters, never audited or notified); the complainant is the caller; the jurisdiction is derived; nothing else changes (PM row 47); one Notification to the complainant; audited. Outcomes: opened, invalid, denied, not_found, already_open.';
comment on function public.complaint_cases_mine() is
  'MVP-001 S11: the caller''s own Complaint Cases (state, linkage, instants and, PS-A6 section 5, their own statement); at most 200. Nothing about assignment, classification or resolution.';
comment on function public.staff_complaint_case(uuid) is
  'MVP-001 S11 complaint workspace: one Complaint Case with minimum metadata for staff holding manage_complaints for its jurisdiction (aal2): the complainant''s role, the linked Consultation''s and Referral''s ids and states, four participation-evidence facts, the latest payment state, the number of unreleased Legal Holds on the case or its Consultation, the complainant''s statement (PS-A6 section 5) and the codes of the complaint vocabulary that governs the case now (PS-A6 section 4); never a name, a User id or other content.';
