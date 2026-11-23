-- MVP-001 S11 pass 2 (10 of 16): the operations dashboard and the database part of system health (MVP-001 Packet
-- S11 "operations dashboard"; MBS sections 16 "Operations" and 18.4 "system health"; TA sections 18 "command
-- center: system health, active consultations, pending requests, payment exceptions, verification exceptions,
-- jurisdiction status, critical alerts", 23, 27 and 41; IMP section 27 exit; PS section 30.4).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). One read:
--
-- staff_operations_summary (EXECUTE for authenticated only; stable security definer; search_path pinned): counts
-- only, never a name, an identifier of a person, a matter's content or a provider reference, for staff holding the
-- global view_operations grant at aal2 (has_staff_capability; a jurisdiction-scoped grant reads nothing, because
-- every count spans every jurisdiction). Each row is (metric, dimension, value, oldest_at); every listed dimension is
-- answered, zero included, so a missing row is never mistaken for zero:
--   jobs                 pending | running | completed | escalated | cancelled (operational jobs by state; the
--                        pending row's oldest_at is the earliest due time of a pending job that is due now, null
--                        when none is waiting);
--   notifications        retrying | permanently_failed (email Notifications by delivery state);
--   review_exceptions    <family>.<severity> for the three families and four severities (open review items);
--   consultations        ready | live | stale (stale: not terminal, nominal end passed and the S11 outcome window
--                        closed, exactly the predicate of the pass 1 stale queue);
--   requests             created | payment_authorized | slot_held | awaiting_attorney (Requests awaiting a decision);
--   payments             pending_authorization | release_pending | capture_pending | refund_pending (transitional);
--   attorney_profiles    under_review;
--   jurisdictions        each of the seven lifecycle states;
--   environment_class    the recorded class (or unrecorded), value 1;
--   environment_status   ok | environment_unrecorded | environment_mismatch for this request, value 1;
--   scheduler            pg_cron (1 when the scheduler is installed in this database, else 0), then each of the
--                        five database-only sweeps the earlier slices register (S2 rosuno_operational_jobs_sweep, S3
--                        rosuno_intake_expiry_sweep, S4 rosuno_scheduling_expiry_sweep, S6
--                        rosuno_request_expiry_sweep, S9 rosuno_consultation_media_sweep): 1 when registered and
--                        active, else 0. A database without pg_cron (the disposable proofs) answers 0 for all six.
-- Without the grant the read answers no row at all. Hosted checks (provider reachability, deployment health) are not
-- database facts and are out of scope (L6 HOLD); the system health page says so.

create function public.staff_operations_summary()
returns table (metric text, dimension text, value bigint, oldest_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_cron boolean;
  v_sweep text;
  v_registered bigint;
begin
  if public.has_staff_capability('view_operations', null, false) is not true then
    return;
  end if;
  return query
    select 'jobs'::text, s.state, count(j.id)::bigint,
      case when s.state = 'pending' then min(j.available_at) filter (where j.available_at <= v_now) end
    from unnest(array['pending', 'running', 'completed', 'escalated', 'cancelled']) with ordinality as s(state, n)
    left join public.operational_jobs as j on j.state = s.state
    group by s.state, s.n
    order by s.n;
  return query
    select 'notifications'::text, s.state, count(x.id)::bigint, null::timestamptz
    from unnest(array['retrying', 'permanently_failed']) with ordinality as s(state, n)
    left join public.notifications as x on x.channel = 'email' and x.state = s.state
    group by s.state, s.n
    order by s.n;
  return query
    select 'review_exceptions'::text, f.family || '.' || v.severity, count(e.id)::bigint, min(e.detected_at)
    from unnest(array['financial', 'compliance', 'operations']) with ordinality as f(family, n)
    cross join unnest(array['critical', 'high', 'medium', 'low']) with ordinality as v(severity, m)
    left join public.reconciliation_exceptions as e
      on e.status = 'open' and e.severity = v.severity and public.exception_family(e.exception_type) = f.family
    group by f.family, f.n, v.severity, v.m
    order by f.n, v.m;
  return query
    select 'consultations'::text, s.state, count(c.id)::bigint, null::timestamptz
    from unnest(array['ready', 'live']) with ordinality as s(state, n)
    left join public.consultations as c on c.state = s.state
    group by s.state, s.n
    order by s.n;
  return query
    select 'consultations'::text, 'stale'::text, count(*)::bigint, null::timestamptz
    from public.consultations as c
    join public.consultation_requests as r on r.id = c.consultation_request_id
    left join public.bookings as k on k.consultation_id = c.id and k.status = 'confirmed'
    cross join lateral public.consultation_outcome_window(c.id, v_now) as w
    where c.state in ('created', 'scheduled', 'ready', 'live')
      and case c.request_path
        when 'scheduled' then k.ends_at
        else coalesce(c.started_at, c.created_at) + make_interval(mins => r.requested_duration_minutes)
      end <= v_now
      and w.closes_at is not null
      and w.closes_at <= v_now;
  return query
    select 'requests'::text, s.state, count(r.id)::bigint, min(r.created_at)
    from unnest(array['created', 'payment_authorized', 'slot_held', 'awaiting_attorney']) with ordinality as s(state, n)
    left join public.consultation_requests as r on r.state = s.state
    group by s.state, s.n
    order by s.n;
  return query
    select 'payments'::text, s.state, count(p.id)::bigint, min(p.updated_at)
    from unnest(array['pending_authorization', 'release_pending', 'capture_pending', 'refund_pending'])
      with ordinality as s(state, n)
    left join public.payment_transactions as p on p.state = s.state
    group by s.state, s.n
    order by s.n;
  return query
    select 'attorney_profiles'::text, 'under_review'::text, count(*)::bigint, min(a.updated_at)
    from public.attorney_profiles as a
    where a.profile_state = 'under_review';
  return query
    select 'jurisdictions'::text, s.state, count(j.id)::bigint, null::timestamptz
    from unnest(array['unsupported', 'waitlist', 'staged', 'ready', 'live', 'restricted', 'suspended'])
      with ordinality as s(state, n)
    left join public.jurisdictions as j on j.lifecycle_state = s.state
    group by s.state, s.n
    order by s.n;
  return query select 'environment_class'::text, public.rosuno_environment_class(), 1::bigint, null::timestamptz;
  return query select 'environment_status'::text, public.rosuno_environment_status(), 1::bigint, null::timestamptz;
  v_cron := to_regclass('cron.job') is not null;
  return query select 'scheduler'::text, 'pg_cron'::text, case when v_cron then 1 else 0 end::bigint, null::timestamptz;
  foreach v_sweep in array array[
    'rosuno_operational_jobs_sweep', 'rosuno_intake_expiry_sweep', 'rosuno_scheduling_expiry_sweep',
    'rosuno_request_expiry_sweep', 'rosuno_consultation_media_sweep'
  ]
  loop
    v_registered := 0;
    if v_cron then
      execute
        'select count(*) from cron.job as j where j.jobname = $1 and coalesce((to_jsonb(j) ->> ''active'')::boolean, true)'
        into v_registered
        using v_sweep;
    end if;
    return query select 'scheduler'::text, v_sweep, least(v_registered, 1)::bigint, null::timestamptz;
  end loop;
end;
$function$;

revoke all on function public.staff_operations_summary()
  from public, anon, authenticated, service_role;
grant execute on function public.staff_operations_summary() to authenticated;

comment on function public.staff_operations_summary() is
  'MVP-001 S11 operations dashboard and system health: counts only (jobs by state with the oldest due pending job, retrying and permanently failed email notifications, open review items by family and severity, ready, live and stale Consultations, Requests awaiting a decision, payments in transitional states, profiles under review, jurisdictions by lifecycle state), the recorded environment class and status and whether the scheduler and its five sweeps are registered, for staff holding the global view_operations grant (aal2). No personal data.';
