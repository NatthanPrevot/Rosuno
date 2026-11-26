-- DEV-001 engineering program (WI-P2-DEV-001-ENGINEERING-PROGRAM, DEC-20261125-DEV-001-ENGINEERING-PROGRAM): storage
-- for the website and appearance studio of the product integration. A site appearance is typed configuration data
-- (colours, type, spacing, page text slots, section order, logo and image references); it is never code, markup or
-- CSS, and the application validates it in full and compiles CSS from it alone. This migration stores the versions of
-- that configuration (draft, published, superseded, discarded), the image library they reference and the one active
-- theme, and adds the functions that read and change them.
--
-- Pending owner confirmation (decision register A53): the capability catalogue code manage_site_appearance is added
-- here as proposed. It is reference data only: no grant row is inserted, and holders are granted through the existing
-- audited staff_grant_capability flow (no self-grant). The owner's decision on A53 is recorded separately.
--
-- Added, and nothing else:
-- - three relations: public.site_appearance_versions, public.site_appearance_assets and
--   public.site_appearance_activation, each with row level security on, no row policy and no privilege for any API
--   role (public, anon, authenticated and service_role hold nothing; every read and write goes through a function);
-- - two guard triggers per versioned relation (row and truncate) on site_appearance_versions and
--   site_appearance_assets;
-- - one capability catalogue row, manage_site_appearance;
-- - eighteen functions: four internal (no API role may execute them), two public reads (anon and authenticated) and
--   twelve staff functions (authenticated only).
-- No existing relation, column, policy, policy type, function or row is changed; no seed, no grant row, no business
-- record.
--
-- Rules, for every role, the database owner included (constraints and guard triggers):
-- - A stored configuration is a JSON object of at most 65,536 octets in its database text form, with "schema": 1,
--   only the nine top-level keys of schema 1, no null or boolean anywhere, every string outside "slots" either a
--   lowercase #rrggbb colour or a lowercase identifier ([a-z0-9][a-z0-9.-]{0,63}), every object key an identifier,
--   every number between -1000 and 100000, "slots" an object of plain texts that pass site_appearance_text_allowed,
--   and "assets" at most 20 references of exactly a SHA-256 digest and a format (png, jpeg, webp). Nothing that CSS or
--   markup could act on can be stored; ranges and component membership are the application validator's.
-- - configuration_sha256 is the SHA-256 digest of the configuration's database text form.
-- - A version is recorded as a new draft (revision 1). One draft and one published version per theme at most; version
--   numbers are unique per theme. A draft may be saved (new configuration, revision + 1, label, base version), published
--   (version number, label, publisher) or discarded; a published version may only become superseded; superseded and
--   discarded versions never change; nothing is ever deleted or truncated.
-- - An asset is a PNG, JPEG or WebP image (the format's signature checked against its media type), 1 to 900,000 bytes,
--   16 to 4096 pixels each way, addressed by the SHA-256 digest of its bytes (checked); it never changes and is never
--   deleted. SVG and every other format are refused.
--
-- Public reads (EXECUTE for anon and authenticated; language sql, stable, security definer):
-- - public_site_appearance(): the published version of the active theme, or nothing; never a draft.
-- - public_site_appearance_asset(p_sha256): an asset the published version of the active theme references, or nothing.
--
-- Staff reads and commands (EXECUTE for authenticated only): manage_site_appearance as a global grant at aal2 (every
-- function passes a null jurisdiction, so a jurisdiction-scoped grant never counts). Reads answer nothing to anyone
-- else; commands validate their arguments first (invalid), then lock the caller's User, Staff Profile and grant
-- (lock_current_capability_staff; denied), then the rows they change, then write exactly one audit event. Lock order:
-- the caller's rows (FOR SHARE), the draft (FOR UPDATE), the published version (FOR UPDATE), the activation row. A
-- restore reads its source without a lock: a published or superseded configuration never changes. Uploads take the
-- asset relation in SHARE ROW EXCLUSIVE mode after the caller's rows, so the library bound holds.
-- Audit events carry identifiers, revisions, digests and sizes only: never a configuration, a page text or image bytes.

-- ---------------------------------------------------------------------------
-- Internal: the text rule and the configuration shape (used by the constraints).
-- ---------------------------------------------------------------------------

-- The page text rule (the application's appearanceTextAllowed implements the same rule with the same phrases): NFC,
-- 1 to 300 characters, no leading or trailing space or line break, no control character other than a line break and
-- no bidirectional or line-separator character, none of < > { } \, no link or contact detail, and none of the
-- regulated phrases. The character, link and phrase tests read the NFKC form, lowered for ASCII letters only, so the
-- rule does not depend on the database locale.
create function public.site_appearance_text_allowed(p_text text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(
    p_text is nfc normalized
    and char_length(p_text) between 1 and 300
    and p_text !~ '^[ \n]|[ \n]$'
    and n.k !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]'
    and n.k !~ '[<>{}\\]'
    and n.k !~* '(https?:|www\.|javascript:|data:|@[a-z0-9-]+\.[a-z])'
    and ' ' || regexp_replace(translate(n.k, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[^a-z0-9]+', ' ', 'g') || ' '
      !~ ' (best|top rated|recommended|recommend|recommends|ranked|ranking|perfect|right lawyer|match|matched|matching|ai selected|rosuno recommends|independent|licensed|certified|board certified|accredited|specialist|specialists|specialized|specialised|expert|experts|vetted|verified|approved|endorsed|live in your state|guarantee|guaranteed|guarantees|promise|cheapest|lowest|free|risk free|no win no fee|legal advice|disclaimer|disclaimers|liability|liable|warranty|warranties|warrant|terms of use|terms of service|privacy policy|we collect|personal data|cookie policy|governing law) ',
    false
  )
  from (select normalize(p_text, nfkc) as k) as n;
$function$;

-- The stored shape of a configuration (see the header). plpgsql, so each test runs only after the ones guarding it.
create function public.site_appearance_shape_valid(p jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' or octet_length(p::text) > 65536 then
    return false;
  end if;
  if p -> 'schema' is distinct from '1'::jsonb then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p) as k(key)
    where k.key not in ('schema', 'tokens', 'type', 'roles', 'components', 'slots', 'sections', 'brand', 'assets')
  ) then
    return false;
  end if;
  -- Every value outside the slots, at every depth (the root included).
  if exists (
    select 1
    from jsonb_path_query(p - 'slots', 'strict $.**') as v(item)
    where case jsonb_typeof(v.item)
      when 'string' then (v.item #>> '{}') !~ '^(#[0-9a-f]{6}|[a-z0-9][a-z0-9.-]{0,63})$'
      when 'number' then (v.item #>> '{}')::numeric not between -1000 and 100000
      when 'object' then exists (
        select 1 from jsonb_object_keys(v.item) as k(key) where k.key !~ '^[a-z][a-zA-Z0-9.-]{0,63}$'
      )
      when 'array' then false
      else true
    end
  ) then
    return false;
  end if;
  if p ? 'slots' then
    if jsonb_typeof(p -> 'slots') is distinct from 'object' then
      return false;
    end if;
    if exists (
      select 1
      from jsonb_each(p -> 'slots') as s(key, value)
      where char_length(s.key) > 64
        or s.key !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+){0,3}$'
        or jsonb_typeof(s.value) is distinct from 'string'
        or not public.site_appearance_text_allowed(s.value #>> '{}')
    ) then
      return false;
    end if;
  end if;
  if p ? 'assets' then
    if jsonb_typeof(p -> 'assets') is distinct from 'array' or jsonb_array_length(p -> 'assets') > 20 then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(p -> 'assets') as a(item) where jsonb_typeof(a.item) is distinct from 'object'
    ) then
      return false;
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p -> 'assets') as a(item)
      where (select array_agg(k.key order by k.key) from jsonb_object_keys(a.item) as k(key))
              is distinct from array['format', 'sha256']
        or jsonb_typeof(a.item -> 'sha256') is distinct from 'string'
        or jsonb_typeof(a.item -> 'format') is distinct from 'string'
        or (a.item ->> 'sha256') !~ '^[0-9a-f]{64}$'
        or (a.item ->> 'format') not in ('png', 'jpeg', 'webp')
    ) then
      return false;
    end if;
  end if;
  return true;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The relations.
-- ---------------------------------------------------------------------------

create table public.site_appearance_versions (
  id uuid primary key default gen_random_uuid(),
  theme_key text not null,
  state text not null,
  version_number integer,
  configuration jsonb not null,
  configuration_sha256 text not null,
  schema_version integer not null,
  revision integer not null,
  based_on_version_id uuid,
  label text,
  created_by_user_id uuid not null,
  created_at timestamptz not null,
  updated_by_user_id uuid not null,
  updated_at timestamptz not null,
  published_by_user_id uuid,
  published_at timestamptz,
  superseded_at timestamptz,
  discarded_at timestamptz,
  constraint site_appearance_versions_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint site_appearance_versions_updated_by_user_id_fkey
    foreign key (updated_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint site_appearance_versions_published_by_user_id_fkey
    foreign key (published_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint site_appearance_versions_based_on_version_id_fkey
    foreign key (based_on_version_id)
    references public.site_appearance_versions (id)
    on update restrict
    on delete restrict,
  constraint site_appearance_versions_theme_key_check
    check (theme_key ~ '^[a-z][a-z0-9-]{1,31}$'),
  constraint site_appearance_versions_state_check
    check (state in ('draft', 'published', 'superseded', 'discarded')),
  constraint site_appearance_versions_schema_check
    check (schema_version = 1),
  constraint site_appearance_versions_revision_check
    check (revision between 1 and 1000000),
  constraint site_appearance_versions_number_check
    check (version_number is null or version_number between 1 and 1000000),
  constraint site_appearance_versions_sha_check
    check (configuration_sha256 ~ '^[0-9a-f]{64}$'),
  constraint site_appearance_versions_digest_check
    check (configuration_sha256 = encode(pg_catalog.sha256(convert_to(configuration::text, 'UTF8')), 'hex')),
  constraint site_appearance_versions_shape_check
    check (public.site_appearance_shape_valid(configuration)),
  constraint site_appearance_versions_label_check
    check (label is null or (char_length(label) between 1 and 80 and label !~ '[[:cntrl:]]')),
  constraint site_appearance_versions_lifecycle_check
    check (
      (state = 'draft' and version_number is null and published_at is null and published_by_user_id is null
       and superseded_at is null and discarded_at is null)
      or (state = 'published' and version_number is not null and published_at is not null
          and published_by_user_id is not null and superseded_at is null and discarded_at is null)
      or (state = 'superseded' and version_number is not null and published_at is not null
          and published_by_user_id is not null and superseded_at is not null and discarded_at is null)
      or (state = 'discarded' and version_number is null and published_at is null and published_by_user_id is null
          and superseded_at is null and discarded_at is not null)
    )
);

alter table public.site_appearance_versions enable row level security;

create unique index site_appearance_versions_one_draft_idx
  on public.site_appearance_versions (theme_key)
  where state = 'draft';

create unique index site_appearance_versions_one_published_idx
  on public.site_appearance_versions (theme_key)
  where state = 'published';

create unique index site_appearance_versions_number_idx
  on public.site_appearance_versions (theme_key, version_number)
  where version_number is not null;

create index site_appearance_versions_list_idx
  on public.site_appearance_versions (theme_key, created_at desc, id);

create table public.site_appearance_assets (
  id uuid primary key default gen_random_uuid(),
  sha256 text not null,
  media_type text not null,
  byte_size integer not null,
  width integer not null,
  height integer not null,
  content bytea not null,
  created_by_user_id uuid not null,
  created_at timestamptz not null,
  constraint site_appearance_assets_sha256_key
    unique (sha256),
  constraint site_appearance_assets_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint site_appearance_assets_sha_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint site_appearance_assets_type_check
    check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  constraint site_appearance_assets_size_check
    check (byte_size between 1 and 900000 and octet_length(content) = byte_size),
  constraint site_appearance_assets_dimensions_check
    check (width between 16 and 4096 and height between 16 and 4096),
  constraint site_appearance_assets_digest_check
    check (encode(pg_catalog.sha256(content), 'hex') = sha256),
  constraint site_appearance_assets_signature_check
    check (
      (media_type = 'image/png' and substring(content from 1 for 8) = '\x89504e470d0a1a0a'::bytea)
      or (media_type = 'image/jpeg' and substring(content from 1 for 3) = '\xffd8ff'::bytea)
      or (media_type = 'image/webp' and substring(content from 1 for 4) = '\x52494646'::bytea
          and substring(content from 9 for 4) = '\x57454250'::bytea)
    )
);

alter table public.site_appearance_assets enable row level security;

create index site_appearance_assets_list_idx
  on public.site_appearance_assets (created_at desc, id);

create table public.site_appearance_activation (
  singleton boolean primary key,
  theme_key text not null,
  activated_by_user_id uuid not null,
  activated_at timestamptz not null,
  constraint site_appearance_activation_activated_by_user_id_fkey
    foreign key (activated_by_user_id)
    references public.users (id)
    on update restrict
    on delete restrict,
  constraint site_appearance_activation_singleton_check
    check (singleton),
  constraint site_appearance_activation_theme_check
    check (theme_key ~ '^[a-z][a-z0-9-]{1,31}$')
);

alter table public.site_appearance_activation enable row level security;

-- ---------------------------------------------------------------------------
-- The guards (every role).
-- ---------------------------------------------------------------------------

create function public.site_appearance_versions_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_saved constant text[] := array[
    'configuration', 'configuration_sha256', 'revision', 'label', 'based_on_version_id', 'updated_by_user_id',
    'updated_at'
  ];
  v_published constant text[] := array[
    'state', 'version_number', 'label', 'published_by_user_id', 'published_at', 'updated_by_user_id', 'updated_at'
  ];
  v_discarded constant text[] := array['state', 'discarded_at', 'updated_by_user_id', 'updated_at'];
  v_superseded constant text[] := array['state', 'superseded_at'];
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'public.site_appearance_versions rows are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'draft' or new.revision is distinct from 1 then
      raise exception 'an appearance version is recorded as a new draft'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.theme_key is distinct from old.theme_key
     or new.schema_version is distinct from old.schema_version
     or new.created_by_user_id is distinct from old.created_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'an appearance version keeps its identity, theme, schema and creation'
      using errcode = '55000';
  end if;
  if old.state = 'draft' and new.state = 'draft' then
    if new.revision is distinct from old.revision + 1
       or (to_jsonb(new) - v_saved) is distinct from (to_jsonb(old) - v_saved) then
      raise exception 'a draft is saved with its next revision and nothing else'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if old.state = 'draft' and new.state = 'published' then
    if (to_jsonb(new) - v_published) is distinct from (to_jsonb(old) - v_published) then
      raise exception 'a draft is published as saved'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if old.state = 'draft' and new.state = 'discarded' then
    if (to_jsonb(new) - v_discarded) is distinct from (to_jsonb(old) - v_discarded) then
      raise exception 'a draft is discarded as saved'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if old.state = 'published' and new.state = 'superseded' then
    if (to_jsonb(new) - v_superseded) is distinct from (to_jsonb(old) - v_superseded) then
      raise exception 'a published version is superseded as published'
        using errcode = '55000';
    end if;
    return new;
  end if;
  raise exception 'appearance version change % -> % is not permitted', old.state, new.state
    using errcode = '55000';
end;
$function$;

create trigger site_appearance_versions_guard
before insert or update or delete on public.site_appearance_versions
for each row
execute function public.site_appearance_versions_guard();

create trigger site_appearance_versions_no_truncate
before truncate on public.site_appearance_versions
for each statement
execute function public.site_appearance_versions_guard();

create function public.site_appearance_assets_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'public.site_appearance_assets rows are never changed or deleted'
    using errcode = '55000';
end;
$function$;

create trigger site_appearance_assets_guard
before update or delete on public.site_appearance_assets
for each row
execute function public.site_appearance_assets_guard();

create trigger site_appearance_assets_no_truncate
before truncate on public.site_appearance_assets
for each statement
execute function public.site_appearance_assets_guard();

-- ---------------------------------------------------------------------------
-- Privileges: no API role reads or writes the relations directly.
-- ---------------------------------------------------------------------------

revoke all on table public.site_appearance_versions
  from public, anon, authenticated, service_role;
revoke all on table public.site_appearance_assets
  from public, anon, authenticated, service_role;
revoke all on table public.site_appearance_activation
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Capability catalog (reference data; pending owner confirmation A53; grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values ('manage_site_appearance');

-- ---------------------------------------------------------------------------
-- Public reads (EXECUTE for anon and authenticated).
-- ---------------------------------------------------------------------------

-- The published version of the active theme; nothing before the first publication.
create function public.public_site_appearance()
returns table (
  version_id uuid,
  version_number integer,
  theme_key text,
  configuration jsonb,
  configuration_sha256 text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select v.id, v.version_number, v.theme_key, v.configuration, v.configuration_sha256, v.published_at
  from public.site_appearance_activation as a
  join public.site_appearance_versions as v on v.theme_key = a.theme_key and v.state = 'published'
  where a.singleton
  limit 1;
$function$;

-- One asset the published version of the active theme references, as unwrapped base64; nothing otherwise.
create function public.public_site_appearance_asset(p_sha256 text)
returns table (
  media_type text,
  content_base64 text,
  byte_size integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select s.media_type, replace(encode(s.content, 'base64'), E'\n', ''), s.byte_size
  from public.site_appearance_assets as s
  where p_sha256 ~ '^[0-9a-f]{64}$'
    and s.sha256 = p_sha256
    and exists (
      select 1
      from public.site_appearance_activation as a
      join public.site_appearance_versions as v on v.theme_key = a.theme_key and v.state = 'published'
      where a.singleton
        and coalesce(v.configuration -> 'assets', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('sha256', p_sha256))
    );
$function$;

-- ---------------------------------------------------------------------------
-- Staff reads (EXECUTE for authenticated only; manage_site_appearance, global grant, aal2).
-- ---------------------------------------------------------------------------

-- Exactly one row for holders: the theme's draft and published version (nulls where absent) and the active theme.
create function public.staff_site_appearance_overview(p_theme_key text)
returns table (
  draft_id uuid,
  draft_revision integer,
  draft_configuration jsonb,
  draft_based_on_version_id uuid,
  draft_updated_at timestamptz,
  published_id uuid,
  published_version_number integer,
  published_configuration jsonb,
  published_at timestamptz,
  active_theme_key text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    d.id, d.revision, d.configuration, d.based_on_version_id, d.updated_at,
    p.id, p.version_number, p.configuration, p.published_at,
    a.theme_key
  from (select 1) as one
  left join public.site_appearance_versions as d on d.theme_key = p_theme_key and d.state = 'draft'
  left join public.site_appearance_versions as p on p.theme_key = p_theme_key and p.state = 'published'
  left join public.site_appearance_activation as a on a.singleton
  where public.has_staff_capability('manage_site_appearance', null, false)
    and p_theme_key ~ '^[a-z][a-z0-9-]{1,31}$';
$function$;

-- One page (25 rows, plus one) of the theme's versions, newest first; no configuration.
create function public.staff_site_appearance_versions(p_theme_key text, p_offset integer)
returns table (
  version_id uuid,
  version_number integer,
  state text,
  label text,
  configuration_sha256 text,
  based_on_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  published_at timestamptz,
  published_by_user_id uuid,
  superseded_at timestamptz,
  discarded_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select
    v.id, v.version_number, v.state, v.label, v.configuration_sha256, v.based_on_version_id, v.created_at,
    v.updated_at, v.published_at, v.published_by_user_id, v.superseded_at, v.discarded_at
  from public.site_appearance_versions as v
  where public.has_staff_capability('manage_site_appearance', null, false)
    and p_theme_key ~ '^[a-z][a-z0-9-]{1,31}$'
    and v.theme_key = p_theme_key
    and p_offset between 0 and 100000
  order by v.created_at desc, v.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 26;
$function$;

-- One version with its configuration; no row for an unknown id.
create function public.staff_site_appearance_version(p_version_id uuid)
returns table (
  version_id uuid,
  theme_key text,
  state text,
  version_number integer,
  configuration jsonb,
  configuration_sha256 text,
  label text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select v.id, v.theme_key, v.state, v.version_number, v.configuration, v.configuration_sha256, v.label, v.published_at
  from public.site_appearance_versions as v
  where v.id = p_version_id
    and public.has_staff_capability('manage_site_appearance', null, false);
$function$;

-- Exactly one row for holders: the theme's draft (with its revision), else its published version (no revision), else
-- nulls.
create function public.staff_site_appearance_preview(p_theme_key text)
returns table (
  version_id uuid,
  revision integer,
  configuration jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(d.id, p.id), d.revision, coalesce(d.configuration, p.configuration)
  from (select 1) as one
  left join public.site_appearance_versions as d on d.theme_key = p_theme_key and d.state = 'draft'
  left join public.site_appearance_versions as p on p.theme_key = p_theme_key and p.state = 'published'
  where public.has_staff_capability('manage_site_appearance', null, false)
    and p_theme_key ~ '^[a-z][a-z0-9-]{1,31}$';
$function$;

-- One page (50 rows, plus one) of the image library, newest first; no bytes.
create function public.staff_site_appearance_assets(p_offset integer)
returns table (
  asset_id uuid,
  sha256 text,
  media_type text,
  byte_size integer,
  width integer,
  height integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select s.id, s.sha256, s.media_type, s.byte_size, s.width, s.height, s.created_at
  from public.site_appearance_assets as s
  where public.has_staff_capability('manage_site_appearance', null, false)
    and p_offset between 0 and 100000
  order by s.created_at desc, s.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit 51;
$function$;

-- One library asset as unwrapped base64, published or not.
create function public.staff_site_appearance_asset(p_sha256 text)
returns table (
  media_type text,
  content_base64 text,
  byte_size integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select s.media_type, replace(encode(s.content, 'base64'), E'\n', ''), s.byte_size
  from public.site_appearance_assets as s
  where p_sha256 ~ '^[0-9a-f]{64}$'
    and s.sha256 = p_sha256
    and public.has_staff_capability('manage_site_appearance', null, false);
$function$;

-- ---------------------------------------------------------------------------
-- Staff commands (EXECUTE for authenticated only; manage_site_appearance, global grant, aal2).
-- ---------------------------------------------------------------------------

-- Saves the theme's draft. Outcomes: created (no draft and no expected revision; based on the published version),
-- saved (the expected revision is the draft's; revision + 1), conflict (another revision, or no expected revision
-- while a draft exists, or an expected revision while none exists), invalid, denied.
create function public.staff_save_site_appearance_draft(
  p_theme_key text,
  p_expected_revision integer,
  p_configuration jsonb
)
returns table (outcome text, version_id uuid, revision integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_now timestamptz;
  v_sha text;
  v_draft public.site_appearance_versions;
  v_published uuid;
  v_id uuid;
begin
  if p_theme_key is null
     or p_theme_key !~ '^[a-z][a-z0-9-]{1,31}$'
     or (p_expected_revision is not null and p_expected_revision not between 1 and 1000000)
     or p_configuration is null
     or not public.site_appearance_shape_valid(p_configuration) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_site_appearance', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid, null::integer;
    return;
  end if;
  v_now := clock_timestamp();
  v_sha := encode(pg_catalog.sha256(convert_to(p_configuration::text, 'UTF8')), 'hex');
  select v.* into v_draft
  from public.site_appearance_versions as v
  where v.theme_key = p_theme_key
    and v.state = 'draft'
  for update;
  if not found then
    if p_expected_revision is not null then
      return query select 'conflict'::text, null::uuid, null::integer;
      return;
    end if;
    select v.id into v_published
    from public.site_appearance_versions as v
    where v.theme_key = p_theme_key
      and v.state = 'published';
    insert into public.site_appearance_versions (
      theme_key, state, configuration, configuration_sha256, schema_version, revision, based_on_version_id,
      created_by_user_id, created_at, updated_by_user_id, updated_at
    ) values (
      p_theme_key, 'draft', p_configuration, v_sha, 1, 1, v_published, v_staff, v_now, v_staff, v_now
    )
    on conflict (theme_key) where state = 'draft'
    do nothing
    returning id into v_id;
    if v_id is null then
      return query select 'conflict'::text, null::uuid, null::integer;
      return;
    end if;
    perform public.decision_audit(
      v_staff, 'staff', 'site_appearance.draft_created', 'site_appearance_version', v_id,
      null,
      jsonb_build_object(
        'theme_key', p_theme_key, 'revision', 1, 'configuration_sha256', v_sha, 'based_on_version_id', v_published
      ),
      null, null, null
    );
    return query select 'created'::text, v_id, 1;
    return;
  end if;
  if p_expected_revision is distinct from v_draft.revision then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;
  update public.site_appearance_versions as v
  set configuration = p_configuration,
      configuration_sha256 = v_sha,
      revision = v_draft.revision + 1,
      updated_by_user_id = v_staff,
      updated_at = v_now
  where v.id = v_draft.id;
  perform public.decision_audit(
    v_staff, 'staff', 'site_appearance.draft_saved', 'site_appearance_version', v_draft.id,
    jsonb_build_object('revision', v_draft.revision, 'configuration_sha256', v_draft.configuration_sha256),
    jsonb_build_object('revision', v_draft.revision + 1, 'configuration_sha256', v_sha),
    null, null, null
  );
  return query select 'saved'::text, v_draft.id, v_draft.revision + 1;
end;
$function$;

-- Publishes the theme's draft as saved: the published version (if any) becomes superseded, the draft becomes the
-- published version with the next version number, and the theme becomes the active one. Outcomes: published,
-- conflict (another revision), not_found (no such draft of that theme), invalid (a malformed argument or label, or a
-- referenced asset missing from the library or of another format), denied.
create function public.staff_publish_site_appearance(
  p_theme_key text,
  p_draft_id uuid,
  p_expected_revision integer,
  p_label text
)
returns table (outcome text, version_id uuid, version_number integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_now timestamptz;
  v_draft public.site_appearance_versions;
  v_published public.site_appearance_versions;
  v_number integer;
begin
  if p_theme_key is null
     or p_theme_key !~ '^[a-z][a-z0-9-]{1,31}$'
     or p_draft_id is null
     or p_expected_revision is null
     or p_expected_revision not between 1 and 1000000
     or (p_label is not null and (char_length(p_label) not between 1 and 80 or p_label ~ '[[:cntrl:]]')) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_site_appearance', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid, null::integer;
    return;
  end if;
  v_now := clock_timestamp();
  select v.* into v_draft
  from public.site_appearance_versions as v
  where v.id = p_draft_id
    and v.theme_key = p_theme_key
    and v.state = 'draft'
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  if v_draft.revision is distinct from p_expected_revision then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_draft.configuration -> 'assets', '[]'::jsonb)) as r(item)
    where not exists (
      select 1
      from public.site_appearance_assets as s
      where s.sha256 = r.item ->> 'sha256'
        and s.media_type = 'image/' || (r.item ->> 'format')
    )
  ) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  select v.* into v_published
  from public.site_appearance_versions as v
  where v.theme_key = p_theme_key
    and v.state = 'published'
  for update;
  select coalesce(max(v.version_number), 0) + 1 into v_number
  from public.site_appearance_versions as v
  where v.theme_key = p_theme_key
    and v.version_number is not null;
  if v_published.id is not null then
    update public.site_appearance_versions as v
    set state = 'superseded',
        superseded_at = v_now
    where v.id = v_published.id;
  end if;
  update public.site_appearance_versions as v
  set state = 'published',
      version_number = v_number,
      label = p_label,
      published_by_user_id = v_staff,
      published_at = v_now,
      updated_by_user_id = v_staff,
      updated_at = v_now
  where v.id = v_draft.id;
  perform 1 from public.site_appearance_activation as a where a.singleton for update;
  insert into public.site_appearance_activation as a (singleton, theme_key, activated_by_user_id, activated_at)
  values (true, p_theme_key, v_staff, v_now)
  on conflict (singleton) do update
  set theme_key = excluded.theme_key,
      activated_by_user_id = excluded.activated_by_user_id,
      activated_at = excluded.activated_at
  where a.theme_key is distinct from excluded.theme_key;
  perform public.decision_audit(
    v_staff, 'staff', 'site_appearance.published', 'site_appearance_version', v_draft.id,
    jsonb_build_object('superseded_version_id', v_published.id),
    jsonb_build_object(
      'theme_key', p_theme_key, 'version_number', v_number, 'configuration_sha256', v_draft.configuration_sha256,
      'label_present', p_label is not null
    ),
    null, null, null
  );
  return query select 'published'::text, v_draft.id, v_number;
end;
$function$;

-- Makes a published or superseded version the draft of its theme (created when none exists and no revision is
-- expected; overwritten when the expected revision is the draft's), based on that version. Outcomes: restored,
-- conflict, not_found, invalid (a malformed argument, or a source that is a draft or discarded), denied.
create function public.staff_restore_site_appearance(p_version_id uuid, p_expected_revision integer)
returns table (outcome text, version_id uuid, revision integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_now timestamptz;
  v_source public.site_appearance_versions;
  v_draft public.site_appearance_versions;
  v_id uuid;
begin
  if p_version_id is null
     or (p_expected_revision is not null and p_expected_revision not between 1 and 1000000) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_site_appearance', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid, null::integer;
    return;
  end if;
  v_now := clock_timestamp();
  -- No lock: a published or superseded configuration never changes.
  select v.* into v_source
  from public.site_appearance_versions as v
  where v.id = p_version_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  if v_source.state not in ('published', 'superseded') then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  select v.* into v_draft
  from public.site_appearance_versions as v
  where v.theme_key = v_source.theme_key
    and v.state = 'draft'
  for update;
  if not found then
    if p_expected_revision is not null then
      return query select 'conflict'::text, null::uuid, null::integer;
      return;
    end if;
    insert into public.site_appearance_versions (
      theme_key, state, configuration, configuration_sha256, schema_version, revision, based_on_version_id,
      created_by_user_id, created_at, updated_by_user_id, updated_at
    ) values (
      v_source.theme_key, 'draft', v_source.configuration, v_source.configuration_sha256, 1, 1, v_source.id,
      v_staff, v_now, v_staff, v_now
    )
    on conflict (theme_key) where state = 'draft'
    do nothing
    returning id into v_id;
    if v_id is null then
      return query select 'conflict'::text, null::uuid, null::integer;
      return;
    end if;
    perform public.decision_audit(
      v_staff, 'staff', 'site_appearance.restored', 'site_appearance_version', v_id,
      null,
      jsonb_build_object(
        'from_version_id', v_source.id, 'revision', 1, 'configuration_sha256', v_source.configuration_sha256
      ),
      null, null, null
    );
    return query select 'restored'::text, v_id, 1;
    return;
  end if;
  if p_expected_revision is distinct from v_draft.revision then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;
  update public.site_appearance_versions as v
  set configuration = v_source.configuration,
      configuration_sha256 = v_source.configuration_sha256,
      revision = v_draft.revision + 1,
      based_on_version_id = v_source.id,
      updated_by_user_id = v_staff,
      updated_at = v_now
  where v.id = v_draft.id;
  perform public.decision_audit(
    v_staff, 'staff', 'site_appearance.restored', 'site_appearance_version', v_draft.id,
    jsonb_build_object('revision', v_draft.revision, 'configuration_sha256', v_draft.configuration_sha256),
    jsonb_build_object(
      'from_version_id', v_source.id, 'revision', v_draft.revision + 1,
      'configuration_sha256', v_source.configuration_sha256
    ),
    null, null, null
  );
  return query select 'restored'::text, v_draft.id, v_draft.revision + 1;
end;
$function$;

-- Replaces the theme's draft configuration with the empty configuration {"schema": 1} (the owner's design): created
-- when none exists and no revision is expected (based on the published version), overwritten when the expected
-- revision is the draft's. Outcomes: reset, conflict, invalid, denied.
create function public.staff_reset_site_appearance(p_theme_key text, p_expected_revision integer)
returns table (outcome text, version_id uuid, revision integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_empty constant jsonb := '{"schema": 1}'::jsonb;
  v_staff uuid;
  v_now timestamptz;
  v_sha text;
  v_draft public.site_appearance_versions;
  v_published uuid;
  v_id uuid;
begin
  if p_theme_key is null
     or p_theme_key !~ '^[a-z][a-z0-9-]{1,31}$'
     or (p_expected_revision is not null and p_expected_revision not between 1 and 1000000) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_site_appearance', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid, null::integer;
    return;
  end if;
  v_now := clock_timestamp();
  v_sha := encode(pg_catalog.sha256(convert_to(v_empty::text, 'UTF8')), 'hex');
  select v.* into v_draft
  from public.site_appearance_versions as v
  where v.theme_key = p_theme_key
    and v.state = 'draft'
  for update;
  if not found then
    if p_expected_revision is not null then
      return query select 'conflict'::text, null::uuid, null::integer;
      return;
    end if;
    select v.id into v_published
    from public.site_appearance_versions as v
    where v.theme_key = p_theme_key
      and v.state = 'published';
    insert into public.site_appearance_versions (
      theme_key, state, configuration, configuration_sha256, schema_version, revision, based_on_version_id,
      created_by_user_id, created_at, updated_by_user_id, updated_at
    ) values (
      p_theme_key, 'draft', v_empty, v_sha, 1, 1, v_published, v_staff, v_now, v_staff, v_now
    )
    on conflict (theme_key) where state = 'draft'
    do nothing
    returning id into v_id;
    if v_id is null then
      return query select 'conflict'::text, null::uuid, null::integer;
      return;
    end if;
    perform public.decision_audit(
      v_staff, 'staff', 'site_appearance.reset', 'site_appearance_version', v_id,
      null,
      jsonb_build_object('revision', 1, 'configuration_sha256', v_sha),
      null, null, null
    );
    return query select 'reset'::text, v_id, 1;
    return;
  end if;
  if p_expected_revision is distinct from v_draft.revision then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;
  update public.site_appearance_versions as v
  set configuration = v_empty,
      configuration_sha256 = v_sha,
      revision = v_draft.revision + 1,
      updated_by_user_id = v_staff,
      updated_at = v_now
  where v.id = v_draft.id;
  perform public.decision_audit(
    v_staff, 'staff', 'site_appearance.reset', 'site_appearance_version', v_draft.id,
    jsonb_build_object('revision', v_draft.revision, 'configuration_sha256', v_draft.configuration_sha256),
    jsonb_build_object('revision', v_draft.revision + 1, 'configuration_sha256', v_sha),
    null, null, null
  );
  return query select 'reset'::text, v_draft.id, v_draft.revision + 1;
end;
$function$;

-- Discards a draft at its expected revision. Outcomes: discarded, conflict, not_found, invalid, denied.
create function public.staff_discard_site_appearance_draft(p_draft_id uuid, p_expected_revision integer)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
declare
  v_staff uuid;
  v_draft public.site_appearance_versions;
  v_now timestamptz;
begin
  if p_draft_id is null
     or p_expected_revision is null
     or p_expected_revision not between 1 and 1000000 then
    return 'invalid';
  end if;
  v_staff := public.lock_current_capability_staff('manage_site_appearance', null);
  if v_staff is null then
    return 'denied';
  end if;
  v_now := clock_timestamp();
  select v.* into v_draft
  from public.site_appearance_versions as v
  where v.id = p_draft_id
    and v.state = 'draft'
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_draft.revision is distinct from p_expected_revision then
    return 'conflict';
  end if;
  update public.site_appearance_versions as v
  set state = 'discarded',
      discarded_at = v_now,
      updated_by_user_id = v_staff,
      updated_at = v_now
  where v.id = p_draft_id;
  perform public.decision_audit(
    v_staff, 'staff', 'site_appearance.draft_discarded', 'site_appearance_version', p_draft_id,
    jsonb_build_object('revision', v_draft.revision),
    jsonb_build_object('state', 'discarded'),
    null, null, null
  );
  return 'discarded';
end;
$function$;

-- Stores one image in the library. Outcomes: stored (with the new asset's id and digest), exists (the same bytes are
-- already in the library with the same media type and dimensions: their id and digest; nothing is recorded),
-- limit_reached (100 assets), invalid (a malformed argument, base64 that does not decode, bytes already in the library
-- declared with another media type or other dimensions, or bytes the relation refuses: another format than declared,
-- a size or dimensions out of bounds), denied.
create function public.staff_upload_site_appearance_asset(
  p_media_type text,
  p_width integer,
  p_height integer,
  p_content_base64 text
)
returns table (outcome text, asset_id uuid, sha256 text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '3s'
as $function$
#variable_conflict use_column
declare
  v_staff uuid;
  v_bytes bytea;
  v_sha text;
  v_id uuid;
  v_count integer;
begin
  if p_media_type is null
     or p_media_type not in ('image/png', 'image/jpeg', 'image/webp')
     or p_width is null
     or p_width not between 16 and 4096
     or p_height is null
     or p_height not between 16 and 4096
     or p_content_base64 is null
     or char_length(p_content_base64) not between 1 and 1300000 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  begin
    v_bytes := decode(p_content_base64, 'base64');
  exception
    when invalid_parameter_value then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;
  if octet_length(v_bytes) not between 1 and 900000 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  v_staff := public.lock_current_capability_staff('manage_site_appearance', null);
  if v_staff is null then
    return query select 'denied'::text, null::uuid, null::text;
    return;
  end if;
  v_sha := encode(pg_catalog.sha256(v_bytes), 'hex');
  lock table public.site_appearance_assets in share row exclusive mode;
  select s.id into v_id
  from public.site_appearance_assets as s
  where s.sha256 = v_sha;
  if found then
    if exists (
      select 1
      from public.site_appearance_assets as s
      where s.id = v_id
        and s.media_type = p_media_type
        and s.width = p_width
        and s.height = p_height
    ) then
      return query select 'exists'::text, v_id, v_sha;
    else
      return query select 'invalid'::text, null::uuid, null::text;
    end if;
    return;
  end if;
  select count(*)::integer into v_count from public.site_appearance_assets;
  if v_count >= 100 then
    return query select 'limit_reached'::text, null::uuid, null::text;
    return;
  end if;
  begin
    insert into public.site_appearance_assets (
      sha256, media_type, byte_size, width, height, content, created_by_user_id, created_at
    ) values (
      v_sha, p_media_type, octet_length(v_bytes), p_width, p_height, v_bytes, v_staff, clock_timestamp()
    )
    returning id into v_id;
  exception
    when check_violation then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;
  perform public.decision_audit(
    v_staff, 'staff', 'site_appearance.asset_uploaded', 'site_appearance_asset', v_id,
    null,
    jsonb_build_object(
      'sha256', v_sha, 'media_type', p_media_type, 'byte_size', octet_length(v_bytes), 'width', p_width,
      'height', p_height
    ),
    null, null, null
  );
  return query select 'stored'::text, v_id, v_sha;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------

do $privileges$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.site_appearance_text_allowed(text)',
    'public.site_appearance_shape_valid(jsonb)',
    'public.site_appearance_versions_guard()',
    'public.site_appearance_assets_guard()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.public_site_appearance()',
    'public.public_site_appearance_asset(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to anon, authenticated', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.staff_site_appearance_overview(text)',
    'public.staff_site_appearance_versions(text, integer)',
    'public.staff_site_appearance_version(uuid)',
    'public.staff_site_appearance_preview(text)',
    'public.staff_site_appearance_assets(integer)',
    'public.staff_site_appearance_asset(text)',
    'public.staff_save_site_appearance_draft(text, integer, jsonb)',
    'public.staff_publish_site_appearance(text, uuid, integer, text)',
    'public.staff_restore_site_appearance(uuid, integer)',
    'public.staff_reset_site_appearance(text, integer)',
    'public.staff_discard_site_appearance_draft(uuid, integer)',
    'public.staff_upload_site_appearance_asset(text, integer, integer, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$privileges$;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on table public.site_appearance_versions is
  'DEV-001 website and appearance studio: versions of a theme''s appearance configuration (typed data, never code, markup or CSS): draft, published, superseded or discarded; one draft and one published version per theme; recorded as a new draft, then saved, published or discarded; a published version only becomes superseded; never deleted. No API role holds a privilege; functions only.';
comment on column public.site_appearance_versions.configuration is
  'The validated configuration of schema 1 (site_appearance_shape_valid: no string outside the page texts other than a colour or an identifier, page texts that pass site_appearance_text_allowed, at most 20 asset references, at most 65,536 octets).';
comment on column public.site_appearance_versions.configuration_sha256 is
  'SHA-256 digest (lowercase hex) of the configuration''s database text form.';
comment on column public.site_appearance_versions.revision is
  'The draft''s revision for optimistic concurrency: 1 when recorded, plus 1 at each save; unchanged once published or discarded.';
comment on column public.site_appearance_versions.version_number is
  'The version number assigned at publication (1, 2, ...), unique per theme; null for drafts and discarded drafts.';
comment on table public.site_appearance_assets is
  'DEV-001 website and appearance studio: the image library (PNG, JPEG or WebP only; signature, size, dimensions and digest checked), content-addressed by SHA-256, never changed or deleted. No API role holds a privilege; functions only.';
comment on column public.site_appearance_assets.content is
  'The image bytes as the application stored them after removing their metadata; served only through the published-asset and staff-asset reads.';
comment on table public.site_appearance_activation is
  'DEV-001 website and appearance studio: the one active theme (a single row, written when a version is published). No API role holds a privilege; functions only.';
comment on function public.site_appearance_text_allowed(text) is
  'DEV-001 website and appearance studio (internal): whether a page text is allowed: NFC, 1 to 300 characters, no leading or trailing space or line break, no control (other than a line break), bidirectional or line-separator character, none of < > { } \, no link or contact detail, none of the regulated phrases (recommendation, ranking, qualification, outcome, price and legal-text vocabulary). The application''s appearanceTextAllowed is the same rule.';
comment on function public.site_appearance_shape_valid(jsonb) is
  'DEV-001 website and appearance studio (internal; the configuration constraint): an object of at most 65,536 octets, schema 1, the nine top-level keys only, no null or boolean, strings outside the page texts only colours (#rrggbb) or identifiers, identifier keys, numbers from -1000 to 100000, page texts that pass site_appearance_text_allowed, at most 20 asset references of a digest and a format.';
comment on function public.site_appearance_versions_guard() is
  'DEV-001 website and appearance studio (every role): refuses deletion and truncation, an insert that is not a new draft, any change of identity, theme, schema or creation, and every change other than a draft''s save (next revision), publication or discard and a published version''s supersession.';
comment on function public.site_appearance_assets_guard() is
  'DEV-001 website and appearance studio (every role): refuses every update, deletion and truncation of the image library.';
comment on function public.public_site_appearance() is
  'DEV-001 website and appearance studio: the published version of the active theme (id, number, theme, configuration, digest, publication instant), or nothing; never a draft, superseded or discarded version. Anon and authenticated.';
comment on function public.public_site_appearance_asset(text) is
  'DEV-001 website and appearance studio: one image (media type, unwrapped base64, size) that the published version of the active theme references, or nothing. Anon and authenticated.';
comment on function public.staff_site_appearance_overview(text) is
  'DEV-001 website and appearance studio: exactly one row for holders of manage_site_appearance (global grant, aal2): the theme''s draft (id, revision, configuration, base, update) and published version (id, number, configuration, publication) with nulls where absent, and the active theme; nothing for anyone else.';
comment on function public.staff_site_appearance_versions(text, integer) is
  'DEV-001 website and appearance studio: one page (25 rows, plus one) of a theme''s versions, newest first, without configurations, for holders of manage_site_appearance (global grant, aal2); offsets 0 to 100000.';
comment on function public.staff_site_appearance_version(uuid) is
  'DEV-001 website and appearance studio: one version with its configuration for holders of manage_site_appearance (global grant, aal2); nothing for an unknown id or anyone else.';
comment on function public.staff_site_appearance_preview(text) is
  'DEV-001 website and appearance studio: exactly one row for holders of manage_site_appearance (global grant, aal2): the theme''s draft with its revision, else its published version, else nulls; nothing for anyone else.';
comment on function public.staff_site_appearance_assets(integer) is
  'DEV-001 website and appearance studio: one page (50 rows, plus one) of the image library, newest first, without bytes, for holders of manage_site_appearance (global grant, aal2); offsets 0 to 100000.';
comment on function public.staff_site_appearance_asset(text) is
  'DEV-001 website and appearance studio: one library image (media type, unwrapped base64, size), published or not, for holders of manage_site_appearance (global grant, aal2).';
comment on function public.staff_save_site_appearance_draft(text, integer, jsonb) is
  'DEV-001 website and appearance studio: holders of manage_site_appearance (global grant, aal2) save a theme''s draft (created with no expected revision when none exists, based on the published version; else at the expected revision, plus 1); audited with digests only. Outcomes: created, saved, conflict, invalid, denied.';
comment on function public.staff_publish_site_appearance(text, uuid, integer, text) is
  'DEV-001 website and appearance studio: holders of manage_site_appearance (global grant, aal2) publish a theme''s draft at its expected revision (the previous published version becomes superseded; next version number; the theme becomes active); every referenced asset must be in the library in its format; audited. Outcomes: published, conflict, not_found, invalid, denied.';
comment on function public.staff_restore_site_appearance(uuid, integer) is
  'DEV-001 website and appearance studio: holders of manage_site_appearance (global grant, aal2) make a published or superseded version the draft of its theme (created, or overwritten at the expected revision); audited. Outcomes: restored, conflict, not_found, invalid, denied.';
comment on function public.staff_reset_site_appearance(text, integer) is
  'DEV-001 website and appearance studio: holders of manage_site_appearance (global grant, aal2) replace a theme''s draft with the empty configuration (the owner''s design; created, or overwritten at the expected revision); audited. Outcomes: reset, conflict, invalid, denied.';
comment on function public.staff_discard_site_appearance_draft(uuid, integer) is
  'DEV-001 website and appearance studio: holders of manage_site_appearance (global grant, aal2) discard a draft at its expected revision; audited. Outcomes: discarded, conflict, not_found, invalid, denied.';
comment on function public.staff_upload_site_appearance_asset(text, integer, integer, text) is
  'DEV-001 website and appearance studio: holders of manage_site_appearance (global grant, aal2) store one PNG, JPEG or WebP image (base64, at most 900,000 bytes, 16 to 4096 pixels each way) in the library of at most 100; the same bytes with the same media type and dimensions answer exists and record nothing; audited with digest and size only. Outcomes: stored, exists, limit_reached, invalid, denied.';
