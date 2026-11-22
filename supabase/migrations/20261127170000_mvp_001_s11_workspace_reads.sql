-- MVP-001 S11 pass 2B (17 of 17): the participants' own workspace reads (MVP-001 Packet S11 "client and attorney
-- workspace surfaces"; MBS sections 18.2 "client workspace", 18.3 "attorney workspace" and 18.6; IMP section 38: a
-- backend capability without its required user-facing workflow is not complete; TA section 41; PS section 30).
--
-- No relation, column, policy type, policy, grant on a relation or seed is added (Packet rules 8, 10 and 16). Six
-- read functions only, each answering the caller's own records and nothing of anyone else, each with the minimum
-- columns its surface shows. Every one is stable security definer with the pinned search_path, executable by
-- authenticated only (anon and service_role hold nothing), and answers nothing for a caller it does not serve: an
-- unknown caller, a User that is not active, a caller without the profile the read serves, an attorney session at
-- aal1, and (for the paged read) an offset outside its bounds all answer the same empty result. No read takes a
-- User, profile, Consultation or record id, so a guessed identifier can never name someone else's record. They reuse
-- the earlier reads' own rules where one exists (the Consultation view and its latest Booking as client_consultations,
-- the Consultation document rule of consultation_documents, the communication window of consultation_messaging, the
-- evidence age rule of staff_compliance_records); nothing here decides a business rule anew.
--
-- Client reads (the caller's active User holding a Client Profile; aal1 suffices, as for every client read):
-- - client_payments(p_offset): one page (25 rows, plus one) of the client's own payment attempts, newest first: the
--   attempt and Request ids, the recorded state, the client total of the Request's immutable Fee Calculation, the
--   currency, the authorized, captured and refunded amounts and the creation instant (the receipt read,
--   client_payment_receipt, stays the one that shows the components and each refund). Offsets 0 to 100000.
-- - client_account_overview(): one row: the account's display name, state and creation instant, and the counts of
--   the categories of records the account holds: Intakes, Requests, Consultations (the client's own), documents the
--   account uploaded that are stored (available), Messages the account sent that are visible, payment attempts of the
--   client's Requests and Complaint Cases the account opened. Counts only: no content, no identifier.
--
-- Participant read (one function for both workspaces; p_role names which one):
-- - consultation_threads(p_role): for 'client', the client's own Consultations; for 'attorney', the Consultations of
--   the caller's approved Attorney Profile at aal2. Each row: the Consultation id and state, the messaging status the
--   communication window reports now (open, closed or window_unavailable; any other answer of the window reads as
--   window_unavailable, so the inbox never shows messaging open that the thread would refuse), the number of visible
--   Messages, the instant of the latest one and whether the caller sent it. At most 200 rows, the latest Message
--   first, then the newest Consultation. No Message body and nothing of the counterpart's identity.
--
-- Attorney reads (the caller's active User holding an Attorney Profile; aal2; the Consultation reads need the
-- approved stage exactly as attorney_consultations does):
-- - attorney_consultation_history(): the attorney's own ended Consultations (completed, cancelled, no_show,
--   technical_failure), the most recent first, at most 200, with exactly the columns of client_consultations (the
--   S9 Consultation view, the latest Booking's times when the view has none, the end instant and the outcome code).
--   attorney_consultations (scheduled, ready, live) is unchanged.
-- - attorney_documents(): the current document versions the attorney may see across their own Consultations, by
--   consultation_documents' own rule (uploaded by the attorney, or shared with the attorney by the latest consultation
--   grant), newest first, at most 200 (plus one, so the answer says whether more exist): the Consultation and
--   Document ids, the version label, the declared type and size, the creation instant, who uploaded it, whether the
--   attorney did, the sharing state and whether it can be opened now. No storage path and no content.
-- - attorney_compliance_records(): the attorney's own licences and insurance records (their recorded validity dates
--   and, where the jurisdiction's in-force Eligibility policy states an age for that evidence and evidence was
--   retrieved, the date the latest evidence reaches that age, computed as staff_compliance_records' evidence_age
--   section does; no threshold or lead time is applied and nothing about the evidence itself is answered) and the
--   discipline findings recorded about the attorney (the status when it is a lower-snake code, the opened and
--   resolved dates). For the applicant, under_review and approved stages (the stages the attorney workspace admits).
--   No licence number, carrier, policy reference, external reference, details reference or evidence content.

