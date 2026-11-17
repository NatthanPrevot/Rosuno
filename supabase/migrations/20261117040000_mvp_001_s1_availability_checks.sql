-- MVP-001 S1 (4 of 4): availability-rule integrity checks (SCH-3).
--
-- PS section 2.3: where local scheduling matters the scheduling object persists an IANA timezone identifier.
-- PS section 16.1 gives availability_rules a weekday and a timezone_name without a range or identifier check.
-- These are implementation constraints (DL-ENG-1 R9), not a physical-model change: the weekday is an ISO 8601
-- day of the week (Monday = 1 ... Sunday = 7, as PostgreSQL isodow), and timezone_name must be a time zone
-- name this server knows. No availability rule exists yet in any environment.

alter table public.availability_rules
  add constraint availability_rules_weekday_iso_check
    check (weekday is null or weekday between 1 and 7);

create function public.availability_rule_timezone_check()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names as z where z.name = new.timezone_name) then
    raise exception 'timezone_name must be an IANA time zone identifier'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger availability_rules_timezone_check
before insert or update of timezone_name on public.availability_rules
for each row
execute function public.availability_rule_timezone_check();

revoke all on function public.availability_rule_timezone_check()
  from public, anon, authenticated, service_role;

comment on column public.availability_rules.weekday is
  'ISO 8601 day of the week (Monday = 1 ... Sunday = 7) for recurring rules.';
