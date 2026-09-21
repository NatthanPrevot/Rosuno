-- P1-011 local candidate. Unreviewed and unapplied.
-- Physical 1K Compliance foundation only.
--
-- Exact retention periods, Legal Hold circumstances, complaint-routing language,
-- complaint/state/category vocabularies, and DOC-DEL deletion semantics remain
-- counsel/policy-gated or unresolved. This migration does not invent them.
--
-- No Payout behavior, Review relation, California 1L regulatory-mode object,
-- deletion/purge executor, production configuration, or later-phase object is
-- introduced.

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  actor_type text not null,
  action_code text not null,
  resource_type text not null,
  resource_id uuid,
  before_snapshot jsonb,
  after_snapshot jsonb,
  reason_code text,
  policy_references jsonb,
  jurisdiction_id uuid,
  occurred_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint audit_events_actor_user_id_fkey
    foreign key (actor_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint audit_events_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint audit_events_actor_type_check
    check (btrim(actor_type) <> ''),
  constraint audit_events_action_code_check
    check (btrim(action_code) <> ''),
  constraint audit_events_resource_type_check
    check (btrim(resource_type) <> ''),
  constraint audit_events_reason_code_check
    check (reason_code is null or btrim(reason_code) <> '')
);

alter table public.audit_events enable row level security;

create table public.retention_rules (
  id uuid primary key default gen_random_uuid(),
  record_class text not null,
  jurisdiction_id uuid,
  policy_version_id uuid not null,
  retention_parameters jsonb not null,
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint retention_rules_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint retention_rules_policy_version_id_fkey
    foreign key (policy_version_id)
    references public.policy_versions (id)
    on update restrict
    on delete restrict,
  constraint retention_rules_record_class_check
    check (btrim(record_class) <> ''),
  constraint retention_rules_parameters_check
    check (jsonb_typeof(retention_parameters) = 'object'),
  constraint retention_rules_effective_period_check
    check (effective_until is null or effective_until > effective_from),
  constraint retention_rules_status_check
    check (btrim(status) <> '')
);

alter table public.retention_rules enable row level security;

