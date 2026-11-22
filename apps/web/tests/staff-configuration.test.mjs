// MVP-001 S1 staff configuration tests (fixture-only).
//
// The staff configuration boundary runs against the synthetic world in
// configuration-fixtures.mjs, whose read port applies the migration's row
// policies and evaluates has_staff_capability exactly as the migration
// defines it, and whose write port records each staff function call and
// answers what the test configures. No provider, network, or database is
// contacted; every staff member, grant, record, and value is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADD_REFERENCE_OUTCOMES,
  addAuthorityReference,
  CANCEL_JOB_OUTCOMES,
  cancelOperationalJob,
  changeJurisdictionLifecycle,
  configurationPageOf,
  CREATE_JURISDICTION_OUTCOMES,
  CREATE_POLICY_OUTCOMES,
  CREATE_PRACTICE_AREA_OUTCOMES,
  CREATE_SERVICE_AREA_OUTCOMES,
  createJurisdiction,
  createPolicyVersion,
  createPracticeArea,
  createServiceArea,
  DECIDE_REFERENCE_OUTCOMES,
  decideAuthorityReference,
  DEFINE_GATE_OUTCOMES,
  defineLaunchGate,
  END_POLICY_OUTCOMES,
  endPolicyVersion,
  GATE_EVALUATION_OUTCOMES,
  GRANT_CAPABILITY_OUTCOMES,
  GRANT_LAUNCH_OUTCOMES,
  grantCapability,
  grantLaunchAuthorization,
  JOB_GROUPS,
  jobGroupOf,
  LIFECYCLE_OUTCOMES,
  PRACTICE_AREA_ACTIVITY_OUTCOMES,
  PUBLISH_QUESTION_SET_OUTCOMES,
  publishQuestionSet,
  recordLaunchGateEvaluation,
  REFUSAL_REASONS,
  resolveCapabilityAdministration,
  resolveCatalog,
  resolveIntakeConfiguration,
  resolveJurisdiction,
  resolveJurisdictionList,
  resolveLaunch,
  resolveLaunchList,
  resolveMemberCapabilities,
  resolveOperationalJobs,
  resolvePolicyVersion,
  resolvePolicyWorkspace,
  resolveStaffHome,
  RETRY_JOB_OUTCOMES,
  retryOperationalJob,
  REVISE_POLICY_OUTCOMES,
  revisePolicyDraft,
  REVOKE_CAPABILITY_OUTCOMES,
  REVOKE_LAUNCH_OUTCOMES,
  revokeCapability,
  revokeLaunchAuthorization,
  setPracticeAreaActive,
  stateOfAnswer,
  TRANSITION_POLICY_OUTCOMES,
  transitionPolicyVersion,
} from "../src/application/staff-configuration.ts";
import { outcomeMessage } from "../src/presentation/staff-configuration-labels.ts";
import {
  addAccount,
  addAuthorization,
  addEvaluation,
  addGate,
  addJob,
  addJurisdiction,
  addPolicyType,
  addPolicyVersion,
  addPracticeArea,
  addQuestionSet,
  addReference,
  addStaff,
  answer,
  configurationSources,
  createWorld,
  form,
  grant,
  idOf,
  production,
  PROJECT_REF,
  stamp,
  syntheticDefinition,
  UNREADABLE,
} from "./configuration-fixtures.mjs";

const ALL = [
  "manage_attorney_verification",
  "manage_policy_configuration",
  "manage_jurisdiction_configuration",
  "authorize_jurisdiction_launch",
  "manage_staff_capabilities",
  "manage_intake_configuration",
  // MVP-001 S2.
  "manage_operational_jobs",
];

function setup() {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  addPolicyType(world, "synthetic_type");
  const admin = addStaff(world, 10, { name: "Synthetic Admin" });
  for (const capability of ALL) {
    grant(world, admin.userId, capability);
  }
  // Jurisdiction-scoped policy and jurisdiction configuration in SYN_A.
  const scoped = addStaff(world, 11, { name: "Synthetic Scoped" });
  grant(world, scoped.userId, "manage_policy_configuration", {
    jurisdiction_id: a,
  });
  grant(world, scoped.userId, "manage_jurisdiction_configuration", {
    jurisdiction_id: a,
  });
  const plain = addStaff(world, 12, { name: "Synthetic Plain" });
  const draft = addPolicyVersion(world, { jurisdiction_id: a });
  const active = addPolicyVersion(world, {
    jurisdiction_id: a,
    status: "active",
    effective_from: stamp(world.now - 86_400_000),
    approved_at: stamp(world.now - 2 * 86_400_000),
    approved_by_user_id: admin.userId,
  });
  const otherDraft = addPolicyVersion(world, { jurisdiction_id: b });
  const reference = addReference(world, draft.id);
  const area = addPracticeArea(world, 1);
  const gate = addGate(world, a, "synthetic_gate");
  const authorization = addAuthorization(world, a);
  // A grant held by another staff member, for revocation.
  const holder = addStaff(world, 13, { name: "Synthetic Holder" });
  const someGrant = grant(world, holder.userId, "manage_intake_configuration");
  // MVP-001 S2: one escalated operational job, for retry and cancellation.
  const escalatedJob = addJob(world, { state: "escalated" });
  return {
    world,
    a,
    b,
    admin,
    scoped,
    plain,
    draft,
    active,
    otherDraft,
    reference,
    area,
    gate,
    authorization,
    someGrant,
    escalatedJob,
  };
}

const sourcesOf = (s, who, overrides) =>
  configurationSources(s.world, who.authId, overrides);

