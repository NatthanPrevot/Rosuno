-- MVP-001 S11 (4 of 7): the reviews relation and the server-qualified review flow (MVP-001 Packet S11 "the reviews
-- relation (PS section 21.1) and the server-qualified review flow"; MBS section 16 "Verified Client Review" and its
-- failure tests "invalid review attempts fail server-side", "duplicate reviews are prevented"; DM section 9 "Review:
-- the reviewed attorney is derived from the Consultation"; TA sections 3.13 and 49; PS sections 21.1, 30.2, 30.3 and
-- P3 "never store an aggregate rating"; MB section 59).
--
-- This migration creates exactly one relation, public.reviews, with exactly the PS section 21.1 columns (id,
-- consultation_id, client_id, rating, review_text, state, submitted_at, published_at, moderated_at, created_at) and
-- nothing else: no attorney column (the reviewed attorney is always derived from the Consultation), no aggregate, no
-- moderation reason. No policy type and no other relation or column is added (Packet rules 8 and 16).
--
-- Rules, for every role, the database owner included (constraints and one guard trigger):
-- - one review per Consultation (PS section 21.1 unique key; MBS section 16 "one review per qualifying Consultation");
-- - a review is recorded only for a completed Consultation (cancelled, no_show and technical_failure never qualify;
--   every completion reason does) and its client_id is that Consultation's client;
-- - rating is a whole number from 1 to 5: a fixed technical scale of this relation's smallint, not a policy value
--   (owner-confirmable);
-- - review_text is optional; when present it is not blank, carries no surrounding whitespace and holds at most 20,000
--   characters (the PS-A1 client free-text ceiling, a technical bound);
-- - state is submitted, published or rejected. A review is recorded submitted, with its submission instant; it moves
--   forward only: submitted -> published | rejected, published -> rejected (a takedown); rejected is final;
-- - its Consultation, client, rating, text, submission instant and creation instant never change;
-- - published_at is recorded once, at the first publication; moderated_at is the instant of the latest moderation
--   decision and is present exactly when one has been made;
-- - a review is never deleted or truncated.
--
-- Publication workflow (MBS section 16 "post-consultation publication workflow"; Packet section 3 gate "review
-- moderation: owner / counsel; configuration"): nothing is public on submission. Staff holding moderate_reviews for
-- the Consultation's jurisdiction (aal2) publish or reject a submitted review and may take a published one down; each
-- decision is audited with identifiers and states only (never the text). There is no automatic publication and no
-- moderation rule: moderation rules are an owner and counsel gate, so the workflow fails closed on a human decision.
--
-- review_submit (EXECUTE for authenticated only; MBS section 16 completion criteria; TA section 49). The server
-- establishes every fact: the actor is the Consultation's own client (an active User through lock_current_client, any
-- aal), the Consultation is completed, and whether a review already exists. The attorney is never an input. Another
-- client, an attorney, an unknown id and a Consultation that is not completed answer alike (not_eligible, no existence
-- oracle); only the Consultation's own client can learn that a review exists (already_reviewed), also when two
-- submissions race (the unique key decides). Lock order: the caller's own rows, then the Consultation FOR SHARE.
--
-- Reads (stable security definer; EXECUTE as stated): client_reviews (authenticated: the caller's completed
-- Consultations, each with its review or none, so the client sees what they may still review); attorney_reviews
-- (authenticated: the published reviews about the calling attorney, approved and at aal2: rating, text and
-- publication instant, never the client or the Consultation); staff_review_queue (authenticated: the moderation queue
-- of the jurisdictions the caller holds moderate_reviews for, with the text a moderator must read); and
-- public_attorney_reviews (anon and authenticated), which follows the S5 public profile exactly: it answers only for
-- an attorney the public profile lists now (public_attorney_profile; an unlisted and an unknown id answer alike, no
-- row), the newest 50 published reviews with the rating, the text (withheld, never rewritten, when it carries a banned
-- recommendation claim: discovery_presentable_text, MBS section 10) and the publication instant, and the count and
-- average of all the attorney's published reviews computed at read time (PS P3: never stored). Never a client
-- identity, a Consultation id, a review id or anything else.
--
-- Direct reads (PS section 30.2 "own reviews"): authenticated holds SELECT under one row policy, the reviews of the
-- caller's own Client Profile (an active User). No API role holds any other privilege on the relation: every write is
-- one of the functions below.

