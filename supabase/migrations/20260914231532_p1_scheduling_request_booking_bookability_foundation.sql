-- P1-007 local candidate. Unreviewed and unapplied.
-- Physical 1G Scheduling / Request / Booking / Bookability foundation only.
--
-- The Booking -> Consultation foreign key is intentionally deferred.
-- Physical 1G requires bookings.consultation_id NOT NULL, while the
-- consultations relation belongs to Physical 1H. The user-approved bounded
-- interpretation preserves consultation_id now and adds the restrictive
-- foreign key forward-only when consultations is created.
--
-- This migration does not implement the later attorney-acceptance workflow,
-- Consultation creation, payment flow, scheduling UI, or runtime Presence
-- persistence.

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null,
  rule_kind text not null,
  timezone_name text not null,
  weekday smallint,
  specific_date date,
  local_start_time time not null,
  local_end_time time not null,
  effective_from date,
  effective_until date,
  active boolean not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint availability_rules_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint availability_rules_rule_kind_check
    check (rule_kind in ('recurring', 'one_time')),
  constraint availability_rules_timezone_name_check
    check (btrim(timezone_name) <> ''),
  constraint availability_rules_local_time_check
    check (local_start_time < local_end_time),
  constraint availability_rules_effective_period_check
    check (
      effective_until is null
      or (
        effective_from is not null
        and effective_until >= effective_from
      )
    ),
  constraint availability_rules_shape_check
    check (
      (
        rule_kind = 'recurring'
        and weekday is not null
        and specific_date is null
        and effective_from is not null
      )
      or
      (
        rule_kind = 'one_time'
        and weekday is null
        and specific_date is not null
        and effective_from is null
        and effective_until is null
      )
    )
);

alter table public.availability_rules enable row level security;

create table public.blackouts (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint blackouts_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint blackouts_time_range_check
    check (starts_at < ends_at)
);

alter table public.blackouts enable row level security;

