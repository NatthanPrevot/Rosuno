-- MVP-001 S6 (1 of 3): Consultation Request and Fee Calculation integrity on the existing Physical 1G and 1J
-- relations (MVP-001 Packet S6; MBS section 11 deliverables, mandatory decision-point evidence, financial invariants
-- and scheduled request boundary; DM sections 2.5, 2.6, 9 and 10; PS sections 15.1, 22.1, 32 and 35; PM section 1
-- INV-2, INV-6 and INV-12; TA sections 6 and 58; Packet section 4 "append-only evidence" and "fresh evaluations").
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). This migration
-- adds implementation constraints, an index and guard triggers on the relations P1-007 and P1-010 created
-- (20260914231532, 20260919000112), and narrows service_role to SELECT on them, so from now on every request and
-- fee write is one of the S6 database functions (20261122030000) or a later slice's function built on them
-- (DL-ENG-1 R9). Each guard applies to every role, the database owner included:
-- - consultation_requests: a Request is never deleted or truncated. Its identity and creation facts (Intake, client,
--   attorney, Referral, path, referral policy version, requested modality, creation time) never change; the
--   response deadline is fixed once set (DM section 2.6: a stored server deadline); the engagement policy version
--   is set at most once. A Request is created in state created only, and its state moves only along the DM
--   section 9 paths: instant created -> payment_authorized -> awaiting_attorney; scheduled created -> slot_held ->
--   awaiting_attorney; awaiting_attorney -> accepted or declined; any state before a decision -> cancelled
--   (withdrawal) or expired. Nothing leaves a terminal state (accepted, declined, expired, cancelled), so an expired
--   Request is never revived (MBS section 11 failure test; PM row 5): a new attempt is a new Referral and a new
--   Request. An instant Request is never slot_held and a scheduled one never payment_authorized. S6 itself uses
--   created, slot_held, cancelled and expired; payment_authorized belongs to S7 and awaiting_attorney, accepted and
--   declined to S8 (PM sections 3-4: the payment sequencing is gated, G-2 and G-3). The state vocabulary is the DM
--   section 9 lifecycle plus the withdrawal outcome; the requested modality is a lower-snake code (which modalities
--   exist is Fee Policy configuration, 20261122020000, never enumerated here);
-- - point-in-time evidence (MBS section 11 "a prior Referral Evaluation does not satisfy the later Request decision
--   point"; Packet section 4 "fresh evaluations"): a deferred constraint trigger makes a Request uncommittable
--   unless, written by the same (sub)transaction as the Request, it has an eligible Eligibility Evaluation of its
--   attorney in its Referral's jurisdiction, a bookable Bookability Evaluation of that attorney with context
--   consultation_request and this Request's id, for its requested modality, based on such an evaluation (with a slot
--   exactly when the Request is scheduled, and then the slot of the Request's Hold), and exactly one root Fee
--   Calculation (MBS section 11: created at Request creation). The same-transaction test compares row xmin, as the
--   S5 referral check does (20261121010000);
-- - fee_calculations: immutable for every role already (P1 blocks update and delete); it is also never truncated,
--   and the listed attorney price is never zero (MB section 152: never a zero price). A root Fee Calculation (no
--   supersession) commits only in its Request's own transaction, so a Request can never gain its quote afterwards;
--   only a supersession row (a later slice's correction; S6 never supersedes) may be added later. The P1 unique
--   indexes already keep one root per Request and one successor per Fee Calculation (a linear chain, so at most one
--   current calculation; PS section 22.1);
-- - the P1 deferred Request/Hold and Request/payment consistency checks (enforce_request_hold_consistency,
--   enforce_payment_request_consistency) run at commit under whatever role the transaction then has: after a
--   security definer S6 command that is the API role, which may not read the rows (permission denied, or rows
--   hidden by RLS that would wrongly pass). They become security definer with a fixed search_path, read only, and
--   stay executable by no API role, exactly as the S5 deferred checks are.
-- Index: the open Requests by response deadline, for the bounded expiry sweep (20261122030000).

-- ---------------------------------------------------------------------------
-- Implementation constraints and indexes on the existing relations.
-- ---------------------------------------------------------------------------

alter table public.consultation_requests
  add constraint consultation_requests_state_v1_check
    check (state in (
      'created', 'payment_authorized', 'slot_held', 'awaiting_attorney',
      'accepted', 'declined', 'expired', 'cancelled'
    )),
  add constraint consultation_requests_requested_modality_v1_check
    check (requested_modality ~ '^[a-z][a-z0-9_]{1,31}$');

alter table public.fee_calculations
  add constraint fee_calculations_attorney_price_positive_v1_check
    check (attorney_listed_price_minor > 0);

create index consultation_requests_open_deadline_idx
  on public.consultation_requests (response_deadline_at, id)
  where state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney');

-- ---------------------------------------------------------------------------
-- Consultation Requests: identity, deadline and lifecycle.
-- ---------------------------------------------------------------------------

create function public.consultation_request_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.consultation_requests rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'created' then
      raise exception 'a consultation request is created in state created'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.intake_id is distinct from old.intake_id
     or new.client_id is distinct from old.client_id
     or new.selected_attorney_id is distinct from old.selected_attorney_id
     or new.referral_id is distinct from old.referral_id
     or new.request_path is distinct from old.request_path
     or new.referral_policy_version_id is distinct from old.referral_policy_version_id
     or new.requested_modality is distinct from old.requested_modality
     or new.created_at is distinct from old.created_at then
    raise exception 'a consultation request keeps its identity and creation facts'
      using errcode = '55000';
  end if;
  if old.state in ('accepted', 'declined', 'expired', 'cancelled')
     and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'a consultation request in a terminal state is immutable'
      using errcode = '55000';
  end if;
  if old.response_deadline_at is not null
     and new.response_deadline_at is distinct from old.response_deadline_at then
    raise exception 'a consultation request response deadline is fixed once set'
      using errcode = '55000';
  end if;
  if old.engagement_policy_version_id is not null
     and new.engagement_policy_version_id is distinct from old.engagement_policy_version_id then
    raise exception 'a consultation request engagement policy version is set once'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.request_path = 'instant' and old.state = 'created' and new.state = 'payment_authorized')
       or (old.request_path = 'instant' and old.state = 'payment_authorized' and new.state = 'awaiting_attorney')
       or (old.request_path = 'scheduled' and old.state = 'created' and new.state = 'slot_held')
       or (old.request_path = 'scheduled' and old.state = 'slot_held' and new.state = 'awaiting_attorney')
       or (old.state = 'awaiting_attorney' and new.state in ('accepted', 'declined'))
       or (old.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
           and new.state in ('cancelled', 'expired'))
     ) then
    raise exception 'consultation request transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger consultation_requests_change_guard