-- ---------------------------------------------------------------------------
-- Client reads.
-- ---------------------------------------------------------------------------

create function public.client_payments(p_offset integer)
returns table (
  payment_transaction_id uuid,
  consultation_request_id uuid,
  payment_state text,
  total_client_amount_minor bigint,
  currency_code text,
  amount_authorized_minor bigint,
  amount_captured_minor bigint,
  amount_refunded_minor bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    pt.id,
    pt.consultation_request_id,
    pt.state,
    c.total_client_amount_minor,
    pt.currency_code::text,
    pt.amount_authorized_minor,
    pt.amount_captured_minor,
    pt.amount_refunded_minor,
    pt.created_at
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  join public.consultation_requests as r on r.client_id = cp.id
  join public.payment_transactions as pt on pt.consultation_request_id = r.id
  join public.fee_calculations as c on c.id = pt.fee_calculation_id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and p_offset between 0 and 100000
  order by pt.created_at desc, pt.id desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

create function public.client_account_overview()
returns table (
  display_name text,
  account_state text,
  created_at timestamptz,
  intakes bigint,
  requests bigint,
  consultations bigint,
  documents bigint,
  messages bigint,
  payments bigint,
  complaints bigint
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    u.display_name,
    u.account_state,
    u.created_at,
    (select count(*) from public.intakes as i where i.client_id = cp.id),
    (select count(*) from public.consultation_requests as r where r.client_id = cp.id),
    (select count(*) from public.consultations as k where k.client_id = cp.id),
    (select count(*) from public.resources as x
     where x.owner_user_id = u.id and x.resource_kind = 'document' and x.visibility_state = 'available'),
    (select count(*) from public.messages as m
     where m.sender_user_id = u.id and m.visibility_state = 'visible'),
    (select count(*) from public.payment_transactions as pt
     join public.consultation_requests as r on r.id = pt.consultation_request_id
     where r.client_id = cp.id),
    (select count(*) from public.complaint_cases as k where k.complainant_user_id = u.id)
  from public.users as u
  join public.client_profiles as cp on cp.user_id = u.id
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active';
$function$;

-- ---------------------------------------------------------------------------
-- The participant's Message threads.
-- ---------------------------------------------------------------------------

create function public.consultation_threads(p_role text)
returns table (
  consultation_id uuid,
  consultation_state text,
  messaging_status text,
  message_count bigint,
  last_message_at timestamptz,
  last_message_mine boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with me as (
    select u.id as user_id
    from public.users as u
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
  ),
  mine as (
    select c.id, c.state, c.created_at, me.user_id
    from me
    join public.client_profiles as cp on cp.user_id = me.user_id
    join public.consultations as c on c.client_id = cp.id
    where p_role = 'client'
    union all
    select c.id, c.state, c.created_at, me.user_id
    from me
    join public.attorney_profiles as ap on ap.user_id = me.user_id and ap.profile_state = 'approved'
    join public.consultations as c on c.attorney_id = ap.id
    where p_role = 'attorney'
      and public.current_session_aal2() is true
  )
  select
    m.id,
    m.state,
    case
      when w.outcome in ('open', 'closed', 'window_unavailable') then w.outcome
      else 'window_unavailable'
    end,
    coalesce(s.message_count, 0),
    s.last_message_at,
    l.mine
  from mine as m
  left join lateral (
    select x.outcome
    from public.communication_window(m.id, clock_timestamp()) as x
    limit 1
  ) as w on true
  left join lateral (
    select count(*) as message_count, max(x.sent_at) as last_message_at
    from public.messages as x
    where x.consultation_id = m.id
      and x.visibility_state = 'visible'
  ) as s on true
  left join lateral (
    select x.sender_user_id = m.user_id as mine
    from public.messages as x
    where x.consultation_id = m.id
      and x.visibility_state = 'visible'
    order by x.sent_at desc, x.id desc
    limit 1
  ) as l on true
  order by s.last_message_at desc nulls last, m.created_at desc, m.id
  limit 200;
$function$;

-- ---------------------------------------------------------------------------
-- Attorney reads.
-- ---------------------------------------------------------------------------

create function public.attorney_consultation_history()
returns table (
  consultation_id uuid,
  state text,
  ready_due boolean,
  request_path text,
  modality text,
  duration_minutes integer,
  booking_starts_at timestamptz,
  booking_ends_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    v.consultation_id,
    v.state,
    v.ready_due,
    v.request_path,
    v.modality,
    v.duration_minutes,
    coalesce(v.booking_starts_at, k.starts_at),
    coalesce(v.booking_ends_at, k.ends_at),
    v.opens_at,
    v.closes_at,
    v.started_at,
    v.ended_at,
    v.outcome_code
  from public.users as u
  join public.attorney_profiles as ap on ap.user_id = u.id
  join public.consultations as c
    on c.attorney_id = ap.id and c.state in ('completed', 'cancelled', 'no_show', 'technical_failure')
  cross join lateral public.consultation_view(c.id) as v
  left join lateral (
    select b.starts_at, b.ends_at
    from public.bookings as b
    where b.consultation_id = c.id
    order by b.created_at desc, b.id desc
    limit 1
  ) as k on true
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and ap.profile_state = 'approved'
    and public.current_session_aal2() is true
  order by coalesce(v.ended_at, v.booking_starts_at, c.created_at) desc, v.consultation_id
  limit 200;
$function$;

create function public.attorney_documents()
returns table (
  consultation_id uuid,
  document_id uuid,
  version_label text,
  mime_type text,
  byte_size bigint,
  created_at timestamptz,
  uploaded_by text,
  mine boolean,
  sharing text,
  accessible boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    c.id,
    d.document_id,
    d.version_label,
    d.mime_type,
    d.byte_size,
    d.created_at,
    d.uploaded_by,
    d.mine,
    d.sharing,
    d.accessible
  from public.users as u
  join public.attorney_profiles as ap on ap.user_id = u.id and ap.profile_state = 'approved'
  join public.consultations as c on c.attorney_id = ap.id
  cross join lateral public.consultation_documents(c.id) as d
  where u.auth_user_id = auth.uid()
    and u.account_state = 'active'
    and public.current_session_aal2() is true
  order by d.created_at desc, d.document_id desc
  limit 201;
$function$;

create function public.attorney_compliance_records()
returns table (
  record_kind text,
  record_id uuid,
  jurisdiction_id uuid,
  status_code text,
  starts_on date,
  ends_on date,
  evidence_lapses_on date,
  recorded_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with me as (
    select ap.id
    from public.users as u
    join public.attorney_profiles as ap on ap.user_id = u.id
    where u.auth_user_id = auth.uid()
      and u.account_state = 'active'
      and ap.profile_state in ('applicant', 'under_review', 'approved')
      and public.current_session_aal2() is true
  ),
  records as (
    select 'license'::text as kind, l.id, l.jurisdiction_id, l.effective_from as starts_on,
      l.effective_until as ends_on, l.updated_at as recorded_at, 1 as kind_order
    from me
    join public.licenses as l on l.attorney_id = me.id
    union all
    select 'insurance'::text, i.id, i.jurisdiction_id, i.coverage_from, i.coverage_until, i.updated_at, 2
    from me
    join public.insurance_records as i on i.attorney_id = me.id
  ),
  policies as (
    select x.jurisdiction_id, public.eligibility_selected_policy(x.jurisdiction_id, statement_timestamp()) as p
    from (select distinct r.jurisdiction_id from records as r where r.jurisdiction_id is not null) as x
  ),
  aged as (
    select r.*,
      (
        select max(v.retrieved_at)
        from public.verification_evidence_subjects as vs
        join public.verification_evidence as v on v.id = vs.verification_evidence_id
        where (r.kind = 'license' and vs.license_id = r.id)
           or (r.kind = 'insurance' and vs.insurance_record_id = r.id)
      ) as retrieved_at,
      case
        when p.p ->> 'status' is distinct from 'selected' then null
        when r.kind = 'license' then (p.p ->> 'license_age')::numeric
        else (p.p ->> 'insurance_age')::numeric
      end as max_age_days
    from records as r
    left join policies as p on p.jurisdiction_id = r.jurisdiction_id
  )
  select * from (
    select g.kind, g.id, g.jurisdiction_id, null::text, g.starts_on, g.ends_on,
      case when g.retrieved_at is null or g.max_age_days is null then null
        else ((g.retrieved_at at time zone 'UTC')::date + least(g.max_age_days, 1000000)::integer) end,
      g.recorded_at
    from aged as g
    order by g.kind_order, g.ends_on nulls last, g.id
    limit 400
  ) as claims
  union all
  select * from (
    select 'discipline'::text, d.id, d.jurisdiction_id,
      case when d.status collate "C" ~ '^[a-z][a-z0-9_]{1,63}$' then d.status end,
      d.opened_at, d.resolved_at, null::date, d.created_at
    from me
    join public.discipline_records as d on d.attorney_id = me.id
    order by d.created_at desc, d.id
    limit 200
  ) as findings;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.client_payments(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.client_payments(integer) to authenticated;
revoke all on function public.client_account_overview()
  from public, anon, authenticated, service_role;
grant execute on function public.client_account_overview() to authenticated;
revoke all on function public.consultation_threads(text)
  from public, anon, authenticated, service_role;
grant execute on function public.consultation_threads(text) to authenticated;
revoke all on function public.attorney_consultation_history()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_consultation_history() to authenticated;
revoke all on function public.attorney_documents()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_documents() to authenticated;
revoke all on function public.attorney_compliance_records()
  from public, anon, authenticated, service_role;
grant execute on function public.attorney_compliance_records() to authenticated;

comment on function public.client_payments(integer) is
  'MVP-001 S11 client workspace: one page (25 rows, plus one) of the caller''s own payment attempts, newest first (attempt and Request ids, recorded state, client total, currency, authorized, captured and refunded amounts, creation); an active User with a Client Profile only; offsets 0 to 100000.';
comment on function public.client_account_overview() is
  'MVP-001 S11 client workspace: the caller''s own account (display name, state, creation) and the counts of the records it holds (Intakes, Requests, Consultations, stored uploaded documents, visible sent Messages, payment attempts, Complaint Cases); counts only; an active User with a Client Profile only.';
comment on function public.consultation_threads(text) is
  'MVP-001 S11 client and attorney workspaces: the caller''s own Consultation threads for one role (client: the Client Profile''s Consultations; attorney: the approved Attorney Profile''s at aal2): Consultation id and state, the messaging status the communication window reports now (open, closed, window_unavailable), the visible Message count, the latest Message instant and whether the caller sent it; at most 200, no Message body.';
comment on function public.attorney_consultation_history() is
  'MVP-001 S11 attorney workspace: the caller''s own ended Consultations (completed, cancelled, no_show, technical_failure), most recent first, at most 200, with the columns of client_consultations; an approved Attorney Profile at aal2 only.';
comment on function public.attorney_documents() is
  'MVP-001 S11 attorney workspace: the current document versions the caller may see across their own Consultations by consultation_documents'' rule, newest first, at most 200 plus one; metadata only (no path, no content); an approved Attorney Profile at aal2 only.';
comment on function public.attorney_compliance_records() is
  'MVP-001 S11 attorney workspace: the caller''s own licences and insurance records (validity dates and the date the latest evidence reaches the in-force Eligibility policy''s stated age, no threshold applied) and the discipline findings about the caller (lower-snake status, opened and resolved dates); the applicant, under_review and approved stages at aal2 only; no number, reference or evidence content.';