create table public.consultation_requests (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null,
  client_id uuid not null,
  selected_attorney_id uuid not null,
  referral_id uuid not null,
  request_path text not null,
  referral_policy_version_id uuid not null,
  engagement_policy_version_id uuid,
  requested_modality text not null,
  state text not null,
  response_deadline_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  accepted_at timestamptz,
  declined_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  constraint consultation_requests_referral_id_key
    unique (referral_id),
  constraint consultation_requests_intake_id_fkey
    foreign key (intake_id)
    references public.intakes (id)
    on update restrict
    on delete restrict,
  constraint consultation_requests_client_id_fkey
    foreign key (client_id)
    references public.client_profiles (id)
    on update restrict
    on delete restrict,
  constraint consultation_requests_selected_attorney_id_fkey
    foreign key (selected_attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint consultation_requests_referral_id_fkey
    foreign key (referral_id)
    references public.referrals (id)
    on update restrict
    on delete restrict,
  constraint consultation_requests_referral_policy_version_id_fkey
    foreign key (referral_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint consultation_requests_engagement_policy_version_id_fkey
    foreign key (engagement_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint consultation_requests_request_path_check
    check (request_path in ('instant', 'scheduled')),
  constraint consultation_requests_requested_modality_check
    check (btrim(requested_modality) <> ''),
  constraint consultation_requests_state_check
    check (btrim(state) <> ''),
  constraint consultation_requests_response_deadline_check
    check (
      response_deadline_at is null
      or response_deadline_at > created_at
    ),
  constraint consultation_requests_terminal_timestamp_count_check
    check (
      num_nonnulls(
        accepted_at,
        declined_at,
        expired_at,
        cancelled_at
      ) <= 1
    ),
  constraint consultation_requests_accepted_timestamp_check
    check (
      (accepted_at is null or state = 'accepted')
      and (state <> 'accepted' or accepted_at is not null)
    ),
  constraint consultation_requests_declined_timestamp_check
    check (
      (declined_at is null or state = 'declined')
      and (state <> 'declined' or declined_at is not null)
    ),
  constraint consultation_requests_expired_timestamp_check
    check (
      (expired_at is null or state = 'expired')
      and (state <> 'expired' or expired_at is not null)
    ),
  constraint consultation_requests_cancelled_timestamp_check
    check (
      (cancelled_at is null or state = 'cancelled')
      and (state <> 'cancelled' or cancelled_at is not null)
    )
);

alter table public.consultation_requests enable row level security;

create table public.slot_holds (
  id uuid primary key default gen_random_uuid(),
  consultation_request_id uuid not null,
  attorney_id uuid not null,
  slot_start_at timestamptz not null,
  slot_end_at timestamptz not null,
  held_at timestamptz not null,
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default statement_timestamp(),
  constraint slot_holds_consultation_request_id_key
    unique (consultation_request_id),
  constraint slot_holds_consultation_request_id_fkey
    foreign key (consultation_request_id)
    references public.consultation_requests (id)
    on update restrict
    on delete restrict,
  constraint slot_holds_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint slot_holds_time_range_check
    check (slot_start_at < slot_end_at),
  constraint slot_holds_expiry_check
    check (expires_at > held_at),
  constraint slot_holds_release_time_check
    check (released_at is null or released_at >= held_at)
);

alter table public.slot_holds enable row level security;

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null,
  attorney_id uuid not null,
  client_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null,
  supersedes_booking_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  superseded_at timestamptz,
  cancelled_at timestamptz,
  constraint bookings_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint bookings_client_id_fkey
    foreign key (client_id)
    references public.client_profiles (id)
    on update restrict
    on delete restrict,
  constraint bookings_supersession_identity_key
    unique (id, consultation_id, attorney_id, client_id),
  constraint bookings_supersedes_booking_id_fkey
    foreign key (
      supersedes_booking_id,
      consultation_id,
      attorney_id,
      client_id
    )
    references public.bookings (
      id,
      consultation_id,
      attorney_id,
      client_id
    )
    on update restrict
    on delete restrict,
  constraint bookings_time_range_check
    check (starts_at < ends_at),
  constraint bookings_status_check
    check (
      status in (
        'confirmed',
        'superseded',
        'cancelled',
        'completed'
      )
    ),
  constraint bookings_not_self_superseding_check
    check (
      supersedes_booking_id is null
      or supersedes_booking_id <> id
    ),
  constraint bookings_superseded_at_check
    check (
      superseded_at is null
      or superseded_at >= created_at
    ),
  constraint bookings_cancelled_at_check
    check (
      cancelled_at is null
      or cancelled_at >= created_at
    ),
  constraint bookings_status_timestamp_check
    check (
      (
        status = 'confirmed'
        and superseded_at is null
        and cancelled_at is null
      )
      or
      (
        status = 'superseded'
        and superseded_at is not null
        and cancelled_at is null
      )
      or
      (
        status = 'cancelled'
        and cancelled_at is not null
        and superseded_at is null
      )
      or
      (
        status = 'completed'
        and superseded_at is null
        and cancelled_at is null
      )
    )
);

alter table public.bookings enable row level security;

create table public.instant_availability_intents (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null,
  application_session_id uuid not null,
  enabled_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  constraint instant_availability_intents_application_session_id_key
    unique (application_session_id),
  constraint instant_availability_intents_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint instant_availability_intents_application_session_id_fkey
    foreign key (application_session_id)
    references public.application_sessions (id)
    on update restrict
    on delete restrict,
  constraint instant_availability_intents_expiry_check
    check (expires_at > enabled_at),
  constraint instant_availability_intents_revoked_at_check
    check (revoked_at is null or revoked_at >= enabled_at)
);

alter table public.instant_availability_intents enable row level security;

create table public.bookability_evaluations (
  id uuid primary key default gen_random_uuid(),
  attorney_id uuid not null,
  eligibility_evaluation_id uuid not null,
  context_type text not null,
  context_id uuid,
  evaluated_at timestamptz not null,
  as_of timestamptz not null,
  modality text not null,
  presence_observed boolean,
  presence_trust_method text,
  instant_intent_observed boolean,
  slot_start_at timestamptz,
  slot_end_at timestamptz,
  availability_basis jsonb,
  constraint_results jsonb not null,
  result text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint bookability_evaluations_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint bookability_evaluations_eligibility_evaluation_id_fkey
    foreign key (eligibility_evaluation_id)
    references public.eligibility_evaluations (id)
    on update restrict
    on delete restrict,
  constraint bookability_evaluations_context_type_check
    check (btrim(context_type) <> ''),
  constraint bookability_evaluations_modality_check
    check (btrim(modality) <> ''),
  constraint bookability_evaluations_presence_trust_method_check
    check (
      presence_trust_method is null
      or btrim(presence_trust_method) <> ''
    ),
  constraint bookability_evaluations_slot_pair_check
    check (
      (slot_start_at is null) = (slot_end_at is null)
    ),
  constraint bookability_evaluations_slot_range_check
    check (
      slot_start_at is null
      or slot_start_at < slot_end_at
    ),
  constraint bookability_evaluations_result_check
    check (btrim(result) <> '')
);

alter table public.bookability_evaluations enable row level security;

create function public.enforce_consultation_request_relationships()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  referral_intake_id uuid;
  referral_attorney_id uuid;
  intake_client_id uuid;
begin
  select r.intake_id, r.attorney_id
  into referral_intake_id, referral_attorney_id
  from public.referrals as r
  where r.id = new.referral_id;

  if not found then
    raise exception
      'consultation request referral does not exist'
      using errcode = '23503';
  end if;

  if referral_intake_id <> new.intake_id then
    raise exception
      'consultation request intake does not match referral intake'
      using errcode = '23514';
  end if;

  if referral_attorney_id is null
     or referral_attorney_id <> new.selected_attorney_id then
    raise exception
      'consultation request attorney does not match referral attorney'
      using errcode = '23514';
  end if;

  select i.client_id
  into intake_client_id
  from public.intakes as i
  where i.id = new.intake_id;

  if not found then
    raise exception
      'consultation request intake does not exist'
      using errcode = '23503';
  end if;

  if intake_client_id <> new.client_id then
    raise exception
      'consultation request client does not match intake client'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_request_hold_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  request_id uuid;
  request_path_value text;
  request_state_value text;
  selected_attorney uuid;
  hold_attorney uuid;
  hold_active boolean;
  hold_exists boolean;
begin
  if tg_table_name = 'consultation_requests' then
    if tg_op = 'DELETE' then
      request_id := old.id;
    else
      request_id := new.id;
    end if;
  else
    if tg_op = 'DELETE' then
      request_id := old.consultation_request_id;
    else
      request_id := new.consultation_request_id;
    end if;
  end if;

  select
    r.request_path,
    r.state,
    r.selected_attorney_id
  into
    request_path_value,
    request_state_value,
    selected_attorney
  from public.consultation_requests as r
  where r.id = request_id;

  if not found then
    return null;
  end if;

  select
    h.attorney_id,
    (
      h.released_at is null
      and h.expires_at > pg_catalog.clock_timestamp()
    )
  into
    hold_attorney,
    hold_active
  from public.slot_holds as h
  where h.consultation_request_id = request_id;

  hold_exists := found;

  if request_path_value = 'scheduled' and not hold_exists then
    raise exception
      'scheduled consultation request requires exactly one slot hold'
      using errcode = '23514';
  end if;

  if request_path_value = 'scheduled'
     and request_state_value not in (
       'accepted',
       'declined',
       'expired',
       'cancelled'
     )
     and not coalesce(hold_active, false) then
    raise exception
      'nonterminal scheduled consultation request requires an active slot hold'
      using errcode = '23514';
  end if;

  if request_path_value = 'instant' and hold_exists then
    raise exception
      'instant consultation request cannot have a slot hold'
      using errcode = '23514';
  end if;

  if hold_exists and hold_attorney <> selected_attorney then
    raise exception
      'slot hold attorney does not match consultation request attorney'
      using errcode = '23514';
  end if;

  if request_state_value in (
    'accepted',
    'declined',
    'expired',
    'cancelled'
  )
  and coalesce(hold_active, false) then
    raise exception
      'terminal consultation request cannot retain an active slot hold'
      using errcode = '23514';
  end if;

  return null;
end;
$function$;

create function public.enforce_scheduling_conflicts()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if tg_table_name = 'slot_holds' then
    if new.released_at is not null
       or new.expires_at <= pg_catalog.clock_timestamp() then
      return new;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(new.attorney_id::text),
      7007
    );

    if exists (
      select 1
      from public.slot_holds as h
      where h.attorney_id = new.attorney_id
        and h.id <> new.id
        and h.released_at is null
        and h.expires_at > pg_catalog.clock_timestamp()
        and pg_catalog.tstzrange(
          h.slot_start_at,
          h.slot_end_at,
          '[)'
        ) && pg_catalog.tstzrange(
          new.slot_start_at,
          new.slot_end_at,
          '[)'
        )
    ) then
      raise exception
        'active slot hold conflicts with another active slot hold'
        using errcode = '23P01';
    end if;

    if exists (
      select 1
      from public.bookings as b
      where b.attorney_id = new.attorney_id
        and b.status = 'confirmed'
        and pg_catalog.tstzrange(
          b.starts_at,
          b.ends_at,
          '[)'
        ) && pg_catalog.tstzrange(
          new.slot_start_at,
          new.slot_end_at,
          '[)'
        )
    ) then
      raise exception
        'active slot hold conflicts with a confirmed booking'
        using errcode = '23P01';
    end if;

    return new;
  end if;

  if tg_table_name = 'bookings' then
    if new.status <> 'confirmed' then
      return new;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(new.attorney_id::text),
      7007
    );

    if exists (
      select 1
      from public.bookings as b
      where b.attorney_id = new.attorney_id
        and b.id <> new.id
        and b.status = 'confirmed'
        and pg_catalog.tstzrange(
          b.starts_at,
          b.ends_at,
          '[)'
        ) && pg_catalog.tstzrange(
          new.starts_at,
          new.ends_at,
          '[)'
        )
    ) then
      raise exception
        'confirmed booking conflicts with another confirmed booking'
        using errcode = '23P01';
    end if;

    if exists (
      select 1
      from public.slot_holds as h
      where h.attorney_id = new.attorney_id
        and h.released_at is null
        and h.expires_at > pg_catalog.clock_timestamp()
        and pg_catalog.tstzrange(
          h.slot_start_at,
          h.slot_end_at,
          '[)'
        ) && pg_catalog.tstzrange(
          new.starts_at,
          new.ends_at,
          '[)'
        )
    ) then
      raise exception
        'confirmed booking conflicts with an active slot hold'
        using errcode = '23P01';
    end if;

    return new;
  end if;

  raise exception
    'unsupported scheduling-conflict trigger source: %',
    tg_table_name;
