// DEV-001 development test configuration and workspace routing tests
// (fixture-only).
//
// The one-click development test configuration runs against the synthetic
// staff configuration world (configuration-fixtures.mjs), whose read port
// applies the row policies and the capability predicate and whose write port
// records each staff function call. No provider, network, or database is
// contacted; every staff member, jurisdiction, mode and value is synthetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEVELOPMENT_TEST_CONFIRMATION,
  DEVELOPMENT_TEST_DEFINITIONS,
  DEVELOPMENT_TEST_LABEL_PREFIX,
} from "../src/application/development-test-configuration.ts";
import { selectEligibilityPolicy } from "../src/application/policy-selection.ts";
import {
  createDevelopmentTestConfiguration,
  createPolicyVersion,
  resolvePolicyWorkspace,
} from "../src/application/staff-configuration.ts";
import {
  addJurisdiction,
  addPolicyType,
  addPolicyVersion,
  addStaff,
  configurationSources,
  createWorld,
  form,
  grant,
  idOf,
  production,
  PROJECT_REF,
  stamp,
} from "./configuration-fixtures.mjs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

// The thirteen versions of the owner's runbook (A10), in its order: key,
// policy type, scope, and whether the development regulatory mode is used.
const RUNBOOK = [
  ["eligibility", "eligibility", "jurisdiction", false],
  ["scheduling", "scheduling", "jurisdiction", false],
  ["bookability", "bookability", "global", false],
  ["referral", "referral", "jurisdiction", false],
  ["fee", "fee", "jurisdiction", false],
  ["fee-options", "fee", "global", false],
  ["notification", "notification", "global", false],
  ["complaint", "complaint", "jurisdiction", false],
  ["payment-flow", "payment_flow", "jurisdiction", true],
  ["payment", "payment", "jurisdiction", true],
  ["cancellation", "cancellation", "jurisdiction", true],
  ["refund", "refund", "jurisdiction", true],
  ["engagement", "engagement", "jurisdiction", true],
];

const MODE = idOf(7, 1);

// A staging world: a global policy holder, a jurisdiction-scoped holder, one
// jurisdiction with the development regulatory mode, and another without.
function setup() {
  const world = createWorld();
  world.deployment_environment = {
    environment_class: "staging",
    project_ref: PROJECT_REF,
  };
  const j = addJurisdiction(world, 1, "SYN_DEV");
  const other = addJurisdiction(world, 2, "SYN_OTHER");
  for (const [, type] of RUNBOOK) {
    if (!world.policy_types.some((t) => t.code === type)) {
      addPolicyType(world, type);
    }
  }
  world.regulatory_modes = [
    {
      id: MODE,
      jurisdiction_id: j,
      code: "DEV_SYN_DEV",
      name: "Development configuration (not a regulatory approval)",
      status: "development_configuration",
      active_from: stamp(world.now - 86_400_000),
      active_until: null,
      approval_status: "development_configuration",
    },
  ];
  const admin = addStaff(world, 10, { name: "Synthetic Admin" });
  grant(world, admin.userId, "manage_policy_configuration");
  const scoped = addStaff(world, 11, { name: "Synthetic Scoped" });
  grant(world, scoped.userId, "manage_policy_configuration", {
    jurisdiction_id: j,
  });
  return { world, j, other, admin, scoped };
}

const sourcesOf = (s, who) => configurationSources(s.world, who.authId);
const confirmed = () => form({ confirmation: DEVELOPMENT_TEST_CONFIRMATION });

