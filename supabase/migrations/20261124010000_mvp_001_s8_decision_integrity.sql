-- MVP-001 S8 (1 of 3): Consultation, Engagement and acceptance integrity on the existing Physical 1G, 1H and 1J
-- relations (MVP-001 Packet S8 "serialized acceptance with a deterministic loser", "booking conversion and hold
-- conversion/release", "consultation creation per G-5 configuration"; MBS section 13 mandatory acceptance revalidation,
-- state rules and failure tests; MBS section 9 invariants 1 and 5; IMP sections 11 (transactional invariants) and 24;
-- TA sections 13 and 14 (B2 acceptance exclusivity, B3 hold release on termination); PS sections 16.4, 17, 32 and 36;
-- DM sections 2.4, 2.7, 9 and 10; PM section 1 INV-4, INV-8, INV-12 and INV-14; FP-1 sections 8-10).
--
-- No relation, column, policy type, capability, enum or seed is added (Packet rules 8, 10 and 16). This migration adds
-- implementation constraints and guard triggers on the relations P1-008 created (20260917045031), one guard on the S7
-- payment association, one deferred acceptance check on consultation_requests, and narrows service_role so that from
-- now on every Consultation and Engagement write is one of the S8 database functions (20261124020000) or a later
-- slice's function built on them (DL-ENG-1 R9). Each guard applies to every role, the database owner included:
-- - consultations: never deleted or truncated. A Consultation is created in state created, with no start, end or
--   outcome, for its accepted Request (the P1 relationship trigger) and with the provenance of that Request: the fee
--   policy version of the Request's current Fee Calculation (FP-1 section 8), and engagement and cancellation versions
--   of their own policy types when recorded. Its identity and provenance never change afterwards. The state vocabulary
--   is the DM section 2.4 lifecycle (created, scheduled, ready, live, completed, cancelled, no_show,
--   technical_failure): an instant Consultation never passes through scheduled; it moves forward only (instant created
--   -> ready -> live; scheduled created -> scheduled -> ready -> live), any undecided state may reach one of the four
--   terminal outcomes, and a terminal Consultation never changes. started_at, ended_at and outcome_code are recorded at
--   most once each (their meaning is the M11 state machine's, S9). S8 itself only creates Consultations and moves them
--   created -> scheduled (scheduled path, once the Booking is confirmed) or created -> ready (instant path; PM rows 2
--   and 7 consultation column);
-- - engagements: never deleted or truncated. The state vocabulary is the DM section 9 lifecycle (presented, accepted,
--   effective, concluded) and it moves only forward along it, one step at a time; effective_at is recorded exactly when
--   the Engagement is effective (and stays when it is concluded), ended_at exactly when it is concluded, each once. An
--   Engagement is recorded either presented (nothing effective yet) or effective (the configured G-1 moment has been
--   reached; S8 records it only then, 20261124020000), for its Consultation's own engagement policy version, which must
--   be of type engagement. Its Consultation, policy version, version number, supersession and creation time never
--   change; terms_reference is set at most once (engagement terms are counsel-gated legal text, MB section 47: nothing
--   here sets one). The P1 unique index keeps at most one current effective Engagement per Consultation;
-- - payment_transactions.consultation_id: the association with the Consultation is set at most once and never changes
--   (the P1 integrity trigger already makes it consistent with the payment's frozen provenance, FP-1 section 8);
-- - acceptance (deferred, at commit; MBS section 13 "freshly re-evaluate and persist ... new decision-point records";
--   PS section 36; IMP section 11 "acceptance + Booking conversion consistency"; TA section 14 B2): a Request moving to
--   accepted commits only with, written by the same (sub)transaction as the acceptance, an eligible Eligibility
--   Evaluation of its attorney in its Referral's jurisdiction and a bookable Bookability Evaluation (context
--   consultation_request, this Request) for its modality based on such an evaluation, with no slot for an instant
--   Request and the slot of its Hold for a scheduled one; a scheduled Request also only with its Hold converted
--   (release_reason converted) into the confirmed Booking, with the Hold's times, of its one Consultation. Earlier
--   evaluations stay historical evidence and never satisfy the decision point. The same-transaction test compares row
--   xmin, as the S5 and S6 evidence checks do. The check is security definer with a fixed search_path (deferred checks
--   run at commit under whatever role the transaction then has), reads only and is executable by no API role;
-- - the P1 deferred Consultation/payment consistency check (enforce_payment_consultation_consistency, fired by every
--   Consultation update) becomes security definer with a fixed search_path, read only and executable by no API role,
--   exactly as S6 did for the two Request checks: otherwise it runs at commit as the API role after a security definer
--   S8 command and cannot read payment_transactions.
-- Whether a Consultation is created at acceptance alone or also needs an authorized or captured payment or an effective
-- Engagement (G-5), and when an Engagement becomes effective (G-1), stay configuration (the engagement policy,
-- 20261124020000); nothing here decides them (FP-1 section 10; PM section 2).

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relations.
-- ---------------------------------------------------------------------------

alter table public.consultations
  add constraint consultations_state_v1_check
    check (state in (
      'created', 'scheduled', 'ready', 'live', 'completed', 'cancelled', 'no_show', 'technical_failure'
    )),
  add constraint consultations_path_state_v1_check
    check (request_path = 'scheduled' or state <> 'scheduled'),
  add constraint consultations_modality_v1_check
    check (modality collate "C" ~ '^[a-z][a-z0-9_]{1,31}$');

alter table public.engagements
  add constraint engagements_state_v1_check
    check (state in ('presented', 'accepted', 'effective', 'concluded')),
  add constraint engagements_effective_facts_v1_check
    check ((effective_at is not null) = (state in ('effective', 'concluded'))),
  add constraint engagements_concluded_facts_v1_check
    check ((ended_at is not null) = (state = 'concluded'));

-- ---------------------------------------------------------------------------
-- Consultations.
-- ---------------------------------------------------------------------------

create function public.consultation_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_fee_policy uuid;
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.consultations rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'created'
       or new.started_at is not null
       or new.ended_at is not null
       or new.outcome_code is not null then
      raise exception 'a consultation is created in state created, with no start, end or outcome'
        using errcode = '23514';
    end if;
    select c.fee_policy_version_id into v_fee_policy
    from public.fee_calculations as c
    where c.consultation_request_id = new.consultation_request_id
      and not exists (
        select 1 from public.fee_calculations as s where s.supersedes_fee_calculation_id = c.id
      );
    if new.fee_policy_version_id is distinct from v_fee_policy then
      raise exception 'a consultation records the fee policy of its request''s current fee calculation'
        using errcode = '23514';
    end if;
    if new.engagement_policy_version_id is not null and not exists (
         select 1 from public.policy_versions as v
         where v.id = new.engagement_policy_version_id and v.policy_type_code = 'engagement'
       ) then
      raise exception 'a consultation engagement policy version is of type engagement'
        using errcode = '23514';
    end if;
    if new.cancellation_policy_version_id is not null and not exists (
         select 1 from public.policy_versions as v
         where v.id = new.cancellation_policy_version_id and v.policy_type_code = 'cancellation'
       ) then
      raise exception 'a consultation cancellation policy version is of type cancellation'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'state' - 'started_at' - 'ended_at' - 'outcome_code' - 'updated_at')
     is distinct from (to_jsonb(old) - 'state' - 'started_at' - 'ended_at' - 'outcome_code' - 'updated_at') then
    raise exception 'a consultation keeps its identity and provenance'
      using errcode = '55000';
  end if;
  if old.state in ('completed', 'cancelled', 'no_show', 'technical_failure')
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'a consultation in a terminal state is immutable'
      using errcode = '55000';
  end if;
  if (old.started_at is not null and new.started_at is distinct from old.started_at)
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
     or (old.outcome_code is not null and new.outcome_code is distinct from old.outcome_code) then
    raise exception 'a consultation start, end and outcome are recorded once'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.request_path = 'instant' and old.state = 'created' and new.state = 'ready')
       or (old.request_path = 'scheduled' and old.state = 'created' and new.state = 'scheduled')
       or (old.request_path = 'scheduled' and old.state = 'scheduled' and new.state = 'ready')
       or (old.state = 'ready' and new.state = 'live')
       or (old.state in ('created', 'scheduled', 'ready', 'live')
           and new.state in ('completed', 'cancelled', 'no_show', 'technical_failure'))
     ) then
    raise exception 'consultation transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger consultations_change_guard
