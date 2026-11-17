-- MVP-001 S3 (6 of 6): staff review of jurisdiction assessments (MVP-001 Packet S3 "staff intake configuration
-- and jurisdiction-assessment review"; MBS section 8 "jurisdiction assessment is clearly a suggestion, not a legal
-- conclusion" and "ambiguous jurisdiction is surfaced rather than guessed"; PS section 12.2; ROS section 6.3; DM
-- section 6; MB section 27; MBS section 5; TA section 30.4).
--
-- No relation or column is added (Packet rule 16). The authority names no capability for this review, so it is
-- governed by the existing manage_intake_configuration capability (the Packet groups intake configuration and
-- jurisdiction-assessment review in one S3 item); no capability row is added. Its scope follows the grant: a
-- global grant reviews every jurisdiction, a jurisdiction-scoped grant only that jurisdiction. Every read and
-- the review itself require an aal2 session (MVP-001 S2) through has_staff_capability and
-- lock_current_capability_staff.
-- - A review records only a review status on one assessment, once: 'confirmed' (the candidate jurisdiction may
--   be relevant) or 'not_confirmed'. It never asserts governing law, never creates, removes or chooses a
--   jurisdiction, and never changes the Intake, its revisions or the client's statement. Audited.
-- - Staff see only what review needs: the Intake's opaque id, state and creation time, how many distinct
--   candidate jurisdictions it holds, and each in-scope assessment (jurisdiction, source, basis, status). No
--   client identity and no intake content (description, answers, voice memo) is disclosed (PS-A1 section 2.9).
-- - Ambiguity is surfaced, never guessed: an Intake whose assessments name several candidate jurisdictions shows
--   that count beside each assessment, and submitted Intakes that name none (the client chose "not sure" or the
--   question set asks none) are listed for global reviewers in their own group, with nothing to choose.
-- - Only submitted or active Intakes not past their expires_at are reviewed; drafts are still being written and
--   ended Intakes are no longer offered.
-- - Attorneys see nothing of any Intake before acceptance (counsel gate, REG-CA-035 equivalent): nothing here is
--   reachable without the staff capability.

-- ---------------------------------------------------------------------------
-- Implementation constraint and integrity on the existing relation.
-- ---------------------------------------------------------------------------

alter table public.jurisdiction_assessments
  add constraint jurisdiction_assessments_review_v1_check
    check (
      (review_status = 'unreviewed' and reviewed_at is null)
      or (review_status in ('confirmed', 'not_confirmed') and reviewed_at is not null)
    );

create function public.jurisdiction_assessment_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.jurisdiction_assessments rows are never deleted'
      using errcode = '55000';
  end if;
  if old.review_status is distinct from 'unreviewed' then
    raise exception 'a reviewed jurisdiction assessment is immutable'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'review_status' - 'reviewed_at' - 'reviewed_by_user_id')
     is distinct from
     (to_jsonb(old) - 'review_status' - 'reviewed_at' - 'reviewed_by_user_id') then
    raise exception 'a jurisdiction assessment changes only by its review'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger jurisdiction_assessments_integrity
before update or delete on public.jurisdiction_assessments
for each row
execute function public.jurisdiction_assessment_integrity();

create trigger jurisdiction_assessments_no_truncate
before truncate on public.jurisdiction_assessments
for each statement
execute function public.jurisdiction_assessment_integrity();

-- ---------------------------------------------------------------------------
-- Staff reads (EXECUTE for authenticated only; nothing for a caller without the capability at aal2).
-- ---------------------------------------------------------------------------

