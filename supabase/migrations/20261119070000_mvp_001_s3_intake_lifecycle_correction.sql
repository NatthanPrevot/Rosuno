-- MVP-001 S3 (7 of 7): forward correction of the Intake lifecycle transitions of 20261119040000 to the locked
-- Domain Model (DM section 6: the Intake lifecycle reaches expired, superseded and closed after active, and an
-- expired Intake is one no longer offered for discovery; DM section 2.8: the client deliberately closes an
-- Intake and inactivity produces expiry).
--
-- 20261119040000 also let a draft expire and a submitted Intake expire or be superseded. The locked lifecycle
-- reaches expired and superseded only from active.
-- This migration narrows the lifecycle guard to that and adds one implementation constraint (no relation or
-- column is added; Packet rule 16; DL-ENG-1 R9):
-- - draft -> submitted | closed; submitted -> active | closed; active -> closed | expired | superseded.
--   Closing a draft or a submitted Intake is the client's deliberate close (DM section 2.8), the existing
--   client_close_intake behaviour of 20261115140653, and is unchanged;
-- - an Intake carries an expiry time only once it is active (intakes_expiry_active_check), so a draft or a
--   submitted Intake can never expire. intake_expire_if_due, intake_expiry_sweep and every function that reads
--   expires_at therefore act on active Intakes only, without being replaced.
-- Nothing in any application path sets expires_at: expiry stays off until gate D-3 is decided. 20261119040000 is
-- unchanged.

alter table public.intakes
  add constraint intakes_expiry_active_check
    check (expires_at is null or state not in ('draft', 'submitted'));

create or replace function public.intake_lifecycle_guard()
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
    (old.state = 'draft' and new.state in ('submitted', 'closed'))
    or (old.state = 'submitted' and new.state in ('active', 'closed'))
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

revoke all on function public.intake_lifecycle_guard()
  from public, anon, authenticated, service_role;

comment on function public.intake_lifecycle_guard() is
  'MVP-001 S3: Intakes are never deleted or truncated; identity, client and creation time are fixed; the state moves only along the Domain Model lifecycle (draft -> submitted | closed; submitted -> active | closed; active -> closed | expired | superseded; no exit from expired, superseded or closed while gate D-3 is open); closed_at is fixed once set; expires_at changes only while the Intake is open.';
comment on function public.intake_expire_if_due(uuid) is
  'Internal (MVP-001 S3): moves an active Intake whose expires_at has passed to expired with one system audit event and answers its resulting state (only an active Intake carries an expiry time). expires_at is never set by any application path while the expiry period (gate D-3) is undecided. Executable by no API role.';
comment on function public.intake_expiry_sweep() is
  'MVP-001 S3: database-only sweep (pg_cron, as the owner) expiring at most 500 due active Intakes per run with skip-locked semantics. Correctness does not depend on it: every command evaluates expiry itself. Executable by no API role.';