// Every operation with a valid submission, its outcomes, and the exact call
// the write port must receive for it.
function operations(s) {
  const jurisdictionA = s.world.jurisdictions.find((j) => j.id === s.a);
  return [
    {
      name: "createPolicyVersion",
      run: createPolicyVersion,
      outcomes: CREATE_POLICY_OUTCOMES,
      fields: {
        policy_type: "synthetic_type",
        scope: "global",
        version_label: "synthetic-new",
        parameters: '{"synthetic": 1, "nested": {"list": [1, 2.5]}}',
        effective_from: "2026-12-01T00:00",
        effective_until: "",
      },
      args: [
        {
          policyTypeCode: "synthetic_type",
          jurisdictionId: null,
          regulatoryModeId: null,
          versionLabel: "synthetic-new",
          parameters: { synthetic: 1, nested: { list: [1, 2.5] } },
          effectiveFrom: "2026-12-01T00:00:00.000Z",
          effectiveUntil: null,
          supersedesId: null,
          developmentOnly: false,
        },
      ],
    },
    {
      name: "revisePolicyDraft",
      run: revisePolicyDraft,
      outcomes: REVISE_POLICY_OUTCOMES,
      fields: {
        version: s.draft.id,
        expected_updated_at: s.draft.updated_at,
        version_label: "synthetic-revised",
        parameters: '{"synthetic": 2}',
        effective_from: "2026-12-01T00:00:30",
        effective_until: "",
      },
      args: [
        {
          versionId: s.draft.id,
          expectedUpdatedAt: s.draft.updated_at,
          versionLabel: "synthetic-revised",
          parameters: { synthetic: 2 },
          effectiveFrom: "2026-12-01T00:00:30.000Z",
          effectiveUntil: null,
        },
      ],
    },
    {
      name: "transitionPolicyVersion",
      run: transitionPolicyVersion,
      outcomes: TRANSITION_POLICY_OUTCOMES,
      fields: {
        version: s.draft.id,
        expected_updated_at: s.draft.updated_at,
        target_status: "internal_review",
      },
      args: [s.draft.id, s.draft.updated_at, "internal_review"],
    },
    {
      name: "endPolicyVersion",
      run: endPolicyVersion,
      outcomes: END_POLICY_OUTCOMES,
      fields: { version: s.active.id, effective_until: "2026-12-31T00:00" },
      args: [s.active.id, "2026-12-31T00:00:00.000Z"],
    },
    {
      name: "addAuthorityReference",
      run: addAuthorityReference,
      outcomes: ADD_REFERENCE_OUTCOMES,
      fields: {
        version: s.draft.id,
        authority_type: "synthetic authority",
        citation_text: "Synthetic citation",
        source_uri: "https://example.test/synthetic",
        source_title: "Synthetic source",
        retrieved_at: "2026-11-17T11:00",
      },
      args: [
        {
          versionId: s.draft.id,
          authorityType: "synthetic authority",
          citationText: "Synthetic citation",
          sourceUri: "https://example.test/synthetic",
          sourceTitle: "Synthetic source",
          retrievedAt: "2026-11-17T11:00:00.000Z",
        },
      ],
    },
    {
      name: "decideAuthorityReference",
      run: decideAuthorityReference,
      outcomes: DECIDE_REFERENCE_OUTCOMES,
      fields: { reference: s.reference.id, decision: "verified" },
      args: [s.reference.id, "verified"],
    },
    {
      name: "createJurisdiction",
      run: createJurisdiction,
      outcomes: CREATE_JURISDICTION_OUTCOMES,
      fields: {
        code: "SYN_NEW",
        name: "Synthetic new",
        region_type: "synthetic",
      },
      args: ["SYN_NEW", "Synthetic new", "synthetic"],
    },
    {
      name: "changeJurisdictionLifecycle",
      run: changeJurisdictionLifecycle,
      outcomes: LIFECYCLE_OUTCOMES,
      fields: {
        jurisdiction: s.a,
        expected_updated_at: jurisdictionA.updated_at,
        target_state: "live",
      },
      args: [s.a, jurisdictionA.updated_at, "live"],
    },
    {
      name: "createServiceArea",
      run: createServiceArea,
      outcomes: CREATE_SERVICE_AREA_OUTCOMES,
      fields: {
        jurisdiction: s.a,
        code: "SYN_SERVICE",
        name: "Synthetic service area",
        active_from: "2026-11-01T00:00",
        active_until: "",
      },
      args: [
        {
          jurisdictionId: s.a,
          code: "SYN_SERVICE",
          name: "Synthetic service area",
          activeFrom: "2026-11-01T00:00:00.000Z",
          activeUntil: null,
        },
      ],
    },
    {
      name: "createPracticeArea",
      run: createPracticeArea,
      outcomes: CREATE_PRACTICE_AREA_OUTCOMES,
      fields: { code: "synthetic_new", name: "Synthetic new" },
      args: ["synthetic_new", "Synthetic new"],
    },
    {
      name: "setPracticeAreaActive",
      run: setPracticeAreaActive,
      outcomes: PRACTICE_AREA_ACTIVITY_OUTCOMES,
      fields: { practice_area: s.area, active: "false" },
      args: [s.area, false],
    },
    {
      name: "defineLaunchGate",
      run: defineLaunchGate,
      outcomes: DEFINE_GATE_OUTCOMES,
      fields: {
        jurisdiction: s.a,
        gate_code: "synthetic_second",
        required: "yes",
        description: "",
      },
      args: [s.a, "synthetic_second", true, null],
    },
    {
      name: "recordLaunchGateEvaluation",
      run: recordLaunchGateEvaluation,
      outcomes: GATE_EVALUATION_OUTCOMES,
      fields: {
        gate: s.gate.id,
        evaluation_status: "passed",
        evidence_reference: '{"document": "synthetic"}',
        reason: "Synthetic reason",
      },
      args: [
        s.gate.id,
        "passed",
        { document: "synthetic" },
        "Synthetic reason",
      ],
    },
    {
      name: "grantLaunchAuthorization",
      run: grantLaunchAuthorization,
      outcomes: GRANT_LAUNCH_OUTCOMES,
      fields: { jurisdiction: s.a, reason: "Synthetic reason" },
      args: [s.a, "Synthetic reason"],
    },
    {
      name: "revokeLaunchAuthorization",
      run: revokeLaunchAuthorization,
      outcomes: REVOKE_LAUNCH_OUTCOMES,
      fields: { authorization: s.authorization.id, reason: "Synthetic reason" },
      args: [s.authorization.id, "Synthetic reason"],
    },
    {
      name: "grantCapability",
      run: grantCapability,
      outcomes: GRANT_CAPABILITY_OUTCOMES,
      fields: {
        member: s.scoped.userId,
        capability_code: "authorize_jurisdiction_launch",
        scope: s.a,
        expires_at: "2027-01-01T00:00",
      },
      args: [
        s.scoped.userId,
        "authorize_jurisdiction_launch",
        s.a,
        "2027-01-01T00:00:00.000Z",
      ],
    },
    {
      name: "revokeCapability",
      run: revokeCapability,
      outcomes: REVOKE_CAPABILITY_OUTCOMES,
      fields: { grant: s.someGrant.id },
      args: [s.someGrant.id],
    },
    {
      name: "publishQuestionSet",
      run: publishQuestionSet,
      outcomes: PUBLISH_QUESTION_SET_OUTCOMES,
      fields: {
        version_key: "synthetic-next",
        definition: JSON.stringify(syntheticDefinition(), null, 2),
      },
      args: ["synthetic-next", syntheticDefinition()],
    },
    // MVP-001 S2: the staff operational job changes.
    {
      name: "retryOperationalJob",
      run: retryOperationalJob,
      outcomes: RETRY_JOB_OUTCOMES,
      fields: { job: s.escalatedJob.id },
      args: [s.escalatedJob.id],
    },
    {
      name: "cancelOperationalJob",
      run: cancelOperationalJob,
      outcomes: CANCEL_JOB_OUTCOMES,
      fields: { job: s.escalatedJob.id },
      args: [s.escalatedJob.id],
    },
  ];
}

function views(s) {
  return [
    ["home", (src) => resolveStaffHome(src)],
    ["policies", (src) => resolvePolicyWorkspace(src)],
    ["policy version", (src) => resolvePolicyVersion(src, s.draft.id)],
    ["jurisdictions", (src) => resolveJurisdictionList(src)],
    ["jurisdiction", (src) => resolveJurisdiction(src, s.a)],
    ["launch list", (src) => resolveLaunchList(src)],
    ["launch", (src) => resolveLaunch(src, s.a)],
    ["catalog", (src) => resolveCatalog(src)],
    ["capabilities", (src) => resolveCapabilityAdministration(src)],
    ["member", (src) => resolveMemberCapabilities(src, s.scoped.userId)],
    ["intake", (src) => resolveIntakeConfiguration(src)],
    ["jobs", (src) => resolveOperationalJobs(src)],
  ];
}

// The state each database outcome must map to.
function expectedState(outcome) {
  if (["created", "applied", "published"].includes(outcome)) {
    return { status: "recorded" };
  }
  if (outcome === "unchanged") {
    return { status: "unchanged" };
  }
  if (outcome === "denied" || outcome === "forbidden") {
    return { status: "denied" };
  }
  return { status: "refused", reason: outcome };
}

