import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  P1_REGULATORY_CATALOG_SQL,
  ROOT,
  scanSecretLikeText,
  validateCiWorkflow,
  validateDecisionRecord,
  validateDriftReport,
  validateEnvironmentContract,
  validateMigrationArtifact,
  validateMigrationRegister,
  validateNeutralPaths,
  validatePackageJson,
  validateP0CliInventory,
  validateP0InventoryReconciliation,
  validateP1AuthorizationMigration,
  validateP1ApplicationTraceability,
  validateP1PlatformEvidence,
  validateP1PlatformMigration,
  validateP1RegulatoryCatalog,
  validateP1RegulatoryEvidence,
  validateP1RegulatoryMigration,
  validateP1RegulatoryTraceability,
  validateReleaseRegister,
  validateRepository,
  validateRestoreEvidence,
  validateSchemaArtifact,
  validateTraceabilityConsistency,
  validateWorkItem,
} from "../lib/controls.mjs";

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function validDecision() {
  return {
    decision_id: "DEC-20260828-TEST",
    title: "Test control decision",
    status: "proposed",
    scope: "P0 test scope",
    decision: "Use the tested control",
    rationale: "The control has explicit evidence",
    authority_refs: ["P0-001-LOCKED"],
    work_item_refs: [],
    owner: "test-owner",
    reviewer: {
      identity: null,
      status: "unresolved_external_dependency",
    },
    created_at: "2026-08-28T10:00:00Z",
    updated_at: "2026-08-28T10:00:00Z",
    supersedes: [],
    impact: "Local control test",
    evidence: ["governance/README.md"],
    expiry: null,
  };
}

function validWorkItem() {
  return {
    work_item_id: "WI-P0-TEST",
    title: "Test bounded work item",
    objective: "Verify semantic work-item controls",
    in_scope: ["P0 validation"],
    out_of_scope: ["Product implementation"],
    status: "proposed",
    owner: "test-owner",
    reviewer: {
      identity: null,
      status: "unresolved_external_dependency",
    },
    priority: "P0",
    authority_refs: ["P0-001-LOCKED"],
    decision_refs: [],
    dependencies: [],
    acceptance_criteria: ["Invalid values are rejected"],
    validation_commands: ["pnpm run p0:test"],
    environment: "none",
    release_refs: [],
    migration_refs: [],
    rollback_reference: "governance/rollback-recovery.md",
    created_at: "2026-08-28T10:00:00Z",
    updated_at: "2026-08-28T10:00:00Z",
  };
}

const p1RegulatoryConstraintSpecifications = `
jurisdictions|jurisdictions_pkey|p
jurisdictions|jurisdictions_code_key|u
jurisdictions|jurisdictions_code_check|c
jurisdictions|jurisdictions_lifecycle_state_check|c
jurisdictions|jurisdictions_require_launch_authorization|t
service_areas|service_areas_pkey|p
service_areas|service_areas_jurisdiction_id_code_key|u
service_areas|service_areas_jurisdiction_id_fkey|f
service_areas|service_areas_code_check|c
service_areas|service_areas_effective_period_check|c
regulatory_modes|regulatory_modes_pkey|p
regulatory_modes|regulatory_modes_code_key|u
regulatory_modes|regulatory_modes_code_check|c
jurisdiction_regulatory_modes|jurisdiction_regulatory_modes_pkey|p
jurisdiction_regulatory_modes|jurisdiction_regulatory_modes_jurisdiction_id_fkey|f
jurisdiction_regulatory_modes|jurisdiction_regulatory_modes_regulatory_mode_id_fkey|f
jurisdiction_regulatory_modes|jurisdiction_regulatory_modes_effective_period_check|c
policy_types|policy_types_pkey|p
policy_types|policy_types_code_check|c
policy_versions|policy_versions_pkey|p
policy_versions|policy_versions_scope_version_key|u
policy_versions|policy_versions_policy_type_code_fkey|f
policy_versions|policy_versions_jurisdiction_id_fkey|f
policy_versions|policy_versions_regulatory_mode_id_fkey|f
policy_versions|policy_versions_approved_by_user_id_fkey|f
policy_versions|policy_versions_supersedes_policy_version_id_fkey|f
policy_versions|policy_versions_parameters_check|c
policy_versions|policy_versions_status_check|c
policy_versions|policy_versions_effective_period_check|c
policy_versions|policy_versions_approval_pair_check|c
policy_versions|policy_versions_approval_state_check|c
policy_versions|policy_versions_effective_state_check|c
policy_versions|policy_versions_not_self_superseding_check|c
policy_versions|policy_versions_require_authority|t
policy_authority_references|policy_authority_references_pkey|p
policy_authority_references|policy_authority_references_policy_version_id_fkey|f
policy_authority_references|policy_authority_references_verified_by_user_id_fkey|f
policy_authority_references|policy_authority_references_verified_actor_check|c
policy_authority_references|policy_authority_references_preserve_approval|t
launch_gates|launch_gates_pkey|p
launch_gates|launch_gates_jurisdiction_id_gate_code_key|u
launch_gates|launch_gates_jurisdiction_id_fkey|f
launch_gates|launch_gates_gate_code_check|c
launch_gate_evaluations|launch_gate_evaluations_pkey|p
launch_gate_evaluations|launch_gate_evaluations_launch_gate_id_fkey|f
launch_gate_evaluations|launch_gate_evaluations_evaluated_by_user_id_fkey|f
launch_gate_evaluations|launch_gate_evaluations_evidence_reference_check|c
launch_authorizations|launch_authorizations_pkey|p
launch_authorizations|launch_authorizations_jurisdiction_id_fkey|f
launch_authorizations|launch_authorizations_authorized_by_user_id_fkey|f
launch_authorizations|launch_authorizations_reason_check|c
launch_authorizations|launch_authorizations_revoked_at_check|c
launch_authorizations|launch_authorizations_preserve_live_boundary|t
`
  .trim()
  .split("\n")
  .map((line) => line.split("|"));

