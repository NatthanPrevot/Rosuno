-- P2-007 local candidate. Unreviewed and unapplied.
-- Registration abuse control: one private quota-counter relation and one
-- restricted atomic decision function.
--
-- Each eligible registration attempt reserves one accepted unit in all three
-- scopes at once, or in none: the trusted client address per aligned UTC
-- hour, the normalized identity per aligned UTC day, and one global scope per
-- aligned UTC hour. Rows are keyed by opaque server-computed HMAC digests; no
-- address, email, account, person, brand, tenant, or jurisdiction is stored.
-- The three maxima come only from validated server-only deployment settings
-- and are bounded again here; the database owns the clock and the windows.
--
-- The existing service_role bypasses RLS and holds the direct table rights
-- this SECURITY INVOKER function needs. That is not a function-only
-- boundary: the isolated server-only credential remains the perimeter.
--
-- Expired rows are pruned opportunistically, at most 100 per decision. Idle
-- rows may remain indefinitely; no scheduler, purge job, or deletion deadline
-- is introduced.

create table public.registration_quota_counters (
  dimension text not null,
  digest text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  expires_at timestamptz not null,
  accepted_count integer not null,
  throttled_count integer not null,
  policy_marker text not null,
  constraint registration_quota_counters_pkey
    primary key (dimension, digest, window_start),
  constraint registration_quota_counters_dimension_check
    check (dimension in ('ip', 'identity', 'global')),
  constraint registration_quota_counters_digest_check
    check (digest ~ '^[0-9a-f]{64}$'),
  constraint registration_quota_counters_window_check
    check (
      (
        dimension = 'identity'
        and (window_start at time zone 'UTC')
          = date_trunc('day', window_start at time zone 'UTC')
        and window_end = window_start + interval '24 hours'
      )
      or (
        dimension in ('ip', 'global')
        and (window_start at time zone 'UTC')
          = date_trunc('hour', window_start at time zone 'UTC')
        and window_end = window_start + interval '1 hour'
      )
    ),
  constraint registration_quota_counters_expiry_check
    check (expires_at = window_end + interval '24 hours'),
  constraint registration_quota_counters_accepted_count_check
    check (
      (dimension in ('ip', 'identity') and accepted_count between 1 and 100)
      or (dimension = 'global' and accepted_count between 0 and 1200)
    ),
  constraint registration_quota_counters_throttled_count_check
    check (
      (dimension in ('ip', 'identity') and throttled_count = 0)
      or (dimension = 'global' and throttled_count >= 0)
    ),
  constraint registration_quota_counters_global_activity_check
    check (
      dimension <> 'global'
      or accepted_count > 0
      or throttled_count > 0
    ),
  constraint registration_quota_counters_policy_marker_check
    check (
      policy_marker ~ '^v1:ip=([1-9][0-9]?|100):identity=([1-9][0-9]?|100):global=([1-9][0-9]{0,2}|1[01][0-9]{2}|1200):windows=3600,86400,3600$'
    )
);

alter table public.registration_quota_counters enable row level security;

create index registration_quota_counters_expiry_idx
  on public.registration_quota_counters
  (expires_at, dimension, digest, window_start);