test("SC-1. identity: anonymous, unconfirmed, non-staff, inactive staff, and suspended Users are refused on every view and action, and nothing is sent", async () => {
  const s = setup();
  const unconfirmed = addStaff(s.world, 20, { confirmed: false });
  for (const capability of ALL) {
    grant(s.world, unconfirmed.userId, capability);
  }
  const callers = [
    [{ authId: null }, "sign-in-required"],
    [unconfirmed, "denied"],
    [addAccount(s.world, 21), "denied"],
  ];
  for (const [n, state] of [
    [22, "invited"],
    [23, "deactivated"],
    [24, "removed"],
  ]) {
    const staff = addStaff(s.world, n, { state });
    for (const capability of ALL) {
      grant(s.world, staff.userId, capability);
    }
    callers.push([staff, "denied"]);
  }
  const suspended = addStaff(s.world, 25, { state: "active" });
  for (const capability of ALL) {
    grant(s.world, suspended.userId, capability);
  }
  s.world.users.find((u) => u.id === suspended.userId).account_state =
    "suspended";
  callers.push([suspended, "denied"]);
  for (const [who, expected] of callers) {
    for (const [name, view] of views(s)) {
      assert.equal((await view(sourcesOf(s, who))).status, expected, name);
    }
    for (const op of operations(s)) {
      assert.deepEqual(
        await op.run(sourcesOf(s, who), form(op.fields)),
        { status: expected },
        op.name,
      );
    }
  }
  assert.deepEqual(s.world.writes, []);
});

test("SC-2. the staff home lists exactly the surfaces the caller holds a current grant for", async () => {
  const s = setup();
  const home = async (who) =>
    (await resolveStaffHome(sourcesOf(s, who))).surfaces;
  // MVP-001 S11 PS-A6 re-pin: every active staff member may also request
  // break-glass access (no capability), listed last.
  const ALWAYS = "break-glass";
  assert.deepEqual(await home(s.admin), [
    "verification",
    "policies",
    "jurisdictions",
    "launch",
    "catalog",
    "capabilities",
    "intake",
    // MVP-001 S3 part 2: the admin's global intake grant opens the review.
    "jurisdiction-review",
    "jobs",
    ALWAYS,
  ]);
  // MVP-001 S3 part 2: a jurisdiction-scoped manage_intake_configuration
  // grant opens the review and nothing else (publishing needs the global
  // grant).
  const reviewer = addStaff(s.world, 34);
  grant(s.world, reviewer.userId, "manage_intake_configuration", {
    jurisdiction_id: s.a,
  });
  assert.deepEqual(await home(reviewer), ["jurisdiction-review", ALWAYS]);
  // MVP-001 S2: the job view needs the global manage_operational_jobs grant;
  // a jurisdiction-scoped one counts for nothing.
  const operator = addStaff(s.world, 32);
  grant(s.world, operator.userId, "manage_operational_jobs");
  assert.deepEqual(await home(operator), ["jobs", ALWAYS]);
  const scopedOperator = addStaff(s.world, 33);
  grant(s.world, scopedOperator.userId, "manage_operational_jobs", {
    jurisdiction_id: s.a,
  });
  assert.deepEqual(await home(scopedOperator), [ALWAYS]);
  // Jurisdiction-scoped grants: the scoped surfaces, but not the catalog,
  // which needs the global jurisdiction-configuration grant.
  assert.deepEqual(await home(s.scoped), [
    "policies",
    "jurisdictions",
    "launch",
    ALWAYS,
  ]);
  assert.deepEqual(await home(s.plain), [ALWAYS]);
  const launcher = addStaff(s.world, 30);
  grant(s.world, launcher.userId, "authorize_jurisdiction_launch", {
    jurisdiction_id: s.b,
  });
  assert.deepEqual(await home(launcher), ["launch", ALWAYS]);
  // Expired, revoked, future, and resource-scoped grants count for nothing.
  const lapsed = addStaff(s.world, 31);
  for (const overrides of [
    { expires_at: stamp(s.world.now - 1) },
    { revoked_at: stamp(s.world.now - 1) },
    { granted_at: stamp(s.world.now + 60_000) },
    { resource_scope: { synthetic: true } },
  ]) {
    grant(s.world, lapsed.userId, "manage_staff_capabilities", overrides);
  }
  assert.deepEqual(await home(lapsed), [ALWAYS]);
  // An unreadable capability answer is unavailable, never access.
  s.world.failures.add("reads.holdsCapability");
  assert.deepEqual(await resolveStaffHome(sourcesOf(s, s.admin)), {
    status: "unavailable",
  });
});

test("SC-3. each surface refuses a caller without its own capability, and an unreadable answer or missing port is unavailable", async () => {
  const s = setup();
  for (const [name, view] of views(s).slice(1)) {
    assert.equal((await view(sourcesOf(s, s.plain))).status, "denied", name);
  }
  // The scoped caller: SYN_A only; the global-only surfaces are refused.
  const scoped = (view) => view(sourcesOf(s, s.scoped));
  assert.equal((await scoped(resolveCatalog)).status, "denied");
  assert.equal(
    (await scoped(resolveCapabilityAdministration)).status,
    "denied",
  );
  assert.equal(
    (await resolveJurisdiction(sourcesOf(s, s.scoped), s.b)).status,
    "denied",
  );
  assert.equal(
    (await resolvePolicyVersion(sourcesOf(s, s.scoped), s.otherDraft.id))
      .status,
    "denied",
  );
  assert.equal(
    (await resolveLaunch(sourcesOf(s, s.scoped), s.b)).status,
    "denied",
  );
  // Unknown or malformed ids look exactly like no access.
  for (const id of [idOf(5, 99), "not-an-id", undefined]) {
    assert.equal(
      (await resolveJurisdiction(sourcesOf(s, s.admin), id)).status,
      "denied",
    );
    assert.equal(
      (await resolvePolicyVersion(sourcesOf(s, s.admin), id)).status,
      "denied",
    );
    assert.equal(
      (await resolveMemberCapabilities(sourcesOf(s, s.admin), id)).status,
      "denied",
    );
  }
  for (const [name, view] of views(s)) {
    s.world.failures.add("reads.holdsCapability");
    assert.equal(
      (await view(sourcesOf(s, s.admin))).status,
      "unavailable",
      name,
    );
    s.world.failures.clear();
    assert.equal(
      (await view(sourcesOf(s, s.admin, { reads: async () => null }))).status,
      "unavailable",
      name,
    );
    assert.equal(
      (
        await view(
          sourcesOf(s, s.admin, {
            reads: async () => {
              throw new Error("synthetic");
            },
          }),
        )
      ).status,
      "unavailable",
      name,
    );
  }
  // Every surface that offers changes is not offered without its write port.
  for (const [name, view] of views(s).slice(1)) {
    assert.equal(
      (await view(sourcesOf(s, s.admin, { writes: async () => null }))).status,
      "unavailable",
      name,
    );
  }
});

