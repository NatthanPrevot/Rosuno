-- MVP-001 S2: authentication-abuse control for sign-in and account recovery (PS-A4 sections 1 to 6; MVP-001
-- Packet S2 "rate limits for sign-in and recovery" and "suspicious-login detection and handling"; MBS section 5;
-- TA sections 25, 43 and 56).
--
-- One private relation of operational counts (PS-A4 section 2) and four server-only decision functions (PS-A4
-- section 3), executable only by service_role, the server-only privileged credential:
-- - authentication_abuse_reserve: one atomic decision per attempt, 'allow' (one attempt reserved in the identity
--   and the global window of the purpose) or 'throttle' (nothing reserved);
-- - authentication_abuse_record_failure: a failed sign-in counted in the current windows; 'suspicious' when the
--   identity's failures reach the configured threshold, otherwise 'recorded';
-- - authentication_abuse_record_success: 'suspicious' for a successful sign-in into an identity whose current
--   window has reached that threshold, otherwise 'recorded';
-- - authentication_abuse_report_unavailable: the database path of the unavailable report (PS-A4 section 4 item 1),
--   'recorded' or 'already_recorded'.
-- Any invalid argument, lock or statement timeout, or other error raises, so the transaction rolls back, nothing is
-- reserved or counted, and the application reads the protection as unavailable.
--
-- The database owns the clock (clock_timestamp() under the purpose lock) and aligns every window to its length in
-- UTC. Window lengths, maxima and the suspicious threshold come from validated server-only operational
-- configuration and are bounded again here (identity maximum 1 to 1,000, global maximum 1 to 100,000, threshold
-- 1 to 1,000, windows of 900, 3,600 or 86,400 seconds); none of them is a default. Counter rows hold only opaque
-- digests computed by the server; no email address, network address, account or device identifier is stored.
--
-- Security events (audit_events, actor_type 'system', no actor User):
-- - security.rate_limited: the first throttle of one counter row in its window. A throttled attempt raises
--   attempt_count from exactly the maximum to the maximum plus one on each dimension at its maximum, and never
--   further, so only that transition writes the event (one per counter row and window while the configured maximum
--   is unchanged);
-- - security.suspicious_login: one per 'suspicious' answer; the User id (resolved from the Auth user id) appears
--   only for a successful sign-in;
-- - security.protection_unavailable: at most one per purpose, failure kind and aligned UTC 15-minute window.
-- No event stores a digest, email address, network address or device data.
--
-- Expired rows are pruned by the reserve function only, at most 100 per call, of its own purpose, in a
-- deterministic order. Nothing else deletes a row; the relation holds no evidence (PS-A4 sections 2 and 6).

-- ---------------------------------------------------------------------------
-- PS-A4 section 2: the relation.
-- ---------------------------------------------------------------------------

create table public.authentication_abuse_counters (
  purpose text not null,
  dimension text not null,
  digest text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  expires_at timestamptz not null,
  attempt_count integer not null,
  failure_count integer not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint authentication_abuse_counters_pkey
    primary key (purpose, dimension, digest, window_start),
  constraint authentication_abuse_counters_purpose_check
    check (purpose in ('sign_in', 'recovery')),
  constraint authentication_abuse_counters_dimension_check
    check (dimension in ('identity', 'global')),
  constraint authentication_abuse_counters_digest_check
    check (digest collate "C" ~ '^[0-9a-f]{64}$'),
  constraint authentication_abuse_counters_window_check
    check (
      extract(epoch from (window_end - window_start)) in (900, 3600, 86400)
      and mod(
        extract(epoch from window_start),
        extract(epoch from (window_end - window_start))
      ) = 0
    ),
  constraint authentication_abuse_counters_expiry_check
    check (expires_at = window_end + interval '24 hours'),
  constraint authentication_abuse_counters_count_check
    check (
      failure_count >= 0
      and failure_count <= attempt_count
      and attempt_count <= 1000000
    )
);

alter table public.authentication_abuse_counters enable row level security;

-- Bounded pruning reads expired rows of one purpose in expiry order.
create index authentication_abuse_counters_expiry_idx
  on public.authentication_abuse_counters
  (purpose, expires_at, dimension, digest, window_start);

revoke all on table public.authentication_abuse_counters
  from public, anon, authenticated, service_role;

