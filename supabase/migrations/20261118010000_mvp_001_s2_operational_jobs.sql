-- MVP-001 S2 (1 of 3): the durable operational-job protocol (MVP-001 Packet S2 job architecture items 1-4;
-- MBS section 21; TA sections 23, 27, 43 and 72; PS section 24; IMP section 37).
--
-- public.operational_jobs (P1, 20260918060600) is the transactional outbox for provider side effects. This
-- migration adds no relation and no column (Packet rule 16); it adds implementation constraints, indexes, a
-- lifecycle trigger and functions on the existing relation (DL-ENG-1 R9):
-- - lifecycle: pending -> running -> completed | pending (retry) | escalated; pending, running or escalated ->
--   cancelled; escalated -> pending only through the audited staff retry; completed and cancelled are terminal;
--   no job is ever deleted;
-- - deterministic idempotency: at most one non-terminal job per (job_type, subject_type, subject_id), and the job
--   id is the stable idempotency key a worker passes to the provider on every attempt of that job;
-- - the outbox: domain functions enqueue (job_enqueue) and cancel (job_cancel_for_subject) inside their own
--   transactions, so a job exists exactly when the domain change that needs it commits;
-- - one claim-based worker in the server runtime (job_claim, job_complete, job_fail; service_role only): claims
--   use FOR UPDATE SKIP LOCKED, a claim holds a lease, attempts are bounded, retries back off exponentially
--   (computed here), exhaustion escalates visibly with one audit event, and a duplicate completion has no effect;
-- - lease expiry is decided by every claim itself (lazy reclamation), so correctness never depends on the
--   sweeper; the sweeper (operational_jobs_sweep, scheduled by 20261118020000 where pg_cron exists) only makes
--   reclamation and escalation prompt;
-- - staff observe jobs and retry or cancel them through capability-checked, audited functions
--   (manage_operational_jobs, a global grant only).
--
-- Lease representation: while a job is running, available_at is the instant its lease expires, i.e. the
-- earliest instant from which the job may be claimed again. For a pending job it is the instant the job falls
-- due. A claim therefore takes every pending or running job whose available_at has passed, and the lease of an
-- earlier claim is judged by the duration that claim chose, never by a later caller's lease.
--
-- System operations (worker escalation, sweeper) are audited with actor_type 'system' and no actor User. The
-- retry backoff (30 seconds doubling per attempt, capped at one hour), the lease bounds (5 to 3600 seconds), the
-- claim batch bound (50) and the per-job attempt bound (1 to 25) are operational configuration of this
-- protocol (TA section 43), not business policy. No job, grant or business row is inserted here.