test("SC-4. policy versions are listed under the row policies, newest first, one explicit page at a time, and never silently cut", async () => {
  const s = setup();
  const scoped = await resolvePolicyWorkspace(sourcesOf(s, s.scoped));
  assert.deepEqual(
    scoped.versions.map((v) => v.id),
    [s.active.id, s.draft.id],
  );
  assert.deepEqual(
    scoped.scopes.map((o) => o.value),
    [s.a],
  );
  const admin = await resolvePolicyWorkspace(sourcesOf(s, s.admin));
  assert.deepEqual(
    admin.versions.map((v) => v.id),
    [s.otherDraft.id, s.active.id, s.draft.id],
  );
  assert.deepEqual(
    admin.scopes.map((o) => o.value),
    ["global", s.a, s.b],
  );
  assert.equal(admin.versions[0].jurisdiction, "Synthetic SYN_B (SYN_B)");
  assert.equal(admin.versions[0].type, "Synthetic synthetic_type");
  for (let n = 0; n < 30; n += 1) {
    addPolicyVersion(s.world, { jurisdiction_id: s.a });
  }
  s.world.calls.length = 0;
  const first = await resolvePolicyWorkspace(sourcesOf(s, s.admin), "1");
  assert.equal(first.versions.length, 25);
  assert.deepEqual(first.pager, {
    page: 1,
    pageSize: 25,
    previousPage: null,
    nextPage: 2,
  });
  assert.ok(s.world.calls.includes("reads.policyVersions:0:26"));
  const second = await resolvePolicyWorkspace(sourcesOf(s, s.admin), "2");
  assert.equal(second.versions.length, 8);
  assert.deepEqual(second.pager, {
    page: 2,
    pageSize: 25,
    previousPage: 1,
    nextPage: null,
  });
  assert.ok(s.world.calls.includes("reads.policyVersions:25:26"));
  assert.equal(
    new Set([...first.versions, ...second.versions].map((v) => v.id)).size,
    33,
  );
  for (const value of ["0", "abc", "1e3", "-1", " 2", "1234567", ["2"], 2]) {
    assert.equal(configurationPageOf(value), 1, String(value));
  }
  assert.equal(configurationPageOf("999999"), 999999);
  // A port that answers more rows than were asked for is not trusted.
  const flooding = sourcesOf(s, s.admin, {
    reads: async () => ({
      ...(await sourcesOf(s, s.admin).reads()),
      policyVersions: async () => ({
        kind: "rows",
        rows: Array.from({ length: 27 }, () => s.world.policy_versions[0]),
      }),
    }),
  });
  assert.deepEqual(await resolvePolicyWorkspace(flooding), {
    status: "unavailable",
  });
  // A choice list read within its bound says when the bound is reached.
  for (let n = 0; n < 200; n += 1) {
    addPolicyType(s.world, `synthetic_type_${String(n).padStart(3, "0")}`);
  }
  const bounded = await resolvePolicyWorkspace(sourcesOf(s, s.admin));
  assert.equal(bounded.policyTypes.length, 200);
  assert.equal(bounded.policyTypesComplete, false);
  s.world.policy_types.pop();
  assert.equal(
    (await resolvePolicyWorkspace(sourcesOf(s, s.admin))).policyTypesComplete,
    true,
  );
});

test("SC-5. development configuration is offered only where the database records a development or staging environment, and policy changes need a bound environment", async () => {
  const s = setup();
  const view = async () => resolvePolicyWorkspace(sourcesOf(s, s.admin));
  assert.equal((await view()).developmentAllowed, true);
  assert.equal((await view()).canChange, true);
  s.world.deployment_environment = {
    environment_class: "staging",
    project_ref: PROJECT_REF,
  };
  assert.equal((await view()).developmentAllowed, true);
  production(s.world);
  assert.equal((await view()).developmentAllowed, false);
  assert.equal((await view()).canChange, true);
  // A misbound deployment and an unrecorded database refuse policy changes.
  s.world.configuration = {
    configuredClass: "staging",
    expectedProjectRef: PROJECT_REF,
  };
  assert.equal((await view()).environment, "mismatch");
  assert.equal((await view()).canChange, false);
  assert.equal((await view()).developmentAllowed, false);
  s.world.configuration = null;
  s.world.deployment_environment = null;
  assert.equal((await view()).environment, "unrecorded");
  assert.equal((await view()).canChange, false);
  const detail = await resolvePolicyVersion(sourcesOf(s, s.admin), s.draft.id);
  assert.equal(detail.canChange, false);
});

test("SC-6. a development configuration is refused before sending outside development or staging, and every policy change is refused on an unbound environment", async () => {
  const s = setup();
  const devFields = {
    ...operations(s)[0].fields,
    development_only: "yes",
  };
  production(s.world);
  assert.deepEqual(
    await createPolicyVersion(sourcesOf(s, s.admin), form(devFields)),
    { status: "refused", reason: "environment_refused" },
  );
  assert.deepEqual(s.world.writes, []);
  s.world.deployment_environment = {
    environment_class: "staging",
    project_ref: PROJECT_REF,
  };
  assert.deepEqual(
    await createPolicyVersion(sourcesOf(s, s.admin), form(devFields)),
    { status: "recorded" },
  );
  assert.equal(s.world.writes[0].args[0].developmentOnly, true);
  s.world.writes.length = 0;
  // A development configuration needs an effective start.
  assert.deepEqual(
    await createPolicyVersion(
      sourcesOf(s, s.admin),
      form({ ...devFields, effective_from: "" }),
    ),
    {
      status: "invalid",
      fieldErrors: {
        effective_from: [
          "A development configuration needs an effective start.",
        ],
      },
    },
  );
  const policyOps = operations(s).slice(0, 6);
  for (const [environment, reason, configuration] of [
    [null, "environment_unrecorded", null],
    [
      { environment_class: "production", project_ref: PROJECT_REF },
      "environment_mismatch",
      { configuredClass: "production", expectedProjectRef: null },
    ],
  ]) {
    s.world.deployment_environment = environment;
    s.world.configuration = configuration;
    for (const op of policyOps) {
      assert.deepEqual(
        await op.run(sourcesOf(s, s.admin), form(op.fields)),
        { status: "refused", reason },
        op.name,
      );
    }
  }
  assert.deepEqual(s.world.writes, []);
});

test("SC-7. every operation sends exactly one call with exactly its named values to its own write function", async () => {
  for (const op of operations(setup())) {
    const s = setup();
    const fresh = operations(s).find((o) => o.name === op.name);
    assert.deepEqual(
      await fresh.run(sourcesOf(s, s.admin), form(fresh.fields)),
      { status: "recorded" },
      op.name,
    );
    assert.deepEqual(s.world.writes, [{ name: op.name, args: fresh.args }]);
  }
});

test("SC-8. every database outcome maps to its fixed state, and an outcome outside the function's own list, a lost, malformed, rejected, or thrown answer is never success", async () => {
  for (const op of operations(setup())) {
    for (const outcome of op.outcomes) {
      const s = setup();
      const fresh = operations(s).find((o) => o.name === op.name);
      const id = ["created", "published"].includes(outcome) ? idOf(8, 1) : null;
      s.world.answers.set(op.name, answer(outcome, id));
      assert.deepEqual(
        await fresh.run(sourcesOf(s, s.admin), form(fresh.fields)),
        expectedState(outcome),
        `${op.name}: ${outcome}`,
      );
      assert.equal(s.world.writes.length, 1);
    }
    const s = setup();
    const fresh = operations(s).find((o) => o.name === op.name);
    const run = () => fresh.run(sourcesOf(s, s.admin), form(fresh.fields));
    const success = op.outcomes[0];
    for (const [label, configured, expected] of [
      ["unknown outcome", answer("synthetic_outcome"), "unconfirmed"],
      [
        "another function's outcome",
        answer(op.outcomes.includes("published") ? "created" : "published"),
        "unconfirmed",
      ],
      [
        "success without a generated id",
        answer(success, success === "applied" ? "x" : null),
        "unconfirmed",
      ],
      ["lost answer", UNREADABLE, "unconfirmed"],
      ["database refusal", { kind: "rejected" }, "not-saved"],
      [
        "extra key",
        { kind: "answer", outcome: success, value: null, extra: 1 },
        "unconfirmed",
      ],
      ["not an answer", "applied", "unconfirmed"],
      [
        "thrown",
        () => {
          throw new Error("synthetic");
        },
        "unconfirmed",
      ],
    ]) {
      s.world.answers.set(op.name, configured);
      assert.deepEqual(
        await run(),
        { status: expected },
        `${op.name}: ${label}`,
      );
    }
    // A refusal answered with an id is not one the database gives.
    s.world.answers.set(op.name, answer("invalid", idOf(8, 2)));
    assert.deepEqual(await run(), { status: "unconfirmed" }, op.name);
  }
  // The answer reader itself, directly.
  assert.deepEqual(stateOfAnswer(answer("applied"), ["applied"]), {
    status: "recorded",
  });
  assert.deepEqual(stateOfAnswer(undefined, ["applied"]), {
    status: "unconfirmed",
  });
  assert.deepEqual(stateOfAnswer(answer("applied"), []), {
    status: "unconfirmed",
  });
});

