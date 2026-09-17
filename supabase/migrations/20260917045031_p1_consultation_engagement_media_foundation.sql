-- P1-008 local candidate. Unreviewed and unapplied.
-- Physical 1H Consultation / Engagement / Media foundation only.
--
-- G-1 remains unresolved: this migration represents Engagement effectiveness
-- but does not decide the business/legal event that makes it effective.
--
-- G-5 remains unresolved: an accepted Consultation Request is a prerequisite
-- for Consultation persistence here, but this migration does not decide whether
-- acceptance alone is sufficient or whether engagement/payment conditions are
-- additionally required.
--
-- Provider/media observations remain evidence only and cannot independently
-- complete a Consultation, establish/terminate Engagement, earn a fee, or
-- determine a refund.
--
-- Persisted session_participation_records are append-only at the ordinary
-- application database-permission layer. service_role receives SELECT/INSERT
-- only. INSERT does not define the business/legal finalization event.
-- Corrections/additional observations are represented by new evidence rows.
--
-- P1-007 historical migration bytes remain untouched. The previously deferred
-- bookings.consultation_id -> consultations.id foreign key is added forward-only.

create table public.consultations (
  id uuid primary key default gen_random_uuid(),
  consultation_request_id uuid not null,
  client_id uuid not null,
  attorney_id uuid not null,
  request_path text not null,
  referral_policy_version_id uuid not null,
  fee_policy_version_id uuid,
  engagement_policy_version_id uuid,
  cancellation_policy_version_id uuid,
  modality text not null,
  state text not null,
  started_at timestamptz,
  ended_at timestamptz,
  outcome_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint consultations_consultation_request_id_key
    unique (consultation_request_id),
  constraint consultations_consultation_request_id_fkey
    foreign key (consultation_request_id)
    references public.consultation_requests (id)
    on update restrict
    on delete restrict,
  constraint consultations_client_id_fkey
    foreign key (client_id)
    references public.client_profiles (id)
    on update restrict
    on delete restrict,
  constraint consultations_attorney_id_fkey
    foreign key (attorney_id)
    references public.attorney_profiles (id)
    on update restrict
    on delete restrict,
  constraint consultations_referral_policy_version_id_fkey
    foreign key (referral_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint consultations_fee_policy_version_id_fkey
    foreign key (fee_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint consultations_engagement_policy_version_id_fkey
    foreign key (engagement_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint consultations_cancellation_policy_version_id_fkey
    foreign key (cancellation_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint consultations_request_path_check
    check (request_path in ('instant', 'scheduled')),
  constraint consultations_modality_check
    check (btrim(modality) <> ''),
  constraint consultations_state_check
    check (btrim(state) <> ''),
  constraint consultations_time_order_check
    check (
      started_at is null
      or ended_at is null
      or ended_at >= started_at
    )
);

alter table public.consultations enable row level security;

create table public.engagements (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null,
  engagement_policy_version_id uuid not null,
  version_number integer not null,
  supersedes_engagement_id uuid,
  effective_at timestamptz,
  ended_at timestamptz,
  state text not null,
  terms_reference text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint engagements_consultation_version_key
    unique (consultation_id, version_number),
  constraint engagements_supersession_identity_key
    unique (id, consultation_id),
  constraint engagements_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint engagements_engagement_policy_version_id_fkey
    foreign key (engagement_policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint engagements_supersedes_engagement_id_fkey
    foreign key (
      supersedes_engagement_id,
      consultation_id
    )
    references public.engagements (
      id,
      consultation_id
    )
    on update restrict
    on delete restrict,
  constraint engagements_version_number_check
    check (version_number > 0),
  constraint engagements_not_self_superseding_check
    check (
      supersedes_engagement_id is null
      or supersedes_engagement_id <> id
    ),
  constraint engagements_state_check
    check (btrim(state) <> ''),
  constraint engagements_effective_period_check
    check (
      effective_at is null
      or ended_at is null
      or ended_at >= effective_at
    )
);

alter table public.engagements enable row level security;

create table public.media_rooms (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null,
  modality text not null,
  state text not null,
  created_at timestamptz not null default statement_timestamp(),
  ended_at timestamptz,
  constraint media_rooms_consultation_id_key
    unique (consultation_id),
  constraint media_rooms_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint media_rooms_modality_check
    check (btrim(modality) <> ''),
  constraint media_rooms_state_check
    check (btrim(state) <> '')
);

alter table public.media_rooms enable row level security;

create table public.media_sessions (
  id uuid primary key default gen_random_uuid(),
  media_room_id uuid not null,
  provider_code text not null,
  provider_session_reference text not null,
  started_at timestamptz,
  ended_at timestamptz,
  provider_state text,
  created_at timestamptz not null default statement_timestamp(),
  constraint media_sessions_provider_reference_key
    unique (provider_code, provider_session_reference),
  constraint media_sessions_media_room_id_fkey
    foreign key (media_room_id)
    references public.media_rooms (id)
    on update restrict
    on delete restrict,
  constraint media_sessions_provider_code_check
    check (btrim(provider_code) <> ''),
  constraint media_sessions_provider_session_reference_check
    check (btrim(provider_session_reference) <> ''),
  constraint media_sessions_provider_state_check
    check (
      provider_state is null
      or btrim(provider_state) <> ''
    ),
  constraint media_sessions_time_order_check
    check (
      started_at is null
      or ended_at is null
      or ended_at >= started_at
    )
);

alter table public.media_sessions enable row level security;

create table public.session_participation_records (
  id uuid primary key default gen_random_uuid(),
  media_session_id uuid not null,
  participant_user_id uuid not null,
  joined_at timestamptz,
  left_at timestamptz,
  observed_participation jsonb,
  provider_observation_reference text,
  created_at timestamptz not null default statement_timestamp(),
  constraint session_participation_records_media_session_id_fkey
    foreign key (media_session_id)
    references public.media_sessions (id)
    on update restrict
    on delete restrict,
  constraint session_participation_records_participant_user_id_fkey
    foreign key (participant_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint session_participation_records_time_order_check
    check (
      joined_at is null
      or left_at is null
      or left_at >= joined_at
    ),
  constraint session_participation_records_provider_observation_reference_check
    check (
      provider_observation_reference is null
      or btrim(provider_observation_reference) <> ''
    )
);

alter table public.session_participation_records enable row level security;

alter table public.bookings
  add constraint bookings_consultation_id_fkey
  foreign key (consultation_id)
  references public.consultations (id)
  on update restrict
  on delete restrict;

create function public.enforce_consultation_relationships()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  request_client_id uuid;
  request_attorney_id uuid;
  request_path_value text;
  request_referral_policy_version_id uuid;
  request_state_value text;
  consultation_client_user_id uuid;
  consultation_attorney_user_id uuid;
begin
  if tg_op = 'UPDATE'
     and (
       new.consultation_request_id is distinct from old.consultation_request_id
       or new.client_id is distinct from old.client_id
       or new.attorney_id is distinct from old.attorney_id
       or new.request_path is distinct from old.request_path
       or new.referral_policy_version_id
          is distinct from old.referral_policy_version_id
     ) then
    raise exception
      'consultation request/client/attorney/path/referral-policy provenance is immutable'
      using errcode = '23514';
  end if;

  select
    r.client_id,
    r.selected_attorney_id,
    r.request_path,
    r.referral_policy_version_id,
    r.state
  into
    request_client_id,
    request_attorney_id,
    request_path_value,
    request_referral_policy_version_id,
    request_state_value
  from public.consultation_requests as r
  where r.id = new.consultation_request_id;

  if not found then
    raise exception
      'consultation request does not exist'
      using errcode = '23503';
  end if;

  if request_client_id <> new.client_id then
    raise exception
      'consultation client does not match consultation request client'
      using errcode = '23514';
  end if;

  if request_attorney_id <> new.attorney_id then
    raise exception
      'consultation attorney does not match consultation request selected attorney'
      using errcode = '23514';
  end if;

  if request_path_value <> new.request_path then
    raise exception
      'consultation request_path does not match consultation request snapshot'
      using errcode = '23514';
  end if;

  if request_referral_policy_version_id <> new.referral_policy_version_id then
    raise exception
      'consultation referral policy does not match consultation request policy'
      using errcode = '23514';
  end if;

  if request_state_value <> 'accepted' then
    raise exception
      'consultation requires an accepted consultation request'
      using errcode = '23514';
  end if;

  select
    client_profile.user_id,
    attorney_profile.user_id
  into
    consultation_client_user_id,
    consultation_attorney_user_id
  from public.client_profiles as client_profile
  cross join public.attorney_profiles as attorney_profile
  where client_profile.id = new.client_id
    and attorney_profile.id = new.attorney_id;

  if not found then
    raise exception
      'consultation participant profile relationship does not exist'
      using errcode = '23503';
  end if;

  if consultation_client_user_id = consultation_attorney_user_id then
    raise exception
      'a user cannot be both client and attorney for the same consultation'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_session_participant_relationship()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  consultation_client_user_id uuid;
  consultation_attorney_user_id uuid;
begin
  select
    client_profile.user_id,
    attorney_profile.user_id
  into
    consultation_client_user_id,
    consultation_attorney_user_id
  from public.media_sessions as media_session
  join public.media_rooms as media_room
    on media_room.id = media_session.media_room_id
  join public.consultations as consultation
    on consultation.id = media_room.consultation_id
  join public.client_profiles as client_profile
    on client_profile.id = consultation.client_id
  join public.attorney_profiles as attorney_profile
    on attorney_profile.id = consultation.attorney_id
  where media_session.id = new.media_session_id;

  if not found then
    raise exception
      'media session consultation relationship does not exist'
      using errcode = '23503';
  end if;

  if new.participant_user_id <> consultation_client_user_id
     and new.participant_user_id <> consultation_attorney_user_id then
    raise exception
      'session participant is not a consultation participant'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_consultation_relationships()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_consultation_relationships()
  to postgres, service_role;

revoke all on function public.enforce_session_participant_relationship()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_session_participant_relationship()
  to postgres, service_role;

create trigger consultations_relationship_consistency
before insert or update of
  consultation_request_id,
  client_id,
  attorney_id,
  request_path,
  referral_policy_version_id
on public.consultations
for each row
execute function public.enforce_consultation_relationships();

create trigger session_participation_records_participant_consistency
before insert
on public.session_participation_records
for each row
execute function public.enforce_session_participant_relationship();

create trigger consultations_set_updated_at
before update on public.consultations
for each row
execute function public.set_updated_at();

create trigger engagements_set_updated_at
before update on public.engagements
for each row
execute function public.set_updated_at();

create index consultations_attorney_state_started_at_idx
  on public.consultations (
    attorney_id,
    state,
    started_at
  );

create index consultations_client_state_started_at_idx
  on public.consultations (
    client_id,
    state,
    started_at
  );

create unique index engagements_one_current_effective_per_consultation_idx
  on public.engagements (consultation_id)
  where effective_at is not null
    and ended_at is null;

revoke all on table public.consultations
  from public, anon, authenticated, service_role;
grant select on table public.consultations to authenticated;
grant select, insert
  on table public.consultations
  to service_role;
grant update (
  state,
  started_at,
  ended_at,
  outcome_code
) on table public.consultations
  to service_role;

revoke all on table public.engagements
  from public, anon, authenticated, service_role;
grant select on table public.engagements to authenticated;
grant select, insert
  on table public.engagements
  to service_role;
grant update (
  state,
  effective_at,
  ended_at
) on table public.engagements
  to service_role;

revoke all on table public.media_rooms
  from public, anon, authenticated, service_role;
grant select on table public.media_rooms to authenticated;
grant select, insert
  on table public.media_rooms
  to service_role;
grant update (
  state,
  ended_at
) on table public.media_rooms
  to service_role;

revoke all on table public.media_sessions
  from public, anon, authenticated, service_role;
grant select on table public.media_sessions to authenticated;
grant select, insert
  on table public.media_sessions
  to service_role;
grant update (
  started_at,
  ended_at,
  provider_state
) on table public.media_sessions
  to service_role;

revoke all on table public.session_participation_records
  from public, anon, authenticated, service_role;
grant select on table public.session_participation_records to authenticated;
grant select, insert
  on table public.session_participation_records
  to service_role;

create policy consultations_select_participants
on public.consultations
for select
to authenticated
using (
  exists (
    select 1
    from public.client_profiles as client_profile
    join public.users as app_user
      on app_user.id = client_profile.user_id
    where client_profile.id = consultations.client_id
      and app_user.auth_user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.attorney_profiles as attorney_profile
    join public.users as app_user
      on app_user.id = attorney_profile.user_id
    where attorney_profile.id = consultations.attorney_id
      and app_user.auth_user_id = (select auth.uid())
  )
);

create policy engagements_select_consultation_participants
on public.engagements
for select
to authenticated
using (
  exists (
    select 1
    from public.consultations as consultation
    where consultation.id = engagements.consultation_id
      and (
        exists (
          select 1
          from public.client_profiles as client_profile
          join public.users as app_user
            on app_user.id = client_profile.user_id
          where client_profile.id = consultation.client_id
            and app_user.auth_user_id = (select auth.uid())
        )
        or exists (
          select 1
          from public.attorney_profiles as attorney_profile
          join public.users as app_user
            on app_user.id = attorney_profile.user_id
          where attorney_profile.id = consultation.attorney_id
            and app_user.auth_user_id = (select auth.uid())
        )
      )
  )
);

create policy media_rooms_select_consultation_participants
on public.media_rooms
for select
to authenticated
using (
  exists (
    select 1
    from public.consultations as consultation
    where consultation.id = media_rooms.consultation_id
      and (
        exists (
          select 1
          from public.client_profiles as client_profile
          join public.users as app_user
            on app_user.id = client_profile.user_id
          where client_profile.id = consultation.client_id
            and app_user.auth_user_id = (select auth.uid())
        )
        or exists (
          select 1
          from public.attorney_profiles as attorney_profile
          join public.users as app_user
            on app_user.id = attorney_profile.user_id
          where attorney_profile.id = consultation.attorney_id
            and app_user.auth_user_id = (select auth.uid())
        )
      )
  )
);

create policy media_sessions_select_consultation_participants
on public.media_sessions
for select
to authenticated
using (
  exists (
    select 1
    from public.media_rooms as media_room
    join public.consultations as consultation
      on consultation.id = media_room.consultation_id
    where media_room.id = media_sessions.media_room_id
      and (
        exists (
          select 1
          from public.client_profiles as client_profile
          join public.users as app_user
            on app_user.id = client_profile.user_id
          where client_profile.id = consultation.client_id
            and app_user.auth_user_id = (select auth.uid())
        )
        or exists (
          select 1
          from public.attorney_profiles as attorney_profile
          join public.users as app_user
            on app_user.id = attorney_profile.user_id
          where attorney_profile.id = consultation.attorney_id
            and app_user.auth_user_id = (select auth.uid())
        )
      )
  )
);

create policy session_participation_records_select_consultation_participants
on public.session_participation_records
for select
to authenticated
using (
  exists (
    select 1
    from public.media_sessions as media_session
    join public.media_rooms as media_room
      on media_room.id = media_session.media_room_id
    join public.consultations as consultation
      on consultation.id = media_room.consultation_id
    where media_session.id =
      session_participation_records.media_session_id
      and (
        exists (
          select 1
          from public.client_profiles as client_profile
          join public.users as app_user
            on app_user.id = client_profile.user_id
          where client_profile.id = consultation.client_id
            and app_user.auth_user_id = (select auth.uid())
        )
        or exists (
          select 1
          from public.attorney_profiles as attorney_profile
          join public.users as app_user
            on app_user.id = attorney_profile.user_id
          where attorney_profile.id = consultation.attorney_id
            and app_user.auth_user_id = (select auth.uid())
        )
      )
  )
);

comment on table public.consultations is
  'Canonical legal-service event and Consultation state owner. Payment and provider/media observations do not determine Consultation state.';

comment on column public.consultations.request_path is
  'Immutable historical snapshot of the authoritative Consultation Request request_path. It may never diverge.';

comment on column public.consultations.attorney_id is
  'Actual Consultation attorney stored directly as canonical historical truth rather than inferred through a mutable Request.';

comment on table public.engagements is
  'Versioned Engagement context for one Consultation. G-1 determines when effectiveness occurs; this relation only represents that approved result.';

comment on column public.engagements.effective_at is
  'NULL until the Engagement becomes effective under the separately approved G-1 rule. This schema does not choose that rule.';

comment on table public.media_rooms is
  'One stable logical media context per Consultation. Provider session instances remain subordinate infrastructure observations.';

comment on table public.media_sessions is
  'Provider media-session correlation and infrastructure state. Provider state is not canonical Consultation state.';

comment on table public.session_participation_records is
  'Durable append-only participation evidence across provider sessions/reconnects at the ordinary application permission layer. INSERT does not define business/legal finalization. Corrections or additional observations create new evidence rows.';

comment on function public.enforce_consultation_relationships() is
  'Preserves Consultation Request/client/actual-attorney/path/referral-policy provenance, prevents self-consultation, and requires acceptance as a prerequisite without deciding the G-5 Consultation creation trigger.';

comment on function public.enforce_session_participant_relationship() is
  'Restricts durable participation evidence to the canonical Client or actual Attorney of the Consultation.';

comment on constraint bookings_consultation_id_fkey
  on public.bookings is
  'P1-008 forward-only completion of the P1-007 deferred Booking-to-Consultation relationship.';
