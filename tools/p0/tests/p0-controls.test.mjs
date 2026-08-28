import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
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

test("neutral P0 control foundation validates successfully", () => {
  assert.doesNotThrow(() => validateRepository());
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