-- ---------------------------------------------------------------------------
-- The relation (PS section 21.1).
-- ---------------------------------------------------------------------------

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null,
  client_id uuid not null,
  rating smallint not null,
  review_text text,
  state text not null,
  submitted_at timestamptz,
  published_at timestamptz,
  moderated_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint reviews_consultation_id_key
    unique (consultation_id),
  constraint reviews_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint reviews_client_id_fkey
    foreign key (client_id)
    references public.client_profiles (id)
    on update restrict
    on delete restrict,
  constraint reviews_rating_v1_check
    check (rating between 1 and 5),
  constraint reviews_text_v1_check
    check (
      review_text is null
      or (
        char_length(review_text) between 1 and 20000
        and review_text !~ '^[[:space:]]'
        and review_text !~ '[[:space:]]$'
      )
    ),
  constraint reviews_state_v1_check
    check (state in ('submitted', 'published', 'rejected')),
  constraint reviews_facts_v1_check
    check (
      submitted_at is not null
      and (state = 'submitted') = (moderated_at is null)
      and (state <> 'published' or published_at is not null)
      and (
        published_at is null
        or (moderated_at is not null and published_at >= submitted_at and moderated_at >= published_at)
      )
      and (moderated_at is null or moderated_at >= submitted_at)
    )
);

alter table public.reviews enable row level security;

create index reviews_client_submitted_idx
  on public.reviews (client_id, submitted_at desc, id);

create index reviews_state_submitted_idx
  on public.reviews (state, submitted_at, id);

-- ---------------------------------------------------------------------------
-- The guard (every role).
-- ---------------------------------------------------------------------------

create function public.review_record_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_client uuid;
  v_state text;
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.reviews rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'submitted'
       or new.published_at is not null
       or new.moderated_at is not null then
      raise exception 'a review is recorded submitted, before any moderation'
        using errcode = '23514';
    end if;
    select c.client_id, c.state into v_client, v_state
    from public.consultations as c
    where c.id = new.consultation_id;
    if new.client_id is distinct from v_client then
      raise exception 'a review belongs to its consultation''s client'
        using errcode = '23514';
    end if;
    if v_state is distinct from 'completed' then
      raise exception 'only a completed consultation is reviewed'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.consultation_id is distinct from old.consultation_id
     or new.client_id is distinct from old.client_id
     or new.rating is distinct from old.rating
     or new.review_text is distinct from old.review_text
     or new.submitted_at is distinct from old.submitted_at
     or new.created_at is distinct from old.created_at then
    raise exception 'a review keeps its consultation, client, rating, text and submission'
      using errcode = '55000';
  end if;
  if old.state = 'rejected' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'a rejected review is final'
      using errcode = '55000';
  end if;
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'a review''s first publication is recorded once'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state then
    if not (
         (old.state = 'submitted' and new.state in ('published', 'rejected'))
         or (old.state = 'published' and new.state = 'rejected')
       ) then
      raise exception 'review transition % -> % is not permitted', old.state, new.state
        using errcode = '55000';
    end if;
    if new.moderated_at is null
       or (old.moderated_at is not null and new.moderated_at < old.moderated_at) then
      raise exception 'a moderation decision records its instant'
        using errcode = '55000';
    end if;
    if (new.state = 'published') is distinct from (old.published_at is null and new.published_at is not null) then
      raise exception 'the publication instant is recorded exactly at the first publication'
        using errcode = '55000';
    end if;
  elsif to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'a review changes only by a moderation decision'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger reviews_record_guard
before insert or update or delete on public.reviews
for each row
execute function public.review_record_guard();