const p1RegulatoryForeignKeySpecifications = `
service_areas|service_areas_jurisdiction_id_fkey|jurisdiction_id|jurisdictions|id
jurisdiction_regulatory_modes|jurisdiction_regulatory_modes_jurisdiction_id_fkey|jurisdiction_id|jurisdictions|id
jurisdiction_regulatory_modes|jurisdiction_regulatory_modes_regulatory_mode_id_fkey|regulatory_mode_id|regulatory_modes|id
policy_versions|policy_versions_policy_type_code_fkey|policy_type_code|policy_types|code
policy_versions|policy_versions_jurisdiction_id_fkey|jurisdiction_id|jurisdictions|id
policy_versions|policy_versions_regulatory_mode_id_fkey|regulatory_mode_id|regulatory_modes|id
policy_versions|policy_versions_approved_by_user_id_fkey|approved_by_user_id|users|id
policy_versions|policy_versions_supersedes_policy_version_id_fkey|supersedes_policy_version_id|policy_versions|id
policy_authority_references|policy_authority_references_policy_version_id_fkey|policy_version_id|policy_versions|id
policy_authority_references|policy_authority_references_verified_by_user_id_fkey|verified_by_user_id|users|id
launch_gates|launch_gates_jurisdiction_id_fkey|jurisdiction_id|jurisdictions|id
launch_gate_evaluations|launch_gate_evaluations_launch_gate_id_fkey|launch_gate_id|launch_gates|id
launch_gate_evaluations|launch_gate_evaluations_evaluated_by_user_id_fkey|evaluated_by_user_id|users|id
launch_authorizations|launch_authorizations_jurisdiction_id_fkey|jurisdiction_id|jurisdictions|id
launch_authorizations|launch_authorizations_authorized_by_user_id_fkey|authorized_by_user_id|users|id
capability_grants|capability_grants_jurisdiction_id_fkey|jurisdiction_id|jurisdictions|id
`
  .trim()
  .split("\n")
  .map((line) => line.split("|"));

const p1RegulatoryIndexSpecifications = [
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_pkey",
    ["jurisdiction_id", "regulatory_mode_id", "active_from"],
    true,
    "p",
  ],
  ["jurisdictions", "jurisdictions_code_key", ["code"], false, "u"],
  ["jurisdictions", "jurisdictions_pkey", ["id"], true, "p"],
  ["launch_authorizations", "launch_authorizations_pkey", ["id"], true, "p"],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_pkey",
    ["id"],
    true,
    "p",
  ],
  [
    "launch_gates",
    "launch_gates_jurisdiction_id_gate_code_key",
    ["jurisdiction_id", "gate_code"],
    false,
    "u",
  ],
  ["launch_gates", "launch_gates_pkey", ["id"], true, "p"],
  [
    "policy_authority_references",
    "policy_authority_references_pkey",
    ["id"],
    true,
    "p",
  ],
  ["policy_types", "policy_types_pkey", ["code"], true, "p"],
  ["policy_versions", "policy_versions_pkey", ["id"], true, "p"],
  [
    "policy_versions",
    "policy_versions_scope_version_key",
    [
      "policy_type_code",
      "jurisdiction_id",
      "regulatory_mode_id",
      "version_label",
    ],
    false,
    "u",
  ],
  ["regulatory_modes", "regulatory_modes_code_key", ["code"], false, "u"],
  ["regulatory_modes", "regulatory_modes_pkey", ["id"], true, "p"],
  [
    "service_areas",
    "service_areas_jurisdiction_id_code_key",
    ["jurisdiction_id", "code"],
    false,
    "u",
  ],
  ["service_areas", "service_areas_pkey", ["id"], true, "p"],
];