-- ---------------------------------------------------------------------------
-- Capability catalog (grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values ('manage_operational_jobs');

-- ---------------------------------------------------------------------------
-- Implementation constraints on the existing relation.
-- ---------------------------------------------------------------------------

alter table public.operational_jobs
  add constraint operational_jobs_lifecycle_state_check
    check (state in ('pending', 'running', 'completed', 'escalated', 'cancelled')),
  add constraint operational_jobs_job_type_format_check
    check (job_type collate "C" ~ '^[a-z][a-z0-9_.]{2,63}$'),
  add constraint operational_jobs_subject_check
    check (
      (subject_type is null) = (subject_id is null)
      and (subject_type is null or subject_type collate "C" ~ '^[a-z][a-z0-9_]{0,63}$')
    ),
  add constraint operational_jobs_lease_consistency_check
    check (
      (state = 'running') = (locked_at is not null)
      and (state = 'running') = (locked_by is not null)
    ),
  add constraint operational_jobs_locked_by_format_check
    check (locked_by is null or locked_by collate "C" ~ '^[A-Za-z0-9._:-]{1,64}$'),
  add constraint operational_jobs_completion_consistency_check
    check ((state = 'completed') = (completed_at is not null)),
  add constraint operational_jobs_escalation_consistency_check
    check ((state = 'escalated') = (failed_at is not null)),
  add constraint operational_jobs_pending_attempts_check
    check (state <> 'pending' or attempt_count < max_attempts),
  add constraint operational_jobs_running_attempts_check
    check (state <> 'running' or attempt_count >= 1),
  add constraint operational_jobs_error_code_format_check
    check (last_error_code is null or last_error_code collate "C" ~ '^[a-z][a-z0-9_]{0,63}$'),
  add constraint operational_jobs_error_message_bound_check
    check (last_error_message is null or char_length(last_error_message) between 1 and 500);

-- Deterministic idempotency: one open (pending, running or escalated) job per job type and subject.
create unique index operational_jobs_open_subject_unique
  on public.operational_jobs (job_type, subject_type, subject_id)
  where subject_id is not null and state in ('pending', 'running', 'escalated');

-- Claim order (available_at, created_at, id) over claimable rows.
create index operational_jobs_claimable_idx
  on public.operational_jobs (available_at, created_at, id)
  where state in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- Lifecycle integrity.
-- ---------------------------------------------------------------------------

create function public.operational_jobs_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'operational jobs are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'pending'
       or new.attempt_count is distinct from 0
       or new.locked_at is not null
       or new.locked_by is not null
       or new.completed_at is not null
       or new.failed_at is not null
       or new.last_error_code is not null
       or new.last_error_message is not null then
      raise exception 'an operational job is created pending, unclaimed and without attempts'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.job_type is distinct from old.job_type
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id
     or new.created_at is distinct from old.created_at then
    raise exception 'an operational job keeps its identity, type, subject and creation time'
      using errcode = '55000';
  end if;
  if old.state in ('completed', 'cancelled') then
    raise exception 'an operational job that is % is terminal', old.state
      using errcode = '55000';
  end if;
  if not (
    (old.state = 'pending' and new.state in ('pending', 'running', 'cancelled'))
    or (old.state = 'running' and new.state in ('running', 'completed', 'pending', 'escalated', 'cancelled'))
    or (old.state = 'escalated' and new.state in ('pending', 'cancelled'))
  ) then
    raise exception 'operational job transition % -> % is not allowed', old.state, new.state
      using errcode = '23514';
  end if;
  -- A pending job may only be rescheduled while it stays pending.
  if old.state = 'pending' and new.state = 'pending'
     and (to_jsonb(new) - 'available_at') is distinct from (to_jsonb(old) - 'available_at') then
    raise exception 'a pending operational job changes only its availability'
      using errcode = '23514';
  end if;
  -- Every claim, including the reclamation of an expired lease, is exactly one more attempt; nothing else
  -- changes the attempt count.
  if new.state = 'running' then
    if new.attempt_count is distinct from old.attempt_count + 1 then
      raise exception 'a claim records exactly one more attempt'
        using errcode = '23514';
    end if;
  elsif new.attempt_count is distinct from old.attempt_count then
    raise exception 'the attempt count changes only when a job is claimed'
      using errcode = '23514';
  end if;
  -- The attempt bound is raised only when an escalated job is retried.
  if new.max_attempts is distinct from old.max_attempts
     and not (old.state = 'escalated' and new.state = 'pending'
              and new.max_attempts > old.max_attempts) then
    raise exception 'the attempt bound is raised only by the retry of an escalated job'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger operational_jobs_lifecycle
before insert or update or delete on public.operational_jobs
for each row
execute function public.operational_jobs_lifecycle();

create trigger operational_jobs_no_truncate
before truncate on public.operational_jobs
for each statement
execute function public.operational_jobs_lifecycle();

-- ---------------------------------------------------------------------------
-- Internal helpers (executable by no API role).
-- ---------------------------------------------------------------------------

-- One audit event about one operational job. System operations pass a null actor and actor_type 'system'.
create function public.operational_job_audit(
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_job_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text
)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    p_actor, p_actor_type, p_action, 'operational_job', p_job_id,
    p_before, p_after, p_reason, null, null, clock_timestamp()
  );