before insert or update or delete on public.consultations
for each row
execute function public.consultation_integrity();

create trigger consultations_no_truncate
before truncate on public.consultations
for each statement
execute function public.consultation_integrity();

-- ---------------------------------------------------------------------------
-- Engagements.
-- ---------------------------------------------------------------------------

create function public.engagement_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.engagements rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state not in ('presented', 'effective') or new.ended_at is not null then
      raise exception 'an engagement is recorded presented or effective, never ended'
        using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.consultations as c
      join public.policy_versions as v on v.id = c.engagement_policy_version_id
      where c.id = new.consultation_id
        and c.engagement_policy_version_id = new.engagement_policy_version_id
        and v.policy_type_code = 'engagement'
    ) then
      raise exception 'an engagement records its consultation''s engagement policy version'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.consultation_id is distinct from old.consultation_id
     or new.engagement_policy_version_id is distinct from old.engagement_policy_version_id
     or new.version_number is distinct from old.version_number
     or new.supersedes_engagement_id is distinct from old.supersedes_engagement_id
     or new.created_at is distinct from old.created_at then
    raise exception 'an engagement keeps its consultation, policy version, version and supersession'
      using errcode = '55000';
  end if;
  if (old.terms_reference is not null and new.terms_reference is distinct from old.terms_reference)
     or (old.effective_at is not null and new.effective_at is distinct from old.effective_at)
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at) then
    raise exception 'an engagement terms reference, effective time and end are recorded once'
      using errcode = '55000';
  end if;
  if old.state = 'concluded' and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'a concluded engagement is immutable'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'presented' and new.state = 'accepted')
       or (old.state = 'accepted' and new.state = 'effective')
       or (old.state = 'effective' and new.state = 'concluded')
     ) then
    raise exception 'engagement transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger engagements_change_guard