-- One page of the reviewable Intakes of one group, oldest first:
-- - 'unreviewed': Intakes holding at least one unreviewed assessment in a jurisdiction the caller's grant
--   covers;
-- - 'unnamed': Intakes holding no assessment at all (no candidate jurisdiction named), for a global grant only.
-- Each row: the Intake id, state and creation time, the number of distinct candidate jurisdictions of all its
-- assessments, and the number of its unreviewed assessments the caller may review. p_offset 0..1000000,
-- p_count 1..101; anything else answers nothing.
create function public.staff_jurisdiction_review_intakes(
  p_group text,
  p_offset integer,
  p_count integer
)
returns table (
  intake_id uuid,
  intake_state text,
  intake_created_at timestamptz,
  candidate_count integer,
  unreviewed_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with in_scope as (
    select j.id
    from public.jurisdictions as j
    where public.has_staff_capability('manage_intake_configuration', j.id, false)
  ),
  reviewable as (
    select
      i.id,
      i.state,
      i.created_at,
      (
        select count(distinct a.jurisdiction_id)
        from public.jurisdiction_assessments as a
        where a.intake_id = i.id
      )::integer as candidates,
      (
        select count(*)
        from public.jurisdiction_assessments as a
        where a.intake_id = i.id
          and a.review_status = 'unreviewed'
          and a.jurisdiction_id in (select s.id from in_scope as s)
      )::integer as unreviewed
    from public.intakes as i
    where i.state in ('submitted', 'active')
      and (i.expires_at is null or i.expires_at > statement_timestamp())
  )
  select r.id, r.state, r.created_at, r.candidates, r.unreviewed
  from reviewable as r
  where p_offset between 0 and 1000000
    and p_count between 1 and 101
    and (
      (p_group = 'unreviewed' and r.unreviewed > 0)
      or (
        p_group = 'unnamed'
        and r.candidates = 0
        and public.has_staff_capability('manage_intake_configuration', null, false)
      )
    )
  order by r.created_at, r.id
  offset case when p_offset between 0 and 1000000 then p_offset else 0 end
  limit case when p_count between 1 and 101 then p_count else 0 end;
$function$;

-- The assessments of one reviewable Intake that the caller's grant covers, oldest first (at most 100).
create function public.staff_jurisdiction_review_assessments(p_intake_id uuid)
returns table (
  assessment_id uuid,
  jurisdiction_id uuid,
  jurisdiction_code text,
  jurisdiction_name text,
  source_type text,
  assessment_basis text,
  review_status text,
  created_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    a.id,
    a.jurisdiction_id,
    j.code,
    j.name,
    a.source_type,
    a.assessment_basis,
    a.review_status,
    a.created_at,
    a.reviewed_at,
    a.reviewed_by_user_id
  from public.jurisdiction_assessments as a
  join public.jurisdictions as j on j.id = a.jurisdiction_id
  join public.intakes as i on i.id = a.intake_id
  where a.intake_id = p_intake_id
    and i.state in ('submitted', 'active')
    and (i.expires_at is null or i.expires_at > statement_timestamp())
    and public.has_staff_capability('manage_intake_configuration', a.jurisdiction_id, false)
  order by a.created_at, a.id
  limit 100;
$function$;

-- ---------------------------------------------------------------------------
-- The review (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

-- Fixed outcomes: applied, invalid, denied, not_found, already_reviewed, not_reviewable. A caller with no
-- manage_intake_configuration grant at aal2 is denied; an assessment outside the caller's grant answers exactly as
-- an unknown one (not_found). Locks User -> Staff Profile -> grant (lock_current_capability_staff, aal2), then the
-- Intake, then the assessment; writes the review status, its time and reviewer, and one staff audit event.
create function public.staff_review_jurisdiction_assessment(
  p_assessment_id uuid,
  p_decision text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_jurisdiction uuid;
  v_intake uuid;
  v_staff uuid;
  v_state text;
  v_expires timestamptz;
  v_assessment public.jurisdiction_assessments;
begin
  if p_assessment_id is null
     or p_decision is null
     or p_decision not in ('confirmed', 'not_confirmed') then
    return 'invalid';
  end if;
  if public.has_staff_capability('manage_intake_configuration', null, true) is not true then
    return 'denied';
  end if;
  select a.jurisdiction_id, a.intake_id
  into v_jurisdiction, v_intake
  from public.jurisdiction_assessments as a
  where a.id = p_assessment_id;
  if not found then
    return 'not_found';
  end if;
  v_staff := public.lock_current_capability_staff('manage_intake_configuration', v_jurisdiction);
  if v_staff is null then
    return 'not_found';
  end if;
  select i.state, i.expires_at
  into v_state, v_expires
  from public.intakes as i
  where i.id = v_intake
  for share;
  select a.*
  into v_assessment
  from public.jurisdiction_assessments as a
  where a.id = p_assessment_id
  for update;
  if v_assessment.review_status is distinct from 'unreviewed' then
    return 'already_reviewed';
  end if;
  if v_state not in ('submitted', 'active')
     or (v_expires is not null and v_expires <= clock_timestamp()) then
    return 'not_reviewable';
  end if;
  update public.jurisdiction_assessments as a
  set review_status = p_decision,
      reviewed_at = clock_timestamp(),
      reviewed_by_user_id = v_staff
  where a.id = p_assessment_id;
  perform public.configuration_audit(
    v_staff, 'jurisdiction_assessment.reviewed', 'jurisdiction_assessment', p_assessment_id,
    jsonb_build_object('review_status', 'unreviewed'),
    jsonb_build_object(
      'review_status', p_decision,
      'intake_id', v_intake,
      'source_type', v_assessment.source_type
    ),
    v_jurisdiction
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.jurisdiction_assessment_integrity()
  from public, anon, authenticated, service_role;

revoke all on function public.staff_jurisdiction_review_intakes(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_jurisdiction_review_intakes(text, integer, integer)
  to authenticated;
revoke all on function public.staff_jurisdiction_review_assessments(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_jurisdiction_review_assessments(uuid)
  to authenticated;
revoke all on function public.staff_review_jurisdiction_assessment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_review_jurisdiction_assessment(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.jurisdiction_assessment_integrity() is
  'MVP-001 S3: a jurisdiction assessment is never deleted or truncated, and changes only by one review (status, time, reviewer).';
comment on function public.staff_jurisdiction_review_intakes(text, integer, integer) is
  'MVP-001 S3: one page of reviewable submitted or active Intakes for an aal2 staff User holding manage_intake_configuration (unreviewed: in-scope unreviewed assessments; unnamed: no candidate jurisdiction, global grant only). Intake id, state, creation time and counts only; no client identity or content.';
comment on function public.staff_jurisdiction_review_assessments(uuid) is
  'MVP-001 S3: the in-scope assessments of one reviewable Intake for an aal2 staff User holding manage_intake_configuration for their jurisdictions: jurisdiction, source, basis and review status only.';
comment on function public.staff_review_jurisdiction_assessment(uuid, text) is
  'MVP-001 S3: records confirmed (may be relevant) or not_confirmed on one unreviewed assessment of a submitted or active Intake, once, for an aal2 staff User holding manage_intake_configuration for its jurisdiction. Never asserts governing law and never changes the Intake. Audited. Outcomes: applied, invalid, denied, not_found, already_reviewed, not_reviewable.';
comment on table public.jurisdiction_assessments is
  'Historical jurisdiction assessment records: client statements recorded at submission and client-confirmed AI suggestions, each with a recorded basis and a review status. An assessment never asserts governing law (PS section 12.2). Never deleted; changed only by one staff review.';
