-- MVP-001 S11 pass 2 (8 of 16): the operations and administration capability catalog rows and the compliance family
-- of the two new review item types (MVP-001 Packet S11 "operations dashboard", "reconciliation and audit
-- workspaces", "compliance workspace"; MBS sections 16 "Operations" and 18.4; TA sections 18, 40 and 41; PS sections
-- 5.1, 22.5 and 30.4; MB sections 19 and 81 to 90; PM section 1 INV-11 and row 46).
--
-- No relation, column, policy type or seed business row is added (Packet rules 8, 10 and 16). This migration adds
-- four capability catalog rows (reference data, as S1, S2, S7 and S11 pass 1 added theirs; grants stay configuration
-- rows and none is inserted) and replaces one internal function forward.
--
-- Capability catalog (PS section 5.1; PS section 30.4 "staff access is not one universal staff policy"; TA section
-- 18 "admin is a workspace over domain operations, not a superuser bypass"):
-- - view_audit_events: the read-only audit workspace (20261127090000); a jurisdiction-scoped grant reads the events
--   of that jurisdiction, events without a jurisdiction need a global grant;
-- - view_operations: the counts-only operations dashboard and system health (20261127100000), global grant only;
-- - view_referral_operations: the read-only referral operations view (20261127130000), by jurisdiction;
-- - manage_client_accounts: client administration, account metadata and the account-state commands
--   (20261127120000), global grant only.
--
-- Review item families (20261127030000, replaced forward with its signature, volatility, security mode and
-- search_path): exactly two types join the compliance family (manage_compliance_reviews), every earlier assignment is
-- unchanged and an unknown type still stays financial:
-- - rejoin_review: a new application or licence claim matches a licence of a removed Attorney Profile (MB section 19;
--   20261127110000);
-- - client_account_review: a client account was suspended while it had open matters (PM row 46; 20261127120000).

-- ---------------------------------------------------------------------------
-- Capability catalog (grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values
  ('view_audit_events'),
  ('view_operations'),
  ('view_referral_operations'),
  ('manage_client_accounts');

-- ---------------------------------------------------------------------------
-- The family of an exception type (internal; 20261127030000 with the two compliance types added).
-- ---------------------------------------------------------------------------

create or replace function public.exception_family(p_exception_type text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select case
    when p_exception_type in (
      'eligibility_change_review', 'jurisdiction_change_review', 'rejoin_review', 'client_account_review'
    ) then 'compliance'
    when p_exception_type in (
      'media_session_mismatch', 'media_activity_outside_consultation', 'media_unrecognized_participant',
      'media_room_missing', 'media_unknown_room', 'notification_delivery_failed'
    ) then 'operations'
    else 'financial'
  end;
$function$;

revoke all on function public.exception_family(text)
  from public, anon, authenticated, service_role;

comment on function public.exception_family(text) is
  'MVP-001 S11 (internal): the review family of an exception type: compliance (eligibility_change_review, jurisdiction_change_review, rejoin_review, client_account_review), operations (the S9 media types and notification_delivery_failed) or financial (every other type, an unknown one included). Executable by no API role.';