test("SC-9. every refusal reason and action state has its own fixed message", () => {
  for (const reason of REFUSAL_REASONS) {
    const message = outcomeMessage({ status: "refused", reason });
    assert.ok(message.title && message.body, reason);
    assert.match(message.body, /Nothing was saved|nothing was saved/, reason);
  }
  const titles = new Set(
    REFUSAL_REASONS.map(
      (reason) => outcomeMessage({ status: "refused", reason }).title,
    ),
  );
  assert.equal(titles.size, REFUSAL_REASONS.length);
  for (const status of [
    "recorded",
    "unchanged",
    "not-saved",
    "unconfirmed",
    "sign-in-required",
    "denied",
    "unavailable",
  ]) {
    assert.ok(outcomeMessage({ status }).body, status);
  }
  assert.ok(outcomeMessage({ status: "invalid", fieldErrors: {} }).body);
  assert.equal(outcomeMessage({ status: "idle" }), null);
  // Every reason any function can answer has a message.
  for (const list of [
    CREATE_POLICY_OUTCOMES,
    REVISE_POLICY_OUTCOMES,
    TRANSITION_POLICY_OUTCOMES,
    END_POLICY_OUTCOMES,
    ADD_REFERENCE_OUTCOMES,
    DECIDE_REFERENCE_OUTCOMES,
    CREATE_JURISDICTION_OUTCOMES,
    LIFECYCLE_OUTCOMES,
    CREATE_SERVICE_AREA_OUTCOMES,
    CREATE_PRACTICE_AREA_OUTCOMES,
    PRACTICE_AREA_ACTIVITY_OUTCOMES,
    DEFINE_GATE_OUTCOMES,
    GATE_EVALUATION_OUTCOMES,
    GRANT_LAUNCH_OUTCOMES,
    REVOKE_LAUNCH_OUTCOMES,
    GRANT_CAPABILITY_OUTCOMES,
    REVOKE_CAPABILITY_OUTCOMES,
    PUBLISH_QUESTION_SET_OUTCOMES,
    RETRY_JOB_OUTCOMES,
    CANCEL_JOB_OUTCOMES,
  ]) {
    for (const outcome of list) {
      const state = expectedState(outcome);
      if (state.status === "refused") {
        assert.ok(REFUSAL_REASONS.includes(outcome), outcome);
      }
    }
  }
});

test("SC-10. authority: a caller without the exact capability for the record's scope, or a record its session cannot read, is refused and nothing is sent", async () => {
  const s = setup();
  for (const op of operations(s)) {
    assert.deepEqual(
      await op.run(sourcesOf(s, s.plain), form(op.fields)),
      { status: "denied" },
      op.name,
    );
  }
  // The SYN_A-scoped caller, acting on SYN_B records or on the global scope.
  const jurisdictionB = s.world.jurisdictions.find((j) => j.id === s.b);
  const outOfScope = [
    [createPolicyVersion, { ...operations(s)[0].fields }],
    [createPolicyVersion, { ...operations(s)[0].fields, jurisdiction_id: s.b }],
    [
      revisePolicyDraft,
      {
        ...operations(s)[1].fields,
        version: s.otherDraft.id,
        expected_updated_at: s.otherDraft.updated_at,
      },
    ],
    [createJurisdiction, operations(s)[6].fields],
    [
      changeJurisdictionLifecycle,
      {
        jurisdiction: s.b,
        expected_updated_at: jurisdictionB.updated_at,
        target_state: "ready",
      },
    ],
    [createServiceArea, { ...operations(s)[8].fields, jurisdiction: s.b }],
    [createPracticeArea, operations(s)[9].fields],
    [setPracticeAreaActive, operations(s)[10].fields],
    [defineLaunchGate, { ...operations(s)[11].fields, jurisdiction: s.b }],
    [grantLaunchAuthorization, operations(s)[13].fields],
    [revokeLaunchAuthorization, operations(s)[14].fields],
    [grantCapability, { ...operations(s)[15].fields, member: s.plain.userId }],
    [revokeCapability, operations(s)[16].fields],
    [publishQuestionSet, operations(s)[17].fields],
  ];
  for (const [run, fields] of outOfScope) {
    assert.deepEqual(
      await run(sourcesOf(s, s.scoped), form(fields)),
      { status: "denied" },
      run.name,
    );
  }
  // An unknown record looks exactly like one the caller cannot read.
  for (const [run, fields] of [
    [revisePolicyDraft, { ...operations(s)[1].fields, version: idOf(9, 999) }],
    [
      decideAuthorityReference,
      { reference: idOf(9, 999), decision: "rejected" },
    ],
    [
      recordLaunchGateEvaluation,
      { ...operations(s)[12].fields, gate: idOf(9, 999) },
    ],
    [
      revokeLaunchAuthorization,
      { authorization: idOf(9, 999), reason: "Synthetic" },
    ],
    [
      changeJurisdictionLifecycle,
      { ...operations(s)[7].fields, jurisdiction: idOf(5, 999) },
    ],
  ]) {
    assert.deepEqual(
      await run(sourcesOf(s, s.admin), form(fields)),
      { status: "denied" },
      run.name,
    );
  }
  assert.deepEqual(s.world.writes, []);
  // An unreadable capability answer is unavailable and sends nothing.
  s.world.failures.add("reads.holdsCapability");
  for (const op of operations(s)) {
    assert.deepEqual(
      await op.run(sourcesOf(s, s.admin), form(op.fields)),
      { status: "unavailable" },
      op.name,
    );
  }
  assert.deepEqual(s.world.writes, []);
});