$function$;

-- The audited view of a job: never the free-text error message.
create function public.operational_job_snapshot(p_job public.operational_jobs)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'state', p_job.state,
    'job_type', p_job.job_type,
    'subject_type', p_job.subject_type,
    'subject_id', p_job.subject_id,
    'attempt_count', p_job.attempt_count,
    'max_attempts', p_job.max_attempts,
    'available_at', p_job.available_at,
    'last_error_code', p_job.last_error_code
  );
$function$;

-- A bounded single-line error message: control characters become spaces, at most 500 characters, no
-- surrounding whitespace; empty becomes null.
create function public.operational_job_error_message(p_message text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog
as $function$
  select nullif(
    btrim(left(regexp_replace(p_message, '[[:cntrl:]]', ' ', 'g'), 500)),
    ''
  );
$function$;

-- Escalates one locked running job whose attempts are exhausted, with one system audit event.
create function public.operational_job_escalate(
  p_job public.operational_jobs,
  p_error_code text,
  p_error_message text,
  p_reason text
)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_after public.operational_jobs;
begin
  update public.operational_jobs as j
  set state = 'escalated',
      failed_at = clock_timestamp(),
      locked_at = null,
      locked_by = null,
      last_error_code = p_error_code,
      last_error_message = p_error_message
  where j.id = p_job.id
  returning j.* into v_after;
  perform public.operational_job_audit(
    null, 'system', 'operational_job.escalated', p_job.id,
    public.operational_job_snapshot(p_job),
    public.operational_job_snapshot(v_after),
    p_reason
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- The outbox: internal functions for domain functions, inside their own transactions.
-- ---------------------------------------------------------------------------

-- Enqueues one job, or answers the id of the open job already enqueued for the same job type and subject.
-- Invalid input is a programming error and raises 22023, which rolls the calling transaction back.
create function public.job_enqueue(
  p_job_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_available_at timestamptz,
  p_max_attempts integer
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_id uuid;
begin
  if p_job_type is null
     or p_job_type collate "C" !~ '^[a-z][a-z0-9_.]{2,63}$'
     or (p_subject_type is null) <> (p_subject_id is null)
     or (p_subject_type is not null
         and p_subject_type collate "C" !~ '^[a-z][a-z0-9_]{0,63}$')
     or p_max_attempts is null
     or p_max_attempts not between 1 and 25 then
    raise exception 'invalid operational job'
      using errcode = '22023';
  end if;
  if p_subject_id is null then
    insert into public.operational_jobs (job_type, state, available_at, max_attempts)
    values (p_job_type, 'pending', coalesce(p_available_at, statement_timestamp()), p_max_attempts)
    returning id into v_id;
    return v_id;
  end if;
  -- A concurrent enqueue of the same subject waits on the unique index and then answers the job that won.
  for v_attempt in 1..3 loop
    insert into public.operational_jobs (
      job_type, subject_type, subject_id, state, available_at, max_attempts
    ) values (
      p_job_type, p_subject_type, p_subject_id, 'pending',
      coalesce(p_available_at, statement_timestamp()), p_max_attempts
    )
    on conflict (job_type, subject_type, subject_id)
      where subject_id is not null and state in ('pending', 'running', 'escalated')
      do nothing
    returning id into v_id;
    if v_id is not null then
      return v_id;
    end if;
    select j.id into v_id
    from public.operational_jobs as j
    where j.job_type = p_job_type
      and j.subject_type = p_subject_type
      and j.subject_id = p_subject_id
      and j.state in ('pending', 'running', 'escalated');
    if v_id is not null then
      return v_id;
    end if;
  end loop;
  raise exception 'operational job enqueue did not settle'
    using errcode = '40001';
end;
$function$;

-- Cancels every open job of a subject that became terminal; answers how many were cancelled. A worker still
-- holding one of them gets not_running when it reports.
create function public.job_cancel_for_subject(
  p_subject_type text,
  p_subject_id uuid
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_count integer;
begin
  if p_subject_type is null or p_subject_id is null then
    raise exception 'invalid operational job subject'
      using errcode = '22023';
  end if;
  update public.operational_jobs as j
  set state = 'cancelled',
      locked_at = null,
      locked_by = null,
      failed_at = null
  where j.subject_type = p_subject_type
    and j.subject_id = p_subject_id
    and j.state in ('pending', 'running', 'escalated');
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The worker (service_role only: the server-only privileged worker credential).
-- ---------------------------------------------------------------------------

-- Claims up to p_limit jobs that are due: pending jobs whose available_at has passed and running jobs whose
-- lease has expired (lazy reclamation), in available_at, created_at, id order, skipping rows another
-- transaction holds. Each claimed job records one more attempt and a lease of p_lease_seconds. A job whose
-- lease expired on its last allowed attempt is escalated (with one system audit event) and not returned.
create function public.job_claim(
  p_worker text,
  p_lease_seconds integer,
  p_limit integer
)
returns table (
  job_id uuid,
  job_type text,
  subject_type text,
  subject_id uuid,
  attempt integer,
  max_attempts integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_job public.operational_jobs;
  v_now timestamptz;
begin
  if p_worker is null
     or p_worker collate "C" !~ '^[A-Za-z0-9._:-]{1,64}$'
     or p_lease_seconds is null
     or p_lease_seconds not between 5 and 3600
     or p_limit is null
     or p_limit not between 1 and 50 then
    raise exception 'invalid operational job claim'
      using errcode = '22023';
  end if;
  v_now := clock_timestamp();
  for v_job in
    select j.*
    from public.operational_jobs as j
    where j.state in ('pending', 'running')
      and j.available_at <= v_now
    order by j.available_at, j.created_at, j.id
    limit p_limit
    for update of j skip locked
  loop
    if v_job.attempt_count >= v_job.max_attempts then
      perform public.operational_job_escalate(v_job, 'lease_expired', null, 'attempts_exhausted');
      continue;
    end if;
    update public.operational_jobs as j
    set state = 'running',
        locked_at = v_now,
        locked_by = p_worker,
        attempt_count = j.attempt_count + 1,
        available_at = v_now + make_interval(secs => p_lease_seconds),
        last_error_code = case when v_job.state = 'running' then 'lease_expired' else j.last_error_code end,
        last_error_message = case when v_job.state = 'running' then null else j.last_error_message end
    where j.id = v_job.id;
    job_id := v_job.id;
    job_type := v_job.job_type;
    subject_type := v_job.subject_type;
    subject_id := v_job.subject_id;
    attempt := v_job.attempt_count + 1;
    max_attempts := v_job.max_attempts;
    return next;
  end loop;
  return;
end;
$function$;

-- Completes a job the caller holds: 'completed', 'not_owner' (another worker holds it) or 'not_running'
-- (unknown, not claimed, already completed, escalated or cancelled; nothing changes).
create function public.job_complete(
  p_job_id uuid,
  p_worker text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_job public.operational_jobs;
begin
  if p_job_id is null
     or p_worker is null
     or p_worker collate "C" !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'invalid operational job report'
      using errcode = '22023';
  end if;
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
  for no key update;
  if not found or v_job.state is distinct from 'running' then
    return 'not_running';
  end if;
  if v_job.locked_by is distinct from p_worker then
    return 'not_owner';
  end if;
  update public.operational_jobs as j
  set state = 'completed',
      completed_at = clock_timestamp(),
      locked_at = null,
      locked_by = null
  where j.id = v_job.id;
  return 'completed';
end;
$function$;

-- Reports a failed attempt of a job the caller holds: 'retry_scheduled' (pending again after a backoff of
-- 30 seconds x 2^(attempt - 1), capped at one hour), 'escalated' (attempts exhausted; one system audit event),
-- 'not_owner' or 'not_running'. The error code is a lower-snake code; the message is bounded to 500 characters.
create function public.job_fail(
  p_job_id uuid,
  p_worker text,
  p_error_code text,
  p_error_message text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_job public.operational_jobs;
  v_message text;
  v_delay integer;
begin
  if p_job_id is null
     or p_worker is null
     or p_worker collate "C" !~ '^[A-Za-z0-9._:-]{1,64}$'
     or p_error_code is null
     or p_error_code collate "C" !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid operational job report'
      using errcode = '22023';
  end if;
  v_message := public.operational_job_error_message(p_error_message);
  select j.* into v_job
  from public.operational_jobs as j
  where j.id = p_job_id
  for no key update;
  if not found or v_job.state is distinct from 'running' then
    return 'not_running';
  end if;
  if v_job.locked_by is distinct from p_worker then
    return 'not_owner';
  end if;
  if v_job.attempt_count >= v_job.max_attempts then
    perform public.operational_job_escalate(v_job, p_error_code, v_message, 'attempts_exhausted');
    return 'escalated';
  end if;
  v_delay := least(30 * power(2, least(v_job.attempt_count - 1, 16))::integer, 3600);
  update public.operational_jobs as j
  set state = 'pending',
      available_at = clock_timestamp() + make_interval(secs => v_delay),
      locked_at = null,
      locked_by = null,
      last_error_code = p_error_code,
      last_error_message = v_message
  where j.id = v_job.id;
  return 'retry_scheduled';
end;
$function$;

-- ---------------------------------------------------------------------------
-- The sweeper (no API role; pg_cron runs it as the owner). It reclaims expired leases (running -> pending
-- when attempts remain, otherwise escalated with one system audit event) and writes nothing else. At most 500
-- jobs per run keep each run short; the next run, or any claim, continues.
-- ---------------------------------------------------------------------------

create function public.operational_jobs_sweep()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_job public.operational_jobs;
  v_now timestamptz;
  v_reclaimed integer := 0;
  v_escalated integer := 0;
begin
  v_now := clock_timestamp();
  for v_job in
    select j.*
    from public.operational_jobs as j
    where j.state = 'running'
      and j.available_at <= v_now
    order by j.available_at, j.created_at, j.id
    limit 500
    for update of j skip locked
  loop
    if v_job.attempt_count >= v_job.max_attempts then
      perform public.operational_job_escalate(v_job, 'lease_expired', null, 'attempts_exhausted');
      v_escalated := v_escalated + 1;
    else
      update public.operational_jobs as j
      set state = 'pending',
          available_at = v_now,
          locked_at = null,
          locked_by = null,
          last_error_code = 'lease_expired',
          last_error_message = null
      where j.id = v_job.id;
      v_reclaimed := v_reclaimed + 1;
    end if;
  end loop;
  return jsonb_build_object('reclaimed', v_reclaimed, 'escalated', v_escalated);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Staff administration (manage_operational_jobs, global grant only). Each function derives the actor from
-- auth.uid(), locks User -> Staff Profile -> grant, then the job, and writes its change and one audit event in
-- one transaction. Outcomes: 'applied', 'invalid', 'denied', 'not_found', 'invalid_transition'.
-- ---------------------------------------------------------------------------

-- Returns an escalated job to pending, available now. Attempts stay bounded: the attempt count keeps its
-- history and the bound is raised by one more round of attempts. The original bound is not stored (rule 16
-- allows no new column), so a round is min(max_attempts, 25): exactly the original bound for a job retried
-- for the first time, because job_enqueue bounds it to 1..25.
create function public.staff_retry_job(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.operational_jobs;
  v_after public.operational_jobs;
begin
  if p_job_id is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_operational_jobs', null);
  if v_staff is null then
    return 'denied';
  end if;
  select j.* into v_before
  from public.operational_jobs as j
  where j.id = p_job_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state is distinct from 'escalated' then
    return 'invalid_transition';
  end if;
  update public.operational_jobs as j
  set state = 'pending',
      available_at = clock_timestamp(),
      failed_at = null,
      max_attempts = j.max_attempts + least(j.max_attempts, 25)
  where j.id = v_before.id
  returning j.* into v_after;
  perform public.operational_job_audit(
    v_staff, 'staff', 'operational_job.retried', v_before.id,
    public.operational_job_snapshot(v_before),
    public.operational_job_snapshot(v_after),
    null
  );
  return 'applied';
end;
$function$;

-- Cancels a non-terminal job (pending, running or escalated).
create function public.staff_cancel_job(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.operational_jobs;
  v_after public.operational_jobs;
begin
  if p_job_id is null then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_operational_jobs', null);
  if v_staff is null then
    return 'denied';
  end if;
  select j.* into v_before
  from public.operational_jobs as j
  where j.id = p_job_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  if v_before.state not in ('pending', 'running', 'escalated') then
    return 'invalid_transition';
  end if;
  update public.operational_jobs as j
  set state = 'cancelled',
      locked_at = null,
      locked_by = null,
      failed_at = null
  where j.id = v_before.id
  returning j.* into v_after;
  perform public.operational_job_audit(
    v_staff, 'staff', 'operational_job.cancelled', v_before.id,
    public.operational_job_snapshot(v_before),
    public.operational_job_snapshot(v_after),
    null
  );
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Staff read (request-scoped, unprivileged) and table privileges: every write goes through the functions.
-- ---------------------------------------------------------------------------

create policy operational_jobs_staff_read on public.operational_jobs
  for select to authenticated
  using (public.has_staff_capability('manage_operational_jobs', null, false));

revoke insert, update, delete, truncate on table public.operational_jobs
  from anon, authenticated, service_role;
grant select on table public.operational_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.operational_jobs_lifecycle()',
    'public.operational_job_audit(uuid, text, text, uuid, jsonb, jsonb, text)',
    'public.operational_job_snapshot(public.operational_jobs)',
    'public.operational_job_error_message(text)',
    'public.operational_job_escalate(public.operational_jobs, text, text, text)',
    'public.job_enqueue(text, text, uuid, timestamptz, integer)',
    'public.job_cancel_for_subject(text, uuid)',
    'public.operational_jobs_sweep()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.job_claim(text, integer, integer)',
    'public.job_complete(uuid, text)',
    'public.job_fail(uuid, text, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.staff_retry_job(uuid)',
    'public.staff_cancel_job(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

comment on function public.job_enqueue(text, text, uuid, timestamptz, integer) is
  'Internal outbox enqueue for domain functions (MBS section 21; TA section 27): one open job per job type and subject; answers the existing open job instead of duplicating. Executable by no API role.';
comment on function public.job_cancel_for_subject(text, uuid) is
  'Internal: cancels the open jobs of a subject that became terminal and answers how many. Executable by no API role.';
comment on function public.job_claim(text, integer, integer) is
  'Worker claim (service_role only): due pending jobs and expired leases, FOR UPDATE SKIP LOCKED, in available_at, created_at, id order; one more attempt and a lease each; exhausted expired leases escalate instead.';
comment on function public.job_complete(uuid, text) is
  'Worker completion (service_role only): completed | not_owner | not_running. A duplicate completion changes nothing.';
comment on function public.job_fail(uuid, text, text, text) is
  'Worker failure report (service_role only): retry_scheduled (exponential backoff, capped at one hour) | escalated (attempts exhausted, audited as system) | not_owner | not_running.';
comment on function public.operational_jobs_sweep() is
  'Database-only sweep (pg_cron, as the owner): reclaims expired leases and escalates exhausted ones; writes nothing else. Correctness never depends on it: every claim reclaims expired leases itself.';
comment on function public.staff_retry_job(uuid) is
  'Staff retry of an escalated job (manage_operational_jobs, global grant, aal2 session): pending and available now, one more bounded round of attempts; audited.';
comment on function public.staff_cancel_job(uuid) is
  'Staff cancellation of a non-terminal job (manage_operational_jobs, global grant, aal2 session); audited.';
