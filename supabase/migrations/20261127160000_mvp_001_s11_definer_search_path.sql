-- MVP-001 S11 pass 2 (16 of 16): correction D8 of the S11 architecture verification: every security definer function
-- pins pg_temp last in its search_path (MVP-001 Packet section 2 rule 4; PS section 30.5; the PostgreSQL guidance for
-- security definer functions: an attacker-creatable schema, pg_temp included, must come last or not at all).
--
-- No relation, column, policy type or seed is added and no function body, signature, volatility, owner, privilege or
-- comment changes (Packet rules 8, 10 and 16). Fifteen security definer functions of earlier slices were created with
-- search_path = pg_catalog only, which leaves pg_temp implicitly searched first for relations; each now has search_path
-- = pg_catalog, pg_temp, the setting of every later definer function (and of has_resource_metadata_access since S10).
-- Every name these functions use is schema-qualified, so their resolution is unchanged.

alter function public.client_create_intake() set search_path = pg_catalog, pg_temp;
alter function public.client_intake_practice_areas() set search_path = pg_catalog, pg_temp;
alter function public.client_intake_jurisdictions() set search_path = pg_catalog, pg_temp;
alter function public.staff_publish_intake_question_set(text, jsonb) set search_path = pg_catalog, pg_temp;
alter function public.rosuno_environment_class() set search_path = pg_catalog, pg_temp;
alter function public.rosuno_environment_status() set search_path = pg_catalog, pg_temp;
alter function public.deployment_environment_identity() set search_path = pg_catalog, pg_temp;
alter function public.policy_select_version(text, uuid, uuid, timestamptz) set search_path = pg_catalog, pg_temp;
alter function public.capability_admin_may_read_user(uuid) set search_path = pg_catalog, pg_temp;
alter function public.production_financial_gate(uuid, text, uuid, timestamptz) set search_path = pg_catalog, pg_temp;
alter function public.has_manage_attorney_verification_scope(uuid, boolean) set search_path = pg_catalog, pg_temp;
alter function public.has_staff_capability(text, uuid, boolean) set search_path = pg_catalog, pg_temp;
alter function public.client_save_intake_revision(uuid, integer, uuid, uuid, text, jsonb)
  set search_path = pg_catalog, pg_temp;
alter function public.client_submit_intake(uuid, integer) set search_path = pg_catalog, pg_temp;
alter function public.client_close_intake(uuid) set search_path = pg_catalog, pg_temp;
