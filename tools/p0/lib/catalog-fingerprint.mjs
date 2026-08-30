import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const CATALOG_FORMAT = "rosuno-p1-catalog-v1";
export const CATALOG_ENCODING = "UTF-8";
export const CATALOG_LINE_ENDING = "LF";
export const CATALOG_HASH_ALGORITHM = "SHA-256";

export const APPROVED_ADVISOR_FINDINGS = [
  "rls_enabled_no_policy_public_application_sessions",
  "rls_enabled_no_policy_public_capability_definitions",
  "rls_enabled_no_policy_public_capability_grants",
];

const CATEGORY_ORDER = [
  "table",
  "column",
  "constraint",
  "index",
  "foreign_key",
  "rls",
  "policy",
  "trigger",
  "function",
  "table_privilege",
  "function_privilege",
];

const CATEGORY_FIELDS = {
  table: ["schema", "name", "kind", "owner", "comment"],
  column: [
    "schema",
    "table",
    "name",
    "ordinal",
    "canonical_type",
    "nullable",
    "default_expression",
  ],
  constraint: [
    "schema",
    "table",
    "name",
    "type",
    "columns",
    "referenced_schema",
    "referenced_table",
    "referenced_columns",
    "definition",
  ],
  index: ["schema", "table", "name", "definition"],
  foreign_key: [
    "schema",
    "table",
    "name",
    "columns",
    "referenced_schema",
    "referenced_table",
    "referenced_columns",
    "definition",
  ],
  rls: ["schema", "table", "enabled", "forced"],
  policy: [
    "schema",
    "table",
    "name",
    "command",
    "roles",
    "permissive",
    "using_expression",
    "check_expression",
  ],
  trigger: ["schema", "table", "name", "function", "definition"],
  function: [
    "schema",
    "name",
    "signature",
    "return_type",
    "language",
    "volatility",
    "security_definer",
    "configuration",
    "definition",
  ],
  table_privilege: [
    "schema",
    "table",
    "principal",
    "principal_name",
    "explicit_privileges",
    "effective_privileges",
  ],
  function_privilege: [
    "schema",
    "function",
    "signature",
    "principal",
    "principal_name",
    "explicit_execute",
    "effective_execute",
  ],
};

const ARRAY_FIELDS = new Set([
  "columns",
  "referenced_columns",
  "roles",
  "configuration",
  "explicit_privileges",
  "effective_privileges",
]);

const SQL_FIELDS = new Set([
  "default_expression",
  "definition",
  "using_expression",
  "check_expression",
]);

const VOLATILE_FIELDS = new Set([
  "oid",
  "xmin",
  "xmax",
  "ctid",
  "transaction_id",
  "created_at",
  "updated_at",
  "observed_at",
  "backend_pid",
  "session_id",
  "tablespace",
  "relfilenode",
  "physical_location",
]);

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSql(value) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("catalog SQL field must be a string or null");
  }
  return value.replace(/\s+/g, " ").trim();
}

function exactObject(value, fields, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const keys = Object.keys(value);
  const missing = fields.filter((field) => !keys.includes(field));
  const extras = keys.filter(
    (field) => !fields.includes(field) && !VOLATILE_FIELDS.has(field),
  );
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `${context} fields are invalid; missing=${missing.join(",") || "none"} extras=${extras.join(",") || "none"}`,
    );
  }
}

function normalizeData(category, data) {
  const fields = CATEGORY_FIELDS[category];
  exactObject(data, fields, `${category} data`);
  const normalized = {};
  for (const field of fields) {
    const value = data[field];
    if (SQL_FIELDS.has(field)) {
      normalized[field] = normalizeSql(value);
    } else if (ARRAY_FIELDS.has(field)) {
      if (!Array.isArray(value)) {
        throw new Error(`${category}.${field} must be an array`);
      }
      const entries = value.map((entry) => {
        if (typeof entry !== "string") {
          throw new Error(`${category}.${field} entries must be strings`);
        }
        return entry;
      });
      normalized[field] = [...entries].sort(compareCodePoints);
    } else {
      if (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      ) {
        throw new Error(`${category}.${field} has an ambiguous value`);
      }
      normalized[field] = value;
    }
  }
  return normalized;
}