before insert or update or delete on public.consultation_requests
for each row
execute function public.consultation_request_integrity();

create trigger consultation_requests_no_truncate
before truncate on public.consultation_requests
for each statement
execute function public.consultation_request_integrity();

-- Point-in-time evidence: at commit, a Request has, from its own (sub)transaction, an eligible Eligibility
-- Evaluation of its attorney in its Referral's jurisdiction, a bookable Bookability Evaluation (context
-- consultation_request, this Request) for its modality based on such an evaluation, with a slot exactly when the
-- Request is scheduled (the slot of its Hold), and exactly one root Fee Calculation. Deferred checks run at commit
-- under whatever role the transaction then has (an API role after a security definer command), so this check is
-- security definer with a fixed search_path; it reads only and is executable by no API role.
create function public.request_point_in_time_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_request public.consultation_requests;
  v_xmin xid;
  v_jurisdiction uuid;
  v_roots integer;
begin
  select r.* into v_request from public.consultation_requests as r where r.id = new.id;
  select r.xmin into v_xmin from public.consultation_requests as r where r.id = new.id;
  if v_xmin is null then
    raise exception 'request evidence check found no consultation request'
      using errcode = '23514';
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  if not exists (
    select 1
    from public.eligibility_evaluations as e
    where e.attorney_id = v_request.selected_attorney_id
      and e.jurisdiction_id = v_jurisdiction
      and e.result = 'eligible'
      and e.xmin = v_xmin
  ) then
    raise exception 'a consultation request needs a point-in-time eligible evaluation of its attorney'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.bookability_evaluations as b
    join public.eligibility_evaluations as e on e.id = b.eligibility_evaluation_id
    where b.context_type = 'consultation_request'
      and b.context_id = v_request.id
      and b.attorney_id = v_request.selected_attorney_id
      and b.result = 'bookable'
      and b.modality = v_request.requested_modality
      and b.xmin = v_xmin
      and e.attorney_id = v_request.selected_attorney_id
      and e.jurisdiction_id = v_jurisdiction
      and e.result = 'eligible'
      and e.xmin = v_xmin
      and (
        (v_request.request_path = 'instant' and b.slot_start_at is null)
        or (
          v_request.request_path = 'scheduled'
          and exists (
            select 1
            from public.slot_holds as h
            where h.consultation_request_id = v_request.id
              and h.slot_start_at = b.slot_start_at
              and h.slot_end_at = b.slot_end_at
          )
        )
      )
  ) then
    raise exception 'a consultation request needs a point-in-time bookable evaluation of its attorney'
      using errcode = '23514';
  end if;
  select count(*)::integer into v_roots
  from public.fee_calculations as c
  where c.consultation_request_id = v_request.id
    and c.supersedes_fee_calculation_id is null
    and c.xmin = v_xmin;
  if v_roots <> 1 then
    raise exception 'a consultation request needs its one fee calculation from its creation'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