test("DTC-1. the definitions are exactly the runbook's thirteen, frozen, labelled DEV TEST, and unique by type, scope and label", () => {
  assert.equal(DEVELOPMENT_TEST_DEFINITIONS.length, 13);
  assert.deepEqual(
    DEVELOPMENT_TEST_DEFINITIONS.map((d) => [
      d.key,
      d.policyTypeCode,
      d.scope,
      d.regulatoryMode,
    ]),
    RUNBOOK,
  );
  assert.equal(DEVELOPMENT_TEST_LABEL_PREFIX, "DEV TEST");
  const deepFrozen = (value) =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(deepFrozen));
  assert.ok(deepFrozen(DEVELOPMENT_TEST_DEFINITIONS));
  const keys = new Set();
  for (const d of DEVELOPMENT_TEST_DEFINITIONS) {
    assert.ok(d.versionLabel.startsWith("DEV TEST "), d.key);
    assert.ok(d.versionLabel.length <= 80, d.key);
    keys.add(JSON.stringify([d.policyTypeCode, d.scope, d.versionLabel]));
  }
  assert.equal(keys.size, 13);
  // The parameters are exactly the runbook's JSON (spot checks of the
  // values the runbook explains).
  const byKey = Object.fromEntries(
    DEVELOPMENT_TEST_DEFINITIONS.map((d) => [d.key, d.parameters]),
  );
  assert.equal(byKey.scheduling.minimum_notice_seconds, 1800);
  assert.equal(byKey.bookability.presence_window_seconds, 120);
  assert.deepEqual(
    byKey["fee-options"].permitted_durations_minutes,
    [30, 60, 90],
  );
  assert.deepEqual(byKey.payment, {});
  assert.equal(
    byKey.engagement.post_consultation_message_window_seconds,
    86400,
  );
  // No id is written into the definitions: the jurisdiction and the mode are
  // resolved at run time.
  assert.doesNotMatch(
    read("src/application/development-test-configuration.ts"),
    /[0-9a-f]{8}-[0-9a-f]{4}-|SYN_STAGING|import\b/,
  );
});

test("DTC-2. every definition passes the application's own validators: the policy creation form's checks, and the eligibility parameter reader", async () => {
  const s = setup();
  for (const d of DEVELOPMENT_TEST_DEFINITIONS) {
    s.world.writes.length = 0;
    const state = await createPolicyVersion(
      sourcesOf(s, s.admin),
      form({
        policy_type: d.policyTypeCode,
        scope: d.scope === "global" ? "global" : s.j,
        regulatory_mode: d.regulatoryMode ? MODE : "",
        version_label: d.versionLabel,
        parameters: JSON.stringify(d.parameters),
        effective_from: "2026-11-17T12:00:00",
        effective_until: "",
        development_only: "yes",
      }),
    );
    assert.deepEqual(state, { status: "recorded" }, d.key);
    assert.equal(s.world.writes.length, 1, d.key);
    assert.deepEqual(s.world.writes[0].args[0].parameters, d.parameters);
  }
  const eligibility = DEVELOPMENT_TEST_DEFINITIONS[0];
  const selection = selectEligibilityPolicy(
    s.j,
    s.world.now,
    [
      {
        id: idOf(8, 1),
        policy_type_code: "eligibility",
        jurisdiction_id: s.j,
        regulatory_mode_id: null,
        version_label: eligibility.versionLabel,
        parameters: eligibility.parameters,
        status: "draft",
        effective_from: stamp(s.world.now - 1000),
        effective_until: null,
        approved_at: null,
        approved_by_user_id: null,
        development_only: true,
      },
    ],
    [],
    "staging",
  );
  assert.equal(selection.status, "selected");
});

test("DTC-3. the action creates the thirteen versions through the policy creation use case, as development configuration effective from now, with the resolved jurisdiction and mode", async () => {
  const s = setup();
  const state = await createDevelopmentTestConfiguration(
    sourcesOf(s, s.admin),
    confirmed(),
  );
  assert.equal(state.status, "completed");
  assert.deepEqual(
    state.results.map((r) => [r.key, r.outcome, r.state]),
    RUNBOOK.map(([key]) => [key, "created", null]),
  );
  assert.equal(s.world.writes.length, 13);
  const from = new Date(Math.floor(s.world.now / 1000) * 1000).toISOString();
  s.world.writes.forEach((write, index) => {
    const [, type, scope, mode] = RUNBOOK[index];
    const d = DEVELOPMENT_TEST_DEFINITIONS[index];
    assert.equal(write.name, "createPolicyVersion");
    assert.deepEqual(write.args, [
      {
        policyTypeCode: type,
        jurisdictionId: scope === "global" ? null : s.j,
        regulatoryModeId: mode ? MODE : null,
        versionLabel: d.versionLabel,
        parameters: d.parameters,
        effectiveFrom: from,
        effectiveUntil: null,
        supersedesId: null,
        developmentOnly: true,
      },
    ]);
  });
});

