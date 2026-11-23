-- MVP-001 S11 pass 2 (12 of 16): client administration (MVP-001 Packet S11 "operations dashboard"; MBS sections 16
-- "Operations" and 18.4 "clients"; TA sections 18 "client operations: account support, intake status, consultation
-- history metadata, complaints, privacy requests", 40 and 41; DM section 3; MB sections 81 to 90 "client admin:
-- account status, support, without exposing consultation contents"; PS section 30.4; PM section 1 INV-11 and row
-- 46).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16). Privacy and data requests are not
-- part of this surface: they need the pending amendment PS-A6, which is not adopted.
--
-- A client is a User holding a Client Profile and no Staff Profile (staff accounts are administered through staff
-- capabilities, never through this surface; a fail-closed bound, an owner-confirmable choice). Everything below needs
-- the global manage_client_accounts grant at aal2 (TA section 41: a client's account spans every jurisdiction).
--
-- Reads (EXECUTE for authenticated only; stable security definer; search_path pinned): account metadata only, never
-- Intake content, a message, a document, a payment detail, an address or a review:
-- - staff_clients: one page (25 rows, plus one) of clients, newest first, optionally of one account state;
-- - staff_client: one client.
-- Each row: the User id, the display name, the account state, the creation instant, the counts of the client's
-- Intakes, Requests and Consultations, of the open matters among them (Requests awaiting a decision: created,
-- payment_authorized, slot_held, awaiting_attorney; Consultations not terminal: created, scheduled, ready, live) and
-- of the Complaint Cases they opened that are not resolved. An unknown id, a User that is not a client and a staff
-- account answer nothing alike.
--
-- staff_change_client_account (EXECUTE for authenticated only; volatile security definer; lock waits bounded):
-- suspend (active -> suspended) or reactivate (suspended -> active) one client's account, with a required staff note
-- of at most 500 characters stored only on the audit event (action user.account_state_changed, reason
-- staff_client_suspend or staff_client_reactivate, the state before and after). Lock order: the caller's User, Staff
-- Profile and grant FOR SHARE (lock_current_capability_staff), then the client's User FOR NO KEY UPDATE, which
-- conflicts with the FOR SHARE every client command takes on its own User (lock_current_active_user): a client
-- command either commits before the suspension (and its matter is counted below) or waits and is then refused. A
-- staff member never acts on their own account. Outcomes: applied, invalid, denied, not_found, locked (the account is
-- not in the intent's from-state).
-- PM row 46 (a client account suspended mid-transaction: the consequence is undecided, so the matter is routed to
-- review and nothing else changes): when a suspension finds open matters, one compliance review item is opened
-- (type client_account_review, compliance family, severity high, source and canonical object the User, no
-- jurisdiction; evidence: the User and Client Profile ids, the Payment Matrix row 46, and the ids of at most 100 open
-- Requests and 100 open Consultations), audited once by the S8 decision_open_review. Nothing else changes: no Request,
-- Consultation, Booking, payment or Engagement is touched, no Attorney Profile changes (DM section 3) and no
-- notification is sent. The existing deferred S8 trigger on users.account_state (20261124030000, unchanged) still
-- routes the open matters of a User who also holds an Attorney Profile. Reactivation opens nothing and resolves
-- nothing.

-- ---------------------------------------------------------------------------
-- The client rows (internal).
-- ---------------------------------------------------------------------------

create function public.client_account_rows(p_user_id uuid, p_account_state text, p_offset integer, p_limit integer)
returns table (
  user_id uuid,
  display_name text,
  account_state text,
  created_at timestamptz,
  intakes bigint,
  requests bigint,
  consultations bigint,
  open_requests bigint,
  open_consultations bigint,
  open_complaints bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select
    u.id,
    u.display_name,
    u.account_state,
    u.created_at,
    (select count(*) from public.intakes as i where i.client_id = c.id),
    (select count(*) from public.consultation_requests as r where r.client_id = c.id),
    (select count(*) from public.consultations as k where k.client_id = c.id),
    (select count(*) from public.consultation_requests as r
     where r.client_id = c.id and r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')),
    (select count(*) from public.consultations as k
     where k.client_id = c.id and k.state in ('created', 'scheduled', 'ready', 'live')),
    (select count(*) from public.complaint_cases as x where x.complainant_user_id = u.id and x.state <> 'resolved')
  from public.users as u
  join public.client_profiles as c on c.user_id = u.id
  where not exists (select 1 from public.staff_profiles as s where s.user_id = u.id)
    and (p_user_id is null or u.id = p_user_id)
    and (p_account_state is null or u.account_state = p_account_state)
  order by u.created_at desc, u.id
  offset p_offset
  limit p_limit;
$function$;

-- ---------------------------------------------------------------------------
-- Reads.
-- ---------------------------------------------------------------------------

create function public.staff_clients(p_account_state text, p_offset integer)
returns table (
  user_id uuid,
  display_name text,
  account_state text,
  created_at timestamptz,
  intakes bigint,
  requests bigint,
  consultations bigint,
  open_requests bigint,
  open_consultations bigint,
  open_complaints bigint
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select r.*
  from public.client_account_rows(null, p_account_state, greatest(coalesce(p_offset, 0), 0), 26) as r
  where public.has_staff_capability('manage_client_accounts', null, false)
    and p_offset between 0 and 100000
    and (p_account_state is null
         or p_account_state in ('pending_verification', 'active', 'suspended', 'closed'));
$function$;

create function public.staff_client(p_client_account_id uuid)
returns table (
  user_id uuid,
  display_name text,
  account_state text,
  created_at timestamptz,
  intakes bigint,
  requests bigint,
  consultations bigint,
  open_requests bigint,
  open_consultations bigint,
  open_complaints bigint
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select r.*
  from public.client_account_rows(p_client_account_id, null, 0, 1) as r
  where p_client_account_id is not null
    and public.has_staff_capability('manage_client_accounts', null, false);
$function$;

-- ---------------------------------------------------------------------------
-- The account-state command.
-- ---------------------------------------------------------------------------

create function public.staff_change_client_account(p_client_account_id uuid, p_intent text, p_note text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_before public.users;
  v_client uuid;
  v_to text;
  v_requests uuid[];
  v_consultations uuid[];
begin
  if p_client_account_id is null
     or p_intent is null
     or p_intent not in ('suspend', 'reactivate')
     or p_note is null
     or not public.professional_text_within(p_note, 500) then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_client_accounts', null);
  if v_staff is null then
    return 'denied';
  end if;
  if p_client_account_id = v_staff then
    return 'denied';
  end if;
  select u.* into v_before
  from public.users as u
  where u.id = p_client_account_id
  for no key update;
  if not found then
    return 'not_found';
  end if;
  select c.id into v_client from public.client_profiles as c where c.user_id = v_before.id;
  if v_client is null or exists (select 1 from public.staff_profiles as s where s.user_id = v_before.id) then
    return 'not_found';
  end if;
  if not (
    (p_intent = 'suspend' and v_before.account_state = 'active')
    or (p_intent = 'reactivate' and v_before.account_state = 'suspended')
  ) then
    return 'locked';
  end if;
  v_to := case p_intent when 'suspend' then 'suspended' else 'active' end;
  update public.users as u
  set account_state = v_to
  where u.id = v_before.id;
  insert into public.audit_events (
    actor_user_id, actor_type, action_code, resource_type, resource_id,
    before_snapshot, after_snapshot, reason_code, policy_references,
    jurisdiction_id, occurred_at
  ) values (
    v_staff, 'staff', 'user.account_state_changed', 'user', v_before.id,
    jsonb_build_object('account_state', v_before.account_state),
    jsonb_build_object('account_state', v_to, 'staff_note', p_note),
    'staff_client_' || p_intent, null, null, clock_timestamp()
  );
  if p_intent = 'suspend' then
    -- Counted after the User is locked: every client command that could add a matter has committed or waits.
    select coalesce(array_agg(x.id order by x.created_at, x.id), array[]::uuid[]) into v_requests
    from (
      select r.id, r.created_at from public.consultation_requests as r
      where r.client_id = v_client
        and r.state in ('created', 'payment_authorized', 'slot_held', 'awaiting_attorney')
      order by r.created_at, r.id
      limit 100
    ) as x;
    select coalesce(array_agg(x.id order by x.created_at, x.id), array[]::uuid[]) into v_consultations
    from (
      select k.id, k.created_at from public.consultations as k
      where k.client_id = v_client
        and k.state in ('created', 'scheduled', 'ready', 'live')
      order by k.created_at, k.id
      limit 100
    ) as x;
    if cardinality(v_requests) > 0 or cardinality(v_consultations) > 0 then
      perform public.decision_open_review(
        'client_account_review', 'user', v_before.id, 'high', null,
        jsonb_build_object(
          'user_id', v_before.id,
          'client_profile_id', v_client,
          'payment_matrix_row', 46,
          'open_request_ids', to_jsonb(v_requests),
          'open_consultation_ids', to_jsonb(v_consultations)
        )
      );
    end if;
  end if;
  return 'applied';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

revoke all on function public.client_account_rows(uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.staff_clients(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_clients(text, integer) to authenticated;
revoke all on function public.staff_client(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_client(uuid) to authenticated;
revoke all on function public.staff_change_client_account(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_change_client_account(uuid, text, text) to authenticated;

comment on function public.client_account_rows(uuid, text, integer, integer) is
  'MVP-001 S11 (internal): client account metadata rows (User id, display name, account state, creation, counts of Intakes, Requests, Consultations, open matters and unresolved complaints) for Users holding a Client Profile and no Staff Profile. Executable by no API role.';
comment on function public.staff_clients(text, integer) is
  'MVP-001 S11 client administration: one page (25 rows, plus one) of client accounts, newest first, optionally of one account state, for staff holding the global manage_client_accounts grant (aal2); account metadata and counts only.';
comment on function public.staff_client(uuid) is
  'MVP-001 S11 client administration: one client account (metadata and counts only) for staff holding the global manage_client_accounts grant (aal2); an unknown id, a non-client and a staff account answer nothing.';
comment on function public.staff_change_client_account(uuid, text, text) is
  'MVP-001 S11 client administration: suspend (active -> suspended) or reactivate (suspended -> active) a client account with a required staff note on the audit event, for staff holding the global manage_client_accounts grant (aal2), never their own account; a suspension with open matters opens one client_account_review compliance item (PM row 46) and changes nothing else. Outcomes: applied, invalid, denied, not_found, locked.';
