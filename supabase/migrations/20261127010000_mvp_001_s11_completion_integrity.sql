-- MVP-001 S11 (1 of 7): the M13 capability catalog rows and the Consultation outcome vocabulary on the existing
-- Physical 1H relation (MVP-001 Packet S11 "completion types (normal, early, cancellation, no-show, technical failure)
-- with PM distinctions"; MBS section 16 "Completion"; DM section 2.4 "completion reason recorded alongside the terminal
-- state"; PS sections 5.1, 17.1 and 30.4; PM sections 5 to 7, rows 11 to 22; TA sections 18 and 48).
--
-- No relation, column, policy type, enum or seed business row is added (Packet rules 8, 10 and 16). This migration adds
-- five capability catalog rows (reference data, as S1, S2 and S7 added theirs; grants stay configuration rows and none
-- is inserted) and one guard on the relation P1-008 created (20260917045031).
--
-- Capability catalog (PS section 5.1; PS section 30.4 "staff access is not one universal staff policy"):
-- - manage_consultation_operations: the staff operations workspace for Consultations (recording the outcome of a
--   Consultation its participants left undecided; the operations family of review exceptions);
-- - manage_compliance_reviews: the compliance family of review exceptions (the S8 eligibility and jurisdiction change
--   reviews);
-- - moderate_reviews: the publication workflow of client reviews;
-- - manage_complaints: the restricted Complaint Case record (PS section 5.1 names it);
-- - manage_legal_holds: placing and releasing Legal Holds.
--
-- Consultation outcome vocabulary (DM section 2.4: normal, early completion by agreement, technical interruption,
-- no-show, manual resolution; PM rows 11 to 22 keep cancellation by each party, each kind of no-show and each kind of
-- technical failure distinct, so each is its own code). consultations.outcome_code is the completion reason recorded
-- with a terminal state; S9 recorded only 'normal'. From now on, for every role, the database owner included, a
-- Consultation commits in a terminal state only with one of that state's codes:
--   completed          normal | early_by_agreement | manual_resolution
--   cancelled          client_cancelled | attorney_cancelled
--   no_show            client_no_show | attorney_no_show | both_no_show
--   technical_failure  neither_connected | mid_consultation_failure
-- together with its end instant, and with a start exactly when the outcome is one a started Consultation reaches
-- (normal, early_by_agreement, manual_resolution, mid_consultation_failure) and no start when it is one a
-- Consultation reaches without ever starting (the cancellations, the no-shows and neither_connected). The S8 guard
-- (consultation_integrity, unchanged) keeps the lifecycle forward-only, the terminal row immutable and each fact
-- recorded once; the S9 check (consultations_outcome_v1_check, unchanged) keeps an outcome code out of every undecided
-- state. Which command records which outcome, and every payment consequence, is 20261127030000.
--
-- The vocabulary is enforced by a deferred constraint trigger (checked at commit, like the S8 acceptance evidence and
-- the P1 payment consistency checks), not by a CHECK constraint: a transaction may pass through intermediate row
-- versions, and what is guaranteed is that no committed Consultation is terminal without one of its state's outcome
-- codes. The check reads only the row version it is fired for and is security definer with a fixed search_path
-- (deferred checks run at commit under whatever role the transaction then has); it is executable by no API role.

-- ---------------------------------------------------------------------------
-- Capability catalog (grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values
  ('manage_consultation_operations'),
  ('manage_compliance_reviews'),
  ('moderate_reviews'),
  ('manage_complaints'),
  ('manage_legal_holds');

-- ---------------------------------------------------------------------------
-- The Consultation outcome vocabulary.
-- ---------------------------------------------------------------------------

-- The outcome codes of one terminal state (empty for every other state).
create function public.consultation_outcome_codes(p_state text)
returns text[]
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case p_state
    when 'completed' then array['normal', 'early_by_agreement', 'manual_resolution']
    when 'cancelled' then array['client_cancelled', 'attorney_cancelled']
    when 'no_show' then array['client_no_show', 'attorney_no_show', 'both_no_show']
    when 'technical_failure' then array['neither_connected', 'mid_consultation_failure']
    else array[]::text[]
  end;
$function$;

-- Whether an outcome code is one only a started Consultation reaches.
create function public.consultation_outcome_needs_start(p_outcome_code text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select p_outcome_code in ('normal', 'early_by_agreement', 'manual_resolution', 'mid_consultation_failure');
$function$;

create function public.consultation_outcome_integrity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  if new.state not in ('completed', 'cancelled', 'no_show', 'technical_failure') then
    return null;
  end if;
  if new.outcome_code is null
     or not (new.outcome_code = any (public.consultation_outcome_codes(new.state))) then
    raise exception 'a consultation in state % carries one of that state''s outcome codes', new.state
      using errcode = '23514';
  end if;
  if new.ended_at is null then
    raise exception 'a consultation in a terminal state records its end'
      using errcode = '23514';
  end if;
  if public.consultation_outcome_needs_start(new.outcome_code) is distinct from (new.started_at is not null) then
    raise exception 'consultation outcome % does not agree with whether the consultation started', new.outcome_code
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

create constraint trigger consultations_outcome_vocabulary
after insert or update on public.consultations
deferrable initially deferred
for each row
when (new.state in ('completed', 'cancelled', 'no_show', 'technical_failure'))
execute function public.consultation_outcome_integrity();

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.consultation_outcome_codes(text)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_outcome_needs_start(text)
  from public, anon, authenticated, service_role;
revoke all on function public.consultation_outcome_integrity()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.consultation_outcome_codes(text) is
  'MVP-001 S11 (internal): the outcome codes of one terminal Consultation state: completed normal | early_by_agreement | manual_resolution; cancelled client_cancelled | attorney_cancelled; no_show client_no_show | attorney_no_show | both_no_show; technical_failure neither_connected | mid_consultation_failure; empty otherwise.';
comment on function public.consultation_outcome_needs_start(text) is
  'MVP-001 S11 (internal): whether an outcome code is one only a started Consultation reaches (normal, early_by_agreement, manual_resolution, mid_consultation_failure).';
comment on function public.consultation_outcome_integrity() is
  'MVP-001 S11 (deferred, at commit, every role): a Consultation commits in a terminal state only with one of that state''s outcome codes, its end instant, and a start exactly when the outcome is one a started Consultation reaches. Reads only the row; security definer with a fixed search_path; executable by no API role.';
comment on column public.consultations.outcome_code is
  'The completion reason recorded with a terminal state (DM section 2.4). MVP-001 S11 vocabulary: completed normal | early_by_agreement | manual_resolution; cancelled client_cancelled | attorney_cancelled; no_show client_no_show | attorney_no_show | both_no_show; technical_failure neither_connected | mid_consultation_failure. Null in every undecided state. Payment state never derives it (PM INV-1).';