test("DTC-4. it is idempotent: a version whose type, scope and label exist is skipped and nothing is sent for it", async () => {
  const s = setup();
  const [first, , third] = DEVELOPMENT_TEST_DEFINITIONS;
  addPolicyVersion(s.world, {
    policy_type_code: first.policyTypeCode,
    jurisdiction_id: s.j,
    version_label: first.versionLabel,
    development_only: true,
    effective_from: stamp(s.world.now - 1000),
  });
  addPolicyVersion(s.world, {
    policy_type_code: third.policyTypeCode,
    jurisdiction_id: null,
    version_label: third.versionLabel,
    development_only: true,
    effective_from: stamp(s.world.now - 1000),
  });
  // The same label in another scope is not the same version.
  addPolicyVersion(s.world, {
    policy_type_code: "scheduling",
    jurisdiction_id: s.other,
    version_label: DEVELOPMENT_TEST_DEFINITIONS[1].versionLabel,
  });
  const state = await createDevelopmentTestConfiguration(
    sourcesOf(s, s.admin),
    confirmed(),
  );
  assert.equal(state.status, "completed");
  assert.deepEqual(
    state.results.map((r) => r.outcome),
    ["exists", "created", "exists", ...Array(10).fill("created")],
  );
  assert.equal(s.world.writes.length, 11);
  // A creation the database refuses is reported with its own outcome.
  s.world.writes.length = 0;
  s.world.answers.set("createPolicyVersion", {
    kind: "answer",
    outcome: "conflict",
    value: null,
  });
  const again = await createDevelopmentTestConfiguration(
    sourcesOf(s, s.admin),
    confirmed(),
  );
  assert.deepEqual(again.results[1], {
    key: "scheduling",
    title: "Scheduling",
    versionLabel: DEVELOPMENT_TEST_DEFINITIONS[1].versionLabel,
    outcome: "not-created",
    state: { status: "refused", reason: "conflict" },
  });
});

test("DTC-5. it refuses in production, on an unbound environment, without the global capability, without exactly one development mode, and without the confirmation; nothing is sent", async () => {
  const cases = [
    [
      "production",
      (s) => production(s.world),
      (s) => s.admin,
      { status: "refused", reason: "environment_refused" },
    ],
    [
      "mismatch",
      (s) => {
        s.world.configuration = {
          configuredClass: "production",
          expectedProjectRef: PROJECT_REF,
        };
      },
      (s) => s.admin,
      { status: "refused", reason: "environment_mismatch" },
    ],
    [
      "unrecorded",
      (s) => {
        s.world.deployment_environment = null;
        s.world.configuration = {
          configuredClass: "staging",
          expectedProjectRef: PROJECT_REF,
        };
      },
      (s) => s.admin,
      { status: "refused", reason: "environment_unrecorded" },
    ],
    ["scoped holder", () => {}, (s) => s.scoped, { status: "denied" }],
    [
      "no development mode",
      (s) => {
        s.world.regulatory_modes = [];
      },
      (s) => s.admin,
      { status: "development-mode-missing" },
    ],
    [
      "two development modes",
      (s) => {
        s.world.regulatory_modes.push({
          ...s.world.regulatory_modes[0],
          id: idOf(7, 2),
          jurisdiction_id: s.other,
        });
      },
      (s) => s.admin,
      { status: "development-mode-missing" },
    ],
    [
      "a mode that is not the development mode",
      (s) => {
        s.world.regulatory_modes[0].status = "synthetic";
      },
      (s) => s.admin,
      { status: "development-mode-missing" },
    ],
  ];
  for (const [name, arrange, who, expected] of cases) {
    const s = setup();
    arrange(s);
    assert.deepEqual(
      await createDevelopmentTestConfiguration(
        sourcesOf(s, who(s)),
        confirmed(),
      ),
      expected,
      name,
    );
    assert.deepEqual(s.world.writes, [], name);
  }
  const s = setup();
  for (const data of [
    form({}),
    form({ confirmation: "yes" }),
    form({ confirmation: ["create", "create"] }),
    null,
  ]) {
    assert.deepEqual(
      await createDevelopmentTestConfiguration(sourcesOf(s, s.admin), data),
      { status: "unavailable" },
    );
  }
  assert.deepEqual(s.world.writes, []);
  // The database refuses a development configuration outside development or
  // staging on its own (PS-A2), whatever the application sends.
  const migration = flat(
    read(
      "../../supabase/migrations/20261117010000_mvp_001_s1_environment_identity.sql",
    ),
  );
  assert.ok(
    migration.includes(
      "if new.development_only then v_class := public.rosuno_environment_class(); if v_class not in ('development', 'staging') then raise exception 'development configuration cannot be created in a % environment', v_class",
    ),
  );
});