-- Decides one eligible registration attempt: 'allow' after reserving one
-- accepted unit in all three current windows, or 'throttle' when any one of
-- them is already at its maximum, reserving nothing. A throttle only creates
-- or advances the single current-hour global aggregate row, whose saturating
-- throttled_count is privacy-safe operational telemetry, never quota. Any
-- invalid argument, effective-policy mismatch with an existing current row,
-- lock timeout, or decision past the statement deadline raises one fixed
-- message and changes nothing. No caller chooses the time, windows, marker,
-- role, or target.
create function public.registration_quota_decide(
  ip_digest text,
  identity_digest text,
  global_digest text,
  ip_max integer,
  identity_max integer,
  global_max integer
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog
set lock_timeout = '250ms'
as $function$
declare
  marker text;
  decided_at timestamptz;
  hour_start timestamptz;
  day_start timestamptz;
  ip_accepted integer;
  ip_marker text;
  identity_accepted integer;
  identity_marker text;
  global_accepted integer;
  global_marker text;
  outcome text;
begin
  if ip_digest is null
     or identity_digest is null
     or global_digest is null
     or ip_digest !~ '^[0-9a-f]{64}$'
     or identity_digest !~ '^[0-9a-f]{64}$'
     or global_digest !~ '^[0-9a-f]{64}$'
     or ip_digest = identity_digest
     or ip_digest = global_digest
     or identity_digest = global_digest
     or ip_max is null
     or ip_max not between 1 and 100
     or identity_max is null
     or identity_max not between 1 and 100
     or global_max is null
     or global_max not between 1 and 1200 then
    raise exception 'registration quota unavailable'
      using errcode = '22023';
  end if;

  marker := format(
    'v1:ip=%s:identity=%s:global=%s:windows=3600,86400,3600',
    ip_max,
    identity_max,
    global_max
  );

  -- One fixed transaction-scoped lock serializes every decision before any
  -- row is read or locked, so decisions never deadlock with each other and
  -- none waits longer than lock_timeout.
  perform pg_advisory_xact_lock(2026102007000000);

  -- The one server-owned timestamp of this decision, taken under the lock.
  decided_at := clock_timestamp();
  hour_start := date_trunc('hour', decided_at, 'UTC');
  day_start := date_trunc('day', decided_at, 'UTC');

  select c.accepted_count, c.policy_marker
  into ip_accepted, ip_marker
  from public.registration_quota_counters as c
  where c.dimension = 'ip'
    and c.digest = ip_digest
    and c.window_start = hour_start
  for update;

  select c.accepted_count, c.policy_marker
  into identity_accepted, identity_marker
  from public.registration_quota_counters as c
  where c.dimension = 'identity'
    and c.digest = identity_digest
    and c.window_start = day_start
  for update;

  select c.accepted_count, c.policy_marker
  into global_accepted, global_marker
  from public.registration_quota_counters as c
  where c.dimension = 'global'
    and c.digest = global_digest
    and c.window_start = hour_start
  for update;

  -- Every existing current row must carry this decision's effective policy.
  if (ip_marker is not null and ip_marker <> marker)
     or (identity_marker is not null and identity_marker <> marker)
     or (global_marker is not null and global_marker <> marker) then
    raise exception 'registration quota unavailable'
      using errcode = '55000';
  end if;

  if coalesce(ip_accepted, 0) >= ip_max
     or coalesce(identity_accepted, 0) >= identity_max
     or coalesce(global_accepted, 0) >= global_max then
    if global_marker is null then
      insert into public.registration_quota_counters (
        dimension,
        digest,
        window_start,
        window_end,
        expires_at,
        accepted_count,
        throttled_count,
        policy_marker
      )
      values (
        'global',
        global_digest,
        hour_start,
        hour_start + interval '1 hour',
        hour_start + interval '25 hours',
        0,
        1,
        marker
      );
    else
      update public.registration_quota_counters as c
      set throttled_count = c.throttled_count + 1
      where c.dimension = 'global'
        and c.digest = global_digest
        and c.window_start = hour_start
        and c.throttled_count < 2147483647;
    end if;
    outcome := 'throttle';
  else
    if ip_marker is null then
      insert into public.registration_quota_counters (
        dimension,
        digest,
        window_start,
        window_end,
        expires_at,
        accepted_count,
        throttled_count,
        policy_marker
      )
      values (
        'ip',
        ip_digest,
        hour_start,
        hour_start + interval '1 hour',
        hour_start + interval '25 hours',
        1,
        0,
        marker
      );
    else
      update public.registration_quota_counters as c
      set accepted_count = c.accepted_count + 1
      where c.dimension = 'ip'
        and c.digest = ip_digest
        and c.window_start = hour_start;
    end if;

    if identity_marker is null then
      insert into public.registration_quota_counters (
        dimension,
        digest,
        window_start,
        window_end,
        expires_at,
        accepted_count,
        throttled_count,
        policy_marker
      )
      values (
        'identity',
        identity_digest,
        day_start,
        day_start + interval '24 hours',
        day_start + interval '48 hours',
        1,
        0,
        marker
      );
    else
      update public.registration_quota_counters as c
      set accepted_count = c.accepted_count + 1
      where c.dimension = 'identity'
        and c.digest = identity_digest
        and c.window_start = day_start;
    end if;

    if global_marker is null then
      insert into public.registration_quota_counters (
        dimension,
        digest,
        window_start,
        window_end,
        expires_at,
        accepted_count,
        throttled_count,
        policy_marker
      )
      values (
        'global',
        global_digest,
        hour_start,
        hour_start + interval '1 hour',
        hour_start + interval '25 hours',
        1,
        0,
        marker
      );
    else
      update public.registration_quota_counters as c
      set accepted_count = c.accepted_count + 1
      where c.dimension = 'global'
        and c.digest = global_digest
        and c.window_start = hour_start;
    end if;
    outcome := 'allow';
  end if;

  -- Bounded opportunistic pruning of rows past their retention grace, in a
  -- deterministic order. A current-window row never qualifies.
  delete from public.registration_quota_counters as c
  where (c.dimension, c.digest, c.window_start) in (
    select e.dimension, e.digest, e.window_start
    from public.registration_quota_counters as e
    where e.expires_at <= decided_at
    order by e.expires_at, e.dimension, e.digest, e.window_start
    limit 100
  );

  -- A decision that ran past the 1,500 ms statement deadline is rolled back
  -- rather than reported.
  if clock_timestamp() - statement_timestamp()
     > interval '1500 milliseconds' then
    raise exception 'registration quota unavailable'
      using errcode = '57014';
  end if;

  return outcome;
end;
$function$;

revoke all on function public.registration_quota_decide(
  text, text, text, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.registration_quota_decide(
  text, text, text, integer, integer, integer
) to service_role;

revoke all on table public.registration_quota_counters
  from public, anon, authenticated, service_role;
grant select, insert, delete
  on table public.registration_quota_counters to service_role;
grant update (
  accepted_count,
  throttled_count
) on table public.registration_quota_counters to service_role;

comment on table public.registration_quota_counters is
  'Private registration quota counters keyed by opaque HMAC digests in fixed UTC windows, with one global hourly aggregate of accepted and throttled decisions. No identity, address, or account data. Written only through registration_quota_decide.';

comment on function public.registration_quota_decide(
  text, text, text, integer, integer, integer
) is
  'Atomic all-or-none registration quota decision for one eligible attempt, returning allow or throttle. Server-only; the caller supplies only opaque digests and validated deployment maxima.';
