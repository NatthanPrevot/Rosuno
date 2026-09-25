import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  P1_REGULATORY_CATALOG_SQL,
  P1_ATTORNEY_PENDING,
  P1_ATTORNEY_VALIDATED,
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
  validateP1AuthorizationCorrectionEvidence,
  validateP1AuthorizationCorrectionMigration,
  validateP1AuthorizationCorrectionTraceability,
  validateP1AuthorizationLifecycleEvidence,
  validateP1AuthorizationLifecycleTraceability,
  validateP1AuthorizationMigration,
  validateP1ApplicationTraceability,
  validateP1AttorneyClosure,
  validateP1AttorneyClosureTraceability,
  validateP1ClientIntakeCandidate,
  validateP1ClientIntakeClosure,
  validateP1ClientIntakeTraceability,
  validateP1MarketplaceReferralCandidate,
  validateP1MarketplaceReferralClosure,
  validateP1MarketplaceReferralTraceability,
  validateP1SchedulingRequestBookingBookabilityCandidate,
  validateP1SchedulingRequestBookingBookabilityClosure,
  validateP1SchedulingRequestBookingBookabilityTraceability,
  validateP1ConsultationEngagementMediaCandidate,
  validateP1ConsultationEngagementMediaClosure,
  validateP1ConsultationEngagementMediaTraceability,
  validateP1ResourcesCommunicationsCandidate,
  validateP1ResourcesCommunicationsClosure,
  validateP1ResourcesCommunicationsTraceability,
  validateP1FinancialFoundationCandidate,
  validateP1FinancialFoundationClosure,
  validateP1FinancialFoundationTraceability,
  validateP1ComplianceFoundationCandidate,
  validateP1ComplianceFoundationClosure,
  validateP1ComplianceFoundationTraceability,
  validateP1009Gate5PrestateContract,
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

test("P1-005 accepted closure remains valid under the current P1-011 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");

  const migration = migrations.migrations.find(
    (item) =>
      item.migration_id === "20260911062917_p1_client_intake_ai_foundation",
  );

  assert.ok(migration);

  const migrationSql = readFileSync(
    path.join(ROOT, migration.artifact_path),
    "utf8",
  );

  const evidence = readJson(
    "governance/evidence/p1-005-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1ClientIntakeCandidate(migration, migrationSql),
    "closed",
  );

  assert.doesNotThrow(() =>
    validateP1ClientIntakeClosure(migration, migrationSql, evidence),
  );

  assert.doesNotThrow(() =>
    validateP1ClientIntakeTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  const baseline = readJson("governance/schema-drift/baseline.json");

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );

  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const staleEvidence = structuredClone(evidence);
  staleEvidence.fingerprints.final_28_table.sha256 = "0".repeat(64);

  assert.throws(() =>
    validateP1ClientIntakeClosure(migration, migrationSql, staleEvidence),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";

  assert.throws(() =>
    validateP1ClientIntakeClosure(staleMigration, migrationSql, evidence),
  );

  const staleReleases = structuredClone(releases);
  staleReleases.releases.find(
    (item) => item.release_id === "REL-20260912-P1-005-STAGING-APPLICATION",
  ).commit_sha = "0".repeat(40);

  assert.throws(() =>
    validateP1ClientIntakeTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );

  assert.throws(() =>
    validateP1ClientIntakeCandidate(
      migration,
      migrationSql + "\n-- unauthorized byte drift\n",
    ),
  );
});