end;
$function$;

create function public.enforce_instant_intent_session_binding()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  attorney_user_id uuid;
  session_user_id uuid;
  session_expires_at timestamptz;
  session_ended_at timestamptz;
  session_revoked_at timestamptz;
begin
  select a.user_id
  into attorney_user_id
  from public.attorney_profiles as a
  where a.id = new.attorney_id;

  if not found then
    raise exception
      'instant availability intent attorney does not exist'
      using errcode = '23503';
  end if;

  select
    s.user_id,
    s.expires_at,
    s.ended_at,
    s.revoked_at
  into
    session_user_id,
    session_expires_at,
    session_ended_at,
    session_revoked_at
  from public.application_sessions as s
  where s.id = new.application_session_id;

  if not found then
    raise exception
      'instant availability intent application session does not exist'
      using errcode = '23503';
  end if;

  if session_user_id <> attorney_user_id then
    raise exception
      'instant availability intent session does not belong to attorney user'
      using errcode = '23514';
  end if;

  if session_ended_at is not null
     or session_revoked_at is not null
     or session_expires_at <= pg_catalog.clock_timestamp() then
    raise exception
      'instant availability intent requires an active application session'
      using errcode = '23514';
  end if;

  if new.expires_at > session_expires_at then
    raise exception
      'instant availability intent cannot outlive application session'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_bookability_eligibility_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  eligibility_attorney_id uuid;