function p1RegulatoryCatalogFixture() {
  const foreignKeys = p1RegulatoryForeignKeySpecifications.map(
    ([table, name, column, referencedTable, referencedColumn]) => ({
      schema: "public",
      table,
      name,
      columns: [column],
      referenced_schema: "public",
      referenced_table: referencedTable,
      referenced_columns: [referencedColumn],
      definition: `FOREIGN KEY (${column}) REFERENCES ${referencedTable}(${referencedColumn}) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      update_action: "RESTRICT",
      delete_action: "RESTRICT",
      deferrable: false,
      initially_deferred: false,
      validated: true,
    }),
  );
  const foreignKeysByIdentity = new Map(
    foreignKeys.map((foreignKey) => [
      `${foreignKey.table}.${foreignKey.name}`,
      foreignKey,
    ]),
  );
  return {
    constraints: p1RegulatoryConstraintSpecifications.map(
      ([table, name, type]) => {
        const foreignKey = foreignKeysByIdentity.get(`${table}.${name}`);
        return {
          schema: "public",
          table,
          name,
          type,
          definition:
            type === "t"
              ? "TRIGGER"
              : foreignKey?.definition || `${type.toUpperCase()} (${name})`,
          referenced_schema: foreignKey?.referenced_schema || null,
          referenced_table: foreignKey?.referenced_table || null,
        };
      },
    ),
    indexes: p1RegulatoryIndexSpecifications.map(
      ([table, name, columns, isPrimary, constraintType]) => ({
        schema: "public",
        table,
        name,
        columns,
        is_unique: true,
        is_primary: isPrimary,
        constraint_backed: true,
        associated_constraint_name: name,
        associated_constraint_type: constraintType,
        definition: `CREATE UNIQUE INDEX ${name} ON public.${table} (${columns.join(", ")})`,
      }),
    ),
    foreign_keys: foreignKeys,
  };
}

test("neutral P0 control foundation validates successfully", () => {
  assert.doesNotThrow(() => validateRepository());
});

test("historical P0 CLI inventory is exact and bounded", () => {
  const sql = readFileSync(
    path.join(
      ROOT,
      "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql",
    ),
    "utf8",
  );
  const evidence = readJson(
    "governance/evidence/p0-cli-inventory-reconciliation.json",
  );
  const migration = readJson("governance/migrations/reviewed-migrations.json")
    .migrations[0];

  assert.doesNotThrow(() =>
    validateP0InventoryReconciliation(evidence, migration, sql),
  );
  assert.throws(
    () => validateP0CliInventory(sql, "supabase/migrations/wrong.sql"),
    /path/,
  );
  assert.throws(
    () =>
      validateP0CliInventory(`${sql}\nREVOKE ALL ON SCHEMA public FROM anon;`),
    /exactly the stored single/,
  );
  assert.throws(
    () =>
      validateP0CliInventory(sql.replace("authenticated;", "service_role;")),
    /exactly the stored single/,
  );
  assert.throws(
    () =>
      validateP0CliInventory(
        sql.replace("REVOKE EXECUTE ON FUNCTION", "GRANT EXECUTE ON FUNCTION"),
      ),
    /exactly the stored single/,
  );

  const wrongVersion = structuredClone(evidence);
  wrongVersion.inventory_artifact.version = "20260828192127";
  assert.throws(
    () => validateP0InventoryReconciliation(wrongVersion, migration, sql),
    /inventory_artifact/,
  );
  const wrongName = structuredClone(evidence);
  wrongName.inventory_artifact.name = "wrong_name";
  assert.throws(
    () => validateP0InventoryReconciliation(wrongName, migration, sql),
    /inventory_artifact/,
  );
  const alteredIntent = structuredClone(evidence);
  alteredIntent.reconciliation.statement_semantics =
    "revoke direct EXECUTE from PUBLIC only";
  assert.throws(
    () => validateP0InventoryReconciliation(alteredIntent, migration, sql),
    /reconciliation/,
  );
});

test("P1 migration bytes remain exact and byte changes are rejected", () => {
  const p1PlatformPath =
    "supabase/migrations/20260829000015_p1_platform_foundation.sql";
  const p1AuthorizationPath =
    "supabase/migrations/20260829171701_p1_authorization_foundation.sql";
  const p1PlatformSql = readFileSync(path.join(ROOT, p1PlatformPath), "utf8");
  const p1AuthorizationSql = readFileSync(
    path.join(ROOT, p1AuthorizationPath),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(p1PlatformSql).digest("hex"),
    "67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8",
  );
  assert.equal(
    createHash("sha256").update(p1AuthorizationSql).digest("hex"),
    "6471ac68949234e29ae1cc492eaa2f77dc15ca010998f72898284b8c9a855fec",
  );
  const register = readJson("governance/migrations/reviewed-migrations.json");
  assert.throws(
    () =>
      validateP1PlatformMigration(
        p1PlatformSql.replace("public.users", "public.changed_users"),
        register.migrations[1],
      ),
    /only public.users/,
  );
  assert.throws(
    () =>
      validateP1AuthorizationMigration(
        p1AuthorizationSql.replace(
          "public.client_profiles",
          "public.changed_profiles",
        ),
        register.migrations[2],
      ),
    /six authorized Migration 2 tables|client_profiles/,
  );
});

test("P1-002 requires the restrictive application-session user foreign key", () => {
  const sql = readFileSync(
    path.join(
      ROOT,
      "supabase/migrations/20260829171701_p1_authorization_foundation.sql",
    ),
    "utf8",
  );
  const migration = readJson("governance/migrations/reviewed-migrations.json")
    .migrations[2];
  const sessionUserForeignKey = `constraint application_sessions_user_id_fkey
    foreign key (user_id)
    references public.users (id)
    on update restrict
    on delete restrict`;

  assert.doesNotThrow(() => validateP1AuthorizationMigration(sql, migration));
  assert.ok(sql.includes(sessionUserForeignKey));

  const invalidVariants = [
    sql.replace(sessionUserForeignKey, ""),
    sql.replace(
      "application_sessions_user_id_fkey",
      "application_sessions_account_id_fkey",
    ),
    sql.replace(
      sessionUserForeignKey,
      sessionUserForeignKey.replace("public.users", "public.changed_users"),
    ),
    sql.replace(
      sessionUserForeignKey,
      sessionUserForeignKey.replace("on delete restrict", "on delete cascade"),
    ),
  ];

  for (const invalidSql of invalidVariants) {
    assert.throws(
      () => validateP1AuthorizationMigration(invalidSql, migration),
      /missing/,
    );
  }
});

test("P1-003 remains inside the jurisdiction policy and launch boundary", () => {
  const sql = readFileSync(
    path.join(
      ROOT,
      "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
    ),
    "utf8",
  );
  const migration = readJson("governance/migrations/reviewed-migrations.json")
    .migrations[3];
  assert.doesNotThrow(() => validateP1RegulatoryMigration(sql, migration));

  const invalidVariants = [
    sql.replace(
      "create table public.service_areas",
      "create table public.changed_areas",
    ),
    sql.replace(
      "constraint capability_grants_jurisdiction_id_fkey",
      "constraint changed_capability_grants_jurisdiction_id_fkey",
    ),
    sql.replace(
      "capability_grants_jurisdiction_id_fkey\n  foreign key (jurisdiction_id)\n  references public.jurisdictions (id)\n  on update restrict\n  on delete restrict",
      "capability_grants_jurisdiction_id_fkey\n  foreign key (jurisdiction_id)\n  references public.jurisdictions (id)\n  on update restrict\n  on delete cascade",
    ),
    sql.replace(
      "alter table public.launch_authorizations enable row level security;",
      "",
    ),
    `${sql}\ncreate policy client_launch_read on public.launch_gates for select to authenticated using (true);`,
    sql.replace(
      "grant select, insert, update on table public.launch_authorizations to service_role;",
      "grant select, insert, update, delete on table public.launch_authorizations to service_role;",
    ),
    sql.replace(
      "approved policy version requires verified authority provenance",
      "approval bypassed",
    ),
    sql.replace(
      "live jurisdiction requires explicit active launch authorization",
      "live allowed without authorization",
    ),
    `${sql}\ninsert into public.jurisdictions (code, name, region_type) values ('TEST', 'Test', 'test');`,
    `${sql}\ncomment on schema public is 'California LRS';`,
    `${sql}\ncreate table public.attorney_service_areas (id uuid primary key);`,
  ];

  for (const invalidSql of invalidVariants) {
    assert.throws(() => validateP1RegulatoryMigration(invalidSql, migration));
  }

  const evidencePath =
    "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json";
  const evidence = readJson(evidencePath);
  assert.doesNotThrow(() => validateP1RegulatoryEvidence(evidence, sql));

  const duplicateHistory = readJson(evidencePath);
  duplicateHistory.persistent_application_validation.migration_history[3].occurrences = 2;
  assert.throws(
    () => validateP1RegulatoryEvidence(duplicateHistory, sql),
    /migration history/,
  );

  const unapprovedAdvisorFinding = readJson(evidencePath);
  unapprovedAdvisorFinding.security.approved_info_findings.push(
    "rls_enabled_no_policy:public.unapproved_table",
  );
  assert.throws(
    () => validateP1RegulatoryEvidence(unapprovedAdvisorFinding, sql),
    /security acceptance/,
  );

  const falseOldInspection = readJson(evidencePath);
  falseOldInspection.environment_integrity.old_read_only_listing = "passed";
  assert.throws(
    () => validateP1RegulatoryEvidence(falseOldInspection, sql),
    /environment or acceptance state/,
  );
});

test("P1-003 catalog validator accepts the exact reviewed classifications", () => {
  const result = validateP1RegulatoryCatalog(p1RegulatoryCatalogFixture());
  assert.deepEqual(result, {
    total_constraint_rows: 53,
    ordinary_constraints: 49,
    constraint_triggers: 4,
    constraint_backed_indexes: 15,
    standalone_indexes: 0,
    new_table_foreign_keys: 15,
    capability_grants_foreign_keys: 1,
    total_p1_003_foreign_keys: 16,
  });
  assert.match(
    P1_REGULATORY_CATALOG_SQL,
    /own_constraint\.conindid\s*=\s*idx\.oid[\s\S]*?own_constraint\.conrelid\s*=\s*tbl\.oid[\s\S]*?own_constraint\.contype\s+IN\s*\(\s*'p'\s*,\s*'u'\s*,\s*'x'\s*\)/i,
  );
});

test("P1-003 catalog validator classifies constraint triggers without weakening extras", () => {
  const wrongTriggerType = p1RegulatoryCatalogFixture();
  wrongTriggerType.constraints.find(
    (constraint) => constraint.name === "policy_versions_require_authority",
  ).type = "c";
  assert.throws(
    () => validateP1RegulatoryCatalog(wrongTriggerType),
    /wrong constraint type|ordinary\/trigger classification/,
  );

  const missingTrigger = p1RegulatoryCatalogFixture();
  missingTrigger.constraints = missingTrigger.constraints.filter(
    (constraint) =>
      constraint.name !== "jurisdictions_require_launch_authorization",
  );
  assert.throws(
    () => validateP1RegulatoryCatalog(missingTrigger),
    /exactly 53 rows|missing/,
  );

  const unexpectedConstraint = p1RegulatoryCatalogFixture();
  unexpectedConstraint.constraints.find(
    (constraint) => constraint.name === "jurisdictions_code_check",
  ).name = "jurisdictions_unreviewed_check";
  assert.throws(
    () => validateP1RegulatoryCatalog(unexpectedConstraint),
    /unexpected constraint/,
  );
});

test("P1-003 catalog validator accepts only the 15 constraint-backed indexes", () => {
  const wrongBacking = p1RegulatoryCatalogFixture();
  wrongBacking.indexes[0].constraint_backed = false;
  wrongBacking.indexes[0].associated_constraint_name = null;
  wrongBacking.indexes[0].associated_constraint_type = null;
  assert.throws(
    () => validateP1RegulatoryCatalog(wrongBacking),
    /reviewed constraint-backed index/,
  );

  const unexpectedStandalone = p1RegulatoryCatalogFixture();
  Object.assign(unexpectedStandalone.indexes[0], {
    name: "jurisdictions_unreviewed_idx",
    columns: ["name"],
    is_unique: false,
    is_primary: false,
    constraint_backed: false,
    associated_constraint_name: null,
    associated_constraint_type: null,
    definition:
      "CREATE INDEX jurisdictions_unreviewed_idx ON public.jurisdictions (name)",
  });
  assert.throws(
    () => validateP1RegulatoryCatalog(unexpectedStandalone),
    /unexpected standalone/,
  );
});

test("P1-003 capability-grant FK validation is structural and fails closed", () => {
  const renderedVariants = [
    "FOREIGN KEY (jurisdiction_id) REFERENCES jurisdictions(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
    "FOREIGN KEY (jurisdiction_id) REFERENCES public.jurisdictions (id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  ];
  for (const definition of renderedVariants) {
    const catalog = p1RegulatoryCatalogFixture();
    catalog.foreign_keys.find(
      (foreignKey) =>
        foreignKey.name === "capability_grants_jurisdiction_id_fkey",
    ).definition = definition;
    assert.doesNotThrow(() => validateP1RegulatoryCatalog(catalog));
  }

  const structuralMutations = [
    (foreignKey) => (foreignKey.referenced_table = "changed_jurisdictions"),
    (foreignKey) => (foreignKey.referenced_columns = ["changed_id"]),
    (foreignKey) => (foreignKey.update_action = "CASCADE"),
    (foreignKey) => (foreignKey.delete_action = "CASCADE"),
    (foreignKey) => (foreignKey.validated = false),
    (foreignKey) => (foreignKey.deferrable = true),
    (foreignKey) => (foreignKey.initially_deferred = true),
  ];
  for (const mutate of structuralMutations) {
    const catalog = p1RegulatoryCatalogFixture();
    mutate(
      catalog.foreign_keys.find(
        (foreignKey) =>
          foreignKey.name === "capability_grants_jurisdiction_id_fkey",
      ),
    );
    assert.throws(
      () => validateP1RegulatoryCatalog(catalog),
      /structurally different/,
    );
  }

  const missingCapabilityGrantForeignKey = p1RegulatoryCatalogFixture();
  missingCapabilityGrantForeignKey.foreign_keys =
    missingCapabilityGrantForeignKey.foreign_keys.filter(
      (foreignKey) =>
        foreignKey.name !== "capability_grants_jurisdiction_id_fkey",
    );
  assert.throws(
    () => validateP1RegulatoryCatalog(missingCapabilityGrantForeignKey),
    /exactly 16 rows|missing/,
  );
});

test("authorized P1 platform migration stays inside Migration 1", () => {
  const sql = readFileSync(
    path.join(
      ROOT,
      "supabase/migrations/20260829000015_p1_platform_foundation.sql",
    ),
    "utf8",
  );
  const migration = readJson("governance/migrations/reviewed-migrations.json")
    .migrations[1];
  assert.doesNotThrow(() => validateP1PlatformMigration(sql, migration));

  assert.throws(
    () =>
      validateP1PlatformMigration(
        `${sql}\ncreate table public.client_profiles (id uuid);`,
        migration,
      ),
    /only public.users|Migration 1 boundary/,
  );
  assert.throws(
    () =>
      validateP1PlatformMigration(
        sql.replace("security invoker", "security definer"),
        migration,
      ),
    /SECURITY DEFINER|missing/,
  );
  assert.throws(
    () =>
      validateP1PlatformMigration(
        `${sql}\ncreate extension if not exists btree_gist;`,
        migration,
      ),
    /extension dependency/,
  );
  assert.throws(
    () =>
      validateP1PlatformMigration(
        sql.replace("revoke all on table public.users from service_role;", ""),
        migration,
      ),
    /service_role/,
  );
});

test("P1 applied evidence is complete and cannot weaken history or security", () => {
  const sql = readFileSync(
    path.join(
      ROOT,
      "supabase/migrations/20260829000015_p1_platform_foundation.sql",
    ),
    "utf8",
  );
  const evidence = readJson(
    "governance/evidence/p1-001-platform-foundation.json",
  );
  assert.doesNotThrow(() => validateP1PlatformEvidence(evidence, sql));

  evidence.migration.persistent_application = false;
  assert.throws(
    () => validateP1PlatformEvidence(evidence, sql),
    /migration record/,
  );

  const duplicateHistory = readJson(
    "governance/evidence/p1-001-platform-foundation.json",
  );
  duplicateHistory.persistent_application_validation.migration_history.reviewed_occurrences = 2;
  assert.throws(
    () => validateP1PlatformEvidence(duplicateHistory, sql),
    /migration history/,
  );

  const generatedHistory = readJson(
    "governance/evidence/p1-001-platform-foundation.json",
  );
  generatedHistory.persistent_application_validation.migration_history.generated_occurrences = 1;
  assert.throws(
    () => validateP1PlatformEvidence(generatedHistory, sql),
    /migration history/,
  );

  const rerun = readJson("governance/evidence/p1-001-platform-foundation.json");
  rerun.persistent_application_validation.history_reconciliation.migration_sql_rerun = true;
  assert.throws(
    () => validateP1PlatformEvidence(rerun, sql),
    /history reconciliation/,
  );

  const production = readJson(
    "governance/evidence/p1-001-platform-foundation.json",
  );
  production.persistent_application_validation.non_target_integrity.production_accessed = true;
  assert.throws(
    () => validateP1PlatformEvidence(production, sql),
    /non-target integrity/,
  );

  const weakened = readJson(
    "governance/evidence/p1-001-platform-foundation.json",
  );
  weakened.security.anon_table_privileges = ["SELECT"];
  assert.throws(
    () => validateP1PlatformEvidence(weakened, sql),
    /security state/,
  );
});

test("P1 applied records require bounded approved Staging traceability", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");

  assert.doesNotThrow(() =>
    validateP1ApplicationTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );
  assert.doesNotThrow(() =>
    validateP1RegulatoryTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  const weakenedP1RegulatoryRelease = structuredClone(releases);
  weakenedP1RegulatoryRelease.releases.find(
    (release) =>
      release.release_id === "REL-20260830-P1-003-STAGING-APPLICATION",
  ).artifact_digest = `sha256:${"b".repeat(64)}`;
  assert.throws(
    () =>
      validateP1RegulatoryTraceability(
        migrations,
        workItems,
        decisions,
        weakenedP1RegulatoryRelease,
      ),
    /P1-003 Staging traceability/,
  );

  const wrongDigest = structuredClone(releases);
  wrongDigest.releases[1].artifact_digest = `sha256:${"a".repeat(64)}`;
  assert.throws(
    () =>
      validateP1ApplicationTraceability(
        migrations,
        workItems,
        decisions,
        wrongDigest,
      ),
    /Staging traceability/,
  );

  const pendingReview = structuredClone(decisions);
  pendingReview.decisions[1].reviewer.status = "pending";
  assert.throws(
    () =>
      validateP1ApplicationTraceability(
        migrations,
        workItems,
        pendingReview,
        releases,
      ),
    /decision traceability/,
  );

  const productionRelease = structuredClone(releases);
  productionRelease.releases[1].environment = "production";
  assert.throws(
    () =>
      validateP1ApplicationTraceability(
        migrations,
        workItems,
        decisions,
        productionRelease,
      ),
    /Staging traceability/,
  );
});

test("configuration isolation rejects production inheritance", () => {
  const contract = readJson("governance/environments/contract.json");
  contract.environments.production.inherits_from = ["development"];
  assert.throws(() => validateEnvironmentContract(contract), /production/);
});

test("forbidden secret input is rejected", () => {
  const fixture = `API_KEY=${["sk", "live", "1234567890abcdef"].join("_")}`;
  assert.ok(scanSecretLikeText(fixture, "fixture").length > 0);
});

test("common credential and connection-string forms are rejected", () => {
  const fixtures = [
    `GITHUB_TOKEN=${["ghp", "123456789012345678901234"].join("_")}`,
    `TOKEN=${["opaque", "12345678901234567890"].join("_")}`,
    `AWS_SECRET_ACCESS_KEY=${["abcd", "12345678901234567890"].join("")}`,
    `GITLAB_TOKEN=${["glpat", "12345678901234567890"].join("-")}`,
    `SENTRY_AUTH_TOKEN=${["sentry", "12345678901234567890"].join("-")}`,
    `DATABASE_PASSWORD=${["database", "password", "value"].join("-")}`,
    `MY_TOKEN=${["opaque", "12345678901234567890"].join("-")}`,
    ["postgres", "user:password@database.example/app"].join("://"),
  ];
  for (const fixture of fixtures) {
    assert.ok(scanSecretLikeText(fixture, "fixture").length > 0);
  }
});

test("incomplete decision records are rejected", () => {
  assert.throws(
    () =>
      validateDecisionRecord({
        decision_id: "DEC-TEST",
        title: "Incomplete",
        status: "proposed",
      }),
    /missing required field/,
  );
});

test("incomplete work items are rejected", () => {
  assert.throws(
    () => validateWorkItem({ work_item_id: "WI-TEST", priority: "P0" }),
    /missing required field/,
  );
});

test("decision timestamps, chronology, expiry, and evidence are enforced", () => {
  for (const mutate of [
    (record) => {
      record.created_at = "not-a-timestamp";
    },
    (record) => {
      record.updated_at = "2026-08-27T10:00:00Z";
    },
    (record) => {
      record.expiry = "tomorrow";
    },
    (record) => {
      record.evidence = ["todo"];
    },
    (record) => {
      record.impact = 42;
    },
  ]) {
    const record = validDecision();
    mutate(record);
    assert.throws(() => validateDecisionRecord(record));
  }
});

test("decision supersession and reviewer states are enforced", () => {
  const badSupersedes = validDecision();
  badSupersedes.supersedes = "DEC-20260828-OLD";
  assert.throws(() => validateDecisionRecord(badSupersedes), /array/);

  const selfSupersedes = validDecision();
  selfSupersedes.supersedes = [selfSupersedes.decision_id];
  assert.throws(() => validateDecisionRecord(selfSupersedes), /itself/);

  const badReviewer = validDecision();
  badReviewer.reviewer = { identity: "reviewer", status: "anything" };
  assert.throws(() => validateDecisionRecord(badReviewer), /not allowed/);
});

test("work-item arrays, timestamps, and extra fields are enforced", () => {
  for (const mutate of [
    (record) => {
      record.in_scope = [null];
    },
    (record) => {
      record.out_of_scope = [];
    },
    (record) => {
      record.acceptance_criteria = [""];
    },
    (record) => {
      record.validation_commands = ["todo"];
    },
    (record) => {
      record.created_at = "2026-99-99T10:00:00Z";
    },
    (record) => {
      record.unexpected = true;
    },
  ]) {
    const record = validWorkItem();
    mutate(record);
    assert.throws(() => validateWorkItem(record));
  }
});

test("strict schema artifacts are validated against required fields", () => {
  const schema = readJson("governance/decision-log.schema.json");
  schema.required = schema.required.slice(1);
  assert.throws(
    () =>
      validateSchemaArtifact(
        schema,
        readJson("governance/control-fields.json").decision_log_required_fields,
        "decision schema",
      ),
    /required/,
  );
});

test("unknown relational references are rejected", () => {
  const workItem = readJson("governance/work-items/template.json");
  workItem.authority_refs = ["UNKNOWN"];
  assert.throws(
    () =>
      validateWorkItem(workItem, "work item", {
        authorityIds: new Set(["P0-001-LOCKED"]),
      }),
    /unknown reference/,
  );
});

test("migration ordering gaps are rejected", () => {
  const register = {
    product_migrations_present: true,
    migrations: [
      {
        migration_id: "M-002",
        migration_kind: "security_control",
        sequence: 2,
        artifact_path: "migrations/002.sql",
        authority_refs: ["P0-001-LOCKED"],
        work_item_refs: ["WI-TEST"],
        decision_refs: ["DEC-TEST"],
        release_refs: ["REL-TEST"],
        reviewed: true,
        reviewed_by: "reviewer",
        reviewed_at: "2026-01-01T00:00:00Z",
        applied_environment: "staging",
        non_production_validation: true,
        drift_check: "clean",
        rollback_plan: "reversible",
        depends_on: [],
      },
    ],
  };
  assert.throws(() => validateMigrationRegister(register), /out of order/);
});

test("recorded migration privilege and invariant evidence cannot be weakened", () => {
  const artifact = readJson(
    "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json",
  );
  const migration = readJson("governance/migrations/reviewed-migrations.json")
    .migrations[0];

  artifact.validation_evidence.authenticated_execute = true;
  assert.throws(
    () => validateMigrationArtifact(artifact, migration, "migration artifact"),
    /authenticated_execute/,
  );

  const changedInvariant = readJson(
    "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json",
  );
  changedInvariant.preserved_invariants.security_definer_unchanged = false;
  assert.throws(
    () =>
      validateMigrationArtifact(
        changedInvariant,
        migration,
        "migration artifact",
      ),
    /security_definer_unchanged/,
  );

  const wrongVersion = readJson(
    "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json",
  );
  wrongVersion.version = "20260828192127";
  assert.throws(
    () =>
      validateMigrationArtifact(wrongVersion, migration, "migration artifact"),
    /version and name/,
  );

  const wrongName = readJson(
    "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json",
  );
  wrongName.name = "p0_expanded_execution_change";
  assert.throws(
    () => validateMigrationArtifact(wrongName, migration, "migration artifact"),
    /version and name/,
  );
});

test("recorded migration provenance identifies Rosuno without a staging classification", () => {
  const artifact = readJson(
    "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json",
  );
  const register = readJson("governance/migrations/reviewed-migrations.json");
  const migration = register.migrations[0];
  const workItem = readJson("governance/work-items/index.json").work_items[0];
  const release = readJson("governance/releases/traceability.json").releases[0];

  assert.deepEqual(artifact.target_project, {
    name: "Rosuno",
    project_ref: "wwcwfbzwljbjlaifklaj",
  });
  assert.equal(migration.applied_environment, "unclassified_external_project");
  assert.equal(migration.non_production_validation, false);
  assert.equal(workItem.environment, "unclassified_external_project");
  assert.equal(release.environment, "unclassified_external_project");
  assert.notEqual(artifact.target_project.project_ref, "mxjlvmowmodzdtdfgqpb");

  artifact.target_project.project_ref = "mxjlvmowmodzdtdfgqpb";
  assert.throws(
    () => validateMigrationArtifact(artifact, migration, "migration artifact"),
    /active Rosuno project/,
  );
});

test("security migration does not set the product-migration presence flag", () => {
  const register = readJson("governance/migrations/reviewed-migrations.json");
  register.migrations = [register.migrations[0]];
  register.product_migrations_present = true;
  assert.throws(
    () =>
      validateMigrationRegister(
        register,
        {
          authorityIds: new Set(["P0-001-LOCKED"]),
          workItemIds: new Set(["WI-P0-SUPABASE-EXECUTE"]),
          decisionIds: new Set(["DEC-20260828-SUPABASE-EXECUTE"]),
          releaseIds: new Set(["REL-20260828-SUPABASE-SECURITY"]),
          migrationIds: new Set([
            "20260828192126_p0_restrict_rls_auto_enable_execution",
          ]),
        },
        [
          "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json",
        ],
      ),
    /product migration presence/,
  );
});

test("unregistered migration artifacts are rejected", () => {
  assert.throws(
    () =>
      validateMigrationRegister(
        { product_migrations_present: false, migrations: [] },
        {},
        ["migrations/unregistered.sql"],
      ),
    /inventory/,
  );
});

test("schema drift findings are rejected", () => {
  const report = readJson("governance/schema-drift/baseline.json");
  report.drift_status = "detected";
  assert.throws(() => validateDriftReport(report), /drift status/);
});

test("sanitized restore evidence validates and rejects weakened recovery", () => {
  const evidence = readJson("governance/evidence/p0-restore-validation.json");
  assert.doesNotThrow(() => validateRestoreEvidence(evidence));

  evidence.event_trigger_recovery.authority = "generated dump";
  assert.throws(() => validateRestoreEvidence(evidence), /event-trigger/);
});

test("restore evidence rejects extra normalization and failed cleanup", () => {
  const extra = readJson("governance/evidence/p0-restore-validation.json");
  extra.backup_restore.normalized_statement_count = 2;
  assert.throws(() => validateRestoreEvidence(extra), /normalization/);

  const dirty = readJson("governance/evidence/p0-restore-validation.json");
  dirty.cleanup.temporary_material_removed = false;
  assert.throws(() => validateRestoreEvidence(dirty), /cleanup/);
});

test("incomplete release traceability is rejected", () => {
  const release = {
    release_id: "REL-TEST",
    commit_sha: "a".repeat(40),
    work_item_refs: ["WI-TEST"],
    decision_refs: ["DEC-TEST"],
    migration_refs: [],
    validation_evidence: [],
    artifact_digest: `sha256:${"a".repeat(64)}`,
    environment: "staging",
    reviewer: {
      identity: null,
      status: "unresolved_external_dependency",
    },
    rollback_reference: "rollback",
    created_at: "2026-01-01T00:00:00Z",
  };
  assert.throws(
    () => validateReleaseRegister({ releases: [release] }),
    /validation_evidence/,
  );
});

test("release records reject mutable short commit references", () => {
  const release = {
    release_id: "REL-TEST",
    commit_sha: "abc",
    work_item_refs: ["WI-TEST"],
    decision_refs: ["DEC-TEST"],
    migration_refs: [],
    validation_evidence: ["evidence"],
    artifact_digest: `sha256:${"a".repeat(64)}`,
    environment: "staging",
    reviewer: {
      identity: null,
      status: "unresolved_external_dependency",
    },
    rollback_reference: "rollback",
    created_at: "2026-01-01T00:00:00Z",
  };
  assert.throws(
    () => validateReleaseRegister({ releases: [release] }),
    /full immutable Git SHA/,
  );
});

test("migration and release links must be bidirectional", () => {
  assert.throws(
    () =>
      validateTraceabilityConsistency(
        {
          migrations: [{ migration_id: "MIG-001", release_refs: ["REL-001"] }],
        },
        {
          releases: [{ release_id: "REL-001", migration_refs: [] }],
        },
      ),
    /bidirectionally/,
  );
});

test("product source and deployment paths outside conventional roots are rejected", () => {
  const packageJson = readJson("package.json");
  assert.throws(
    () => validateNeutralPaths(["main.ts"], packageJson),
    /product implementation paths/,
  );
  assert.throws(
    () => validateNeutralPaths(["app/index.mjs"], packageJson),
    /product implementation paths/,
  );
  assert.throws(
    () => validateNeutralPaths(["index.mjs"], packageJson),
    /product implementation paths/,
  );
  assert.throws(
    () => validateNeutralPaths(["infra/main.tf"], packageJson),
    /product implementation paths/,
  );
  assert.throws(
    () => validateNeutralPaths(["deployment/k8s.yaml"], packageJson),
    /product implementation paths/,
  );
  assert.throws(
    () => validateNeutralPaths([".github/workflows/deploy.yml"], packageJson),
    /product implementation paths/,
  );
});

test("CI rejects shallow history that would break historical release validation", () => {
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/p0-controls.yml"),
    "utf8",
  ).replaceAll("fetch-depth: 0", "fetch-depth: 1");
  assert.throws(() => validateCiWorkflow(workflow), /full history/);
});

test("CI rejects injected deployment commands", () => {
  const workflow = `${readFileSync(
    path.join(ROOT, ".github/workflows/p0-controls.yml"),
    "utf8",
  )}\n      - run: ./deploy-production.sh\n`;
  assert.throws(() => validateCiWorkflow(workflow), /run command/);
});

test("package scripts reject executable product or deployment carriers", () => {
  const packageJson = readJson("package.json");
  packageJson.scripts.deploy = "node product-server.mjs";
  assert.throws(() => validatePackageJson(packageJson), /scripts/);
});