before insert or update or delete on public.engagements
for each row
execute function public.engagement_integrity();

create trigger engagements_no_truncate
before truncate on public.engagements
for each statement
execute function public.engagement_integrity();

-- ---------------------------------------------------------------------------
-- The payment's Consultation association is set once.
-- ---------------------------------------------------------------------------

create function public.payment_consultation_link_once()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if old.consultation_id is not null and new.consultation_id is distinct from old.consultation_id then
    raise exception 'a payment transaction''s consultation is set once'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger payment_transactions_consultation_link_once
before update of consultation_id on public.payment_transactions
for each row
execute function public.payment_consultation_link_once();

-- ---------------------------------------------------------------------------
-- Acceptance evidence and Booking conversion (deferred, at commit).
-- ---------------------------------------------------------------------------

create function public.request_acceptance_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_request public.consultation_requests;
  v_xmin xid;
  v_jurisdiction uuid;
  v_hold public.slot_holds;
begin
  select r.* into v_request from public.consultation_requests as r where r.id = new.id;
  select r.xmin into v_xmin from public.consultation_requests as r where r.id = new.id;
  if v_xmin is null or v_request.state is distinct from 'accepted' then
    raise exception 'acceptance evidence check found no accepted consultation request'
      using errcode = '23514';
  end if;
  select f.jurisdiction_id into v_jurisdiction from public.referrals as f where f.id = v_request.referral_id;
  select h.* into v_hold from public.slot_holds as h where h.consultation_request_id = v_request.id;
  if not exists (
    select 1
    from public.eligibility_evaluations as e
    where e.attorney_id = v_request.selected_attorney_id
      and e.jurisdiction_id = v_jurisdiction
      and e.result = 'eligible'
      and e.xmin = v_xmin
  ) then
    raise exception 'an acceptance needs a decision-point eligible evaluation of its attorney'
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
          and b.slot_start_at = v_hold.slot_start_at
          and b.slot_end_at = v_hold.slot_end_at
        )
      )
  ) then
    raise exception 'an acceptance needs a decision-point bookable evaluation of its attorney'
      using errcode = '23514';
  end if;
  if v_request.request_path = 'scheduled' and not (
    v_hold.release_reason is not distinct from 'converted'
    and exists (
      select 1
      from public.consultations as c
      join public.bookings as k on k.consultation_id = c.id
      where c.consultation_request_id = v_request.id
        and k.status = 'confirmed'
        and k.starts_at = v_hold.slot_start_at
        and k.ends_at = v_hold.slot_end_at
    )
  ) then
    raise exception 'an accepted scheduled consultation request converts its hold into its consultation''s booking'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