test("SC-11. malformed input is refused before anything is read or sent, with a message for each field", async () => {
  const s = setup();
  const base = operations(s);
  const cases = [
    [0, { parameters: "{not json" }, "parameters"],
    [0, { parameters: "[1, 2]" }, "parameters"],
    [0, { parameters: "null" }, "parameters"],
    [0, { parameters: "" }, "parameters"],
    [0, { parameters: '{"n": 12345678901234567}' }, "parameters"],
    [0, { parameters: '{"n": 1e400}' }, "parameters"],
    [0, { parameters: '{"n": 0.10000000000000001}' }, "parameters"],
    [0, { parameters: `{"t": "${"x".repeat(70000)}"}` }, "parameters"],
    [0, { version_label: "" }, "version_label"],
    [0, { version_label: "x".repeat(81) }, "version_label"],
    [0, { version_label: "bad\u0007label" }, "version_label"],
    [0, { policy_type: "Bad Type" }, "policy_type"],
    [0, { scope: "not-an-id" }, "scope"],
    [0, { scope: "" }, "scope"],
    [0, { effective_from: "2026-13-01T00:00" }, "effective_from"],
    [0, { effective_until: "2026-11-30T00:00" }, "effective_until"],
    [
      0,
      { effective_from: "", effective_until: "2026-12-30T00:00" },
      "effective_until",
    ],
    [1, { parameters: "[]" }, "parameters"],
    [3, { effective_until: "2026-11-17T11:00" }, "effective_until"],
    [3, { effective_until: "" }, "effective_until"],
    [4, { source_uri: "http://example.test/insecure" }, "source_uri"],
    [4, { retrieved_at: "2026-11-18T00:00" }, "retrieved_at"],
    [4, { citation_text: "" }, "citation_text"],
    [6, { code: "syn_lower" }, "code"],
    [6, { name: "" }, "name"],
    [7, { target_state: "launched" }, "target_state"],
    [8, { code: "x" }, "code"],
    [8, { active_from: "" }, "active_from"],
    [8, { active_until: "2026-10-01T00:00" }, "active_until"],
    [9, { code: "Synthetic" }, "code"],
    [11, { gate_code: "ab" }, "gate_code"],
    [11, { required: "" }, "required"],
    [12, { evaluation_status: "pending" }, "evaluation_status"],
    [12, { evidence_reference: "[1]" }, "evidence_reference"],
    [
      12,
      { evidence_reference: `{"t": "${"x".repeat(9000)}"}` },
      "evidence_reference",
    ],
    [12, { reason: "" }, "reason"],
    [13, { reason: "" }, "reason"],
    [15, { capability_code: "" }, "capability_code"],
    [15, { scope: "x" }, "scope"],
    [15, { scope: "" }, "scope"],
    [15, { expires_at: "2026-11-17T11:00" }, "expires_at"],
    [17, { version_key: "Bad Key" }, "version_key"],
    [17, { definition: '{"format": 2}' }, "definition"],
    [
      17,
      { definition: JSON.stringify(syntheticDefinition({ questions: [] })) },
      "definition",
    ],
  ];
  for (const [index, change, field] of cases) {
    const op = base[index];
    s.world.calls.length = 0;
    const state = await op.run(
      sourcesOf(s, s.admin),
      form({ ...op.fields, ...change }),
    );
    assert.equal(state.status, "invalid", `${op.name} ${field}`);
    assert.ok(state.fieldErrors[field]?.length > 0, `${op.name} ${field}`);
    assert.deepEqual(s.world.calls, [], `${op.name} ${field}`);
  }
  // A hidden field this page did not render, a repeated field, or no form
  // at all is unavailable, and nothing is sent.
  const tampered = [
    [0, { supersedes: "not-an-id" }, "unavailable"],
    [0, { development_only: "true" }, "unavailable"],
    [0, { version_label: ["a", "b"] }, "invalid"],
    [1, { version: "not-an-id" }, "unavailable"],
    [1, { expected_updated_at: "yesterday" }, "unavailable"],
    [2, { target_status: "published" }, "unavailable"],
    [5, { decision: "maybe" }, "unavailable"],
    [7, { jurisdiction: "x" }, "unavailable"],
    [10, { active: "yes" }, "unavailable"],
    [12, { gate: "" }, "unavailable"],
    [14, { authorization: "x" }, "unavailable"],
    [15, { member: "x" }, "unavailable"],
    [16, { grant: "x" }, "unavailable"],
  ];
  for (const [index, change, expected] of tampered) {
    const op = base[index];
    const state = await op.run(
      sourcesOf(s, s.admin),
      form({ ...op.fields, ...change }),
    );
    assert.equal(
      state.status,
      expected,
      `${op.name} ${JSON.stringify(change)}`,
    );
  }
  for (const op of base) {
    assert.deepEqual(
      await op.run(sourcesOf(s, s.admin), { ...op.fields }),
      { status: "unavailable" },
      op.name,
    );
  }
  assert.deepEqual(s.world.writes, []);
});

test("SC-12. a successor draft takes its type and scope from the version it supersedes, never from the form", async () => {
  const s = setup();
  const fields = {
    supersedes: s.active.id,
    policy_type: "ignored_type",
    scope: s.b,
    version_label: "synthetic-successor",
    parameters: "{}",
    effective_from: "",
    effective_until: "",
  };
  assert.deepEqual(
    await createPolicyVersion(sourcesOf(s, s.scoped), form(fields)),
    { status: "recorded" },
  );
  assert.deepEqual(s.world.writes[0].args[0], {
    policyTypeCode: "synthetic_type",
    jurisdictionId: s.a,
    regulatoryModeId: null,
    versionLabel: "synthetic-successor",
    parameters: {},
    effectiveFrom: null,
    effectiveUntil: null,
    supersedesId: s.active.id,
    developmentOnly: false,
  });
  // A version the caller cannot read cannot be superseded.
  assert.deepEqual(
    await createPolicyVersion(
      sourcesOf(s, s.scoped),
      form({ ...fields, supersedes: s.otherDraft.id }),
    ),
    { status: "denied" },
  );
  assert.equal(s.world.writes.length, 1);
});