create trigger reviews_no_truncate
before truncate on public.reviews
for each statement
execute function public.review_record_guard();

-- ---------------------------------------------------------------------------
-- Privileges and the row policy: writes are function-only.
-- ---------------------------------------------------------------------------

revoke all on table public.reviews
  from public, anon, authenticated, service_role;
grant select on table public.reviews to authenticated;

create policy reviews_select_own_client
on public.reviews
for select
to authenticated
using (
  exists (
    select 1
    from public.client_profiles as client_profile
    join public.users as app_user
      on app_user.id = client_profile.user_id
    where client_profile.id = reviews.client_id
      and app_user.auth_user_id = (select auth.uid())
      and app_user.account_state = 'active'
  )
);

-- ---------------------------------------------------------------------------
-- Submission (EXECUTE for authenticated only).
-- ---------------------------------------------------------------------------

create function public.review_submit(p_consultation_id uuid, p_rating integer, p_review_text text)
returns table (outcome text, review_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_text text;
  v_client record;
  v_consultation public.consultations;
  v_now timestamptz;
  v_review uuid;
  v_jurisdiction uuid;
begin
  v_text := nullif(regexp_replace(p_review_text, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if p_consultation_id is null
     or p_rating is null
     or p_rating not between 1 and 5
     or char_length(v_text) > 20000 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  -- The caller's own rows, then the Consultation. Whoever is not this Consultation's own client, and a Consultation
  -- that is not completed, answer alike.
  select l.user_id, l.client_id into v_client from public.lock_current_client() as l;
  if v_client.client_id is null then
    return query select 'not_eligible'::text, null::uuid;
    return;
  end if;
  select c.* into v_consultation
  from public.consultations as c
  where c.id = p_consultation_id
    and c.client_id = v_client.client_id
  for share;
  if not found or v_consultation.state is distinct from 'completed' then
    return query select 'not_eligible'::text, null::uuid;
    return;
  end if;
  v_now := clock_timestamp();
  insert into public.reviews (consultation_id, client_id, rating, review_text, state, submitted_at)
  values (p_consultation_id, v_client.client_id, p_rating::smallint, v_text, 'submitted', v_now)
  on conflict (consultation_id) do nothing
  returning id into v_review;
  if v_review is null then
    return query select 'already_reviewed'::text, null::uuid;
    return;
  end if;
  select x.jurisdiction_id into v_jurisdiction from public.consultation_context(p_consultation_id) as x;
  perform public.decision_audit(
    v_client.user_id, 'client', 'review.submitted', 'review', v_review,
    null,
    jsonb_build_object('consultation_id', p_consultation_id, 'state', 'submitted'),
    null, null, v_jurisdiction
  );
  return query select 'submitted'::text, v_review;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Moderation (EXECUTE for authenticated only; moderate_reviews for the Consultation's jurisdiction, aal2).
-- ---------------------------------------------------------------------------

-- p_decision publish: a submitted review becomes published; reject: a submitted review is rejected, or a published
-- one is taken down. Outcomes: applied, invalid, denied, not_found, invalid_transition.
create function public.staff_moderate_review(p_review_id uuid, p_decision text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_jurisdiction uuid;
  v_known boolean;
  v_staff uuid;
  v_before public.reviews;
  v_now timestamptz;
  v_state text;
  v_action text;
begin
  if p_review_id is null or p_decision is null or p_decision not in ('publish', 'reject') then
    return 'invalid';
  end if;
  -- The jurisdiction is an immutable fact of the review's Consultation, read before any lock; a caller without the
  -- capability for it (or, for an unknown id, without a global grant) is denied either way.
  select true, f.jurisdiction_id into v_known, v_jurisdiction
  from public.reviews as r
  join public.consultations as c on c.id = r.consultation_id
  join public.consultation_requests as q on q.id = c.consultation_request_id
  join public.referrals as f on f.id = q.referral_id
  where r.id = p_review_id;
  v_staff := public.lock_current_capability_staff('moderate_reviews', v_jurisdiction);
  if v_staff is null then
    return 'denied';
  end if;
  if v_known is not true then
    return 'not_found';
  end if;
  select r.* into v_before from public.reviews as r where r.id = p_review_id for update;
  if not (
       (p_decision = 'publish' and v_before.state = 'submitted')
       or (p_decision = 'reject' and v_before.state in ('submitted', 'published'))
     ) then
    return 'invalid_transition';
  end if;
  v_now := clock_timestamp();
  v_state := case p_decision when 'publish' then 'published' else 'rejected' end;
  v_action := case
    when p_decision = 'publish' then 'review.published'
    when v_before.state = 'published' then 'review.taken_down'
    else 'review.rejected'
  end;
  update public.reviews as r
  set state = v_state,
      moderated_at = v_now,
      published_at = case when p_decision = 'publish' then v_now else r.published_at end
  where r.id = p_review_id;
  perform public.decision_audit(
    v_staff, 'staff', v_action, 'review', p_review_id,
    jsonb_build_object('state', v_before.state),
    jsonb_build_object('state', v_state, 'consultation_id', v_before.consultation_id),
    null, null, v_jurisdiction
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reads.
-- ---------------------------------------------------------------------------

-- The caller's completed Consultations as their client (an active User), each with its review or none (a Consultation
-- without one may still be reviewed); the most recently completed first, at most 200.
create function public.client_reviews()
returns table (
  consultation_id uuid,
  consultation_ended_at timestamptz,
  review_id uuid,
  rating smallint,
  review_text text,
  state text,
  submitted_at timestamptz,
  published_at timestamptz,
  moderated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    c.id,
    c.ended_at,
    r.id,
    r.rating,
    r.review_text,
    r.state,
    r.submitted_at,
    r.published_at,
    r.moderated_at
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultations as c on c.client_id = cp.id and c.state = 'completed'
  left join public.reviews as r on r.consultation_id = c.id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
  order by c.ended_at desc nulls last, c.id
  limit 200;
$function$;

-- The published reviews about the calling attorney (an approved Attorney Profile of an active User at aal2): rating,
-- text and publication instant, the newest first, at most 200. Never the client or the Consultation.
create function public.attorney_reviews()
returns table (rating smallint, review_text text, published_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select r.rating, r.review_text, r.published_at
  from public.users as u
  join public.attorney_profiles as ap on ap.user_id = u.id
  join public.consultations as c on c.attorney_id = ap.id
  join public.reviews as r on r.consultation_id = c.id and r.state = 'published'
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and ap.profile_state = 'approved'
    and public.current_session_aal2() is true
  order by r.published_at desc, r.id
  limit 200;
$function$;

-- One page (25 rows, plus one) of the reviews in one state, in the jurisdictions the caller holds moderate_reviews
-- for (aal2), the oldest submission first: what a moderator must read (rating and text) and nothing about who wrote
-- it or about whom.
create function public.staff_review_queue(p_state text, p_offset integer)
returns table (
  review_id uuid,
  jurisdiction_id uuid,
  state text,
  rating smallint,
  review_text text,
  submitted_at timestamptz,
  published_at timestamptz,
  moderated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select r.id, f.jurisdiction_id, r.state, r.rating, r.review_text, r.submitted_at, r.published_at, r.moderated_at
  from public.reviews as r
  join public.consultations as c on c.id = r.consultation_id
  join public.consultation_requests as q on q.id = c.consultation_request_id
  join public.referrals as f on f.id = q.referral_id
  where p_state in ('submitted', 'published', 'rejected')
    and r.state = p_state
    and p_offset between 0 and 100000
    and public.has_staff_capability('moderate_reviews', f.jurisdiction_id, false)
  order by r.submitted_at, r.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- The published reviews of one publicly listed attorney (see the header): the newest 50, each with the count and the
-- average (two decimals) of all the attorney's published reviews, computed now. An attorney the public profile does
-- not list, an unknown id and an attorney without a published review answer no row.
create function public.public_attorney_reviews(p_attorney_id uuid)
returns table (
  rating smallint,
  review_text text,
  published_at timestamptz,
  review_count integer,
  average_rating numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
begin
  if p_attorney_id is null
     or not exists (select 1 from public.public_attorney_profile(p_attorney_id, null)) then
    return;
  end if;
  return query
  with published as (
    select r.id, r.rating, r.review_text, r.published_at
    from public.reviews as r
    join public.consultations as c on c.id = r.consultation_id
    where c.attorney_id = p_attorney_id
      and r.state = 'published'
  )
  select
    p.rating,
    public.discovery_presentable_text(p.review_text),
    p.published_at,
    (select count(*)::integer from published),
    (select round(avg(q.rating), 2) from published as q)
  from published as p
  order by p.published_at desc, p.id
  limit 50;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.review_record_guard()
  from public, anon, authenticated, service_role;

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.review_submit(uuid, integer, text)',
    'public.staff_moderate_review(uuid, text)',
    'public.client_reviews()',
    'public.attorney_reviews()',
    'public.staff_review_queue(text, integer)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

revoke all on function public.public_attorney_reviews(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.public_attorney_reviews(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on table public.reviews is
  'MVP-001 S11 (PS section 21.1): one verified client review per completed Consultation. The reviewed attorney is derived from the Consultation (DM section 9) and is never stored here; no aggregate rating is stored (PS P3). Written only by the S11 review functions.';
comment on column public.reviews.rating is
  'A whole number from 1 to 5 (a fixed technical scale, not a policy value).';
comment on column public.reviews.review_text is
  'The client''s optional text: not blank, no surrounding whitespace, at most 20,000 characters (the PS-A1 client free-text ceiling). Never audited or logged.';
comment on column public.reviews.state is
  'submitted (not public), published, or rejected (never published, or taken down). Forward only: submitted -> published | rejected, published -> rejected.';
comment on column public.reviews.published_at is
  'The instant of the first publication, recorded once.';
comment on column public.reviews.moderated_at is
  'The instant of the latest moderation decision; null until one is made.';
comment on function public.review_record_guard() is
  'MVP-001 S11 (every role): a review is never deleted or truncated; it is recorded submitted for a completed Consultation and that Consultation''s client; its Consultation, client, rating, text and submission never change; it moves only submitted -> published | rejected and published -> rejected, each with its moderation instant; the publication instant is recorded once.';
comment on function public.review_submit(uuid, integer, text) is
  'MVP-001 S11: the Consultation''s own client (active User, any aal) submits the one review of a completed Consultation (rating 1 to 5, optional text of at most 20,000 characters); the attorney is never an input; nothing is public on submission; audited without the text. Outcomes: submitted, invalid, not_eligible (everyone else, an unknown id and a Consultation not completed, alike), already_reviewed.';
comment on function public.staff_moderate_review(uuid, text) is
  'MVP-001 S11: staff holding moderate_reviews for the Consultation''s jurisdiction (aal2) publish or reject a submitted review, or take a published one down (reject); audited with identifiers and states only. Outcomes: applied, invalid, denied, not_found, invalid_transition.';
comment on function public.client_reviews() is
  'MVP-001 S11: the caller''s completed Consultations as their client (active User), each with its review or none; at most 200.';
comment on function public.attorney_reviews() is
  'MVP-001 S11: the published reviews about the calling attorney (approved, aal2): rating, text and publication instant; never the client or the Consultation; at most 200.';
comment on function public.staff_review_queue(text, integer) is
  'MVP-001 S11 moderation queue: one page of the reviews in one state in the jurisdictions the caller holds moderate_reviews for (aal2), oldest submission first: rating, text, state and instants; never a client, an attorney or a Consultation.';
comment on function public.public_attorney_reviews(uuid) is
  'MVP-001 S11 (public): the newest 50 published reviews of an attorney the public profile lists now (rating, text withheld when it carries a banned claim, publication instant) with the count and average of all the attorney''s published reviews computed at read time; never a client identity or a Consultation id; an unlisted and an unknown id answer no row. Persists nothing.';