comment on table public.authentication_abuse_counters is
  'Private authentication-abuse counts (PS-A4): attempts and failed attempts of one purpose (sign_in, recovery) in one dimension (identity, global) during one aligned UTC window, keyed by an opaque server-computed HMAC digest. Operational state, not evidence. Row level security with no policy and no API-role privilege: read and written only by the authentication_abuse_* decision functions.';

-- ---------------------------------------------------------------------------
-- Internal helpers (executable by no API role).
-- ---------------------------------------------------------------------------

-- The start of the aligned UTC window of the given length that contains the instant.
create function public.authentication_abuse_window_start(p_at timestamptz, p_seconds integer)
returns timestamptz
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select to_timestamp(floor(extract(epoch from p_at) / p_seconds) * p_seconds);
$function$;

-- One system security event (PS-A4 sections 3 and 4): no actor User, no before snapshot, no policy reference.
create function public.authentication_abuse_audit(
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_after jsonb,
  p_reason text,
  p_at timestamptz
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
    null, 'system', p_action, p_resource_type, p_resource_id,
    null, p_after, p_reason, null, null, p_at
  );
$function$;

-- Moves the current counter row of one dimension to the configured window length when the length changed while
-- the row's window start is also the start of the new window: every attempt it counted happened inside the new
-- window, so its counts stay correct. Answers the row's attempt count, or null when there is no current row. The
-- caller holds the purpose lock; the row is locked here.
create function public.authentication_abuse_current_attempts(
  p_purpose text,
  p_dimension text,
  p_digest text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_at timestamptz
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_attempts integer;
  v_window_end timestamptz;
begin
  select c.attempt_count, c.window_end
  into v_attempts, v_window_end
  from public.authentication_abuse_counters as c
  where c.purpose = p_purpose
    and c.dimension = p_dimension
    and c.digest = p_digest
    and c.window_start = p_window_start
  for update;
  if found and v_window_end is distinct from p_window_end then
    update public.authentication_abuse_counters as c
    set window_end = p_window_end,
        expires_at = p_window_end + interval '24 hours',
        updated_at = p_at
    where c.purpose = p_purpose
      and c.dimension = p_dimension
      and c.digest = p_digest
      and c.window_start = p_window_start;
  end if;
  return v_attempts;
end;
$function$;

-- Records the first throttle of one counter row in its window: attempt_count moves from exactly the maximum to
-- the maximum plus one, once, with one security.rate_limited event. A row already past its maximum is unchanged.
create function public.authentication_abuse_mark_throttled(
  p_purpose text,
  p_dimension text,
  p_digest text,
  p_window_start timestamptz,
  p_maximum integer,
  p_at timestamptz
)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $function$
declare
  v_window_end timestamptz;
begin
  update public.authentication_abuse_counters as c
  set attempt_count = p_maximum + 1,
      updated_at = p_at
  where c.purpose = p_purpose
    and c.dimension = p_dimension
    and c.digest = p_digest
    and c.window_start = p_window_start
    and c.attempt_count = p_maximum
  returning c.window_end into v_window_end;
  if found then
    perform public.authentication_abuse_audit(
      'security.rate_limited', 'authentication_abuse_counter', null,
      jsonb_build_object(
        'purpose', p_purpose,
        'dimension', p_dimension,
        'window_start', p_window_start,
        'window_end', v_window_end,
        'maximum', p_maximum
      ),
      'maximum_reached', p_at
    );
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- PS-A4 section 3: the decision functions (service_role only).
-- ---------------------------------------------------------------------------

-- Reserves one attempt of a purpose in its identity window and its global window together, or throttles and
-- reserves nothing when either is already at its maximum. Expired rows of the purpose are pruned afterwards, at
-- most 100, in expiry order.
create function public.authentication_abuse_reserve(
  p_purpose text,
  p_identity_digest text,
  p_identity_max integer,
  p_identity_window_seconds integer,
  p_global_digest text,
  p_global_max integer,
  p_global_window_seconds integer
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '1s'
set statement_timeout = '1500ms'
as $function$
declare
  v_now timestamptz;
  v_identity_start timestamptz;
  v_identity_end timestamptz;
  v_global_start timestamptz;
  v_global_end timestamptz;
  v_identity_attempts integer;
  v_global_attempts integer;
  v_outcome text;
begin
  if p_purpose is null
     or p_purpose not in ('sign_in', 'recovery')
     or p_identity_digest is null
     or p_identity_digest collate "C" !~ '^[0-9a-f]{64}$'
     or p_global_digest is null
     or p_global_digest collate "C" !~ '^[0-9a-f]{64}$'
     or p_identity_digest = p_global_digest
     or p_identity_max is null
     or p_identity_max not between 1 and 1000
     or p_global_max is null
     or p_global_max not between 1 and 100000
     or p_identity_window_seconds is null
     or p_identity_window_seconds not in (900, 3600, 86400)
     or p_global_window_seconds is null
     or p_global_window_seconds not in (900, 3600, 86400) then
    raise exception 'authentication abuse decision unavailable'
      using errcode = '22023';
  end if;

  -- One transaction-scoped lock per purpose serializes its reservations before any row is read, so concurrent
  -- attempts never overspend a window and never wait longer than lock_timeout.
  perform pg_advisory_xact_lock(
    case p_purpose when 'sign_in' then 2026111804000001 else 2026111804000002 end
  );

  v_now := clock_timestamp();
  v_identity_start := public.authentication_abuse_window_start(v_now, p_identity_window_seconds);
  v_identity_end := v_identity_start + make_interval(secs => p_identity_window_seconds);
  v_global_start := public.authentication_abuse_window_start(v_now, p_global_window_seconds);
  v_global_end := v_global_start + make_interval(secs => p_global_window_seconds);

  -- Rows are locked identity first, then global, as every other decision function does.
  v_identity_attempts := public.authentication_abuse_current_attempts(
    p_purpose, 'identity', p_identity_digest, v_identity_start, v_identity_end, v_now
  );
  v_global_attempts := public.authentication_abuse_current_attempts(
    p_purpose, 'global', p_global_digest, v_global_start, v_global_end, v_now
  );

  if coalesce(v_identity_attempts, 0) >= p_identity_max
     or coalesce(v_global_attempts, 0) >= p_global_max then
    if coalesce(v_identity_attempts, 0) >= p_identity_max then
      perform public.authentication_abuse_mark_throttled(
        p_purpose, 'identity', p_identity_digest, v_identity_start, p_identity_max, v_now
      );
    end if;
    if coalesce(v_global_attempts, 0) >= p_global_max then
      perform public.authentication_abuse_mark_throttled(
        p_purpose, 'global', p_global_digest, v_global_start, p_global_max, v_now
      );
    end if;
    v_outcome := 'throttle';
  else
    insert into public.authentication_abuse_counters as c (
      purpose, dimension, digest, window_start, window_end, expires_at,
      attempt_count, failure_count, created_at, updated_at
    ) values (
      p_purpose, 'identity', p_identity_digest, v_identity_start, v_identity_end,
      v_identity_end + interval '24 hours', 1, 0, v_now, v_now
    )
    on conflict (purpose, dimension, digest, window_start)
    do update set attempt_count = c.attempt_count + 1,
                  updated_at = v_now;
    insert into public.authentication_abuse_counters as c (
      purpose, dimension, digest, window_start, window_end, expires_at,
      attempt_count, failure_count, created_at, updated_at
    ) values (
      p_purpose, 'global', p_global_digest, v_global_start, v_global_end,
      v_global_end + interval '24 hours', 1, 0, v_now, v_now
    )
    on conflict (purpose, dimension, digest, window_start)
    do update set attempt_count = c.attempt_count + 1,
                  updated_at = v_now;
    v_outcome := 'allow';
  end if;

  -- Bounded pruning (PS-A4 section 2): expired rows of this purpose only, so two purposes never contend.
  delete from public.authentication_abuse_counters as c
  where (c.purpose, c.dimension, c.digest, c.window_start) in (
    select e.purpose, e.dimension, e.digest, e.window_start
    from public.authentication_abuse_counters as e
    where e.purpose = p_purpose
      and e.expires_at <= v_now
    order by e.expires_at, e.dimension, e.digest, e.window_start
    limit 100
    for update skip locked
  );

  return v_outcome;
end;
$function$;

-- Counts one failed sign-in in the current identity and global windows (a window with no reserved attempt, for
-- example one that began after the reservation, has nothing to count). 'suspicious' exactly when the identity's
-- failure count reaches the threshold, with one security.suspicious_login event; otherwise 'recorded'.
create function public.authentication_abuse_record_failure(
  p_identity_digest text,
  p_identity_window_seconds integer,
  p_global_digest text,
  p_global_window_seconds integer,
  p_suspicious_threshold integer
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '1s'
set statement_timeout = '1500ms'
as $function$
declare
  v_now timestamptz;
  v_identity_start timestamptz;
  v_global_start timestamptz;
  v_failures integer;
  v_window_end timestamptz;
begin
  if p_identity_digest is null
     or p_identity_digest collate "C" !~ '^[0-9a-f]{64}$'
     or p_global_digest is null
     or p_global_digest collate "C" !~ '^[0-9a-f]{64}$'
     or p_identity_digest = p_global_digest
     or p_identity_window_seconds is null
     or p_identity_window_seconds not in (900, 3600, 86400)
     or p_global_window_seconds is null
     or p_global_window_seconds not in (900, 3600, 86400)
     or p_suspicious_threshold is null
     or p_suspicious_threshold not between 1 and 1000 then
    raise exception 'authentication abuse decision unavailable'
      using errcode = '22023';
  end if;

  v_now := clock_timestamp();
  v_identity_start := public.authentication_abuse_window_start(v_now, p_identity_window_seconds);
  v_global_start := public.authentication_abuse_window_start(v_now, p_global_window_seconds);

  update public.authentication_abuse_counters as c
  set failure_count = c.failure_count + 1,
      updated_at = v_now
  where c.purpose = 'sign_in'
    and c.dimension = 'identity'
    and c.digest = p_identity_digest
    and c.window_start = v_identity_start
    and c.failure_count < c.attempt_count
  returning c.failure_count, c.window_end into v_failures, v_window_end;

  update public.authentication_abuse_counters as c
  set failure_count = c.failure_count + 1,
      updated_at = v_now
  where c.purpose = 'sign_in'
    and c.dimension = 'global'
    and c.digest = p_global_digest
    and c.window_start = v_global_start
    and c.failure_count < c.attempt_count;

  if v_failures is not null and v_failures = p_suspicious_threshold then
    perform public.authentication_abuse_audit(
      'security.suspicious_login', 'authentication_abuse_counter', null,
      jsonb_build_object(
        'purpose', 'sign_in',
        'dimension', 'identity',
        'signal', 'failure_threshold_reached',
        'window_start', v_identity_start,
        'window_end', v_window_end,
        'failure_count', v_failures,
        'threshold', p_suspicious_threshold
      ),
      'failure_threshold_reached', v_now
    );
    return 'suspicious';
  end if;
  return 'recorded';
end;
$function$;

-- Judges one successful sign-in: 'suspicious' when the identity's current window has reached the threshold, with
-- one security.suspicious_login event naming the User of the Auth user id (none when no User has that Auth
-- identity); otherwise 'recorded'. Nothing is counted or changed.
create function public.authentication_abuse_record_success(
  p_identity_digest text,
  p_identity_window_seconds integer,
  p_suspicious_threshold integer,
  p_auth_user_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '1s'
set statement_timeout = '1500ms'
as $function$
declare
  v_now timestamptz;
  v_identity_start timestamptz;
  v_failures integer;
  v_window_end timestamptz;
  v_user uuid;
begin
  if p_identity_digest is null
     or p_identity_digest collate "C" !~ '^[0-9a-f]{64}$'
     or p_identity_window_seconds is null
     or p_identity_window_seconds not in (900, 3600, 86400)
     or p_suspicious_threshold is null
     or p_suspicious_threshold not between 1 and 1000
     or p_auth_user_id is null then
    raise exception 'authentication abuse decision unavailable'
      using errcode = '22023';
  end if;

  v_now := clock_timestamp();
  v_identity_start := public.authentication_abuse_window_start(v_now, p_identity_window_seconds);

  select c.failure_count, c.window_end
  into v_failures, v_window_end
  from public.authentication_abuse_counters as c
  where c.purpose = 'sign_in'
    and c.dimension = 'identity'
    and c.digest = p_identity_digest
    and c.window_start = v_identity_start;

  if v_failures is null or v_failures < p_suspicious_threshold then
    return 'recorded';
  end if;

  select u.id into v_user
  from public.users as u
  where u.auth_user_id = p_auth_user_id;

  perform public.authentication_abuse_audit(
    'security.suspicious_login', 'user', v_user,
    jsonb_build_object(
      'purpose', 'sign_in',
      'dimension', 'identity',
      'signal', 'success_after_failure_threshold',
      'window_start', v_identity_start,
      'window_end', v_window_end,
      'failure_count', v_failures,
      'threshold', p_suspicious_threshold
    ),
    'success_after_failure_threshold', v_now
  );
  return 'suspicious';
end;
$function$;

-- The database path of an unavailable report (PS-A4 section 4 item 1): one security.protection_unavailable event
-- per purpose, failure kind and aligned UTC 15-minute window. 'recorded' when this call wrote it,
-- 'already_recorded' when that window's event already exists; both are confirmed persistence.
create function public.authentication_abuse_report_unavailable(
  p_purpose text,
  p_failure_kind text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '1s'
set statement_timeout = '1500ms'
as $function$
declare
  v_now timestamptz;
  v_window_start timestamptz;
  v_window_end timestamptz;
begin
  if p_purpose is null
     or p_purpose not in ('sign_in', 'recovery')
     or p_failure_kind is null
     or p_failure_kind not in ('configuration', 'runtime') then
    raise exception 'authentication abuse report unavailable'
      using errcode = '22023';
  end if;

  -- One lock per purpose and failure kind makes the existence check and the write one decision.
  perform pg_advisory_xact_lock(
    case
      when p_purpose = 'sign_in' and p_failure_kind = 'configuration' then 2026111804000011
      when p_purpose = 'sign_in' then 2026111804000012
      when p_failure_kind = 'configuration' then 2026111804000013
      else 2026111804000014
    end
  );

  v_now := clock_timestamp();
  v_window_start := public.authentication_abuse_window_start(v_now, 900);
  v_window_end := v_window_start + interval '15 minutes';

  if exists (
    select 1
    from public.audit_events as a
    where a.resource_type = 'authentication_protection'
      and a.resource_id is null
      and a.occurred_at >= v_window_start
      and a.occurred_at < v_window_end
      and a.action_code = 'security.protection_unavailable'
      and a.after_snapshot ->> 'purpose' = p_purpose
      and a.after_snapshot ->> 'failure_kind' = p_failure_kind
  ) then
    return 'already_recorded';
  end if;

  perform public.authentication_abuse_audit(
    'security.protection_unavailable', 'authentication_protection', null,
    jsonb_build_object(
      'purpose', p_purpose,
      'failure_kind', p_failure_kind,
      'window_start', v_window_start,
      'window_end', v_window_end
    ),
    p_failure_kind, v_now
  );
  return 'recorded';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges: the four decision functions for service_role only; the helpers for no API role.
-- ---------------------------------------------------------------------------

revoke all on function public.authentication_abuse_window_start(timestamptz, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.authentication_abuse_audit(text, text, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.authentication_abuse_current_attempts(
  text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.authentication_abuse_mark_throttled(
  text, text, text, timestamptz, integer, timestamptz
) from public, anon, authenticated, service_role;

revoke all on function public.authentication_abuse_reserve(
  text, text, integer, integer, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.authentication_abuse_reserve(
  text, text, integer, integer, text, integer, integer
) to service_role;

revoke all on function public.authentication_abuse_record_failure(text, integer, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.authentication_abuse_record_failure(text, integer, text, integer, integer)
  to service_role;

revoke all on function public.authentication_abuse_record_success(text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authentication_abuse_record_success(text, integer, integer, uuid)
  to service_role;

revoke all on function public.authentication_abuse_report_unavailable(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.authentication_abuse_report_unavailable(text, text)
  to service_role;

comment on function public.authentication_abuse_reserve(text, text, integer, integer, text, integer, integer) is
  'Authentication-abuse reservation (PS-A4 section 3; service_role only): allow (one attempt reserved in the identity and the global window of the purpose together) | throttle (nothing reserved; the first throttle of a counter row writes one security.rate_limited event). Database clock, aligned UTC windows, maxima bounded again; any error raises and reserves nothing.';
comment on function public.authentication_abuse_record_failure(text, integer, text, integer, integer) is
  'Failed sign-in signal (PS-A4 section 3; service_role only): counted in the current identity and global windows; suspicious exactly when the identity failure count reaches the threshold (one security.suspicious_login event), otherwise recorded.';
comment on function public.authentication_abuse_record_success(text, integer, integer, uuid) is
  'Successful sign-in signal (PS-A4 section 3; service_role only): suspicious when the identity current window has reached the threshold (one security.suspicious_login event naming the User), otherwise recorded. Changes no count.';
comment on function public.authentication_abuse_report_unavailable(text, text) is
  'Unavailable protection report (PS-A4 section 4 item 1; service_role only): one security.protection_unavailable event per purpose, failure kind and aligned UTC 15-minute window; recorded | already_recorded.';