create constraint trigger consultation_requests_acceptance_evidence
after update of state on public.consultation_requests
deferrable initially deferred
for each row
when (new.state = 'accepted' and old.state is distinct from 'accepted')
execute function public.request_acceptance_evidence();

-- ---------------------------------------------------------------------------
-- The P1 deferred Consultation/payment consistency check runs at commit as its owner (read only).
-- ---------------------------------------------------------------------------

-- The P1 deferred check (consultations_payment_consistency) runs at commit under whatever role the transaction then
-- has: after a security definer S8 command that is the API role, which may not read payment_transactions (permission
-- denied, or rows hidden that would wrongly pass). It becomes security definer with a fixed search_path, reads only
-- and stays executable by no API role, exactly as S6 did for the Request checks (20261122010000).
alter function public.enforce_payment_consultation_consistency()
  security definer;
alter function public.enforce_payment_consultation_consistency()
  set search_path = pg_catalog, pg_temp;

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only (Packet section 1 RLS impact). SELECT grants and the P1 participant row
-- policies are unchanged; no API role may write either relation.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.consultations,
  public.engagements
from public, anon, authenticated, service_role;

revoke all on function public.consultation_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.engagement_integrity()
  from public, anon, authenticated, service_role;
revoke all on function public.payment_consultation_link_once()
  from public, anon, authenticated, service_role;
revoke all on function public.request_acceptance_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_payment_consultation_consistency()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.consultation_integrity() is
  'MVP-001 S8: a Consultation is never deleted or truncated; it is created in state created, without start, end or outcome, with its Request''s current fee policy and typed engagement and cancellation versions; its identity and provenance never change; it moves only forward along the DM section 2.4 lifecycle (instant created -> ready -> live, scheduled created -> scheduled -> ready -> live, any undecided state -> completed | cancelled | no_show | technical_failure) and a terminal Consultation never changes; start, end and outcome are recorded once.';
comment on function public.engagement_integrity() is
  'MVP-001 S8: an Engagement is never deleted or truncated; it is recorded presented or effective for its Consultation''s engagement policy version; its identity never changes; it moves only forward along the DM section 9 lifecycle (presented -> accepted -> effective -> concluded), with effective_at and ended_at each recorded once and terms_reference set once.';
comment on function public.payment_consultation_link_once() is
  'MVP-001 S8: a Payment Transaction''s Consultation association is set at most once.';
comment on function public.request_acceptance_evidence() is
  'MVP-001 S8 (deferred): an acceptance commits only with same-transaction decision-point evidence (an eligible Eligibility Evaluation of the attorney in the Referral''s jurisdiction and a bookable consultation_request Bookability Evaluation for the modality based on one, with the Hold''s slot exactly when scheduled) and, when scheduled, with its Hold converted into its Consultation''s confirmed Booking.';
comment on function public.enforce_payment_consultation_consistency() is
  'Deferred guard: a Consultation update cannot contradict existing Payment Transaction provenance. MVP-001 S8: security definer with a fixed search_path, so it runs at commit as its owner whatever role the transaction has; read only; executable by no API role.';
comment on column public.consultations.state is
  'The Consultation lifecycle (DM section 2.4): created, scheduled (scheduled path only), ready, live, completed, cancelled, no_show or technical_failure. Terminal states never change. Payment state never derives it (PM INV-1).';
comment on column public.engagements.state is
  'The Engagement lifecycle (DM section 9): presented, accepted, effective or concluded. When it becomes effective is G-1 configuration (the engagement policy); payment never establishes it by itself (PM INV-14).';