begin
  select e.attorney_id
  into eligibility_attorney_id
  from public.eligibility_evaluations as e
  where e.id = new.eligibility_evaluation_id;

  if not found then
    raise exception
      'bookability eligibility evaluation does not exist'
      using errcode = '23503';
  end if;

  if eligibility_attorney_id <> new.attorney_id then
    raise exception
      'bookability attorney does not match eligibility evaluation attorney'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_consultation_request_relationships()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_consultation_request_relationships()
  to postgres, service_role;

revoke all on function public.enforce_request_hold_consistency()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_request_hold_consistency()
  to postgres, service_role;

revoke all on function public.enforce_scheduling_conflicts()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_scheduling_conflicts()
  to postgres, service_role;

revoke all on function public.enforce_instant_intent_session_binding()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_instant_intent_session_binding()
  to postgres, service_role;

revoke all on function public.enforce_bookability_eligibility_consistency()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_bookability_eligibility_consistency()
  to postgres, service_role;

create trigger consultation_requests_relationship_consistency
before insert or update of
  intake_id,
  client_id,
  selected_attorney_id,
  referral_id
on public.consultation_requests
for each row
execute function public.enforce_consultation_request_relationships();

create constraint trigger consultation_requests_hold_consistency
after insert or update
on public.consultation_requests
deferrable initially deferred
for each row
execute function public.enforce_request_hold_consistency();