test("SC-13. nobody grants themselves a capability: refused before sending; a decision on a reference checks the version's scope", async () => {
  const s = setup();
  assert.deepEqual(
    await grantCapability(
      sourcesOf(s, s.admin),
      form({ ...operations(s)[15].fields, member: s.admin.userId }),
    ),
    { status: "refused", reason: "self_grant_refused" },
  );
  assert.deepEqual(s.world.writes, []);
  // A reference of a SYN_B version is out of the scoped caller's reach.
  const otherReference = addReference(s.world, s.otherDraft.id);
  assert.deepEqual(
    await decideAuthorityReference(
      sourcesOf(s, s.scoped),
      form({ reference: otherReference.id, decision: "verified" }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await decideAuthorityReference(
      sourcesOf(s, s.scoped),
      form({ reference: s.reference.id, decision: "rejected" }),
    ),
    { status: "recorded" },
  );
  assert.deepEqual(s.world.writes, [
    { name: "decideAuthorityReference", args: [s.reference.id, "rejected"] },
  ]);
});

test("SC-14. a policy version offers only the changes its state allows, and marks development configuration", async () => {
  const s = setup();
  const view = async (version) =>
    resolvePolicyVersion(sourcesOf(s, s.admin), version.id);
  const draft = await view(s.draft);
  assert.equal(draft.status, "ready");
  assert.equal(draft.draftFamily, true);
  assert.deepEqual(draft.transitions, ["internal_review"]);
  assert.equal(draft.canEnd, false);
  assert.equal(draft.hasVerifiedReference, false);
  assert.deepEqual(
    draft.references.map((r) => [r.id, r.status, r.verifiedBy]),
    [[s.reference.id, "unverified", null]],
  );
  assert.equal(draft.version.parametersText, '{\n  "synthetic": true\n}');
  const counsel = addPolicyVersion(s.world, {
    jurisdiction_id: s.a,
    status: "counsel_review",
  });
  addReference(s.world, counsel.id, {
    verification_status: "verified",
    verified_by_user_id: s.admin.userId,
  });
  const counselView = await view(counsel);
  assert.deepEqual(counselView.transitions, [
    "draft",
    "internal_review",
    "approved",
  ]);
  assert.equal(counselView.hasVerifiedReference, true);
  assert.equal(counselView.references[0].verifiedBy, "you");
  const active = await view(s.active);
  assert.equal(active.draftFamily, false);
  assert.deepEqual(active.transitions, ["suspended", "retired"]);
  assert.equal(active.canEnd, true);
  assert.equal(active.version.approvedBy, "you");
  const retired = await view(
    addPolicyVersion(s.world, {
      jurisdiction_id: s.a,
      status: "retired",
      effective_from: stamp(s.world.now - 1000),
      approved_at: stamp(s.world.now - 2000),
      approved_by_user_id: idOf(2, 999),
    }),
  );
  assert.deepEqual(retired.transitions, []);
  assert.equal(retired.canEnd, false);
  assert.equal(retired.version.approvedBy, "another staff member");
  const development = await view(
    addPolicyVersion(s.world, {
      jurisdiction_id: s.a,
      development_only: true,
      effective_from: stamp(s.world.now - 1000),
    }),
  );
  assert.equal(development.version.developmentOnly, true);
  assert.equal(development.draftFamily, false);
  assert.deepEqual(development.transitions, []);
  assert.equal(development.canEnd, true);
  assert.equal(development.canSucceed, false);
  // A reference that belongs to another version is not trusted.
  s.world.policy_authority_references.push({
    ...s.reference,
    id: idOf(9, 500),
  });
  const reads = await sourcesOf(s, s.admin).reads();
  const mixed = sourcesOf(s, s.admin, {
    reads: async () => ({
      ...reads,
      authorityReferencesOf: async () => ({
        kind: "rows",
        rows: [
          {
            ...(await reads.authorityReferenceById(s.reference.id)).rows[0],
            policy_version_id: s.otherDraft.id,
          },
        ],
      }),
    }),
  });
  assert.deepEqual(await resolvePolicyVersion(mixed, s.draft.id), {
    status: "unavailable",
  });
});

test("SC-15. jurisdictions, service areas, launch gates, and authorizations are shown within the caller's scope and bounds", async () => {
  const s = setup();
  s.world.service_areas.push(
    {
      id: idOf(9, 701),
      jurisdiction_id: s.a,
      code: "SYN_ONE",
      name: "Synthetic one",
      active_from: stamp(s.world.now),
      active_until: null,
    },
    {
      id: idOf(9, 702),
      jurisdiction_id: s.b,
      code: "SYN_TWO",
      name: "Synthetic two",
      active_from: stamp(s.world.now),
      active_until: null,
    },
  );
  const jurisdiction = await resolveJurisdiction(sourcesOf(s, s.scoped), s.a);
  assert.equal(jurisdiction.status, "ready");
  assert.deepEqual(
    jurisdiction.serviceAreas.map((a) => a.code),
    ["SYN_ONE"],
  );
  assert.ok(!jurisdiction.targets.includes("staged"));
  assert.equal(jurisdiction.targets.length, 6);
  const list = await resolveJurisdictionList(sourcesOf(s, s.scoped));
  assert.deepEqual(
    list.jurisdictions.map((j) => j.code),
    ["SYN_A"],
  );
  assert.equal(list.canCreate, false);
  assert.equal(
    (await resolveJurisdictionList(sourcesOf(s, s.admin))).canCreate,
    true,
  );
  // Launch: the latest evaluation of each required gate decides "passed".
  const optional = addGate(s.world, s.a, "synthetic_optional", false);
  addEvaluation(s.world, s.gate.id, "failed");
  addEvaluation(s.world, s.gate.id, "passed", {
    evaluated_by_user_id: s.scoped.userId,
  });
  addEvaluation(s.world, optional.id, "failed");
  const launch = await resolveLaunch(sourcesOf(s, s.scoped), s.a);
  assert.equal(launch.canManageGates, true);
  assert.equal(launch.canAuthorize, false);
  assert.equal(launch.requiredGates, 1);
  assert.equal(launch.requiredPassed, 1);
  assert.equal(launch.hasActiveAuthorization, true);
  const gate = launch.gates.find((g) => g.id === s.gate.id);
  assert.deepEqual(
    gate.evaluations.map((e) => [e.status, e.by]),
    [
      ["passed", "you"],
      ["failed", null],
    ],
  );
  // The gate history is bounded and says so.
  for (let n = 0; n < 10; n += 1) {
    addEvaluation(s.world, optional.id, "failed");
  }
  const bounded = (await resolveLaunch(sourcesOf(s, s.scoped), s.a)).gates.find(
    (g) => g.id === optional.id,
  );
  assert.equal(bounded.evaluations.length, 10);
  assert.equal(bounded.evaluationsComplete, false);
  // A launch-authorization holder sees the gates but cannot manage them.
  const launcher = addStaff(s.world, 40);
  grant(s.world, launcher.userId, "authorize_jurisdiction_launch", {
    jurisdiction_id: s.a,
  });
  const launcherView = await resolveLaunch(sourcesOf(s, launcher), s.a);
  assert.equal(launcherView.canManageGates, false);
  assert.equal(launcherView.canAuthorize, true);
  assert.equal(
    (await resolveLaunchList(sourcesOf(s, launcher))).status,
    "ready",
  );
  assert.equal(
    (await resolveJurisdictionList(sourcesOf(s, launcher))).status,
    "denied",
  );
  s.world.launch_authorizations[0].revoked_at = stamp(s.world.now - 1);
  assert.equal(
    (await resolveLaunch(sourcesOf(s, launcher), s.a)).hasActiveAuthorization,
    false,
  );
});

test("SC-16. the catalog and the staff list page explicitly; capability grants show their state and a grant is offered only to another active staff member", async () => {
  const s = setup();
  for (let n = 2; n <= 30; n += 1) {
    addPracticeArea(s.world, n, n % 2 === 0);
  }
  const first = await resolveCatalog(sourcesOf(s, s.admin));
  assert.equal(first.areas.length, 25);
  assert.equal(first.pager.nextPage, 2);
  const second = await resolveCatalog(sourcesOf(s, s.admin), "2");
  assert.equal(second.areas.length, 5);
  assert.equal(second.pager.nextPage, null);
  assert.ok([...first.areas, ...second.areas].some((a) => !a.active));
  const members = await resolveCapabilityAdministration(sourcesOf(s, s.admin));
  assert.deepEqual(
    members.members.map((m) => [m.name, m.isYou, m.staffState]),
    [
      ["Synthetic Admin", true, "active"],
      ["Synthetic Scoped", false, "active"],
      ["Synthetic Plain", false, "active"],
      ["Synthetic Holder", false, "active"],
    ],
  );
  grant(s.world, s.scoped.userId, "manage_policy_configuration", {
    revoked_at: stamp(s.world.now - 1),
  });
  grant(s.world, s.scoped.userId, "manage_policy_configuration", {
    expires_at: stamp(s.world.now - 1),
    granted_at: stamp(s.world.now - 10_000),
  });
  grant(s.world, s.scoped.userId, "manage_policy_configuration", {
    granted_at: stamp(s.world.now + 60_000),
  });
  grant(s.world, s.scoped.userId, "manage_policy_configuration", {
    resource_scope: { synthetic: true },
  });
  const member = await resolveMemberCapabilities(
    sourcesOf(s, s.admin),
    s.scoped.userId,
  );
  assert.equal(member.canGrant, true);
  assert.deepEqual([...new Set(member.grants.map((g) => g.state))].sort(), [
    "current",
    "expired",
    "resource_scoped",
    "revoked",
    "scheduled",
  ]);
  assert.ok(
    member.grants.some((g) => g.jurisdiction === "Synthetic SYN_A (SYN_A)"),
  );
  assert.ok(
    member.capabilities.some((c) => c.value === "manage_staff_capabilities"),
  );
  const self = await resolveMemberCapabilities(
    sourcesOf(s, s.admin),
    s.admin.userId,
  );
  assert.equal(self.member.isYou, true);
  assert.equal(self.canGrant, false);
  const inactive = addStaff(s.world, 50, { state: "deactivated" });
  assert.equal(
    (await resolveMemberCapabilities(sourcesOf(s, s.admin), inactive.userId))
      .canGrant,
    false,
  );
  // A staff profile whose User cannot be read is unavailable, not dropped.
  s.world.users = s.world.users.filter((u) => u.id !== inactive.userId);
  assert.deepEqual(
    await resolveCapabilityAdministration(sourcesOf(s, s.admin)),
    { status: "unavailable" },
  );
});

test("SC-17. intake configuration lists published versions newest first and starts the next version from the current definition", async () => {
  const s = setup();
  assert.deepEqual(
    (await resolveIntakeConfiguration(sourcesOf(s, s.admin)))
      .currentDefinitionText,
    null,
  );
  addQuestionSet(s.world, 1);
  const latest = addQuestionSet(
    s.world,
    2,
    syntheticDefinition({
      questions: syntheticDefinition().questions.slice(1),
    }),
  );
  const view = await resolveIntakeConfiguration(sourcesOf(s, s.admin));
  assert.deepEqual(
    view.versions.map((v) => [v.versionKey, v.questions]),
    [
      ["synthetic-v2", 1],
      ["synthetic-v1", 2],
    ],
  );
  assert.equal(view.currentVersionKey, latest.version_key);
  assert.deepEqual(JSON.parse(view.currentDefinitionText), latest.definition);
  // A version that no longer reads as format 1 makes the list unavailable.
  s.world.intake_question_sets[0].definition = { format: 9 };
  assert.deepEqual(await resolveIntakeConfiguration(sourcesOf(s, s.admin)), {
    status: "unavailable",
  });
});

// ---------------------------------------------------------------------------
// MVP-001 S2: operational jobs
// ---------------------------------------------------------------------------

test("SC-18. the job view lists one group of states at a time, in its own order, one explicit page at a time, and marks work that waits for a worker run", async () => {
  const s = setup();
  const now = s.world.now;
  const overdue = addJob(s.world, { available_at: stamp(now - 5_000) });
  const later = addJob(s.world, { available_at: stamp(now + 60_000) });
  const expired = addJob(s.world, {
    state: "running",
    available_at: stamp(now - 1_000),
  });
  const leased = addJob(s.world, {
    state: "running",
    available_at: stamp(now + 90_000),
  });
  const done = addJob(s.world, { state: "completed" });
  const cancelled = addJob(s.world, {
    state: "cancelled",
    created_at: stamp(now - 1),
  });
  const view = async (group, page) =>
    resolveOperationalJobs(sourcesOf(s, s.admin), group, page);
  // Escalated first, by default and for anything but a group name.
  for (const group of [undefined, "escalated", "", "all", ["open"], "OPEN"]) {
    const escalated = await view(group);
    assert.equal(escalated.group, "escalated", String(group));
    assert.deepEqual(
      escalated.jobs.map((j) => j.id),
      [s.escalatedJob.id],
    );
  }
  assert.deepEqual(JOB_GROUPS, ["escalated", "open", "finished"]);
  assert.equal(jobGroupOf("finished"), "finished");
  const [row] = (await view()).jobs;
  assert.deepEqual(row, {
    id: s.escalatedJob.id,
    jobType: "synthetic.check",
    subjectType: "synthetic",
    subjectId: s.escalatedJob.subject_id,
    state: "escalated",
    attempts: 1,
    maxAttempts: 1,
    lastErrorCode: "unknown_job_type",
    createdAt: s.escalatedJob.created_at,
    availableAt: s.escalatedJob.available_at,
    lockedAt: null,
    completedAt: null,
    failedAt: s.escalatedJob.failed_at,
    waiting: false,
    canRetry: true,
    canCancel: true,
  });
  // Nothing beyond the job's own columns is read: no message, no worker.
  assert.equal(
    JSON.stringify(await view()).includes("Synthetic message"),
    false,
  );
  assert.equal(
    JSON.stringify(await view()).includes("synthetic-worker"),
    false,
  );
  // Open jobs: soonest due first; past their due time or lease they wait.
  const open = await view("open");
  assert.deepEqual(
    open.jobs.map((j) => [j.id, j.state, j.waiting, j.canRetry, j.canCancel]),
    [
      [overdue.id, "pending", true, false, true],
      [expired.id, "running", true, false, true],
      [later.id, "pending", false, false, true],
      [leased.id, "running", false, false, true],
    ],
  );
  // Finished jobs: newest first, and nothing can be changed.
  const finished = await view("finished");
  assert.deepEqual(
    finished.jobs.map((j) => [j.id, j.canRetry, j.canCancel, j.waiting]),
    [
      [cancelled.id, false, false, false],
      [done.id, false, false, false],
    ],
  );
  // Paging: exactly one page at a time, never silently cut.
  for (let n = 0; n < 30; n += 1) {
    addJob(s.world, { available_at: stamp(now + 1_000_000 + n) });
  }
  const first = await view("open");
  assert.equal(first.jobs.length, 25);
  assert.deepEqual(first.pager, {
    page: 1,
    pageSize: 25,
    previousPage: null,
    nextPage: 2,
  });
  const second = await view("open", "2");
  assert.equal(second.jobs.length, 9);
  assert.equal(second.pager.nextPage, null);
  assert.ok(
    s.world.calls.includes("reads.operationalJobs:open:25:26"),
    s.world.calls.join(),
  );
});

test("SC-19. the job view needs the global manage_operational_jobs grant, and a row outside its group or its constraints is never shown", async () => {
  const s = setup();
  // A jurisdiction-scoped grant, or none, sees nothing and is refused.
  const scoped = addStaff(s.world, 40);
  grant(s.world, scoped.userId, "manage_operational_jobs", {
    jurisdiction_id: s.a,
  });
  for (const who of [s.plain, scoped, s.scoped]) {
    assert.deepEqual(await resolveOperationalJobs(sourcesOf(s, who)), {
      status: "denied",
    });
  }
  assert.ok(s.world.calls.every((c) => !c.startsWith("reads.operationalJobs")));
  // A row in another group's state, or one its constraints do not allow,
  // makes the page unavailable rather than shown.
  const fresh = () => setup();
  const cases = [
    (w) => {
      w.operational_jobs[0].state = "pending";
    },
    (w) => {
      w.operational_jobs[0].failed_at = null;
    },
    (w) => {
      w.operational_jobs[0].subject_id = null;
    },
    (w) => {
      w.operational_jobs[0].max_attempts = 0;
    },
    (w) => {
      w.operational_jobs[0].job_type = "Synthetic Check";
    },
    (w) => {
      w.operational_jobs[0].last_error_code = "Not a code";
    },
    (w) => {
      w.operational_jobs[0].attempt_count = -1;
    },
    (w) => {
      w.operational_jobs[0].locked_at = stamp(w.now);
    },
  ];
  for (const change of cases) {
    const t = fresh();
    change(t.world);
    // The fixture filters by group; a row whose state moved still reaches
    // the reader here because the read port is replaced to answer it.
    const reads = async () => ({
      ...(await sourcesOf(t, t.admin).reads()),
      operationalJobs: async () => ({
        kind: "rows",
        rows: t.world.operational_jobs.map((j) => {
          const { locked_by, last_error_message, ...rest } = j;
          void locked_by;
          void last_error_message;
          return rest;
        }),
      }),
    });
    assert.deepEqual(
      await resolveOperationalJobs(sourcesOf(t, t.admin, { reads })),
      { status: "unavailable" },
      change.toString(),
    );
  }
  // An unreadable page is unavailable.
  s.world.failures.add("reads.operationalJobs");
  assert.deepEqual(await resolveOperationalJobs(sourcesOf(s, s.admin)), {
    status: "unavailable",
  });
});

test("SC-20. a retry or cancellation names exactly one job and sends exactly one call; a malformed form sends nothing", async () => {
  for (const [run, name] of [
    [retryOperationalJob, "retryOperationalJob"],
    [cancelOperationalJob, "cancelOperationalJob"],
  ]) {
    const s = setup();
    for (const fields of [
      {},
      { job: "not-an-id" },
      { job: [s.escalatedJob.id, s.escalatedJob.id] },
      { job: "ABCDEF00-0000-4000-8000-000000000001" },
    ]) {
      assert.deepEqual(
        await run(sourcesOf(s, s.admin), form(fields)),
        { status: "unavailable" },
        `${name}: ${JSON.stringify(fields)}`,
      );
    }
    assert.deepEqual(await run(sourcesOf(s, s.admin), null), {
      status: "unavailable",
    });
    assert.deepEqual(s.world.writes, []);
    assert.deepEqual(
      await run(sourcesOf(s, s.admin), form({ job: s.escalatedJob.id })),
      { status: "recorded" },
    );
    assert.deepEqual(s.world.writes, [{ name, args: [s.escalatedJob.id] }]);
    // The database's refusals are shown with their own fixed message.
    for (const outcome of ["invalid_transition", "not_found", "invalid"]) {
      s.world.answers.set(name, answer(outcome));
      const state = await run(
        sourcesOf(s, s.admin),
        form({ job: s.escalatedJob.id }),
      );
      assert.deepEqual(state, { status: "refused", reason: outcome });
      assert.match(outcomeMessage(state).body, /nothing was saved/i);
    }
    assert.match(
      outcomeMessage({ status: "refused", reason: "invalid_transition" }).body,
      /operational job can be retried only while escalated/,
    );
  }
});