test("DTC-6. the workspace offers the panel only to a global holder on development or staging with exactly one development mode", async () => {
  const s = setup();
  const view = await resolvePolicyWorkspace(sourcesOf(s, s.admin));
  assert.equal(view.status, "ready");
  assert.deepEqual(view.developmentTest, {
    jurisdictionId: s.j,
    jurisdictionLabel: "Synthetic SYN_DEV (SYN_DEV)",
    regulatoryModeId: MODE,
    regulatoryModeLabel:
      "Development configuration (not a regulatory approval) (DEV_SYN_DEV)",
  });
  assert.equal(
    (await resolvePolicyWorkspace(sourcesOf(s, s.scoped))).developmentTest,
    null,
  );
  production(s.world);
  assert.equal(
    (await resolvePolicyWorkspace(sourcesOf(s, s.admin))).developmentTest,
    null,
  );
  const none = setup();
  none.world.regulatory_modes = [];
  assert.equal(
    (await resolvePolicyWorkspace(sourcesOf(none, none.admin))).developmentTest,
    null,
  );
});

test("DTC-7. source pins: the panel's visibility, the page's step-up check, and the server action's step-up gate and checks", () => {
  const page = read("app/staff/policies/page.tsx");
  assert.match(page, /\n {2}await requireSteppedUp\("staff"\);\n/);
  assert.ok(
    page.includes(
      `{view.canChange &&
      view.developmentAllowed &&
      view.developmentTest !== null ? (`,
    ),
  );
  assert.ok(
    page.includes(
      'title="Development test configuration — test values, not policy"',
    ),
  );
  const forms = read("app/staff/policies/forms.tsx");
  assert.match(forms, /Create the development test configuration\n/);
  assert.match(
    forms,
    /development-only test values\. They decide no production policy/,
  );
  assert.equal(forms.match(/name="confirmation"/g)?.length, 1);
  const actions = flat(read("app/staff/actions.ts"));
  assert.ok(
    actions.includes(
      'return run( "createDevelopmentTestConfiguration", createDevelopmentTestConfiguration, "policies", formData, );',
    ),
  );
  assert.ok(
    actions.includes(
      'const refusal = await stepUpRefusal("staff"); if (refusal !== null) { return refusal; }',
    ),
  );
  const code = read("src/application/staff-configuration.ts");
  const start = code.indexOf(
    "export async function createDevelopmentTestConfiguration(",
  );
  const body = code.slice(start, code.indexOf("\n}\n", start));
  const order = [
    'single(formData, "confirmation") !== DEVELOPMENT_TEST_CONFIRMATION',
    "await contextOf(sources)",
    'holds(\n      reads,\n      "manage_policy_configuration",\n      null,\n      false,\n    )',
    "environmentRefusal(environment)",
    'if (!developmentAllowedIn(environment)) {\n      return refused("environment_refused");',
    "await developmentTestTargetOf(reads, jurisdictions)",
    "await existingVersionKeys(reads)",
    'form.set("development_only", "yes");',
    "await createPolicyVersion(sources, form)",
  ].map((needle) => {
    const at = body.indexOf(needle);
    assert.ok(at > 0, needle);
    return at;
  });
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.equal(body.match(/writes\./g), null);
});

test("DTC-8. sign-in without a continuation goes to the workspace route, which decides from existing reads only and fails closed", () => {
  const page = read("app/workspace/page.tsx");
  const code = page.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /robots: \{ index: false, follow: false \},/);
  assert.match(
    code,
    /await connection\(\);\n {2}redirect\(await workspaceOf\(\)\);/,
  );
  assert.ok(
    flat(code).includes(
      'const staff = await resolveStaffHome(STAFF_CONFIGURATION_SOURCES); if (staff.status === "ready") { return "/staff"; }',
    ),
  );
  assert.ok(
    flat(code).includes(
      'if (attorney.status === "granted") { return "/attorney"; } return staff.status === "sign-in-required" && attorney.status === "sign-in-required" ? "/sign-in" : "/client"; } catch { return "/client"; }',
    ),
  );
  assert.doesNotMatch(
    code,
    /searchParams|params|headers\(|cookies\(|process\.env|\.rpc\(|\.insert\(|\.update\(|grantCapability|createPolicy/,
  );
});