create constraint trigger consultation_requests_point_in_time_evidence
after insert on public.consultation_requests
deferrable initially deferred
for each row
execute function public.request_point_in_time_evidence();

-- ---------------------------------------------------------------------------
-- Fee Calculations: created with their Request, never truncated.
-- ---------------------------------------------------------------------------

-- At commit, a root Fee Calculation was written by its Request's own (sub)transaction. Security definer for the
-- same reason as the evidence check; read only; executable by no API role.
create function public.fee_calculation_with_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_row_xmin xid;
  v_request_xmin xid;
begin
  if new.supersedes_fee_calculation_id is not null then
    return null;
  end if;
  select c.xmin into v_row_xmin from public.fee_calculations as c where c.id = new.id;
  select r.xmin into v_request_xmin
  from public.consultation_requests as r
  where r.id = new.consultation_request_id;
  if v_row_xmin is null
     or v_request_xmin is null
     or v_row_xmin is distinct from v_request_xmin then
    raise exception 'a fee calculation is created together with its consultation request'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

create constraint trigger fee_calculations_with_request
after insert on public.fee_calculations
deferrable initially deferred
for each row
execute function public.fee_calculation_with_request();

create function public.fee_calculation_no_truncate()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'public.fee_calculations is never truncated'
    using errcode = '55000';
end;
$function$;

create trigger fee_calculations_no_truncate
before truncate on public.fee_calculations
for each statement
execute function public.fee_calculation_no_truncate();

-- ---------------------------------------------------------------------------
-- The P1 deferred consistency checks run at commit as their owner (read only).
-- ---------------------------------------------------------------------------

alter function public.enforce_request_hold_consistency()
  security definer;
alter function public.enforce_request_hold_consistency()
  set search_path = pg_catalog, pg_temp;
alter function public.enforce_payment_request_consistency()
  security definer;
alter function public.enforce_payment_request_consistency()
  set search_path = pg_catalog, pg_temp;

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only (Packet section 1 RLS impact). SELECT grants are unchanged (the client's
-- own Requests under the P1 row policy; service_role SELECT); no API role may write either relation.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.consultation_requests,
  public.fee_calculations
from public, anon, authenticated, service_role;

revoke all on function public.consultation_request_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.request_point_in_time_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.fee_calculation_with_request()
  from public, anon, authenticated, service_role;
revoke all on function public.fee_calculation_no_truncate()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_request_hold_consistency()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_payment_request_consistency()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.consultation_request_integrity() is
  'MVP-001 S6: a Consultation Request is never deleted or truncated; it is created in state created; its identity and creation facts never change, its response deadline is fixed once set and its engagement policy version set once; its state moves only along the DM section 9 paths (instant created -> payment_authorized -> awaiting_attorney; scheduled created -> slot_held -> awaiting_attorney; awaiting_attorney -> accepted | declined; any undecided state -> cancelled | expired) and never leaves a terminal state.';
comment on function public.request_point_in_time_evidence() is
  'MVP-001 S6 (deferred): a Consultation Request commits only with same-transaction evidence: an eligible Eligibility Evaluation of its attorney in its Referral''s jurisdiction, a bookable consultation_request Bookability Evaluation for its modality based on one (with the Hold''s slot exactly when scheduled), and exactly one root Fee Calculation.';
comment on function public.fee_calculation_with_request() is
  'MVP-001 S6 (deferred): a root Fee Calculation commits only in its Consultation Request''s own transaction; only a supersession may be added later.';
comment on function public.fee_calculation_no_truncate() is
  'MVP-001 S6: Fee Calculations are never truncated (P1 already refuses update and delete for every role).';
comment on function public.enforce_request_hold_consistency() is
  'Deferred transaction-boundary guard: scheduled Requests require their Hold, instant Requests cannot have one, and terminal Requests cannot retain an active Hold. MVP-001 S6: security definer with a fixed search_path, so it runs at commit as its owner whatever role the transaction has; read only; executable by no API role.';
comment on function public.enforce_payment_request_consistency() is
  'Deferred guard: a Consultation Request update cannot contradict existing Payment Transaction provenance. MVP-001 S6: security definer with a fixed search_path, so it runs at commit as its owner whatever role the transaction has; read only; executable by no API role.';
comment on column public.consultation_requests.state is
  'The Request lifecycle (DM section 9): created, payment_authorized (instant), slot_held (scheduled), awaiting_attorney, accepted, declined, expired, or cancelled (withdrawn). Terminal states never change.';
comment on column public.consultation_requests.requested_modality is
  'The modality the client chose: a lower-snake code the selected Fee Policy permits (configuration, never enumerated in the schema).';