create constraint trigger slot_holds_request_consistency
after insert or update or delete
on public.slot_holds
deferrable initially deferred
for each row
execute function public.enforce_request_hold_consistency();

create trigger slot_holds_conflict_guard
before insert or update of
  attorney_id,
  slot_start_at,
  slot_end_at,
  expires_at,
  released_at
on public.slot_holds
for each row
execute function public.enforce_scheduling_conflicts();

create trigger bookings_conflict_guard
before insert or update of
  attorney_id,
  starts_at,
  ends_at,
  status
on public.bookings
for each row
execute function public.enforce_scheduling_conflicts();

create trigger instant_availability_intents_session_binding
before insert or update of
  attorney_id,
  application_session_id,
  enabled_at,
  expires_at
on public.instant_availability_intents
for each row
execute function public.enforce_instant_intent_session_binding();

create trigger bookability_evaluations_eligibility_consistency
before insert or update of
  attorney_id,
  eligibility_evaluation_id
on public.bookability_evaluations
for each row
execute function public.enforce_bookability_eligibility_consistency();

create trigger availability_rules_set_updated_at
before update on public.availability_rules
for each row
execute function public.set_updated_at();

create trigger blackouts_set_updated_at
before update on public.blackouts
for each row
execute function public.set_updated_at();

create index availability_rules_attorney_effective_idx
  on public.availability_rules (
    attorney_id,
    active,
    effective_from,
    effective_until
  );

create index blackouts_attorney_time_idx
  on public.blackouts (
    attorney_id,
    starts_at,
    ends_at
  );

create index blackouts_time_range_gist_idx
  on public.blackouts
  using gist (
    tstzrange(starts_at, ends_at, '[)')
  );

create index consultation_requests_intake_created_idx
  on public.consultation_requests (
    intake_id,
    created_at desc
  );

create index consultation_requests_attorney_state_idx
  on public.consultation_requests (
    selected_attorney_id,
    state
  );

create index slot_holds_attorney_time_idx
  on public.slot_holds (
    attorney_id,
    slot_start_at,
    slot_end_at
  )
  where released_at is null;

create index slot_holds_time_range_gist_idx
  on public.slot_holds
  using gist (
    tstzrange(slot_start_at, slot_end_at, '[)')
  );

create unique index bookings_one_confirmed_per_consultation_idx
  on public.bookings (consultation_id)
  where status = 'confirmed';

create index bookings_attorney_time_idx
  on public.bookings (
    attorney_id,
    starts_at,
    ends_at
  )
  where status = 'confirmed';

create index bookings_time_range_gist_idx
  on public.bookings
  using gist (
    tstzrange(starts_at, ends_at, '[)')
  );

revoke all on table public.availability_rules
  from public, anon, authenticated, service_role;
grant select on table public.availability_rules to authenticated;
grant select, insert, update
  on table public.availability_rules
  to service_role;

revoke all on table public.blackouts
  from public, anon, authenticated, service_role;
grant select on table public.blackouts to authenticated;
grant select, insert, update
  on table public.blackouts
  to service_role;

revoke all on table public.consultation_requests
  from public, anon, authenticated, service_role;
grant select on table public.consultation_requests to authenticated;
grant select, insert
  on table public.consultation_requests
  to service_role;
grant update (
  state,
  response_deadline_at,
  accepted_at,
  declined_at,
  expired_at,
  cancelled_at
) on table public.consultation_requests
  to service_role;