test("P1-005 reusable contract and rollback imports are inert and direct CLI remains functional", () => {
  const temp = mkdtempSync(
    path.join(tmpdir(), "rosuno-p1-005-rollback-import-"),
  );
  const directTarget = path.join(temp, "direct.sql");

  const importTargets = [
    "./tools/p0/lib/p1-005-contract-data.mjs",
    "./tools/p0/p1-005-rollback.mjs",
  ];

  try {
    const rollbackSource = readFileSync(
      path.join(ROOT, "tools/p0/p1-005-rollback.mjs"),
      "utf8",
    );
    const contractDataSource = readFileSync(
      path.join(ROOT, "tools/p0/lib/p1-005-contract-data.mjs"),
      "utf8",
    );

    assert.doesNotMatch(rollbackSource, /tests\/p1-005-contract\.test\.mjs/);
    assert.doesNotMatch(contractDataSource, /node:test|\.test\.mjs/);

    for (const target of importTargets) {
      const probe = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(target)});`,
          "importer-placeholder",
          temp,
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
        },
      );

      assert.equal(probe.status, 0, `${target} import failed: ${probe.stderr}`);
      assert.equal(probe.stdout, "", `${target} import emitted stdout`);
      assert.equal(probe.stderr, "", `${target} import emitted stderr`);
      assert.deepEqual(
        readdirSync(temp),
        [],
        `${target} import mutated filesystem`,
      );
    }

    const direct = spawnSync(
      process.execPath,
      [path.join(ROOT, "tools/p0/p1-005-rollback.mjs"), directTarget],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );

    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, "");
    assert.equal(direct.stderr, "");

    const generated = readFileSync(directTarget, "utf8");

    assert.match(generated, /^BEGIN;\n/);
    assert.match(generated, /\nROLLBACK;\n$/);
  } finally {
    rmSync(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("P1-004 accepted closure requires exact lifecycle evidence and traceability", () => {
  const migration = readJson(
    "governance/migrations/reviewed-migrations.json",
  ).migrations.find(
    (item) =>
      item.migration_id ===
      "20260910075939_p1_attorney_verification_eligibility_foundation",
  );
  const evidence = readJson(
    "governance/evidence/p1-004-governance-lifecycle-closure.json",
  );
  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  assert.doesNotThrow(() =>
    validateP1AttorneyClosure(migration, sql, evidence),
  );
  const stale = structuredClone(evidence);
  stale.release.application_exit = 1;
  assert.throws(() => validateP1AttorneyClosure(migration, sql, stale));
  const registers = {
    migrations: readJson("governance/migrations/reviewed-migrations.json"),
    workItems: readJson("governance/work-items/index.json"),
    decisions: readJson("governance/decision-log.json"),
    releases: readJson("governance/releases/traceability.json"),
  };
  assert.doesNotThrow(() =>
    validateP1AttorneyClosureTraceability(
      registers.migrations,
      registers.workItems,
      registers.decisions,
      registers.releases,
    ),
  );
});

test("P1-004 closure rejects each independently mutated governed fact", () => {
  const migration = readJson(
    "governance/migrations/reviewed-migrations.json",
  ).migrations.find(
    (item) =>
      item.migration_id ===
      "20260910075939_p1_attorney_verification_eligibility_foundation",
  );
  const evidence = readJson(
    "governance/evidence/p1-004-governance-lifecycle-closure.json",
  );
  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  const mutations = [
    [
      "decision",
      (e) => {
        e.lifecycle = "ACCEPTED";
      },
    ],
    [
      "work item",
      (e) => {
        e.work_item_id = "stale";
      },
    ],
    [
      "reviewer",
      (e) => {
        e.authorization.review.identity = "other";
      },
    ],
    [
      "reviewed",
      (e) => {
        e.lifecycle_state.postapplication_readonly_verification = false;
      },
    ],
    [
      "reviewed_by",
      (e) => {
        e.authorization.review.status = "pending";
      },
    ],
    [
      "review id",
      (e) => {
        e.authorization.review.review_id = "x";
      },
    ],
    [
      "review time",
      (e) => {
        e.authorization.review.approved_at = "2026-01-01T00:00:00Z";
      },
    ],
    [
      "applied",
      (e) => {
        e.lifecycle_state.staging_application = false;
      },
    ],
    [
      "release",
      (e) => {
        e.release.id = "wrong";
      },
    ],
    [
      "head",
      (e) => {
        e.authorization.approved_head = "wrong";
      },
    ],
    [
      "merge",
      (e) => {
        e.authorization.merge_commit = "wrong";
      },
    ],
    [
      "tree",
      (e) => {
        e.authorization.tree = "wrong";
      },
    ],
    [
      "parent",
      (e) => {
        e.authorization.ordered_parents[0] = "wrong";
      },
    ],
    [
      "release environment",
      (e) => {
        e.release.environment = "production";
      },
    ],
    [
      "release commit",
      (e) => {
        e.release.commit_sha = "wrong";
      },
    ],
    [
      "migration digest",
      (e) => {
        e.migration.sha256 = "wrong";
      },
    ],
    [
      "INFO missing",
      (e) => {
        e.validation.advisor_findings.info.pop();
      },
    ],
    [
      "INFO substitute",
      (e) => {
        e.validation.advisor_findings.info[0] = "wrong";
      },
    ],
    [
      "INFO duplicate",
      (e) => {
        e.validation.advisor_findings.info.push(
          e.validation.advisor_findings.info[0],
        );
      },
    ],
    [
      "WARN code",
      (e) => {
        e.validation.advisor_findings.warn.code = "wrong";
      },
    ],
    [
      "WARN target",
      (e) => {
        e.validation.advisor_findings.warn.target.function = "wrong";
      },
    ],
    [
      "second warning",
      (e) => {
        e.validation.advisor.warn_count = 2;
      },
    ],
    [
      "unapproved",
      (e) => {
        e.validation.advisor_findings.unapproved.push("unexpected");
      },
    ],
    [
      "helper count",
      (e) => {
        e.validation.helper_contract.contract.count = 2;
      },
    ],
    [
      "helper callable",
      (e) => {
        e.validation.helper_contract.contract.callable = "wrong";
      },
    ],
    [
      "helper named args",
      (e) => {
        e.validation.helper_contract.contract.named_arguments[0] = "wrong";
      },
    ],
    [
      "helper return",
      (e) => {
        e.validation.helper_contract.contract.return_type = "text";
      },
    ],
    [
      "helper language",
      (e) => {
        e.validation.helper_contract.contract.language = "plpgsql";
      },
    ],
    [
      "helper volatility",
      (e) => {
        e.validation.helper_contract.contract.volatility = "VOLATILE";
      },
    ],
    [
      "helper security",
      (e) => {
        e.validation.helper_contract.contract.security_definer = false;
      },
    ],
    [
      "helper owner",
      (e) => {
        e.validation.helper_contract.contract.owner = "wrong";
      },
    ],
    [
      "helper path",
      (e) => {
        e.validation.helper_contract.contract.search_path = "public";
      },
    ],
    [
      "helper execute",
      (e) => {
        e.validation.helper_contract.contract.execute.auth = false;
      },
    ],
    [
      "helper table select",
      (e) => {
        e.validation.helper_contract.contract.authenticated_select_capability_grants = true;
      },
    ],
    [
      "baseline digest",
      (e) => {
        e.catalog_fingerprints.baseline.sha256 = "wrong";
      },
    ],
    [
      "baseline bytes",
      (e) => {
        e.catalog_fingerprints.baseline.canonical_byte_length++;
      },
    ],
    [
      "baseline rows",
      (e) => {
        e.catalog_fingerprints.baseline.row_count++;
      },
    ],
    [
      "baseline membership",
      (e) => {
        e.catalog_fingerprints.membership.foundation[0] = "wrong";
      },
    ],
    [
      "candidate digest",
      (e) => {
        e.catalog_fingerprints.candidate.sha256 = "wrong";
      },
    ],
    [
      "candidate bytes",
      (e) => {
        e.catalog_fingerprints.candidate.canonical_byte_length++;
      },
    ],
    [
      "candidate rows",
      (e) => {
        e.catalog_fingerprints.candidate.row_count++;
      },
    ],
    [
      "candidate membership",
      (e) => {
        e.catalog_fingerprints.membership.candidate[0] = "wrong";
      },
    ],
    [
      "historical candidate",
      (e) => {
        e.historical_evidence_hashes.candidate_rollback = "wrong";
      },
    ],
    [
      "validation hash",
      (e) => {
        e.historical_evidence_hashes.validation_details = "wrong";
      },
    ],
    [
      "local explained",
      (e) => {
        e.boundaries.local_state.explained = true;
      },
    ],
    [
      "local attribution",
      (e) => {
        e.boundaries.local_state.attribution = "someone";
      },
    ],
    [
      "local cause",
      (e) => {
        e.boundaries.local_state.cause = "reason";
      },
    ],
    [
      "local erased",
      (e) => {
        e.boundaries.local_state.erased = true;
      },
    ],
    [
      "local counts",
      (e) => {
        e.validation.dry_run_reproduction.controlled_reproduction.content_changes = 1;
      },
    ],
    [
      "database closure",
      (e) => {
        e.boundaries.database_contacted_for_closure = true;
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const candidate = structuredClone(evidence);
    mutate(candidate);
    assert.throws(
      () => validateP1AttorneyClosure(migration, sql, candidate),
      label,
    );
  }
});

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

test("P1-002 authorization correction preserves rollback evidence and validates accepted Staging closure", () => {
  const migrationPath =
    "supabase/migrations/20260901012518_p1_authorization_scope_correction.sql";
  const evidencePath =
    "governance/evidence/p1-002-authorization-scope-correction.json";
  const fingerprintPath =
    "governance/evidence/p1-002-corrected-catalog-fingerprint-v2.json";
  const sql = readFileSync(path.join(ROOT, migrationPath), "utf8");
  const evidence = readJson(evidencePath);
  const fingerprintText = readFileSync(
    path.join(ROOT, fingerprintPath),
    "utf8",
  );
  const fingerprint = JSON.parse(fingerprintText);
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const migration = migrations.migrations.find(
    (entry) =>
      entry.migration_id === "20260901012518_p1_authorization_scope_correction",
  );

  assert.doesNotThrow(() =>
    validateP1AuthorizationCorrectionMigration(sql, migration),
  );
  assert.doesNotThrow(() =>
    validateP1AuthorizationCorrectionEvidence(
      evidence,
      sql,
      fingerprint,
      fingerprintText,
    ),
  );
  assert.doesNotThrow(() =>
    validateP1AuthorizationCorrectionTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  assert.throws(
    () =>
      validateP1AuthorizationCorrectionMigration(
        `${sql}\nalter table public.bookings add column correction_leak text;`,
        migration,
      ),
    /authorized P1-002 correction table boundary/,
  );
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionMigration(
        sql.replace(
          "drop table public.attorney_profiles restrict;",
          "drop table public.attorney_profiles cascade;",
        ),
        migration,
      ),
    /RESTRICT.*CASCADE/,
  );
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionMigration(
        `${sql}\ndrop table public.capability_grants restrict;`,
        migration,
      ),
    /drop exactly|in place/,
  );

  const changedRows = structuredClone(fingerprint);
  changedRows.normalized_outputs.snapshot.rows[0].identity =
    "public.unauthorized_table";
  assert.throws(
    () => validateP1AuthorizationCorrectionEvidence(evidence, sql, changedRows),
    /normalized snapshot/,
  );

  const falseRestoration = structuredClone(fingerprint);
  falseRestoration.runs[0].after.state_sha256 = "a".repeat(64);
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        evidence,
        sql,
        falseRestoration,
      ),
    /rollback or restoration/,
  );

  const falseClosure = structuredClone(evidence);
  falseClosure.governance_state.finally_closed = false;
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(falseClosure, sql, fingerprint),
    /accepted closure state/,
  );

  const falseTraceability = structuredClone(migrations);
  falseTraceability.migrations.find(
    (entry) =>
      entry.migration_id === "20260901012518_p1_authorization_scope_correction",
  ).release_refs = [];
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionTraceability(
        falseTraceability,
        workItems,
        decisions,
        releases,
      ),
    /migration traceability/,
  );

  const missingRelease = structuredClone(releases);
  missingRelease.releases = missingRelease.releases.filter(
    (entry) =>
      entry.release_id !== "REL-20260901-P1-002-CORRECTION-STAGING-APPLICATION",
  );
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionTraceability(
        migrations,
        workItems,
        decisions,
        missingRelease,
      ),
    /Staging traceability/,
  );

  const falsePersistentHistory = structuredClone(evidence);
  falsePersistentHistory.persistent_application_validation.migration_history[4].occurrences = 2;
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        falsePersistentHistory,
        sql,
        fingerprint,
      ),
    /persistent migration history/,
  );

  const falsePersistentCatalog = structuredClone(evidence);
  falsePersistentCatalog.persistent_application_validation.catalog_validation.row_count = 101;
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        falsePersistentCatalog,
        sql,
        fingerprint,
      ),
    /persistent catalog validation/,
  );

  const falseOldAccess = structuredClone(evidence);
  falseOldAccess.persistent_application_validation.non_target_integrity.old_accessed = true;
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        falseOldAccess,
        sql,
        fingerprint,
      ),
    /persistent non-target integrity/,
  );

  const missingCategoryCounts = structuredClone(evidence);
  delete missingCategoryCounts.catalog_fingerprint.category_counts;
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        missingCategoryCounts,
        sql,
        fingerprint,
      ),
    /catalog reference/,
  );

  const missingEnvironmentObservation = structuredClone(evidence);
  delete missingEnvironmentObservation.source_dev_mutation;
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        missingEnvironmentObservation,
        sql,
        fingerprint,
      ),
    /missing required field source_dev_mutation|environment and publication observations/,
  );

  const alteredChronology = structuredClone(evidence);
  alteredChronology.checkpoint_and_revert_history.chronology[6].description =
    "in-scope configuration change";
  assert.throws(
    () =>
      validateP1AuthorizationCorrectionEvidence(
        alteredChronology,
        sql,
        fingerprint,
      ),
    /checkpoint or revert history/,
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

test("work-item priority controls admit exactly P0, P1, and P2", () => {
  for (const priority of ["P0", "P1", "P2"]) {
    const record = validWorkItem();
    record.priority = priority;
    record.work_item_id = `WI-${priority}-TEST`;
    assert.doesNotThrow(() => validateWorkItem(record));
  }

  const p3 = validWorkItem();
  p3.priority = "P3";
  p3.work_item_id = "WI-P3-TEST";
  assert.throws(() => validateWorkItem(p3), /priority must be P0, P1, or P2/);

  const mismatched = validWorkItem();
  mismatched.priority = "P2";
  mismatched.work_item_id = "WI-P1-TEST";
  assert.throws(() => validateWorkItem(mismatched), /must match its priority/);

  const schema = readJson("governance/work-items/schema.json");
  assert.deepEqual(schema.properties.priority.enum, ["P0", "P1", "P2"]);
  assert.equal(
    schema.properties.work_item_id.pattern,
    "^WI-P(?:0|1|2)-[A-Z0-9][A-Z0-9-]*$",
  );

  const idPattern = new RegExp(schema.properties.work_item_id.pattern);

  for (const id of ["WI-P0-TEST", "WI-P1-TEST", "WI-P2-TEST"]) {
    assert.equal(idPattern.test(id), true);
  }

  assert.equal(idPattern.test("WI-P3-TEST"), false);
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

test("only exact retained P1-009/P1-010/P1-011 catalog SQL evidence queries bypass migration inventory", () => {
  assert.doesNotThrow(() =>
    validateMigrationRegister(
      { product_migrations_present: false, migrations: [] },
      {},
      [
        "tools/p0/catalog/p1-009-gate5-prestate.sql",
        "tools/p0/catalog/p1-009-postapplication.sql",
        "tools/p0/catalog/p1-010-postapplication.sql",
        "tools/p0/catalog/p1-011-postapplication.sql",
      ],
    ),
  );

  assert.throws(
    () =>
      validateMigrationRegister(
        { product_migrations_present: false, migrations: [] },
        {},
        ["tools/p0/catalog/p1-009-unregistered.sql"],
      ),
    /inventory/,
  );

  assert.throws(
    () =>
      validateMigrationRegister(
        { product_migrations_present: false, migrations: [] },
        {},
        ["tools/p0/catalog/p1-010-unregistered.sql"],
      ),
    /inventory/,
  );

  assert.throws(
    () =>
      validateMigrationRegister(
        { product_migrations_present: false, migrations: [] },
        {},
        ["tools/p0/catalog/p1-011-unregistered.sql"],
      ),
    /inventory/,
  );
});

test("schema drift findings are rejected", () => {
  const report = readJson("governance/schema-drift/baseline.json");
  report.drift_status = "detected";
  assert.throws(() => validateDriftReport(report), /drift status/);
});

test("reviewed and persistently applied P1-002 cannot remain pending", () => {
  const register = readJson("governance/migrations/reviewed-migrations.json");
  const migration = register.migrations.find(
    (entry) =>
      entry.migration_id === "20260829171701_p1_authorization_foundation",
  );
  migration.reviewed = false;
  migration.reviewed_by = "pending designated human PR review";
  migration.reviewed_at = null;
  migration.release_refs = [];

  assert.throws(
    () => validateMigrationRegister(register),
    /reviewed or persistently applied migration may not remain pending/,
  );
});

test("merged PR #12 governance closure rejects inaccurate review and CI state", () => {
  const evidence = readJson(
    "governance/evidence/p1-002-governance-lifecycle-correction.json",
  );
  assert.doesNotThrow(() => validateP1AuthorizationLifecycleEvidence(evidence));

  const inaccurateReview = structuredClone(evidence);
  inaccurateReview.governance_closure.reviewer = "not Rosuno";
  assert.throws(
    () => validateP1AuthorizationLifecycleEvidence(inaccurateReview),
    /PR #12 governance closure/,
  );

  const unsuccessfulCi = structuredClone(evidence);
  unsuccessfulCi.governance_closure.required_ci[0].conclusion = "failure";
  assert.throws(
    () => validateP1AuthorizationLifecycleEvidence(unsuccessfulCi),
    /PR #12 governance closure/,
  );
});

test("merged PR #12 governance correction cannot return to pending", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const workItem = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-002-GOVERNANCE-CONTROL-CORRECTION",
  );
  const decision = decisions.decisions.find(
    (entry) =>
      entry.decision_id === "DEC-20260902-P1-002-GOVERNANCE-CONTROL-CORRECTION",
  );
  workItem.status = "proposed";
  workItem.reviewer = {
    identity: "pending designated human PR review",
    status: "pending",
  };
  decision.status = "proposed";
  decision.reviewer = {
    identity: "pending designated human PR review",
    status: "pending",
  };

  assert.throws(
    () =>
      validateP1AuthorizationLifecycleTraceability(
        migrations,
        workItems,
        decisions,
        releases,
      ),
    /accepted after PR #12 protected review/,
  );
});

test("former empty schema-drift baseline is rejected", () => {
  const report = readJson("governance/schema-drift/baseline.json");
  report.product_schema_present = false;

  assert.throws(
    () => validateDriftReport(report),
    /product_schema_present must be true/,
  );
});

test("schema-drift baseline digest and migration inventory are immutable", () => {
  const badDigest = readJson("governance/schema-drift/baseline.json");
  badDigest.baseline_digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateDriftReport(badDigest), /identity\/digest/);

  const badInventory = readJson("governance/schema-drift/baseline.json");
  badInventory.migration_inventory[2].migration_id =
    "20260829171701_pending_migration";
  assert.throws(
    () => validateDriftReport(badInventory),
    /inventory contradicts/,
  );
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

test("P1-009 migration path is allowed by the neutral repository control", () => {
  const packageJson = readJson("package.json");

  assert.doesNotThrow(() =>
    validateNeutralPaths(
      [
        "supabase/migrations/20260918060600_p1_resources_communications_foundation.sql",
      ],
      packageJson,
    ),
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

// Disposable filesystem fixtures exercise the actual register/drift entry points.
// Synthetic completed proof below is test input, never live validation evidence.
test("P1-004 local overlay preserves the exact five-migration foundation", async (t) => {
  async function fixture(run) {
    const root = mkdtempSync(path.join(tmpdir(), "rosuno-p1-004-controls-"));
    try {
      for (const directory of ["governance", "supabase", "tools/p0/lib"]) {
        cpSync(path.join(ROOT, directory), path.join(root, directory), {
          recursive: true,
        });
      }
      cpSync(
        path.join(ROOT, "tools/p0/p1-009-gate5-fingerprint.mjs"),
        path.join(root, "tools/p0/p1-009-gate5-fingerprint.mjs"),
      );
      execFileSync("git", ["init", "-q", root]);
      const controls = await import(
        pathToFileURL(path.join(root, "tools/p0/lib/controls.mjs"))
      );
      const register = readJson(
        "governance/migrations/reviewed-migrations.json",
      );
      register.migrations = register.migrations.slice(0, 5);
      // Remove a real local overlay from the disposable fixture, if present.
      const liveOverlays = readJson(
        "governance/migrations/reviewed-migrations.json",
      ).migrations.slice(5);
      for (const actual of liveOverlays)
        rmSync(path.join(root, actual.artifact_path), { force: true });
      const id =
        "20260910075939_p1_attorney_verification_eligibility_foundation";
      const candidate = {
        ...structuredClone(register.migrations[4]),
        migration_id: id,
        sequence: 6,
        artifact_path: `supabase/migrations/${id}.sql`,
        reviewed: false,
        reviewed_by: "pending designated human PR review",
        reviewed_at: null,
        applied_environment: "none",
        release_refs: [],
        non_production_validation: false,
        drift_check: P1_ATTORNEY_PENDING,
        depends_on: ["20260901012518_p1_authorization_scope_correction"],
      };
      register.migrations.push(candidate);
      const sql = "-- Disposable governance fixture; never executed as SQL.\n";
      writeFileSync(path.join(root, candidate.artifact_path), sql);
      const evidence = {
        version: 1,
        migration_id: id,
        migration_sha256: createHash("sha256").update(sql).digest("hex"),
        project_ref: "mxjlvmowmodzdtdfgqpb",
        phase: "rollback_only_pending",
        rollback_validation: null,
      };
      const report = readJson("governance/schema-drift/baseline.json");
      // Historical candidate fixtures intentionally validate against the
      // retained five-migration baseline, not the live accepted closure.
      report.baseline_id = "rosuno-staging-foundation-20260901-v1";
      report.baseline_digest =
        "sha256:6bb6920c2d418d27d0c406399c79ad1be2d9705f30ca2d6d364e54211d3156e8";
      report.checked_at = "2026-09-01T18:27:41.110779Z";
      report.migration_inventory = report.migration_inventory.slice(0, 5);
      report.accepted_evidence = report.accepted_evidence.slice(0, 3);
      report.evidence = report.evidence.slice(0, 3);
      report.catalog_fingerprint = {
        format: "rosuno-p1-catalog-v1",
        sha256:
          "72825bbbfe9d8f0bdbbc4bb7967d8a343f552a0db104cc62f2e6b2fabae4323e",
        canonical_byte_length: 31443,
        row_count: 102,
      };
      const validate = () => {
        writeFileSync(
          path.join(
            root,
            "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json",
          ),
          JSON.stringify(evidence),
        );
        const files = execFileSync(
          "git",
          ["ls-files", "-co", "--exclude-standard"],
          { cwd: root, encoding: "utf8" },
        )
          .trim()
          .split("\n");
        // Keep the fixture's discovered inventory limited to migration
        // artifacts; the disposable checkout intentionally has no index.
        const migrationFiles = files.filter(
          (file) =>
            file.startsWith("governance/migrations/") ||
            file.startsWith("supabase/migrations/"),
        );
        controls.validateMigrationRegister(register, {}, migrationFiles);
        controls.validateDriftReport(report, register);
      };
      await run({
        root,
        register,
        candidate,
        evidence,
        report,
        validate,
        controls,
        sql,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  await t.test(
    "pending candidate passes without claiming validation or changing baseline",
    () => fixture(({ validate }) => assert.doesNotThrow(validate)),
  );
  const mutations = {
    "unregistered P1-004 SQL": ({ register }) => register.migrations.pop(),
    "absent registered artifact": ({ root, candidate }) =>
      rmSync(path.join(root, candidate.artifact_path)),
    "wrong sequence": ({ candidate }) => {
      candidate.sequence = 7;
    },
    "wrong predecessor": ({ candidate }) => {
      candidate.depends_on = [
        "20260830023823_p1_jurisdiction_policy_launch_foundation",
      ];
    },
    "wrong migration name": ({ candidate }) => {
      candidate.migration_id = "20260910075939_arbitrary";
    },
    "wrong migration path": ({ candidate }) => {
      candidate.artifact_path =
        "supabase/migrations/20260901012518_p1_authorization_scope_correction.sql";
    },
    "reviewed candidate": ({ candidate }) => {
      candidate.reviewed = true;
    },
    "persistently applied candidate": ({ candidate }) => {
      candidate.applied_environment = "staging";
    },
    "released candidate": ({ candidate }) => {
      candidate.release_refs = ["REL-FALSE"];
    },
    "two candidates": ({ register, candidate }) => {
      register.migrations.push({
        ...candidate,
        sequence: 7,
        migration_id:
          "20260910075940_p1_attorney_verification_eligibility_foundation",
      });
    },
    "P1-005 candidate": ({ candidate }) => {
      candidate.migration_id = "20260910075939_p1_client_intake_foundation";
    },
    "candidate included in persistent baseline": ({ report, candidate }) => {
      report.migration_inventory.push(candidate);
    },
    "false completed flag": ({ candidate }) => {
      candidate.non_production_validation = true;
    },
    "false completed rollback text": ({ candidate }) => {
      candidate.drift_check = P1_ATTORNEY_VALIDATED;
    },
    "false completed proof": ({ candidate, evidence }) => {
      candidate.non_production_validation = true;
      candidate.drift_check = P1_ATTORNEY_VALIDATED;
      evidence.phase = "rollback_only_validated";
    },
    "artifact changed after validation evidence": ({ root, candidate }) => {
      writeFileSync(path.join(root, candidate.artifact_path), "-- changed\n");
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(`rejects ${name}`, () =>
      fixture((f) => {
        mutate(f);
        assert.throws(f.validate);
      }),
    );
  }
  for (let index = 0; index < 5; index++) {
    await t.test(`rejects foundation ${index + 1} byte mutation`, () =>
      fixture((f) => {
        const file = f.report.migration_inventory[index].artifact_path;
        writeFileSync(
          path.join(f.root, file),
          readFileSync(path.join(f.root, file), "utf8") + "\n",
        );
        assert.throws(f.validate);
      }),
    );
    await t.test(`rejects foundation ${index + 1} reorder`, () =>
      fixture((f) => {
        const other = (index + 1) % 5;
        [f.register.migrations[index], f.register.migrations[other]] = [
          f.register.migrations[other],
          f.register.migrations[index],
        ];
        assert.throws(f.validate);
      }),
    );
  }
  await t.test(
    "completed phase requires matching artifact, successful checks and exact restoration",
    () =>
      fixture((f) => {
        const tables = [
          "application_sessions",
          "capability_definitions",
          "capability_grants",
          "jurisdiction_regulatory_modes",
          "jurisdictions",
          "launch_authorizations",
          "launch_gate_evaluations",
          "launch_gates",
          "policy_authority_references",
          "policy_types",
          "policy_versions",
          "regulatory_modes",
          "service_areas",
          "staff_profiles",
          "users",
        ];
        const snapshot = readJson(
          "governance/evidence/p1-002-corrected-catalog-fingerprint-v2.json",
        ).normalized_outputs.snapshot;
        const state = {
          migration_history: f.report.migration_inventory.map((m) => [
            m.migration_id.slice(0, 14),
            m.migration_id.slice(15),
          ]),
          catalog_rows: snapshot.rows,
          public_tables: tables,
          public_function_count: 4,
          public_row_counts: Object.fromEntries(
            tables.map((name) => [name, 0]),
          ),
          candidate_relations: [],
          candidate_helper_present: false,
          candidate_seed_count: 0,
        };
        f.candidate.non_production_validation = true;
        f.candidate.drift_check = P1_ATTORNEY_VALIDATED;
        f.evidence.phase = "rollback_only_validated";
        f.evidence.rollback_validation = {
          started_at: "2026-09-10T08:00:00Z",
          rolled_back_at: "2026-09-10T08:01:00Z",
          restored_at: "2026-09-10T08:02:00Z",
          transaction_end: "ROLLBACK",
          checks: Object.fromEntries(
            [
              "structure",
              "constraints",
              "rls",
              "service_privileges",
              "capability_helper",
              "corrections",
              "historical_independence",
            ].map((name) => [
              name,
              [{ name: `synthetic ${name} assertion`, passed: true }],
            ]),
          ),
          before: structuredClone(state),
          after: structuredClone(state),
        };
        assert.doesNotThrow(f.validate);
        f.evidence.rollback_validation.after.candidate_helper_present = true;
        assert.throws(f.validate, /restoration/);
        f.evidence.rollback_validation.after.candidate_helper_present = false;
        f.evidence.rollback_validation.transaction_end = "COMMIT";
        assert.throws(f.validate, /rollback/);
      }),
  );
});

// Every scalar and collection in the final closure contract is independently
// mutated. Mutation happens outside assert.throws, so a defective mutator fails.
function p1004Mutations(value, route = []) {
  const result = [];
  if (value !== null && typeof value === "object") {
    result.push([route, Array.isArray(value) ? {} : []]);
    if (Array.isArray(value)) {
      result.push([
        route,
        [...value, value.length ? structuredClone(value[0]) : "unexpected"],
      ]);
      if (value.length) result.push([route, value.slice(1)]);
    } else {
      result.push([route, { ...value, unapproved_field: true }]);
      for (const key of Object.keys(value)) {
        const missing = structuredClone(value);
        delete missing[key];
        result.push([route, missing]);
      }
    }
    for (const [key, child] of Object.entries(value))
      result.push(...p1004Mutations(child, [...route, key]));
  } else {
    result.push([
      route,
      typeof value === "boolean"
        ? !value
        : typeof value === "number"
          ? value + 1
          : value === null
            ? "unproven"
            : "mutated",
    ]);
  }
  return result;
}
function p1004Changed(value, route, replacement) {
  if (!route.length) return structuredClone(replacement);
  const copy = structuredClone(value);
  let target = copy;
  for (const key of route.slice(0, -1)) target = target[key];
  target[route.at(-1)] = structuredClone(replacement);
  return copy;
}
test("P1-004 closure rejects every independent evidence mutation", async (t) => {
  const evidence = readJson(
    "governance/evidence/p1-004-governance-lifecycle-closure.json",
  );
  const migration = readJson(
    "governance/migrations/reviewed-migrations.json",
  ).migrations.find(
    (item) =>
      item.migration_id ===
      "20260910075939_p1_attorney_verification_eligibility_foundation",
  );
  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  assert.doesNotThrow(() =>
    validateP1AttorneyClosure(migration, sql, evidence),
  );
  for (const [i, [route, replacement]] of p1004Mutations(evidence).entries()) {
    await t.test(String(i) + ":" + route.join("."), () => {
      const altered = p1004Changed(evidence, route, replacement);
      assert.throws(() => validateP1AttorneyClosure(migration, sql, altered));
    });
  }
});
test("P1-004 closure rejects every independent lifecycle record mutation", async (t) => {
  const registers = [
    readJson("governance/migrations/reviewed-migrations.json"),
    readJson("governance/work-items/index.json"),
    readJson("governance/decision-log.json"),
    readJson("governance/releases/traceability.json"),
  ];
  const selectors = [
    [
      "migrations",
      "migration_id",
      "20260910075939_p1_attorney_verification_eligibility_foundation",
    ],
    [
      "work_items",
      "work_item_id",
      "WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION",
    ],
    ["decisions", "decision_id", "DEC-20260910-P1-004-BOUNDED-CANDIDATE"],
    ["releases", "release_id", "REL-20260910-P1-004-STAGING-APPLICATION"],
  ];
  assert.doesNotThrow(() =>
    validateP1AttorneyClosureTraceability(...registers),
  );
  for (const [slot, [collection, key, id]] of selectors.entries()) {
    const index = registers[slot][collection].findIndex((x) => x[key] === id);
    assert.notEqual(index, -1);
    const record = registers[slot][collection][index];
    for (const [i, [route, replacement]] of p1004Mutations(record).entries()) {
      await t.test(collection + ":" + i + ":" + route.join("."), () => {
        const altered = structuredClone(registers);
        altered[slot][collection][index] = p1004Changed(
          record,
          route,
          replacement,
        );
        assert.throws(() => validateP1AttorneyClosureTraceability(...altered));
      });
    }
    await t.test(collection + ":duplicate", () => {
      const altered = structuredClone(registers);
      altered[slot][collection].push(structuredClone(record));
      assert.throws(() => validateP1AttorneyClosureTraceability(...altered));
    });
  }
  const duplicate = structuredClone(registers);
  duplicate[2].decisions.push({
    ...duplicate[2].decisions.find((x) => x.decision_id === selectors[2][2]),
    decision_id: "DEC-20260910-P1-004-GOVERNANCE-LIFECYCLE-CLOSURE",
  });
  assert.throws(() => validateP1AttorneyClosureTraceability(...duplicate));
});
test("P1-004 closed baseline rejects its specific governed-value mutations", async (t) => {
  const register = readJson("governance/migrations/reviewed-migrations.json");

  const baseline = {
    version: 1,
    product_schema_present: true,
    baseline_id: "rosuno-staging-p1-004-20260910-v1",
    baseline_digest:
      "sha256:53837aef8833e9d14e6739c54ac8b82a05b133b178b6ceaf7393fe49f0798a33",
    checked_environment: "staging",
    checked_at: "2026-09-10T22:48:00.544397Z",
    project: {
      name: "Rosuno Staging",
      project_ref: "mxjlvmowmodzdtdfgqpb",
    },
    migration_inventory: [
      {
        sequence: 1,
        migration_id: "20260828192126_p0_restrict_rls_auto_enable_execution",
        artifact_path:
          "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql",
        sha256:
          "2ba591b2767c43a32731c8b74b5ffaa07c47a41d096eee6fb3672aad9278c49d",
      },
      {
        sequence: 2,
        migration_id: "20260829000015_p1_platform_foundation",
        artifact_path:
          "supabase/migrations/20260829000015_p1_platform_foundation.sql",
        sha256:
          "67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8",
      },
      {
        sequence: 3,
        migration_id: "20260829171701_p1_authorization_foundation",
        artifact_path:
          "supabase/migrations/20260829171701_p1_authorization_foundation.sql",
        sha256:
          "6471ac68949234e29ae1cc492eaa2f77dc15ca010998f72898284b8c9a855fec",
      },
      {
        sequence: 4,
        migration_id: "20260830023823_p1_jurisdiction_policy_launch_foundation",
        artifact_path:
          "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
        sha256:
          "94e9b746cf303154790bc51e8160f9184b2e9765e82ec2702e03030f7a79b7ee",
      },
      {
        sequence: 5,
        migration_id: "20260901012518_p1_authorization_scope_correction",
        artifact_path:
          "supabase/migrations/20260901012518_p1_authorization_scope_correction.sql",
        sha256:
          "bf0cdabed8ffa41a65e793b9041c00dc7d2ca47eeef40c2750770e195b47d6c5",
      },
      {
        sequence: 6,
        migration_id:
          "20260910075939_p1_attorney_verification_eligibility_foundation",
        artifact_path:
          "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql",
        sha256:
          "09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
      },
    ],
    accepted_evidence: [
      {
        path: "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json",
        sha256:
          "59f4facdc8115606cedf517b17f690f050b8203287289ca6735ddaa26d7c6f34",
      },
      {
        path: "governance/evidence/p1-002-authorization-scope-correction.json",
        sha256:
          "4f63b0d550d5a1a589549d031a7184ec7072cd96fdbd20a47918613e0fc6136f",
      },
      {
        path: "governance/evidence/p1-002-corrected-catalog-fingerprint-v2.json",
        sha256:
          "c5bb94594f8a82915ad5a9faabbee00ad90bf782914de072bee8a6a5fa333e6f",
      },
      {
        path: "governance/evidence/p1-004-governance-lifecycle-closure.json",
        sha256:
          "0ace4c7c1b30af97d35c98d2638383d525ff66b3be74581e91c7dc9a21149a47",
      },
    ],
    catalog_fingerprint: {
      format: "rosuno-p1-catalog-v1",
      sha256:
        "f79a78d39870ed25ac94ac58d646ea997c9bacf15199d0c1d1abe6dbfe634508",
      canonical_byte_length: 90175,
      row_count: 279,
    },
    evidence: [
      "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json",
      "governance/evidence/p1-002-authorization-scope-correction.json",
      "governance/evidence/p1-002-corrected-catalog-fingerprint-v2.json",
      "governance/evidence/p1-004-governance-lifecycle-closure.json",
    ],
    drift_status: "clean",
    drift_items: [],
  };

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-004-20260910-v1");
  assert.equal(baseline.checked_at, "2026-09-10T22:48:00.544397Z");
  assert.equal(baseline.migration_inventory.length, 6);
  assert.equal(baseline.accepted_evidence.length, 4);
  assert.doesNotThrow(() => validateDriftReport(baseline, register));

  const mutations = [
    [
      "checked_at",
      (x) => {
        x.checked_at = "2026-09-10T16:13:01Z";
      },
    ],
    [
      "candidate SHA",
      (x) => {
        x.catalog_fingerprint.sha256 = "0".repeat(64);
      },
    ],
    [
      "candidate bytes",
      (x) => {
        x.catalog_fingerprint.canonical_byte_length++;
      },
    ],
    [
      "candidate rows",
      (x) => {
        x.catalog_fingerprint.row_count++;
      },
    ],
    [
      "six-migration inventory",
      (x) => {
        x.migration_inventory.pop();
      },
    ],
    [
      "closure evidence SHA",
      (x) => {
        const item = x.accepted_evidence.find(
          (y) =>
            y.path ===
            "governance/evidence/p1-004-governance-lifecycle-closure.json",
        );
        assert.ok(item);
        item.sha256 = "0".repeat(64);
      },
    ],
    [
      "baseline digest",
      (x) => {
        x.baseline_digest = "sha256:" + "0".repeat(64);
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, () => {
      const altered = structuredClone(baseline);
      mutate(altered);
      assert.throws(() => validateDriftReport(altered, register), label);
    });
  }
});

test("Fast-Control package scripts remain explicit and dependency-neutral", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );

  assert.equal(
    packageJson.scripts["rosuno:preflight"],
    "node tools/p0/fast-control.mjs preflight",
  );

  assert.equal(
    packageJson.scripts["rosuno:check"],
    "node tools/p0/fast-control.mjs check",
  );

  assert.doesNotThrow(() => validatePackageJson(packageJson));

  const withoutPreflight = structuredClone(packageJson);
  delete withoutPreflight.scripts["rosuno:preflight"];

  assert.throws(() => validatePackageJson(withoutPreflight));

  const broadenedDependencies = structuredClone(packageJson);
  broadenedDependencies.dependencies = { unexpected: "1.0.0" };

  assert.throws(() => validatePackageJson(broadenedDependencies));
});

test("P1-006 accepted closure remains valid under the current P1-011 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");

  const migration = migrations.migrations.find(
    (item) =>
      item.migration_id === "20260914000658_p1_marketplace_referral_foundation",
  );

  assert.ok(migration);

  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  const evidence = readJson(
    "governance/evidence/p1-006-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1MarketplaceReferralCandidate(migration, sql),
    "closed",
  );

  assert.doesNotThrow(() =>
    validateP1MarketplaceReferralClosure(migration, sql, evidence),
  );

  assert.doesNotThrow(() =>
    validateP1MarketplaceReferralTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  const baseline = readJson("governance/schema-drift/baseline.json");

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(migrations.migrations.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );

  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const staleEvidence = structuredClone(evidence);
  staleEvidence.security_advisor.info_count = 15;

  assert.throws(() =>
    validateP1MarketplaceReferralClosure(migration, sql, staleEvidence),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";

  assert.throws(() =>
    validateP1MarketplaceReferralClosure(staleMigration, sql, evidence),
  );

  const staleReleases = structuredClone(releases);
  staleReleases.releases.find(
    (item) => item.release_id === "REL-20260914-P1-006-STAGING-APPLICATION",
  ).commit_sha = "0".repeat(40);

  assert.throws(() =>
    validateP1MarketplaceReferralTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );

  assert.throws(() =>
    validateP1MarketplaceReferralCandidate(
      migration,
      sql + "\n-- unauthorized byte drift\n",
    ),
  );

  /* Historical pending-candidate validation remains deterministic. */
  const pendingMigration = structuredClone(migration);
  pendingMigration.release_refs = [];
  pendingMigration.reviewed = false;
  pendingMigration.reviewed_by = "pending designated human PR review";
  pendingMigration.reviewed_at = null;
  pendingMigration.applied_environment = "none";
  pendingMigration.non_production_validation = false;
  pendingMigration.drift_check =
    "Not yet executed. This is an unreviewed, unapplied local candidate; no database validation or persistent application has occurred.";
  pendingMigration.rollback_plan =
    "A separately authorized rollback-only Rosuno Staging validation must execute the exact protected candidate transactionally and independently prove exact restoration of the accepted seven-migration baseline before any persistent Staging application.";

  assert.equal(
    validateP1MarketplaceReferralCandidate(pendingMigration, sql),
    "pending",
  );

  const pendingMigrations = structuredClone(migrations);
  pendingMigrations.migrations[
    pendingMigrations.migrations.findIndex(
      (item) =>
        item.migration_id ===
        "20260914000658_p1_marketplace_referral_foundation",
    )
  ] = pendingMigration;

  const pendingDecisions = structuredClone(decisions);
  const pendingDecision = pendingDecisions.decisions.find(
    (item) => item.decision_id === "DEC-20260914-P1-006-BOUNDED-CANDIDATE",
  );

  pendingDecision.scope =
    "Bounded local Physical 1F Marketplace / Referral foundation implementation only; no protected review, remote mutation, database execution, or later P1 work.";
  pendingDecision.rationale =
    "The ten current locked Rosuno authority documents place Marketplace / Referral persistence in Physical 1F while Scheduling, Consultation Request, and Bookability remain later dependencies. The frozen contract resolves the physical implementation without inventing regulatory outcome taxonomies, referral-policy columns, paid ranking, recommendation truth, or later-phase relations.";
  pendingDecision.updated_at = "2026-09-14T00:11:59Z";
  pendingDecision.impact =
    "Authorizes only the bounded local P1-006 implementation gate. It does not authorize commit, push, pull request, merge, database contact, rollback validation, persistent Staging application, production, OLD access, P1-007, or an end-to-end Referral capability claim.";
  pendingDecision.evidence = [
    "supabase/migrations/20260914000658_p1_marketplace_referral_foundation.sql",
    "tools/p0/lib/p1-006-contract-data.mjs",
    "tools/p0/tests/p1-006-contract.test.mjs",
    "tools/p0/p1-006-rollback.mjs",
  ];

  const pendingWorkItems = structuredClone(workItems);
  const pendingWorkItem = pendingWorkItems.work_items.find(
    (item) => item.work_item_id === "WI-P1-006-MARKETPLACE-REFERRAL-FOUNDATION",
  );

  pendingWorkItem.status = "in_progress";
  pendingWorkItem.reviewer.status = "pending";
  pendingWorkItem.release_refs = [];
  pendingWorkItem.updated_at = "2026-09-14T00:11:59Z";

  const pendingReleases = structuredClone(releases);
  pendingReleases.releases = pendingReleases.releases.filter(
    (item) => item.release_id !== "REL-20260914-P1-006-STAGING-APPLICATION",
  );

  assert.doesNotThrow(() =>
    validateP1MarketplaceReferralTraceability(
      pendingMigrations,
      pendingWorkItems,
      pendingDecisions,
      pendingReleases,
    ),
  );
});
test("P1-007 accepted closure remains valid under the current P1-011 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const migrationId =
    "20260914231532_p1_scheduling_request_booking_bookability_foundation";
  const decisionId = "DEC-20260914-P1-007-BOUNDED-CANDIDATE";
  const workItemId =
    "WI-P1-007-SCHEDULING-REQUEST-BOOKING-BOOKABILITY-FOUNDATION";
  const releaseId = "REL-20260916-P1-007-STAGING-APPLICATION";

  const migration = migrations.migrations.find(
    (item) => item.migration_id === migrationId,
  );

  assert.ok(migration);

  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  const evidence = readJson(
    "governance/evidence/p1-007-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1SchedulingRequestBookingBookabilityCandidate(migration, sql),
    "closed",
  );

  assert.doesNotThrow(() =>
    validateP1SchedulingRequestBookingBookabilityClosure(
      migration,
      sql,
      evidence,
    ),
  );

  assert.doesNotThrow(() =>
    validateP1SchedulingRequestBookingBookabilityTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(migrations.migrations.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );

  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const staleEvidence = structuredClone(evidence);
  staleEvidence.security_advisor.info_count = 18;

  assert.throws(() =>
    validateP1SchedulingRequestBookingBookabilityClosure(
      migration,
      sql,
      staleEvidence,
    ),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";

  assert.throws(() =>
    validateP1SchedulingRequestBookingBookabilityClosure(
      staleMigration,
      sql,
      evidence,
    ),
  );

  const staleReleases = structuredClone(releases);
  staleReleases.releases.find(
    (item) => item.release_id === releaseId,
  ).commit_sha = "0".repeat(40);

  assert.throws(() =>
    validateP1SchedulingRequestBookingBookabilityTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );

  assert.throws(() =>
    validateP1SchedulingRequestBookingBookabilityCandidate(
      migration,
      sql + "\n-- unauthorized P1-007 byte drift\n",
    ),
  );

  /* Historical pending-candidate validation remains deterministic. */
  const pendingMigration = structuredClone(migration);
  pendingMigration.release_refs = [];
  pendingMigration.reviewed = false;
  pendingMigration.reviewed_by = "pending designated human PR review";
  pendingMigration.reviewed_at = null;
  pendingMigration.applied_environment = "none";
  pendingMigration.non_production_validation = false;
  pendingMigration.drift_check =
    "Not yet executed. This is an unreviewed, unapplied local P1-007 candidate; no database validation or persistent application has occurred.";
  pendingMigration.rollback_plan =
    "A separately authorized rollback-only Rosuno Staging validation must execute the exact protected candidate transactionally and independently prove exact restoration of the accepted eight-migration baseline before any persistent Staging application.";

  assert.equal(
    validateP1SchedulingRequestBookingBookabilityCandidate(
      pendingMigration,
      sql,
    ),
    "pending",
  );

  const pendingMigrations = structuredClone(migrations);
  pendingMigrations.migrations[
    pendingMigrations.migrations.findIndex(
      (item) => item.migration_id === migrationId,
    )
  ] = pendingMigration;

  const pendingDecisions = structuredClone(decisions);
  const pendingDecision = pendingDecisions.decisions.find(
    (item) => item.decision_id === decisionId,
  );

  assert.ok(pendingDecision);

  pendingDecision.scope =
    "Bounded local Physical 1G Scheduling / Request / Booking / Bookability foundation implementation only; no branch publication, protected review, remote mutation, database execution, or later P1 work.";
  pendingDecision.rationale =
    "The ten current locked Rosuno authority documents place Scheduling, Consultation Request, Booking substrate, Instant Availability Intent, and Bookability evidence in Physical 1G while Consultation persistence belongs to the later Physical 1H boundary. The two approved interpretation gates resolve only the under-specified cross-migration Booking foreign key and recurring Availability effective range; they do not authorize early Consultation creation, invented recurrence semantics, or later workflow.";
  pendingDecision.updated_at = "2026-09-15T03:23:17Z";
  pendingDecision.impact =
    "Authorizes only the bounded local P1-007 candidate implementation gate, including local validation and the controlled local candidate commit per the current Operating Model. It does not authorize branch publication, pull request creation, review, merge, database contact, rollback execution, persistent Staging application, production, OLD access, P1-008, or an end-to-end Scheduling / Booking capability claim.";
  pendingDecision.evidence = [
    "supabase/migrations/20260914231532_p1_scheduling_request_booking_bookability_foundation.sql",
    "tools/p0/lib/p1-007-contract-data.mjs",
    "tools/p0/tests/p1-007-contract.test.mjs",
    "tools/p0/p1-007-rollback.mjs",
  ];

  const pendingWorkItems = structuredClone(workItems);
  const pendingWorkItem = pendingWorkItems.work_items.find(
    (item) => item.work_item_id === workItemId,
  );

  assert.ok(pendingWorkItem);

  pendingWorkItem.status = "in_progress";
  pendingWorkItem.reviewer.status = "pending";
  pendingWorkItem.release_refs = [];
  pendingWorkItem.updated_at = "2026-09-15T03:23:17Z";

  const pendingReleases = structuredClone(releases);
  pendingReleases.releases = pendingReleases.releases.filter(
    (item) => item.release_id !== releaseId,
  );

  assert.doesNotThrow(() =>
    validateP1SchedulingRequestBookingBookabilityTraceability(
      pendingMigrations,
      pendingWorkItems,
      pendingDecisions,
      pendingReleases,
    ),
  );
});

test("P1-008 accepted closure remains valid under the current P1-011 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const migrationId =
    "20260917045031_p1_consultation_engagement_media_foundation";
  const decisionId = "DEC-20260917-P1-008-BOUNDED-CANDIDATE";
  const workItemId = "WI-P1-008-CONSULTATION-ENGAGEMENT-MEDIA-FOUNDATION";
  const releaseId = "REL-20260918-P1-008-STAGING-APPLICATION";

  const migration = migrations.migrations.find(
    (item) => item.migration_id === migrationId,
  );
  assert.ok(migration);
  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  const evidence = readJson(
    "governance/evidence/p1-008-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1ConsultationEngagementMediaCandidate(migration, sql),
    "closed",
  );
  assert.doesNotThrow(() =>
    validateP1ConsultationEngagementMediaClosure(migration, sql, evidence),
  );
  assert.doesNotThrow(() =>
    validateP1ConsultationEngagementMediaTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(migrations.migrations.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );
  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const staleEvidence = structuredClone(evidence);
  staleEvidence.security_advisor.info_count = 18;
  assert.throws(() =>
    validateP1ConsultationEngagementMediaClosure(migration, sql, staleEvidence),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";
  assert.throws(() =>
    validateP1ConsultationEngagementMediaClosure(staleMigration, sql, evidence),
  );

  const staleReleases = structuredClone(releases);
  staleReleases.releases.find(
    (item) => item.release_id === releaseId,
  ).commit_sha = "0".repeat(40);
  assert.throws(() =>
    validateP1ConsultationEngagementMediaTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );
  assert.throws(() =>
    validateP1ConsultationEngagementMediaCandidate(
      migration,
      sql + "\n-- unauthorized P1-008 byte drift\n",
    ),
  );

  const pendingMigration = structuredClone(migration);
  pendingMigration.release_refs = [];
  pendingMigration.reviewed = false;
  pendingMigration.reviewed_by = "pending designated human PR review";
  pendingMigration.reviewed_at = null;
  pendingMigration.applied_environment = "none";
  pendingMigration.non_production_validation = false;
  pendingMigration.drift_check =
    "Not yet executed. This is an unreviewed, unapplied local P1-008 candidate; no database validation or persistent application has occurred.";
  pendingMigration.rollback_plan =
    "A separately authorized rollback-only Rosuno Staging validation must execute the exact protected candidate transactionally and independently prove exact restoration of the accepted nine-migration baseline before any persistent Staging application.";
  assert.equal(
    validateP1ConsultationEngagementMediaCandidate(pendingMigration, sql),
    "pending",
  );

  const pendingMigrations = structuredClone(migrations);
  pendingMigrations.migrations[
    pendingMigrations.migrations.findIndex(
      (item) => item.migration_id === migrationId,
    )
  ] = pendingMigration;

  const pendingDecisions = structuredClone(decisions);
  const pendingDecision = pendingDecisions.decisions.find(
    (item) => item.decision_id === decisionId,
  );
  assert.ok(pendingDecision);
  pendingDecision.scope =
    "Bounded local Physical 1H Consultation / Engagement / Media foundation implementation only; no branch publication, protected review, remote mutation, database execution, or later P1 work.";
  pendingDecision.rationale =
    "The ten current locked Rosuno authority documents place Consultation persistence, Engagement context, Media Room and provider-session correlation, and durable Participation evidence in Physical 1H, while P1-007 intentionally deferred the Booking-to-Consultation foreign key until consultations exists. The approved P1-008 interpretation gates resolve only the started_at index typo, otherwise-unspecified established-relationship referential actions, append-only Participation evidence permissions, and structural Engagement version-history integrity. They do not choose the G-1 effectiveness event, the G-5 Consultation creation trigger, Payment semantics, provider-driven Consultation completion, or later workflow.";
  pendingDecision.updated_at = "2026-09-17T20:50:25Z";
  pendingDecision.impact =
    "Authorizes only the bounded local P1-008 candidate implementation gate, including local validation and the controlled local candidate commit per the current Operating Model. It does not authorize branch publication, pull request creation, review, merge, database contact, rollback execution, persistent Staging application, release creation, production, OLD access, P1-009 or later work, or an end-to-end Consultation / Engagement / Media capability claim.";
  pendingDecision.evidence = [
    "supabase/migrations/20260917045031_p1_consultation_engagement_media_foundation.sql",
    "tools/p0/lib/p1-008-contract-data.mjs",
    "tools/p0/tests/p1-008-contract.test.mjs",
    "tools/p0/p1-008-rollback.mjs",
  ];

  const pendingWorkItems = structuredClone(workItems);
  const pendingWorkItem = pendingWorkItems.work_items.find(
    (item) => item.work_item_id === workItemId,
  );
  assert.ok(pendingWorkItem);
  pendingWorkItem.status = "in_progress";
  pendingWorkItem.reviewer.status = "pending";
  pendingWorkItem.release_refs = [];
  pendingWorkItem.updated_at = "2026-09-17T20:50:25Z";

  const pendingReleases = structuredClone(releases);
  pendingReleases.releases = pendingReleases.releases.filter(
    (item) => item.release_id !== releaseId,
  );
  assert.doesNotThrow(() =>
    validateP1ConsultationEngagementMediaTraceability(
      pendingMigrations,
      pendingWorkItems,
      pendingDecisions,
      pendingReleases,
    ),
  );

  const pendingBaseline = structuredClone(baseline);
  pendingBaseline.baseline_id = "rosuno-staging-p1-007-20260916-v1";
  pendingBaseline.baseline_digest =
    "sha256:c4f2151ac71875a55e91c5ce050740a702a6069c194bbf7f99ef4ce8df8d0609";
  pendingBaseline.checked_at = "2026-09-16T04:43:44.771854Z";
  pendingBaseline.migration_inventory =
    pendingBaseline.migration_inventory.filter((item) => item.sequence <= 9);
  pendingBaseline.accepted_evidence = pendingBaseline.accepted_evidence.filter(
    (item) =>
      item.path !==
        "governance/evidence/p1-008-governance-lifecycle-closure.json" &&
      item.path !==
        "governance/evidence/p1-009-governance-lifecycle-closure.json" &&
      item.path !==
        "governance/evidence/p1-010-governance-lifecycle-closure.json" &&
      item.path !==
        "governance/evidence/p1-011-governance-lifecycle-closure.json",
  );
  pendingBaseline.catalog_fingerprint = {
    format: "rosuno-p1-catalog-v1",
    sha256: "841ae8ef5f67443ecf9d8b135ffb28affb9b0758597dfd2e174b7b8c61104635",
    canonical_byte_length: 348401,
    row_count: 1089,
  };
  pendingBaseline.evidence = pendingBaseline.evidence.filter(
    (path) =>
      path !== "governance/evidence/p1-008-governance-lifecycle-closure.json" &&
      path !== "governance/evidence/p1-009-governance-lifecycle-closure.json" &&
      path !== "governance/evidence/p1-010-governance-lifecycle-closure.json" &&
      path !== "governance/evidence/p1-011-governance-lifecycle-closure.json",
  );
  assert.doesNotThrow(() =>
    validateDriftReport(pendingBaseline, pendingMigrations),
  );
});

test("P1-009 accepted closure remains valid under the current P1-011 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const migration = migrations.migrations.find(
    (item) =>
      item.migration_id ===
      "20260918060600_p1_resources_communications_foundation",
  );

  assert.ok(migration);

  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");

  const evidence = readJson(
    "governance/evidence/p1-009-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1ResourcesCommunicationsCandidate(migration, sql),
    "closed",
  );

  assert.doesNotThrow(() =>
    validateP1ResourcesCommunicationsClosure(migration, sql, evidence),
  );

  assert.doesNotThrow(() =>
    validateP1ResourcesCommunicationsTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );

  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const queryBytes = readFileSync(
    "tools/p0/catalog/p1-009-postapplication.sql",
  );

  assert.equal(
    createHash("sha256").update(queryBytes).digest("hex"),
    "4d3641ef6ba94ea6ef79f8e42b7649689c211b4c1cb702d1eee59fb9c783b728",
  );
  assert.equal(queryBytes.length, 12266);

  const staleEvidence = structuredClone(evidence);
  staleEvidence.security_advisor.info_count = 20;

  assert.throws(() =>
    validateP1ResourcesCommunicationsClosure(migration, sql, staleEvidence),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";

  assert.throws(() =>
    validateP1ResourcesCommunicationsClosure(staleMigration, sql, evidence),
  );

  const staleReleases = structuredClone(releases);

  staleReleases.releases.find(
    (item) => item.release_id === "REL-20260918-P1-009-STAGING-APPLICATION",
  ).commit_sha = "0".repeat(40);

  assert.throws(() =>
    validateP1ResourcesCommunicationsTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );

  assert.throws(() =>
    validateP1ResourcesCommunicationsCandidate(
      migration,
      sql + "\n-- unauthorized P1-009 byte drift\n",
    ),
  );

  const pendingMigration = structuredClone(migration);

  pendingMigration.release_refs = [];
  pendingMigration.reviewed = false;
  pendingMigration.reviewed_by = "pending designated human PR review";
  pendingMigration.reviewed_at = null;
  pendingMigration.applied_environment = "none";
  pendingMigration.non_production_validation = false;
  pendingMigration.drift_check =
    "Not yet executed. This is an unreviewed, unapplied local P1-009 candidate; no database validation or persistent application has occurred.";
  pendingMigration.rollback_plan =
    "A separately authorized rollback-only Rosuno Staging validation must execute the exact protected candidate transactionally and independently prove exact restoration of the accepted ten-migration P1-008 baseline before any persistent Staging application.";

  assert.equal(
    validateP1ResourcesCommunicationsCandidate(pendingMigration, sql),
    "pending",
  );
});

test("P1-009 Gate 5A prestate contract fails closed on provenance or scope weakening", () => {
  const evidence = readJson(
    "governance/evidence/p1-009-gate5-prestate-contract.json",
  );
  const decisions = readJson("governance/decision-log.json");

  assert.equal(validateP1009Gate5PrestateContract(evidence, decisions), true);

  const cases = [
    (copy) => {
      copy.historical_p1_008.reproduction_claimed = true;
    },
    (copy) => {
      copy.historical_p1_008.replaced_or_repaired = true;
    },
    (copy) => {
      copy.verification_contract.tables.pop();
    },
    (copy) => {
      copy.verification_contract.functions.pop();
    },
    (copy) => {
      copy.preconditions.public_function_count = 13;
    },
    (copy) => {
      copy.preconditions.security_advisor.info_count = 18;
    },
    (copy) => {
      copy.preconditions.security_advisor.unapproved_count = 1;
    },
    (copy) => {
      copy.execution_policy.database_execution_authorized = true;
    },
  ];

  for (const mutate of cases) {
    const copy = structuredClone(evidence);
    mutate(copy);
    assert.throws(() => validateP1009Gate5PrestateContract(copy, decisions));
  }
});

test("P1-010 accepted closure remains valid under the current P1-011 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const authority = readJson("governance/authority-references.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const migration = migrations.migrations.find(
    (item) => item.migration_id === "20260919000112_p1_financial_foundation",
  );

  assert.ok(migration);
  assert.equal(migration.sequence, 12);
  assert.equal(migration.reviewed, true);
  assert.equal(migration.reviewed_by, "Rosuno");
  assert.equal(migration.reviewed_at, "2026-09-19T03:45:19Z");
  assert.equal(migration.applied_environment, "staging");
  assert.equal(migration.non_production_validation, true);

  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  const evidence = readJson(
    "governance/evidence/p1-010-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1FinancialFoundationCandidate(migration, sql),
    "closed",
  );

  assert.doesNotThrow(() =>
    validateP1FinancialFoundationClosure(migration, sql, evidence),
  );

  assert.doesNotThrow(() =>
    validateP1FinancialFoundationTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  const fp1 = authority.references.find(
    (item) =>
      item.authority_id ===
      "FINANCIAL-PROVENANCE-PHYSICAL-CORRECTION-FP-1-LOCKED",
  );

  assert.deepEqual(fp1, {
    authority_id: "FINANCIAL-PROVENANCE-PHYSICAL-CORRECTION-FP-1-LOCKED",
    title:
      "Rosuno Financial Provenance Physical Correction / Bounded Authority Amendment FP-1",
    location: "external locked authority package",
    locked: true,
    content_copied: false,
    reinterpreted: false,
    integrity:
      "sha256:ca7d257b6fbf6081c7bd48194a0d39b6fad7a6a6af0f4191e734f9af0d2af1c0",
    usage: "reference-only",
    status: "active",
  });

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.checked_at, "2026-09-23T03:14:20Z");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(migrations.migrations.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );

  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const queryBytes = readFileSync(
    "tools/p0/catalog/p1-010-postapplication.sql",
  );

  assert.equal(
    createHash("sha256").update(queryBytes).digest("hex"),
    "6225d1027e0dee034c81c2819934f974218b31c8d22bb0179a14599b146a885a",
  );
  assert.equal(queryBytes.length, 12917);

  const staleGate6 = structuredClone(evidence);
  staleGate6.gate6.successful_application.persistent_application_attempts = 2;

  assert.throws(() =>
    validateP1FinancialFoundationClosure(migration, sql, staleGate6),
  );

  const inventedTimestamp = structuredClone(evidence);
  inventedTimestamp.fingerprints.postapplication_56_table.exact_observation_timestamp_retained = true;

  assert.throws(() =>
    validateP1FinancialFoundationClosure(migration, sql, inventedTimestamp),
  );

  const weakenedAdvisor = structuredClone(evidence);
  weakenedAdvisor.security_advisor.info_count = 25;

  assert.throws(() =>
    validateP1FinancialFoundationClosure(migration, sql, weakenedAdvisor),
  );

  const broadenedBoundary = structuredClone(evidence);
  broadenedBoundary.boundaries.production_authorized = true;

  assert.throws(() =>
    validateP1FinancialFoundationClosure(migration, sql, broadenedBoundary),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";

  assert.throws(() =>
    validateP1FinancialFoundationClosure(staleMigration, sql, evidence),
  );

  const staleReleases = structuredClone(releases);
  staleReleases.releases.find(
    (item) => item.release_id === "REL-20260921-P1-010-STAGING-APPLICATION",
  ).commit_sha = "0".repeat(40);

  assert.throws(() =>
    validateP1FinancialFoundationTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );

  const missingFp1 = structuredClone(migration);
  missingFp1.authority_refs = missingFp1.authority_refs.filter(
    (item) => item !== "FINANCIAL-PROVENANCE-PHYSICAL-CORRECTION-FP-1-LOCKED",
  );

  assert.throws(
    () => validateP1FinancialFoundationCandidate(missingFp1, sql),
    /authority_refs|provenance/,
  );

  assert.throws(
    () =>
      validateP1FinancialFoundationCandidate(
        migration,
        sql + "\n-- unauthorized byte drift\n",
      ),
    /bytes|byte length|SHA-256/,
  );

  /*
   * Historical pending-candidate representation remains deterministic.
   * These are test-only copies of the exact pre-closure governance records.
   */
  const pendingMigration = structuredClone(migration);

  pendingMigration.release_refs = [];
  pendingMigration.reviewed = false;
  pendingMigration.reviewed_by = "pending designated human PR review";
  pendingMigration.reviewed_at = null;
  pendingMigration.applied_environment = "none";
  pendingMigration.non_production_validation = false;
  pendingMigration.drift_check =
    "Not yet executed. This is an unreviewed, unapplied local P1-010 candidate; no database validation or persistent application has occurred.";
  pendingMigration.rollback_plan =
    "A separately authorized rollback-only Rosuno Staging validation must execute the exact protected P1-010 candidate transactionally with transient fixtures and independently prove exact restoration of the accepted eleven-migration P1-009 baseline before any persistent Staging application.";

  assert.equal(
    validateP1FinancialFoundationCandidate(pendingMigration, sql),
    "pending",
  );

  const pendingMigrations = structuredClone(migrations);
  pendingMigrations.migrations[
    pendingMigrations.migrations.findIndex(
      (item) => item.migration_id === "20260919000112_p1_financial_foundation",
    )
  ] = pendingMigration;

  const pendingDecisions = structuredClone(decisions);
  const pendingDecision = pendingDecisions.decisions.find(
    (item) => item.decision_id === "DEC-20260918-P1-010-BOUNDED-CANDIDATE",
  );

  pendingDecision.reviewer = {
    identity: "pending designated human PR review",
    status: "pending",
  };
  pendingDecision.updated_at = "2026-09-19T01:51:20Z";
  pendingDecision.scope =
    "Bounded local P1-010 Gate 1 candidate implementation only from canonical main at 74141e50a656d9f3ddff918c9494e224da53bceb under the eleven-artifact authority package including locked FP-1. No publication, protected review, database contact, persistent Staging application, Production, OLD, P1-011, or later work is authorized by this decision.";
  pendingDecision.impact =
    "Creates only the local unreviewed Physical 1J Financial foundation candidate and associated governance/control tooling. No Payout relation, Audit Event, Retention Rule, Legal Hold, Complaint Case, provider execution, Production financial configuration, database execution, P1-011, or end-to-end payment capability is authorized.";
  pendingDecision.evidence = [
    "supabase/migrations/20260919000112_p1_financial_foundation.sql",
    "tools/p0/lib/p1-010-contract-data.mjs",
    "tools/p0/p1-010-rollback.mjs",
    "tools/p0/tests/p1-010-contract.test.mjs",
    "FP-1 sha256:ca7d257b6fbf6081c7bd48194a0d39b6fad7a6a6af0f4191e734f9af0d2af1c0",
  ];

  const pendingWorkItems = structuredClone(workItems);
  const pendingWork = pendingWorkItems.work_items.find(
    (item) => item.work_item_id === "WI-P1-010-FINANCIAL-FOUNDATION",
  );

  pendingWork.status = "in_progress";
  pendingWork.reviewer = {
    identity: "pending designated human PR review",
    status: "pending",
  };
  pendingWork.release_refs = [];
  pendingWork.updated_at = "2026-09-19T01:51:20Z";

  const pendingReleases = structuredClone(releases);
  pendingReleases.releases = pendingReleases.releases.filter(
    (item) => item.release_id !== "REL-20260921-P1-010-STAGING-APPLICATION",
  );

  assert.doesNotThrow(() =>
    validateP1FinancialFoundationTraceability(
      pendingMigrations,
      pendingWorkItems,
      pendingDecisions,
      pendingReleases,
    ),
  );
});

test("P1-010 migration path is allowed by the neutral repository control", () => {
  const packageJson = readJson("package.json");

  assert.doesNotThrow(() =>
    validateNeutralPaths(
      ["supabase/migrations/20260919000112_p1_financial_foundation.sql"],
      packageJson,
    ),
  );
});
test("P1-011 accepted Compliance closure requires exact lifecycle evidence and thirteen-migration baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const migration = migrations.migrations.find(
    (item) => item.migration_id === "20260921051204_p1_compliance_foundation",
  );

  assert.ok(migration);
  assert.equal(migration.sequence, 13);
  assert.equal(migration.reviewed, true);
  assert.equal(migration.reviewed_by, "Rosuno");
  assert.equal(migration.reviewed_at, "2026-09-22T05:16:16Z");
  assert.equal(migration.applied_environment, "staging");
  assert.equal(migration.non_production_validation, true);

  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");
  const evidence = readJson(
    "governance/evidence/p1-011-governance-lifecycle-closure.json",
  );

  assert.equal(
    validateP1ComplianceFoundationCandidate(migration, sql),
    "closed",
  );

  assert.doesNotThrow(() =>
    validateP1ComplianceFoundationClosure(migration, sql, evidence),
  );

  assert.doesNotThrow(() =>
    validateP1ComplianceFoundationTraceability(
      migrations,
      workItems,
      decisions,
      releases,
    ),
  );

  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.checked_at, "2026-09-23T03:14:20Z");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(migrations.migrations.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 640365);
  assert.equal(baseline.catalog_fingerprint.row_count, 1938);
  assert.equal(
    baseline.baseline_digest,
    "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
  );
  assert.equal(
    baseline.accepted_evidence.at(-1).path,
    "governance/evidence/p1-011-governance-lifecycle-closure.json",
  );
  assert.equal(
    baseline.accepted_evidence.at(-1).sha256,
    "7a95c0350f5be2836671513431f4c9c8982d60eb362d7561c12f3bc758e8ae73",
  );

  assert.doesNotThrow(() => validateDriftReport(baseline, migrations));

  const queryBytes = readFileSync(
    "tools/p0/catalog/p1-011-postapplication.sql",
  );
  assert.equal(
    createHash("sha256").update(queryBytes).digest("hex"),
    "8ab63a71d029a9641b8f9918f60afe323572b1f0ade6a5451d6801a59d7af6ef",
  );
  assert.equal(queryBytes.length, 13200);

  const weakenedWorkItems = structuredClone(workItems);
  weakenedWorkItems.work_items.find(
    (item) => item.work_item_id === "WI-P1-011-COMPLIANCE-FOUNDATION",
  ).status = "in_progress";

  assert.throws(() =>
    validateP1ComplianceFoundationTraceability(
      migrations,
      weakenedWorkItems,
      decisions,
      releases,
    ),
  );

  const staleGate6 = structuredClone(evidence);
  staleGate6.gate6.successful_application.persistent_application_attempts = 2;
  assert.throws(() =>
    validateP1ComplianceFoundationClosure(migration, sql, staleGate6),
  );

  const staleFingerprint = structuredClone(evidence);
  staleFingerprint.fingerprints.postapplication_60_table.sha256 = "0".repeat(
    64,
  );
  assert.throws(() =>
    validateP1ComplianceFoundationClosure(migration, sql, staleFingerprint),
  );

  const weakenedAdvisor = structuredClone(evidence);
  weakenedAdvisor.security_advisor.info_count = 29;
  assert.throws(() =>
    validateP1ComplianceFoundationClosure(migration, sql, weakenedAdvisor),
  );

  const broadenedBoundary = structuredClone(evidence);
  broadenedBoundary.boundaries.production_authorized = true;
  assert.throws(() =>
    validateP1ComplianceFoundationClosure(migration, sql, broadenedBoundary),
  );

  const staleMigration = structuredClone(migration);
  staleMigration.applied_environment = "none";
  assert.throws(() =>
    validateP1ComplianceFoundationClosure(staleMigration, sql, evidence),
  );

  const staleReleases = structuredClone(releases);
  staleReleases.releases.find(
    (item) => item.release_id === "REL-20260923-P1-011-STAGING-APPLICATION",
  ).commit_sha = "0".repeat(40);
  assert.throws(() =>
    validateP1ComplianceFoundationTraceability(
      migrations,
      workItems,
      decisions,
      staleReleases,
    ),
  );

  assert.throws(
    () =>
      validateP1ComplianceFoundationCandidate(
        migration,
        sql + "\n-- unauthorized byte drift\n",
      ),
    /byte length|SHA-256/,
  );
});

test("P1-011 historical pending representation remains valid against the accepted P1-010 baseline", () => {
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const workItems = readJson("governance/work-items/index.json");
  const decisions = readJson("governance/decision-log.json");
  const releases = readJson("governance/releases/traceability.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const migration = migrations.migrations.find(
    (item) => item.migration_id === "20260921051204_p1_compliance_foundation",
  );
  assert.ok(migration);

  const sql = readFileSync(path.join(ROOT, migration.artifact_path), "utf8");

  const pendingMigration = structuredClone(migration);
  pendingMigration.release_refs = [];
  pendingMigration.reviewed = false;
  pendingMigration.reviewed_by = "pending designated human PR review";
  pendingMigration.reviewed_at = null;
  pendingMigration.applied_environment = "none";
  pendingMigration.non_production_validation = false;
  pendingMigration.drift_check =
    "Not yet executed. This is an unreviewed, unapplied local P1-011 candidate; no database validation or persistent application has occurred.";
  pendingMigration.rollback_plan =
    "A separately authorized rollback-only Rosuno Staging validation must execute the exact protected P1-011 candidate transactionally with transient fixtures and independently prove exact restoration of the accepted twelve-migration P1-010 baseline before any persistent Staging application.";

  assert.equal(
    validateP1ComplianceFoundationCandidate(pendingMigration, sql),
    "pending",
  );

  const pendingMigrations = structuredClone(migrations);
  pendingMigrations.migrations[
    pendingMigrations.migrations.findIndex(
      (item) => item.migration_id === "20260921051204_p1_compliance_foundation",
    )
  ] = pendingMigration;

  const pendingDecisions = structuredClone(decisions);
  const pendingDecision = pendingDecisions.decisions.find(
    (item) => item.decision_id === "DEC-20260921-P1-011-BOUNDED-CANDIDATE",
  );

  pendingDecision.reviewer = {
    identity: "pending designated human PR review",
    status: "pending",
  };
  pendingDecision.updated_at = "2026-09-21T05:12:04Z";
  pendingDecision.scope =
    "Bounded local P1-011 Gate 1 candidate implementation only from canonical main at 2ee5946883a195c37dbe69f8042c5480f7ca2897. No commit, publication, protected review, database contact, persistent Staging application, Production, OLD, branch deletion, P1-012, or later work is authorized by this decision.";
  pendingDecision.impact =
    "Creates only the local unreviewed Physical 1K Compliance foundation candidate and associated governance/control tooling. No Review, Payout, California 1L relation, deletion executor, database execution, Production, OLD, P1-012, or end-to-end compliance/operations workflow is authorized.";
  pendingDecision.evidence = [
    "supabase/migrations/20260921051204_p1_compliance_foundation.sql",
    "tools/p0/lib/p1-011-contract-data.mjs",
    "tools/p0/p1-011-rollback.mjs",
    "tools/p0/tests/p1-011-contract.test.mjs",
  ];

  const pendingWorkItems = structuredClone(workItems);
  const pendingWork = pendingWorkItems.work_items.find(
    (item) => item.work_item_id === "WI-P1-011-COMPLIANCE-FOUNDATION",
  );

  pendingWork.status = "in_progress";
  pendingWork.reviewer = {
    identity: "pending designated human PR review",
    status: "pending",
  };
  pendingWork.release_refs = [];
  pendingWork.updated_at = "2026-09-21T05:12:04Z";

  const pendingReleases = structuredClone(releases);
  pendingReleases.releases = pendingReleases.releases.filter(
    (item) => item.release_id !== "REL-20260923-P1-011-STAGING-APPLICATION",
  );

  assert.doesNotThrow(() =>
    validateP1ComplianceFoundationTraceability(
      pendingMigrations,
      pendingWorkItems,
      pendingDecisions,
      pendingReleases,
    ),
  );

  const pendingBaseline = structuredClone(baseline);
  pendingBaseline.baseline_id = "rosuno-staging-p1-010-20260921-v1";
  pendingBaseline.baseline_digest =
    "sha256:f5776fa5d14843e3bd0f57a0dcfeb161581c077bfcae957b6130f49d287dd96f";
  pendingBaseline.checked_at = null;
  pendingBaseline.migration_inventory =
    pendingBaseline.migration_inventory.slice(0, -1);
  pendingBaseline.accepted_evidence = pendingBaseline.accepted_evidence.slice(
    0,
    -1,
  );
  pendingBaseline.evidence = pendingBaseline.evidence.slice(0, -1);
  pendingBaseline.catalog_fingerprint = {
    format: "rosuno-p1-catalog-v1",
    sha256: "3d4cd0c09940e5f55bc5b67fbbee7edad5676af5edc34f50273682efb5b43238",
    canonical_byte_length: 595722,
    row_count: 1794,
  };

  assert.equal(pendingBaseline.migration_inventory.length, 12);
  assert.equal(pendingBaseline.accepted_evidence.length, 10);
  assert.equal(pendingBaseline.evidence.length, 10);

  assert.doesNotThrow(() =>
    validateDriftReport(pendingBaseline, pendingMigrations),
  );
});

test("P1-011 migration path is allowed by the neutral repository control", () => {
  const packageJson = readJson("package.json");
  assert.doesNotThrow(() =>
    validateNeutralPaths(
      ["supabase/migrations/20260921051204_p1_compliance_foundation.sql"],
      packageJson,
    ),
  );
});
