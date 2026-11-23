-- MVP-001 S11 pass 2 (13 of 16): referral operations and the financial activity summary (MVP-001 Packet S11
-- "operations dashboard", "reconciliation and audit workspaces"; MBS sections 16 "Operations" (administer referrals,
-- monitor payments and reconciliation, view required financial activity) and 18.4 "referral / allocation operations"
-- and "revenue / financial operations"; TA sections 18, 41 and 52; PS sections 22.2, 22.3 and 30.4; FP-1 sections 2
-- to 8).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). Read-only: there is no referral
-- write command here (the Referral outcome taxonomy is gated configuration) and the ledger stays append-only.
--
-- Referral operations (view_referral_operations by the Referral's jurisdiction: a global grant, or a grant for that
-- jurisdiction; aal2 through has_staff_capability; EXECUTE for authenticated only; stable security definer):
-- - staff_referrals: one page (25 rows, plus one) of Referrals, newest first: the Referral id, its jurisdiction,
--   attempt ordinal, allocation method, creation instant, the outcome code and its instant when recorded, and the
--   linked Request's id and state and the Consultation's id and state when they exist. Never Intake content, the
--   client's identity beyond the Request id, or a pool or presentation snapshot of any attorney;
-- - staff_referral_counts: counts over the Referrals the caller covers: open (no outcome recorded), ended without a
--   Request (an outcome recorded and no Request), and Referrals whose Request expired or was declined.
--
-- Financial activity summary (the global manage_financial_operations grant at aal2, exactly as the S7 finance
-- workspace; EXECUTE for authenticated only; stable security definer): staff_finance_summary for one period
-- [from, until) of at most 366 days and optionally one jurisdiction (the payment's recorded jurisdiction). Rows are
-- (metric, dimension, currency_code, value):
--   ledger      <entry_type>.<direction>, per currency: the sum of the ledger entries effective in the period (the
--               append-only ledger is the only source of amounts);
--   payments    each of the thirteen payment states (zero included): the payments created in the period, by their
--               current state;
--   refunds     posted: the distinct refunds (refund:<request> source references) whose reversal entries are effective
--               in the period;
--   disputes    opened: the dispute_opened review items about the payments, detected in the period.
-- An invalid period answers nothing; without the grant nothing is answered.
--
-- Jurisdiction names for the staff surfaces (staff_jurisdiction_names; EXECUTE for authenticated only; stable
-- security definer): the id, code and name of every jurisdiction (reference data, no personal data) for staff holding
-- any current capability grant at aal2 with an active User and Staff Profile, so the operations, audit, referral,
-- compliance and finance surfaces can name the jurisdictions they show. Nothing for anyone else.

-- ---------------------------------------------------------------------------
-- Referral operations.
-- ---------------------------------------------------------------------------

create function public.staff_referrals(p_offset integer)
returns table (
  referral_id uuid,
  jurisdiction_id uuid,
  attempt_ordinal integer,
  allocation_method text,
  created_at timestamptz,
  outcome_code text,
  outcome_recorded_at timestamptz,
  consultation_request_id uuid,
  request_state text,
  consultation_id uuid,
  consultation_state text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select f.id, f.jurisdiction_id, f.attempt_ordinal, f.allocation_method, f.created_at, f.outcome_code,
    f.outcome_recorded_at, r.id, r.state, c.id, c.state
  from public.referrals as f
  left join public.consultation_requests as r on r.referral_id = f.id
  left join public.consultations as c on c.consultation_request_id = r.id
  where p_offset between 0 and 100000
    and public.has_staff_capability('view_referral_operations', f.jurisdiction_id, false)
  order by f.created_at desc, f.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

create function public.staff_referral_counts()
returns table (metric text, value bigint)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with covered as (
    select f.id, f.outcome_code, r.id as request_id, r.state as request_state
    from public.referrals as f
    left join public.consultation_requests as r on r.referral_id = f.id
    where public.has_staff_capability('view_referral_operations', f.jurisdiction_id, false)
  )
  select m.metric, case m.metric
      when 'open' then (select count(*) from covered as c where c.outcome_code is null)
      when 'ended_without_request' then
        (select count(*) from covered as c where c.outcome_code is not null and c.request_id is null)
      when 'request_expired' then (select count(*) from covered as c where c.request_state = 'expired')
      else (select count(*) from covered as c where c.request_state = 'declined')
    end
  from unnest(array['open', 'ended_without_request', 'request_expired', 'request_declined'])
    with ordinality as m(metric, n)
  where public.has_staff_capability('view_referral_operations', null, true)
  order by m.n;
$function$;

-- ---------------------------------------------------------------------------
-- The financial activity summary.
-- ---------------------------------------------------------------------------

create function public.staff_finance_summary(p_from timestamptz, p_until timestamptz, p_jurisdiction_id uuid)
returns table (metric text, dimension text, currency_code text, value bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
#variable_conflict use_column
begin
  if p_from is null
     or p_until is null
     or p_until <= p_from
     or p_until - p_from > interval '366 days'
     or public.has_staff_capability('manage_financial_operations', null, false) is not true then
    return;
  end if;
  return query
    select 'ledger'::text, l.entry_type || '.' || l.direction, l.currency_code::text, sum(l.amount_minor)::bigint
    from public.ledger_entries as l
    join public.payment_transactions as pt on pt.id = l.payment_transaction_id
    where l.effective_at >= p_from
      and l.effective_at < p_until
      and (p_jurisdiction_id is null or pt.jurisdiction_id = p_jurisdiction_id)
    group by l.entry_type, l.direction, l.currency_code
    order by l.entry_type, l.direction, l.currency_code;
  return query
    select 'payments'::text, s.state, null::text, count(pt.id)::bigint
    from unnest(array[
      'pending_authorization', 'authorized', 'failed', 'cancelled', 'release_pending', 'authorization_released',
      'capture_pending', 'captured', 'capture_failed', 'refund_pending', 'partially_refunded', 'fully_refunded',
      'charged_back'
    ]) with ordinality as s(state, n)
    left join public.payment_transactions as pt
      on pt.state = s.state
     and pt.created_at >= p_from
     and pt.created_at < p_until
     and (p_jurisdiction_id is null or pt.jurisdiction_id = p_jurisdiction_id)
    group by s.state, s.n
    order by s.n;
  return query
    select 'refunds'::text, 'posted'::text, null::text, count(distinct l.source_reference)::bigint
    from public.ledger_entries as l
    join public.payment_transactions as pt on pt.id = l.payment_transaction_id
    where l.reason_code = 'payment_refunded'
      and l.effective_at >= p_from
      and l.effective_at < p_until
      and (p_jurisdiction_id is null or pt.jurisdiction_id = p_jurisdiction_id);
  return query
    select 'disputes'::text, 'opened'::text, null::text, count(e.id)::bigint
    from public.reconciliation_exceptions as e
    join public.payment_transactions as pt on pt.id = e.canonical_id
    where e.exception_type = 'dispute_opened'
      and e.canonical_type = 'payment_transaction'
      and e.detected_at >= p_from
      and e.detected_at < p_until
      and (p_jurisdiction_id is null or pt.jurisdiction_id = p_jurisdiction_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Jurisdiction names.
-- ---------------------------------------------------------------------------

create function public.staff_jurisdiction_names()
returns table (jurisdiction_id uuid, code text, name text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select j.id, j.code, j.name
  from public.jurisdictions as j
  where public.current_session_aal2() is true
    and exists (
      select 1
      from public.users as u
      join public.staff_profiles as s on s.user_id = u.id
      join public.capability_grants as g on g.user_id = u.id
      where u.auth_user_id = auth.uid()
        and u.account_state = 'active'
        and s.staff_state = 'active'
        and g.granted_at <= statement_timestamp()
        and g.revoked_at is null
        and (g.expires_at is null or g.expires_at > statement_timestamp())
        and g.resource_scope is null
    )
  order by j.code
  limit 500;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.staff_referrals(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_referrals(integer) to authenticated;
revoke all on function public.staff_referral_counts()
  from public, anon, authenticated, service_role;
grant execute on function public.staff_referral_counts() to authenticated;
revoke all on function public.staff_finance_summary(timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_finance_summary(timestamptz, timestamptz, uuid) to authenticated;

revoke all on function public.staff_jurisdiction_names()
  from public, anon, authenticated, service_role;
grant execute on function public.staff_jurisdiction_names() to authenticated;

comment on function public.staff_jurisdiction_names() is
  'MVP-001 S11 staff surfaces: the id, code and name of every jurisdiction (at most 500, by code) for staff holding any current capability grant with an active User and Staff Profile (aal2); reference data only.';
comment on function public.staff_referrals(integer) is
  'MVP-001 S11 referral operations: one page (25 rows, plus one) of Referrals newest first (jurisdiction, attempt ordinal, allocation method and time, outcome when recorded, the linked Request and Consultation ids and states) for staff holding view_referral_operations covering the Referral''s jurisdiction (aal2); no Intake content, client identity or attorney snapshots.';
comment on function public.staff_referral_counts() is
  'MVP-001 S11 referral operations: counts of open Referrals, Referrals ended without a Request and Referrals whose Request expired or was declined, over the Referrals the caller covers with view_referral_operations (aal2).';
comment on function public.staff_finance_summary(timestamptz, timestamptz, uuid) is
  'MVP-001 S11 financial activity summary: for one period of at most 366 days and optionally one jurisdiction, ledger totals by entry type, direction and currency, payments created by current state, refunds posted and disputes opened, for staff holding the global manage_financial_operations grant (aal2). Read-only, from the append-only ledger.';
