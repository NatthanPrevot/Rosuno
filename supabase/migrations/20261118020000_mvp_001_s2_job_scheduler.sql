-- MVP-001 S2 (2 of 3): the database-only job scheduler (MVP-001 Packet S2 job architecture item 2; TA sections
-- 23 and 27; PS section 24).
--
-- pg_cron runs database-only sweeps: no network, no secrets, no provider call. It is enabled only where the
-- extension is available (hosted and local Supabase); a database without it (the disposable plain-PostgreSQL
-- proofs) applies this migration as a no-op. Correctness never depends on this schedule: every claim reclaims
-- expired leases itself and every consequential command evaluates its own deadlines (Packet S2 item 1), so a
-- missing or delayed sweep only delays prompt reclamation and escalation marking.
--
-- Exactly one schedule is registered here: rosuno_operational_jobs_sweep, every minute, running
-- public.operational_jobs_sweep() as the owner. Re-applying replaces it, never duplicates it. The domain sweeps
-- for holds, requests and quotes are added by the slices that introduce those deadlines. Intake expiry is unset
-- configuration and stays off until it is configured (MBS sections 2.10 and 23).

do $scheduler$
begin
  if not exists (
    select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice 'pg_cron is not available: no schedule registered (lazy reclamation still applies)';
    return;
  end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute $unschedule$
    select cron.unschedule(j.jobid)
    from cron.job as j
    where j.jobname = 'rosuno_operational_jobs_sweep'
  $unschedule$;
  execute $schedule$
    select cron.schedule(
      'rosuno_operational_jobs_sweep',
      '* * * * *',
      'select public.operational_jobs_sweep();'
    )
  $schedule$;
end;
$scheduler$;
