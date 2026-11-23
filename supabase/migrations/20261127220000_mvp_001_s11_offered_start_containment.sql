-- MVP-001 S11 correction (offered slot starts): a listed start that request creation refuses, corrected forward
-- (MVP-001 Packet section 2 rule 4; MBS sections 12 and 16; TA sections 40 and 41; PS section 25). Every committed
-- migration stays unchanged; one function is replaced with its signature, return type, volatility, security mode,
-- owner and privileges, and its body unchanged except for the one filter named below.
--
-- What was wrong. request_slot_starts (20261122020000) generates the half-hour grid starts across the windows of
-- scheduling_offered_windows (20261121020000), which merges touching and overlapping rule windows into one range.
-- Request creation checks the slot with scheduling_slot_problem (20261120030000), which requires one single window of
-- scheduling_expand_availability (20261120020000) to start at or before the slot start and end at or after the slot
-- end. A start whose duration spans two adjacent rule windows (rules 09:00-12:00 and 12:00-17:00 offer 11:30 for 60
-- minutes; a day ending at 24:00 and the next day starting at 00:00 offer a start across midnight) was therefore
-- listed and then refused as not available (outside_availability). The S6 header promised that every listed start
-- fits inside one window.
--
-- The correction. A candidate start is kept only when one window of scheduling_expand_availability for the
-- attorney contains the whole slot (window_start <= start and window_end >= start + duration), exactly as
-- scheduling_slot_problem tests it. The windows are expanded once per call over the local dates the offered horizon
-- covers (the same date bounds scheduling_offered_windows uses: the UTC date of now minus one day to the UTC date of
-- now plus 14 days plus one day, from a clock reading taken before the offered windows are read). A start is only
-- ever removed, never added: the grid, the bound of 20, the order, the notice, Blackouts, Holds and confirmed Bookings
-- stay as before. The extra join raises the planner's estimate above the JIT threshold although the work stays
-- small, so the function sets jit = off for its own execution.
--
-- Unchanged: the bookability rule (scheduling_slot_problem), the point-in-time evidence and its shape, the S8
-- decision check, the discovery display (scheduling_offered_windows and its callers) and every other function.
-- No relation, column, policy type, policy, grant or seed is added or changed.

create or replace function public.request_slot_starts(
  p_referral_id uuid,
  p_modality text,
  p_duration_minutes integer
)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set jit = off
as $function$
#variable_conflict use_column
declare
  v_referral record;
  v_length interval;
  v_now timestamptz;
  v_to timestamptz;
begin
  if p_referral_id is null
     or p_modality is null
     or p_modality !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_duration_minutes is null
     or p_duration_minutes not between 1 and 1440 then
    return;
  end if;
  select f.* into v_referral from public.request_client_referral(p_referral_id) as f;
  if not found or not v_referral.requestable or v_referral.request_path is distinct from 'scheduled' then
    return;
  end if;
  if (
    select q.outcome
    from public.pricing_quote(
      v_referral.attorney_id, v_referral.jurisdiction_id, p_modality, p_duration_minutes, clock_timestamp()
    ) as q
  ) is distinct from 'priced' then
    return;
  end if;
  v_length := make_interval(mins => p_duration_minutes);
  v_now := clock_timestamp();
  v_to := v_now + interval '14 days';
  return query
  with rule_windows as materialized (
    select w.window_start, w.window_end
    from public.scheduling_expand_availability(
      v_referral.attorney_id,
      (v_now at time zone 'UTC')::date - 1,
      (v_to at time zone 'UTC')::date + 1
    ) as w
  )
  select s.start_at, s.start_at + v_length
  from (
    select g as start_at
    from public.scheduling_offered_windows(v_referral.attorney_id, v_referral.jurisdiction_id, 20) as w
    cross join lateral generate_series(
      to_timestamp((ceil(extract(epoch from w.window_start) / 1800) * 1800)::double precision),
      w.window_end - v_length,
      interval '30 minutes'
    ) as g
  ) as s
  where exists (
    select 1
    from rule_windows as r
    where r.window_start <= s.start_at
      and r.window_end >= s.start_at + v_length
  )
  order by s.start_at
  limit 20;
end;
$function$;