create table public.legal_holds (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null,
  scope_id uuid not null,
  status text not null,
  reason text not null,
  started_at timestamptz not null,
  released_at timestamptz,
  created_by_user_id uuid not null,
  released_by_user_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  constraint legal_holds_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint legal_holds_released_by_user_id_fkey
    foreign key (released_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint legal_holds_scope_type_check
    check (btrim(scope_type) <> ''),
  constraint legal_holds_status_check
    check (btrim(status) <> ''),
  constraint legal_holds_reason_check
    check (btrim(reason) <> ''),
  constraint legal_holds_release_pair_check
    check ((released_at is null) = (released_by_user_id is null)),
  constraint legal_holds_release_time_check
    check (released_at is null or released_at >= started_at)
);

alter table public.legal_holds enable row level security;

create table public.complaint_cases (
  id uuid primary key default gen_random_uuid(),
  complainant_user_id uuid not null,
  consultation_id uuid,
  referral_id uuid,
  jurisdiction_id uuid,
  state text not null,
  category_code text,
  opened_at timestamptz not null,
  resolved_at timestamptz,
  assigned_to_user_id uuid,
  resolution_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint complaint_cases_complainant_user_id_fkey
    foreign key (complainant_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint complaint_cases_consultation_id_fkey
    foreign key (consultation_id)
    references public.consultations (id)
    on update restrict
    on delete restrict,
  constraint complaint_cases_referral_id_fkey
    foreign key (referral_id)
    references public.referrals (id)
    on update restrict
    on delete restrict,
  constraint complaint_cases_jurisdiction_id_fkey
    foreign key (jurisdiction_id)
    references public.jurisdictions (id)
    on update restrict
    on delete restrict,
  constraint complaint_cases_assigned_to_user_id_fkey
    foreign key (assigned_to_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint complaint_cases_state_check
    check (btrim(state) <> ''),
  constraint complaint_cases_category_code_check
    check (category_code is null or btrim(category_code) <> ''),
  constraint complaint_cases_resolution_code_check
    check (resolution_code is null or btrim(resolution_code) <> ''),
  constraint complaint_cases_resolution_time_check
    check (resolved_at is null or resolved_at >= opened_at)
);

alter table public.complaint_cases enable row level security;

create function public.prevent_audit_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  raise exception
    'Audit Event is append-only; correction requires new evidence'
    using errcode = '23514';
end;
$function$;

create function public.enforce_retention_rule_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  policy_type text;
  policy_jurisdiction_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (
      new.record_class is distinct from old.record_class
      or new.jurisdiction_id is distinct from old.jurisdiction_id
      or new.policy_version_id is distinct from old.policy_version_id
      or new.retention_parameters is distinct from old.retention_parameters
      or new.effective_from is distinct from old.effective_from
      or new.created_at is distinct from old.created_at
    ) then
      raise exception
        'Retention Rule provenance is immutable; create a new versioned rule'
        using errcode = '23514';
    end if;
  end if;

  select pv.policy_type_code, pv.jurisdiction_id
  into policy_type, policy_jurisdiction_id
  from public.policy_versions as pv
  where pv.id = new.policy_version_id;

  if not found then
    raise exception
      'Retention Rule Policy Version does not exist'
      using errcode = '23503';
  end if;

  if policy_type <> 'retention' then
    raise exception
      'Retention Rule policy_version_id must reference policy type retention'
      using errcode = '23514';
  end if;

  if policy_jurisdiction_id is not null
     and new.jurisdiction_id is distinct from policy_jurisdiction_id then
    raise exception
      'Retention Rule jurisdiction contradicts its Policy Version scope'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create function public.enforce_legal_hold_integrity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if tg_op = 'UPDATE' and (
    new.scope_type is distinct from old.scope_type
    or new.scope_id is distinct from old.scope_id
    or new.reason is distinct from old.reason
    or new.started_at is distinct from old.started_at
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception
      'Legal Hold scope/origin is immutable; release does not rewrite provenance'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.prevent_audit_event_mutation()
  from public, anon, authenticated, service_role;
grant execute on function public.prevent_audit_event_mutation()
  to service_role;

revoke all on function public.enforce_retention_rule_integrity()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_retention_rule_integrity()
  to service_role;

revoke all on function public.enforce_legal_hold_integrity()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_legal_hold_integrity()
  to service_role;

create trigger audit_events_immutable
before update or delete on public.audit_events
for each row
execute function public.prevent_audit_event_mutation();

create trigger retention_rules_integrity
before insert or update on public.retention_rules
for each row
execute function public.enforce_retention_rule_integrity();

create trigger legal_holds_integrity
before insert or update on public.legal_holds
for each row
execute function public.enforce_legal_hold_integrity();

create trigger complaint_cases_set_updated_at
before update on public.complaint_cases
for each row
execute function public.set_updated_at();

create index audit_events_resource_idx
  on public.audit_events (resource_type, resource_id, occurred_at);

create index legal_holds_scope_idx
  on public.legal_holds (scope_type, scope_id, status);

revoke all on table public.audit_events
  from public, anon, authenticated, service_role;
grant select, insert on table public.audit_events to service_role;

revoke all on table public.retention_rules
  from public, anon, authenticated, service_role;
grant select, insert on table public.retention_rules to service_role;
grant update (
  status,
  effective_until
) on table public.retention_rules to service_role;

revoke all on table public.legal_holds
  from public, anon, authenticated, service_role;
grant select, insert on table public.legal_holds to service_role;
grant update (
  status,
  released_at,
  released_by_user_id
) on table public.legal_holds to service_role;

revoke all on table public.complaint_cases
  from public, anon, authenticated, service_role;
grant select, insert on table public.complaint_cases to service_role;
grant update (
  state,
  category_code,
  resolved_at,
  assigned_to_user_id,
  resolution_code
) on table public.complaint_cases to service_role;

comment on table public.audit_events is
  'Append-only server-controlled audit history. It is evidence, not current-state storage, and ordinary end users cannot author authoritative audit metadata.';

comment on table public.retention_rules is
  'Versioned/effective-dated retention policy application. Exact retention periods remain counsel/policy-driven and are not hard-coded by Physical 1K.';

comment on table public.legal_holds is
  'Scoped Legal Hold history. An active hold constrains allowable disposition but does not change underlying business state; DOC-DEL remains unresolved.';

comment on table public.complaint_cases is
  'Restricted complaint foundation. State/category/routing/resolution vocabularies remain policy/counsel-controlled rather than hard-coded by Physical 1K.';