export function canonicalizeCatalogRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("catalog rows must be a non-empty array");
  }
  const identities = new Set();
  const categoryCounts = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [category, 0]),
  );
  const normalizedRows = rows.map((row, index) => {
    exactObject(row, ["category", "identity", "data"], `catalog row ${index}`);
    if (!CATEGORY_FIELDS[row.category]) {
      throw new Error(`unsupported catalog category ${row.category}`);
    }
    if (typeof row.identity !== "string" || row.identity.length === 0) {
      throw new Error("catalog identity must be a non-empty string");
    }
    const stableIdentity = `${row.category}:${row.identity}`;
    if (identities.has(stableIdentity)) {
      throw new Error(`duplicate catalog identity ${stableIdentity}`);
    }
    identities.add(stableIdentity);
    categoryCounts[row.category] += 1;
    return {
      category: row.category,
      identity: row.identity,
      data: normalizeData(row.category, row.data),
    };
  });
  for (const category of CATEGORY_ORDER) {
    if (categoryCounts[category] === 0) {
      throw new Error(`required catalog category ${category} is absent`);
    }
  }
  normalizedRows.sort((left, right) => {
    const categoryDifference =
      CATEGORY_ORDER.indexOf(left.category) -
      CATEGORY_ORDER.indexOf(right.category);
    return (
      categoryDifference || compareCodePoints(left.identity, right.identity)
    );
  });
  const snapshot = {
    format: CATALOG_FORMAT,
    encoding: CATALOG_ENCODING,
    line_ending: CATALOG_LINE_ENDING,
    rows: normalizedRows,
  };
  const canonicalBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  return {
    snapshot,
    canonicalBytes,
    sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
    categoryCounts,
  };
}

export function validateCatalogBaseline(baseline) {
  exactObject(
    baseline,
    [
      "version",
      "scope",
      "query_contract",
      "normalization_contract",
      "encoding",
      "line_ending",
      "hashing_algorithm",
      "canonical_byte_length",
      "excluded_metadata",
      "historical_diagnostic",
      "expected_category_counts",
      "sha256",
    ],
    "catalog baseline",
  );
  if (
    baseline.version !== 1 ||
    baseline.scope !== "P1-001 and P1-002 approved Staging catalog surface" ||
    baseline.query_contract !==
      "tools/p0/lib/catalog-fingerprint.mjs#CATALOG_SQL" ||
    baseline.normalization_contract !== CATALOG_FORMAT ||
    baseline.encoding !== CATALOG_ENCODING ||
    baseline.line_ending !== CATALOG_LINE_ENDING ||
    baseline.hashing_algorithm !== CATALOG_HASH_ALGORITHM ||
    !Number.isInteger(baseline.canonical_byte_length) ||
    baseline.canonical_byte_length <= 0 ||
    !Array.isArray(baseline.excluded_metadata) ||
    baseline.excluded_metadata.join("|") !==
      "object identifiers|transaction identifiers|timestamps|physical storage identifiers and locations|generated execution ordering|backend and session values|environment-specific connection values" ||
    baseline.historical_diagnostic?.value !==
      "9984150cd18477095c120c4a38115ff7" ||
    baseline.historical_diagnostic?.status !==
      "non-canonical; derivation was not retained" ||
    !/^[a-f0-9]{64}$/.test(baseline.sha256)
  ) {
    throw new Error("catalog baseline identity is invalid");
  }
  exactObject(
    baseline.expected_category_counts,
    CATEGORY_ORDER,
    "catalog baseline category counts",
  );
  for (const category of CATEGORY_ORDER) {
    if (
      !Number.isInteger(baseline.expected_category_counts[category]) ||
      baseline.expected_category_counts[category] <= 0
    ) {
      throw new Error(`catalog baseline category ${category} is invalid`);
    }
  }
  return baseline;
}

export function verifyCatalogFingerprint(result, baseline) {
  validateCatalogBaseline(baseline);
  if (
    result.sha256 !== baseline.sha256 ||
    result.canonicalBytes.length !== baseline.canonical_byte_length ||
    JSON.stringify(result.categoryCounts) !==
      JSON.stringify(baseline.expected_category_counts)
  ) {
    throw new Error("live catalog fingerprint differs from canonical baseline");
  }
  return true;
}

export function validateAdvisorFindings(findings) {
  if (!Array.isArray(findings)) {
    throw new Error("advisor findings must be an array");
  }
  const identities = findings.map((finding) => {
    exactObject(
      finding,
      ["identity", "name", "level", "schema", "table", "type"],
      "advisor finding",
    );
    if (
      finding.name !== "rls_enabled_no_policy" ||
      finding.level !== "INFO" ||
      finding.schema !== "public" ||
      finding.type !== "table" ||
      finding.identity !== `${finding.name}_${finding.schema}_${finding.table}`
    ) {
      throw new Error(`advisor finding identity changed: ${finding.identity}`);
    }
    return finding.identity;
  });
  if (
    identities.length !== APPROVED_ADVISOR_FINDINGS.length ||
    new Set(identities).size !== identities.length ||
    [...identities].sort(compareCodePoints).join("|") !==
      [...APPROVED_ADVISOR_FINDINGS].sort(compareCodePoints).join("|")
  ) {
    throw new Error(
      "advisor findings contain a missing or unapproved identity",
    );
  }
  return true;
}