revoke all on table public.slot_holds
  from public, anon, authenticated, service_role;
grant select, insert
  on table public.slot_holds
  to service_role;
grant update (
  expires_at,
  released_at,
  release_reason
) on table public.slot_holds
  to service_role;

revoke all on table public.bookings
  from public, anon, authenticated, service_role;
grant select on table public.bookings to service_role;

revoke all on table public.instant_availability_intents
  from public, anon, authenticated, service_role;
grant select on table public.instant_availability_intents to authenticated;
grant select, insert
  on table public.instant_availability_intents
  to service_role;
grant update (
  enabled_at,
  expires_at,
  revoked_at
) on table public.instant_availability_intents
  to service_role;

revoke all on table public.bookability_evaluations
  from public, anon, authenticated, service_role;
grant select, insert
  on table public.bookability_evaluations
  to service_role;

create policy availability_rules_select_own
on public.availability_rules
for select
to authenticated
using (
  exists (
    select 1
    from public.attorney_profiles as a
    join public.users as u
      on u.id = a.user_id
    where a.id = availability_rules.attorney_id
      and u.auth_user_id = (select auth.uid())
  )
);

create policy blackouts_select_own
on public.blackouts
for select
to authenticated
using (
  exists (
    select 1
    from public.attorney_profiles as a
    join public.users as u
      on u.id = a.user_id
    where a.id = blackouts.attorney_id
      and u.auth_user_id = (select auth.uid())
  )
);

create policy consultation_requests_select_own_client
on public.consultation_requests
for select
to authenticated
using (
  exists (
    select 1
    from public.client_profiles as c
    join public.users as u
      on u.id = c.user_id
    where c.id = consultation_requests.client_id
      and u.auth_user_id = (select auth.uid())
  )
);

create policy instant_availability_intents_select_own
on public.instant_availability_intents
for select
to authenticated
using (
  exists (
    select 1
    from public.attorney_profiles as a
    join public.users as u
      on u.id = a.user_id
    where a.id = instant_availability_intents.attorney_id
      and u.auth_user_id = (select auth.uid())
  )
);

comment on table public.availability_rules is
  'Attorney-declared scheduled availability. Recurring and one-time rules preserve the attorney local timezone context.';

comment on table public.blackouts is
  'Attorney scheduling blackout ranges. Blackout remains semantically distinct from declared Availability.';

comment on table public.consultation_requests is
  'One client attempt to obtain one consultation from one selected attorney. Request lifecycle is independent from Referral, payment, and Consultation state.';

comment on table public.slot_holds is
  'Server-authoritative scheduled reservation hold. Scheduled Request and Hold consistency is enforced at the transaction boundary.';

comment on table public.bookings is
  'Committed scheduled-reservation history substrate. Application Booking creation remains fail-closed in P1-007 until the later authorized acceptance/Consultation boundary exists.';

comment on column public.bookings.consultation_id is
  'Required future Consultation identity. P1-007 intentionally has no FK because public.consultations belongs to Physical 1H; the restrictive FK is added forward-only there.';

comment on table public.instant_availability_intents is
  'Session-bound attorney instant-request intent. Current validity also depends on the authoritative application-session lifecycle.';

comment on table public.bookability_evaluations is
  'Immutable point-in-time Bookability decision evidence. Current bookability remains derived and this record never replaces Eligibility truth.';

comment on function public.enforce_consultation_request_relationships() is
  'Prevents Request client/intake/referral/selected-attorney identities from silently diverging.';

comment on function public.enforce_request_hold_consistency() is
  'Deferred transaction-boundary guard: scheduled Requests require their Hold, instant Requests cannot have one, and terminal Requests cannot retain an active Hold.';

comment on function public.enforce_scheduling_conflicts() is
  'Serializes scheduling writes per attorney and rejects overlapping active Holds, confirmed Bookings, and Hold-versus-Booking conflicts.';

comment on function public.enforce_instant_intent_session_binding() is
  'Ensures Instant Availability Intent belongs to the attorney authenticated-session owner and cannot outlive that server-observable session.';

comment on function public.enforce_bookability_eligibility_consistency() is
  'Ensures a Bookability Evaluation references an Eligibility Evaluation for the same attorney.';