export const CATALOG_SQL = String.raw`
WITH
target_tables(schema_name, table_name) AS (
  VALUES
    ('public','users'),
    ('public','client_profiles'),
    ('public','attorney_profiles'),
    ('public','staff_profiles'),
    ('public','capability_definitions'),
    ('public','capability_grants'),
    ('public','application_sessions')
),
target_functions(schema_name, function_name) AS (
  VALUES ('public','rls_auto_enable'), ('public','set_updated_at')
),
principals(principal, role_name) AS (
  VALUES
    ('PUBLIC',NULL::name),
    ('anon','anon'::name),
    ('authenticated','authenticated'::name),
    ('service_role','service_role'::name),
    ('owner',NULL::name)
),
catalog_rows AS (
  SELECT 'table' category, n.nspname||'.'||c.relname identity,
    jsonb_build_object(
      'schema',n.nspname,'name',c.relname,'kind',
      CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' ELSE c.relkind::text END,
      'owner',pg_get_userbyid(c.relowner),'comment',obj_description(c.oid,'pg_class')
    ) data
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname
  WHERE c.relkind IN ('r','p')

  UNION ALL
  SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',a.attname,'ordinal',a.attnum,
      'canonical_type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,
      'default_expression',CASE WHEN d.oid IS NULL THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END
    )
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped

  UNION ALL
  SELECT 'constraint',n.nspname||'.'||r.relname||'.'||con.conname,
    jsonb_build_object(
      'schema',n.nspname,'table',r.relname,'name',con.conname,'type',con.contype::text,
      'columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.conkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=u.attnum),'[]'::jsonb),
      'referenced_schema',rn.nspname,'referenced_table',rr.relname,
      'referenced_columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.confkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=u.attnum),'[]'::jsonb),
      'definition',pg_get_constraintdef(con.oid,true)
    )
  FROM pg_constraint con JOIN pg_class r ON r.oid=con.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=r.relname
  LEFT JOIN pg_class rr ON rr.oid=con.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rr.relnamespace

  UNION ALL
  SELECT 'index',n.nspname||'.'||r.relname||'.'||i.relname,
    jsonb_build_object('schema',n.nspname,'table',r.relname,'name',i.relname,'definition',pg_get_indexdef(i.oid))
  FROM pg_index x JOIN pg_class r ON r.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
  JOIN pg_namespace n ON n.oid=r.relnamespace JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=r.relname

  UNION ALL
  SELECT 'foreign_key',n.nspname||'.'||r.relname||'.'||con.conname,
    jsonb_build_object(
      'schema',n.nspname,'table',r.relname,'name',con.conname,
      'columns',(SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.conkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=u.attnum),
      'referenced_schema',rn.nspname,'referenced_table',rr.relname,
      'referenced_columns',(SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.confkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=u.attnum),
      'definition',pg_get_constraintdef(con.oid,true)
    )
  FROM pg_constraint con JOIN pg_class r ON r.oid=con.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=r.relname
  JOIN pg_class rr ON rr.oid=con.confrelid JOIN pg_namespace rn ON rn.oid=rr.relnamespace
  WHERE con.contype='f'

  UNION ALL
  SELECT 'rls',n.nspname||'.'||c.relname,
    jsonb_build_object('schema',n.nspname,'table',c.relname,'enabled',c.relrowsecurity,'forced',c.relforcerowsecurity)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname

  UNION ALL
  SELECT 'policy',n.nspname||'.'||c.relname||'.'||p.polname,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',p.polname,
      'command',CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END) FROM unnest(p.polroles) role_oid),
      'permissive',p.polpermissive,'using_expression',pg_get_expr(p.polqual,p.polrelid),
      'check_expression',pg_get_expr(p.polwithcheck,p.polrelid)
    )
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname

  UNION ALL
  SELECT 'trigger',n.nspname||'.'||c.relname||'.'||tr.tgname,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',tr.tgname,'function',pn.nspname||'.'||pr.proname,
      'definition',pg_get_triggerdef(tr.oid,true)
    )
  FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname
  JOIN pg_proc pr ON pr.oid=tr.tgfoid JOIN pg_namespace pn ON pn.oid=pr.pronamespace
  WHERE NOT tr.tgisinternal

  UNION ALL
  SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    jsonb_build_object(
      'schema',n.nspname,'name',p.proname,'signature',pg_get_function_identity_arguments(p.oid),
      'return_type',pg_get_function_result(p.oid),'language',l.lanname,
      'volatility',CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END,
      'security_definer',p.prosecdef,
      'configuration',COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM unnest(p.proconfig) value),'[]'::jsonb),
      'definition',pg_get_functiondef(p.oid)
    )
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  JOIN target_functions f ON f.schema_name=n.nspname AND f.function_name=p.proname

  UNION ALL
  SELECT 'table_privilege',n.nspname||'.'||c.relname||'.'||pr.principal,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'principal',pr.principal,
      'principal_name',CASE WHEN pr.principal='owner' THEN pg_get_userbyid(c.relowner) ELSE pr.role_name::text END,
      'explicit_privileges',COALESCE((
        SELECT jsonb_agg(e.privilege_type ORDER BY e.privilege_type)
        FROM aclexplode(c.relacl) e
        WHERE e.grantee=CASE WHEN pr.principal='PUBLIC' THEN 0 WHEN pr.principal='owner' THEN c.relowner ELSE (SELECT oid FROM pg_roles WHERE rolname=pr.role_name) END
      ),'[]'::jsonb),
      'effective_privileges',CASE WHEN pr.principal='PUBLIC' THEN '[]'::jsonb ELSE COALESCE((
        SELECT jsonb_agg(operation ORDER BY operation)
        FROM unnest(ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) operation
        WHERE has_table_privilege(CASE WHEN pr.principal='owner' THEN pg_get_userbyid(c.relowner) ELSE pr.role_name::text END,c.oid,operation)
      ),'[]'::jsonb) END
    )
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname CROSS JOIN principals pr

  UNION ALL
  SELECT 'function_privilege',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||').'||pr.principal,
    jsonb_build_object(
      'schema',n.nspname,'function',p.proname,'signature',pg_get_function_identity_arguments(p.oid),
      'principal',pr.principal,
      'principal_name',CASE WHEN pr.principal='owner' THEN pg_get_userbyid(p.proowner) ELSE pr.role_name::text END,
      'explicit_execute',EXISTS(
        SELECT 1 FROM aclexplode(p.proacl) e
        WHERE e.grantee=CASE WHEN pr.principal='PUBLIC' THEN 0 WHEN pr.principal='owner' THEN p.proowner ELSE (SELECT oid FROM pg_roles WHERE rolname=pr.role_name) END
          AND e.privilege_type='EXECUTE'
      ),
      'effective_execute',CASE WHEN pr.principal='PUBLIC' THEN NULL ELSE has_function_privilege(CASE WHEN pr.principal='owner' THEN pg_get_userbyid(p.proowner) ELSE pr.role_name::text END,p.oid,'EXECUTE') END
    )
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN target_functions f ON f.schema_name=n.nspname AND f.function_name=p.proname CROSS JOIN principals pr
)
SELECT jsonb_build_object('category',category,'identity',identity,'data',data)::text
FROM catalog_rows
ORDER BY CASE category
  WHEN 'table' THEN 1 WHEN 'column' THEN 2 WHEN 'constraint' THEN 3 WHEN 'index' THEN 4
  WHEN 'foreign_key' THEN 5 WHEN 'rls' THEN 6 WHEN 'policy' THEN 7 WHEN 'trigger' THEN 8
  WHEN 'function' THEN 9 WHEN 'table_privilege' THEN 10 WHEN 'function_privilege' THEN 11
  ELSE 99 END, identity COLLATE "C";
`;

export function queryCatalog(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    throw new Error("database URL is required through the environment");
  }
  const connection = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(connection.protocol) ||
    !connection.hostname ||
    !connection.username
  ) {
    throw new Error("database URL is not a valid PostgreSQL connection");
  }
  const databaseName = connection.pathname.replace(/^\/+/, "");
  if (!databaseName) {
    throw new Error("database URL does not name a database");
  }
  const output = execFileSync(
    "psql",
    [
      "-X",
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--command",
      CATALOG_SQL,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PGHOST: connection.hostname,
        PGPORT: connection.port || "5432",
        PGUSER: decodeURIComponent(connection.username),
        PGPASSWORD: decodeURIComponent(connection.password),
        PGDATABASE: decodeURIComponent(databaseName),
        PGSSLMODE: connection.searchParams.get("sslmode") || "require",
        PGCONNECT_TIMEOUT: "20",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const rows = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return canonicalizeCatalogRows(rows);
}
