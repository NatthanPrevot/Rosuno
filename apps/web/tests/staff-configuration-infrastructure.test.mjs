// MVP-001 S1 staff configuration adapter tests (fixture-only).
//
// The request-scoped configuration read and write adapters run against a
// recording stand-in for the installed client: every query chain and staff
// function call they build is captured and compared exactly, and nothing is
// sent anywhere. Synthetic values only; no provider, network, credential, or
// database is contacted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { USER_COLUMNS } from "../src/application/professional-identity.ts";
import { PRACTICE_AREA_COLUMNS } from "../src/application/professional-records.ts";
import {
  AUTHORITY_COLUMNS,
  CANCEL_JOB_OUTCOMES,
  CAPABILITY_DEFINITION_COLUMNS,
  CONFIGURATION_JURISDICTION_COLUMNS,
  CONFIGURATION_POLICY_COLUMNS,
  CREATE_POLICY_OUTCOMES,
  GATE_EVALUATION_COLUMNS,
  GRANT_COLUMNS,
  LAUNCH_AUTHORIZATION_COLUMNS,
  LAUNCH_GATE_COLUMNS,
  MEMBER_USER_COLUMNS,
  OPERATIONAL_JOB_COLUMNS,
  POLICY_TYPE_COLUMNS,
  QUESTION_SET_COLUMNS,
  RETRY_JOB_OUTCOMES,
  REVISE_POLICY_OUTCOMES,
  SERVICE_AREA_COLUMNS,
} from "../src/application/staff-configuration.ts";
import { STAFF_PROFILE_COLUMNS } from "../src/application/staff-verification.ts";
import {
  createConfigurationReads,
  createConfigurationWrites,
  rowAnswerOf,
  STAFF_CONFIGURATION_SOURCES,
  textAnswerOf,
} from "../src/infrastructure/staff/staff-configuration-adapter.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*\n/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADAPTER = "src/infrastructure/staff/staff-configuration-adapter.ts";

// A recording client: every builder call is captured in order, and the
// awaited query answers what the test configures.
function recordingClient(answer = () => ({ data: [], error: null })) {
  const log = [];
  const builderFor = (chain) => {
    const builder = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (resolve, reject) =>
              Promise.resolve(answer(chain)).then(resolve, reject);
          }
          return (...args) => {
            chain.push([property, ...args]);
            return builder;
          };
        },
      },
    );
    return builder;
  };
  const client = {
    from(table) {
      const chain = [["from", table]];
      log.push(chain);
      return builderFor(chain);
    },
    rpc(name, args) {
      const chain = [["rpc", name, args]];
      log.push(chain);
      return builderFor(chain);
    },
  };
  return { client, log };
}

// Each write: the port call, the one staff function it must call with
// exactly these named arguments, and the column naming the generated id
// (null for a function that answers one outcome text).
const WRITES = [
  [
    (w) =>
      w.createPolicyVersion({
        policyTypeCode: "synthetic_type",
        jurisdictionId: ID(5),
        regulatoryModeId: null,
        versionLabel: "synthetic-v1",
        parameters: { synthetic: 1 },
        effectiveFrom: "2026-12-01T00:00:00.000Z",
        effectiveUntil: null,
        supersedesId: ID(3),
        developmentOnly: true,
      }),
    "staff_create_policy_version",
    {
      p_policy_type_code: "synthetic_type",
      p_jurisdiction_id: ID(5),
      p_regulatory_mode_id: null,
      p_version_label: "synthetic-v1",
      p_parameters: { synthetic: 1 },
      p_effective_from: "2026-12-01T00:00:00.000Z",
      p_effective_until: null,
      p_supersedes_policy_version_id: ID(3),
      p_development_only: true,
    },
    "policy_version_id",
  ],
  [
    (w) =>
      w.revisePolicyDraft({
        versionId: ID(3),
        expectedUpdatedAt: "2026-11-17T11:00:00.123456+00:00",
        versionLabel: "synthetic-v2",
        parameters: {},
        effectiveFrom: null,
        effectiveUntil: null,
      }),
    "staff_revise_policy_draft",
    {
      p_policy_version_id: ID(3),
      p_expected_updated_at: "2026-11-17T11:00:00.123456+00:00",
      p_version_label: "synthetic-v2",
      p_parameters: {},
      p_effective_from: null,
      p_effective_until: null,
    },
    null,
  ],
  [
    (w) => w.transitionPolicyVersion(ID(3), "u", "approved"),
    "staff_transition_policy_version",
    {
      p_policy_version_id: ID(3),
      p_expected_updated_at: "u",
      p_target_status: "approved",
    },
    null,
  ],
  [
    (w) => w.endPolicyVersion(ID(3), "e"),
    "staff_end_policy_version",
    { p_policy_version_id: ID(3), p_effective_until: "e" },
    null,
  ],
  [
    (w) =>
      w.addAuthorityReference({
        versionId: ID(3),
        authorityType: "t",
        citationText: "c",
        sourceUri: null,
        sourceTitle: "s",
        retrievedAt: "r",
      }),
    "staff_add_policy_authority_reference",
    {
      p_policy_version_id: ID(3),
      p_authority_type: "t",
      p_citation_text: "c",
      p_source_uri: null,
      p_source_title: "s",
      p_retrieved_at: "r",
    },
    "reference_id",
  ],
  [
    (w) => w.decideAuthorityReference(ID(4), "rejected"),
    "staff_decide_policy_authority_reference",
    { p_reference_id: ID(4), p_decision: "rejected" },
    null,
  ],
  [
    (w) => w.createJurisdiction("SYN_X", "Synthetic", "synthetic"),
    "staff_create_jurisdiction",
    { p_code: "SYN_X", p_name: "Synthetic", p_region_type: "synthetic" },
    "jurisdiction_id",
  ],
  [
    (w) => w.changeJurisdictionLifecycle(ID(5), "u", "live"),
    "staff_change_jurisdiction_lifecycle",
    {
      p_jurisdiction_id: ID(5),
      p_expected_updated_at: "u",
      p_target_state: "live",
    },
    null,
  ],
  [
    (w) =>
      w.createServiceArea({
        jurisdictionId: ID(5),
        code: "SYN_SA",
        name: "n",
        activeFrom: "f",
        activeUntil: "u",
      }),
    "staff_create_service_area",
    {
      p_jurisdiction_id: ID(5),
      p_code: "SYN_SA",
      p_name: "n",
      p_active_from: "f",
      p_active_until: "u",
    },
    "service_area_id",
  ],
  [
    (w) => w.createPracticeArea("synthetic_area", "n"),
    "staff_create_practice_area",
    { p_code: "synthetic_area", p_name: "n" },
    "practice_area_id",
  ],
  [
    (w) => w.setPracticeAreaActive(ID(6), false),
    "staff_set_practice_area_active",
    { p_practice_area_id: ID(6), p_active: false },
    null,
  ],
  [
    (w) => w.defineLaunchGate(ID(5), "synthetic_gate", false, null),
    "staff_define_launch_gate",
    {
      p_jurisdiction_id: ID(5),
      p_gate_code: "synthetic_gate",
      p_required: false,
      p_description: null,
    },
    "launch_gate_id",
  ],
  [
    (w) => w.recordLaunchGateEvaluation(ID(7), "failed", { d: 1 }, "r"),
    "staff_record_launch_gate_evaluation",
    {
      p_launch_gate_id: ID(7),
      p_evaluation_status: "failed",
      p_evidence_reference: { d: 1 },
      p_reason: "r",
    },
    "evaluation_id",
  ],
  [
    (w) => w.grantLaunchAuthorization(ID(5), "r"),
    "staff_grant_launch_authorization",
    { p_jurisdiction_id: ID(5), p_reason: "r" },
    "launch_authorization_id",
  ],
  [
    (w) => w.revokeLaunchAuthorization(ID(8), "r"),
    "staff_revoke_launch_authorization",
    { p_launch_authorization_id: ID(8), p_reason: "r" },
    null,
  ],
  [
    (w) => w.grantCapability(ID(2), "manage_policy_configuration", null, "x"),
    "staff_grant_capability",
    {
      p_user_id: ID(2),
      p_capability_code: "manage_policy_configuration",
      p_jurisdiction_id: null,
      p_expires_at: "x",
    },
    "grant_id",
  ],
  [
    (w) => w.revokeCapability(ID(9)),
    "staff_revoke_capability",
    { p_grant_id: ID(9) },
    null,
  ],
  [
    (w) => w.publishQuestionSet("synthetic-v3", { format: 1 }),
    "staff_publish_intake_question_set",
    { p_version_key: "synthetic-v3", p_definition: { format: 1 } },
    "question_set_id",
  ],
  // MVP-001 S2: the two audited staff operational job functions.
  [
    (w) => w.retryOperationalJob(ID(10)),
    "staff_retry_job",
    { p_job_id: ID(10) },
    null,
  ],
  [
    (w) => w.cancelOperationalJob(ID(10)),
    "staff_cancel_job",
    { p_job_id: ID(10) },
    null,
  ],
  // MVP-001 S3 part 2: the audited jurisdiction assessment review.
  [
    (w) => w.reviewJurisdictionAssessment(ID(11), "confirmed"),
    "staff_review_jurisdiction_assessment",
    { p_assessment_id: ID(11), p_decision: "confirmed" },
    null,
  ],
];

test("SC-I1. each write calls exactly one fixed staff function with only its named arguments, never an actor, staff User, grant, or scope", async () => {
  const idColumns = new Map(WRITES.map(([, name, , column]) => [name, column]));
  const { client, log } = recordingClient((chain) => {
    const column = idColumns.get(chain[0][1]);
    if (column === null) {
      return {
        data:
          chain[0][1] === "staff_change_jurisdiction_lifecycle"
            ? "launch_gates_unmet"
            : "applied",
        error: null,
        status: 200,
      };
    }
    return {
      data: [
        {
          outcome:
            chain[0][1] === "staff_publish_intake_question_set"
              ? "published"
              : "created",
          [column]: ID(99),
        },
      ],
      error: null,
      status: 200,
    };
  });
  const writes = await createConfigurationWrites(async () => client, 50)();
  assert.deepEqual(
    Object.keys(writes),
    WRITES.map(([call]) => /w\.(\w+)\(/.exec(call.toString())[1]),
  );
  assert.ok(Object.isFrozen(writes));
  for (const [call, name, args, column] of WRITES) {
    log.length = 0;
    const answer = await call(writes);
    assert.deepEqual(log, [[["rpc", name, args]]], name);
    for (const key of Object.keys(args)) {
      assert.doesNotMatch(
        key,
        /actor|staff_user|granted_by|verified_by|approved_by|evaluated_by|authorized_by|auth_user/,
        name,
      );
    }
    assert.deepEqual(
      answer,
      column === null
        ? {
            kind: "answer",
            outcome:
              name === "staff_change_jurisdiction_lifecycle"
                ? "launch_gates_unmet"
                : "applied",
            value: null,
          }
        : {
            kind: "answer",
            outcome:
              name === "staff_publish_intake_question_set"
                ? "published"
                : "created",
            value: ID(99),
          },
      name,
    );
  }
  // A slow call is unreadable at the deadline; a missing client is null.
  const slow = await createConfigurationWrites(
    async () => ({ rpc: () => new Promise(() => {}) }),
    20,
  )();
  assert.deepEqual(await slow.revokeCapability(ID(9)), { kind: "unreadable" });
  assert.equal(await createConfigurationWrites(async () => null, 20)(), null);
  // The deployed wiring, unconfigured, builds no request client at all.
  assert.equal(await STAFF_CONFIGURATION_SOURCES.reads(), null);
  assert.equal(await STAFF_CONFIGURATION_SOURCES.writes(), null);
});

test("SC-I2. answers are read strictly against the function's own outcomes; a database refusal is rejected and anything else unknown", () => {
  const outcomes = CREATE_POLICY_OUTCOMES;
  const row = (fields) => ({ data: [fields], error: null, status: 200 });
  assert.deepEqual(
    rowAnswerOf(
      row({ outcome: "created", policy_version_id: ID(1) }),
      outcomes,
      "policy_version_id",
    ),
    { kind: "answer", outcome: "created", value: ID(1) },
  );
  assert.deepEqual(
    rowAnswerOf(
      row({ outcome: "environment_refused", policy_version_id: null }),
      outcomes,
      "policy_version_id",
    ),
    { kind: "answer", outcome: "environment_refused", value: null },
  );
  for (const result of [
    row({ outcome: "applied", policy_version_id: null }),
    row({ outcome: "created", policy_version_id: "not-an-id" }),
    row({ outcome: "created", policy_version_id: 7 }),
    row({ outcome: "created", other_id: ID(1) }),
    row({ outcome: "created", policy_version_id: ID(1), extra: 1 }),
    { data: [], error: null, status: 200 },
    {
      data: [
        { outcome: "created", policy_version_id: ID(1) },
        { outcome: "created", policy_version_id: ID(2) },
      ],
      error: null,
      status: 200,
    },
    { data: "created", error: null, status: 200 },
    { data: null, error: { code: "08006" }, status: 503 },
    { data: null, error: { code: "57P01" }, status: 503 },
    { data: null, error: { message: "synthetic" }, status: 502 },
    { data: null, error: { code: "42501" }, status: 200 },
    undefined,
  ]) {
    assert.deepEqual(
      rowAnswerOf(result, outcomes, "policy_version_id"),
      { kind: "unreadable" },
      JSON.stringify(result),
    );
  }
  assert.deepEqual(
    rowAnswerOf(
      { data: null, error: { code: "23514" }, status: 400 },
      outcomes,
      "policy_version_id",
    ),
    { kind: "rejected" },
  );
  assert.deepEqual(
    textAnswerOf(
      { data: "conflict", error: null, status: 200 },
      REVISE_POLICY_OUTCOMES,
    ),
    { kind: "answer", outcome: "conflict", value: null },
  );
  for (const result of [
    { data: "created", error: null, status: 200 },
    { data: ["applied"], error: null, status: 200 },
    { data: null, error: null, status: 204 },
  ]) {
    assert.deepEqual(textAnswerOf(result, REVISE_POLICY_OUTCOMES), {
      kind: "unreadable",
    });
  }
  assert.deepEqual(
    textAnswerOf(
      { data: null, error: { code: "40P01" }, status: 500 },
      REVISE_POLICY_OUTCOMES,
    ),
    { kind: "rejected" },
  );
  // MVP-001 S2: the staff job functions' own five outcomes, and nothing else.
  for (const outcomes of [RETRY_JOB_OUTCOMES, CANCEL_JOB_OUTCOMES]) {
    assert.deepEqual(
      [...outcomes],
      ["applied", "invalid", "denied", "not_found", "invalid_transition"],
    );
    for (const outcome of outcomes) {
      assert.deepEqual(
        textAnswerOf({ data: outcome, error: null, status: 200 }, outcomes),
        { kind: "answer", outcome, value: null },
      );
    }
    for (const data of [
      "completed",
      "cancelled",
      "Applied",
      null,
      ["applied"],
    ]) {
      assert.deepEqual(
        textAnswerOf({ data, error: null, status: 200 }, outcomes),
        { kind: "unreadable" },
      );
    }
  }
});

test("SC-I3. every read names its exact columns, is keyed only by the ids it is given, and is paged or bounded by the count asked for", async () => {
  const { client, log } = recordingClient();
  const reads = await createConfigurationReads(async () => client, 50)();
  const expect = async (call, chain) => {
    log.length = 0;
    await call();
    assert.deepEqual(log, [chain], JSON.stringify(chain[0]));
  };
  await expect(
    () => reads.usersOf(ID(1)),
    [
      ["from", "users"],
      ["select", USER_COLUMNS],
      ["eq", "auth_user_id", ID(1)],
      ["limit", 2],
    ],
  );
  await expect(
    () => reads.staffProfilesOf(ID(2)),
    [
      ["from", "staff_profiles"],
      ["select", STAFF_PROFILE_COLUMNS],
      ["eq", "user_id", ID(2)],
      ["limit", 2],
    ],
  );
  await expect(
    () => reads.environmentIdentity(),
    [["rpc", "deployment_environment_identity", undefined]],
  );
  await expect(
    () => reads.policyTypes(201),
    [
      ["from", "policy_types"],
      ["select", POLICY_TYPE_COLUMNS],
      ["order", "code"],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.policyVersions(0, 26),
    [
      ["from", "policy_versions"],
      ["select", CONFIGURATION_POLICY_COLUMNS],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 26],
    ],
  );
  await expect(
    () => reads.policyVersions(25, 26),
    [
      ["from", "policy_versions"],
      ["select", CONFIGURATION_POLICY_COLUMNS],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["range", 25, 50],
    ],
  );
  for (const [call, table, columns] of [
    ["policyVersionById", "policy_versions", CONFIGURATION_POLICY_COLUMNS],
    [
      "authorityReferenceById",
      "policy_authority_references",
      AUTHORITY_COLUMNS,
    ],
    ["jurisdictionById", "jurisdictions", CONFIGURATION_JURISDICTION_COLUMNS],
    ["launchGateById", "launch_gates", LAUNCH_GATE_COLUMNS],
    [
      "launchAuthorizationById",
      "launch_authorizations",
      LAUNCH_AUTHORIZATION_COLUMNS,
    ],
  ]) {
    await expect(
      () => reads[call](ID(3)),
      [
        ["from", table],
        ["select", columns],
        ["eq", "id", ID(3)],
        ["limit", 2],
      ],
    );
  }
  await expect(
    () => reads.authorityReferencesOf(ID(3), 201),
    [
      ["from", "policy_authority_references"],
      ["select", AUTHORITY_COLUMNS],
      ["eq", "policy_version_id", ID(3)],
      ["order", "created_at"],
      ["order", "id"],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.jurisdictions(0, 201),
    [
      ["from", "jurisdictions"],
      ["select", CONFIGURATION_JURISDICTION_COLUMNS],
      ["order", "code"],
      ["order", "id"],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.serviceAreasOf(ID(5), 201),
    [
      ["from", "service_areas"],
      ["select", SERVICE_AREA_COLUMNS],
      ["eq", "jurisdiction_id", ID(5)],
      ["order", "code"],
      ["order", "id"],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.launchGatesOf(ID(5), 201),
    [
      ["from", "launch_gates"],
      ["select", LAUNCH_GATE_COLUMNS],
      ["eq", "jurisdiction_id", ID(5)],
      ["order", "gate_code"],
      ["order", "id"],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.gateEvaluationsOf(ID(7), 11),
    [
      ["from", "launch_gate_evaluations"],
      ["select", GATE_EVALUATION_COLUMNS],
      ["eq", "launch_gate_id", ID(7)],
      ["order", "evaluated_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 11],
    ],
  );
  await expect(
    () => reads.launchAuthorizationsOf(ID(5), 201),
    [
      ["from", "launch_authorizations"],
      ["select", LAUNCH_AUTHORIZATION_COLUMNS],
      ["eq", "jurisdiction_id", ID(5)],
      ["order", "authorized_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.practiceAreas(50, 26),
    [
      ["from", "practice_areas"],
      ["select", PRACTICE_AREA_COLUMNS],
      ["order", "code"],
      ["order", "id"],
      ["range", 50, 75],
    ],
  );
  await expect(
    () => reads.staffMembers(0, 26),
    [
      ["from", "staff_profiles"],
      ["select", STAFF_PROFILE_COLUMNS],
      ["order", "created_at"],
      ["order", "id"],
      ["limit", 26],
    ],
  );
  await expect(
    () => reads.memberUsers([ID(2), ID(2), ID(7)]),
    [
      ["from", "users"],
      ["select", MEMBER_USER_COLUMNS],
      ["in", "id", [ID(2), ID(7)]],
      ["limit", 3],
    ],
  );
  await expect(
    () => reads.grantsOf(ID(2), 201),
    [
      ["from", "capability_grants"],
      ["select", GRANT_COLUMNS],
      ["eq", "user_id", ID(2)],
      ["order", "granted_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.capabilityDefinitions(201),
    [
      ["from", "capability_definitions"],
      ["select", CAPABILITY_DEFINITION_COLUMNS],
      ["order", "capability_code"],
      ["limit", 201],
    ],
  );
  await expect(
    () => reads.questionSets(0, 1),
    [
      ["from", "intake_question_sets"],
      ["select", QUESTION_SET_COLUMNS],
      ["order", "published_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 1],
    ],
  );
  // MVP-001 S2: one group of job states per read, in the group's own order.
  await expect(
    () => reads.operationalJobs("escalated", 0, 26),
    [
      ["from", "operational_jobs"],
      ["select", OPERATIONAL_JOB_COLUMNS],
      ["in", "state", ["escalated"]],
      ["order", "failed_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 26],
    ],
  );
  await expect(
    () => reads.operationalJobs("open", 25, 26),
    [
      ["from", "operational_jobs"],
      ["select", OPERATIONAL_JOB_COLUMNS],
      ["in", "state", ["running", "pending"]],
      ["order", "available_at"],
      ["order", "id"],
      ["range", 25, 50],
    ],
  );
  await expect(
    () => reads.operationalJobs("finished", 0, 26),
    [
      ["from", "operational_jobs"],
      ["select", OPERATIONAL_JOB_COLUMNS],
      ["in", "state", ["completed", "cancelled"]],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 26],
    ],
  );
  assert.doesNotMatch(
    OPERATIONAL_JOB_COLUMNS,
    /last_error_message|locked_by|payload/,
  );
  // Malformed ids, pages, and counts are unreadable and send nothing.
  log.length = 0;
  for (const call of [
    () => reads.operationalJobs("all", 0, 26),
    () => reads.operationalJobs("__proto__", 0, 26),
    () => reads.operationalJobs("open", -1, 26),
    () => reads.operationalJobs("open", 0, 1001),
    () => reads.policyVersions(-1, 26),
    () => reads.policyVersions(0, 0),
    () => reads.policyVersions(0, 1001),
    () => reads.policyVersions(1.5, 26),
    () => reads.jurisdictions(0, "26"),
    () => reads.policyVersionById("not-an-id"),
    () => reads.authorityReferencesOf(ID(3), 0),
    () => reads.serviceAreasOf("x", 10),
    () => reads.gateEvaluationsOf(ID(7), 5000),
    () => reads.memberUsers([]),
    () => reads.memberUsers(["x"]),
    () => reads.grantsOf("x", 10),
    () => reads.policyTypes(0),
  ]) {
    assert.deepEqual(await call(), { kind: "unreadable" });
  }
  assert.deepEqual(log, []);
  // A failed or malformed read answer is unreadable.
  const failing = recordingClient(() => ({
    data: null,
    error: { code: "42501" },
    status: 403,
  }));
  const failingReads = await createConfigurationReads(
    async () => failing.client,
    50,
  )();
  assert.deepEqual(await failingReads.policyTypes(10), { kind: "unreadable" });
  assert.equal(await createConfigurationReads(async () => null, 20)(), null);
});

test("SC-I4. the capability question is the database's own predicate, asked through the request's session with exact arguments, and only a boolean answer counts", async () => {
  const answers = [];
  const { client, log } = recordingClient(
    () => answers.shift() ?? { data: null, error: null },
  );
  const reads = await createConfigurationReads(async () => client, 50)();
  answers.push({ data: true, error: null });
  assert.deepEqual(
    await reads.holdsCapability("manage_policy_configuration", ID(5), false),
    { kind: "answer", granted: true },
  );
  answers.push({ data: false, error: null });
  assert.deepEqual(
    await reads.holdsCapability("manage_staff_capabilities", null, true),
    { kind: "answer", granted: false },
  );
  for (const answer of [
    { data: "true", error: null },
    { data: true, error: { message: "synthetic" } },
    { data: null, error: null },
  ]) {
    answers.push(answer);
    assert.deepEqual(
      await reads.holdsCapability("manage_intake_configuration", null, false),
      { kind: "unreadable" },
    );
  }
  assert.deepEqual(
    log.map((chain) => chain[0]),
    [
      [
        "rpc",
        "has_staff_capability",
        {
          p_capability: "manage_policy_configuration",
          p_jurisdiction: ID(5),
          p_any_jurisdiction: false,
        },
      ],
      [
        "rpc",
        "has_staff_capability",
        {
          p_capability: "manage_staff_capabilities",
          p_jurisdiction: null,
          p_any_jurisdiction: true,
        },
      ],
      ...Array.from({ length: 3 }, () => [
        "rpc",
        "has_staff_capability",
        {
          p_capability: "manage_intake_configuration",
          p_jurisdiction: null,
          p_any_jurisdiction: false,
        },
      ]),
    ],
  );
  log.length = 0;
  for (const args of [
    ["synthetic_capability", null, false],
    ["manage_policy_configuration", "not-an-id", false],
    ["manage_policy_configuration", null, "false"],
  ]) {
    assert.deepEqual(await reads.holdsCapability(...args), {
      kind: "unreadable",
    });
  }
  assert.deepEqual(log, []);
  const slow = await createConfigurationReads(
    async () => ({ ...client, rpc: () => new Promise(() => {}) }),
    20,
  )();
  assert.deepEqual(
    await slow.holdsCapability("manage_policy_configuration", null, false),
    { kind: "unreadable" },
  );
});

test("SC-I5. a failed call writes one log line naming the call and how it failed, and nothing the call carried", async () => {
  const citation = "Synthetic secret citation 7f3a";
  const { client } = recordingClient(() => ({
    data: null,
    error: { code: "23514", message: citation },
    status: 400,
  }));
  const writes = await createConfigurationWrites(async () => client, 50)();
  const written = [];
  const original = console.error;
  console.error = (line) => written.push(line);
  try {
    assert.deepEqual(
      await writes.addAuthorityReference({
        versionId: ID(3),
        authorityType: citation,
        citationText: citation,
        sourceUri: null,
        sourceTitle: citation,
        retrievedAt: "r",
      }),
      { kind: "rejected" },
    );
  } finally {
    console.error = original;
  }
  assert.equal(written.length, 1);
  const line = JSON.parse(written[0]);
  assert.equal(line.event, "staff_configuration.call_failed");
  assert.equal(line.operation, "staff_add_policy_authority_reference");
  assert.equal(line.outcome, "rejected");
  assert.equal(line.errorCode, "23514");
  assert.equal(line.status, 400);
  assert.equal(written[0].includes("7f3a"), false);
});

test("SC-I6. the adapter's source stays request-scoped: exact imports, named tables only, and no privileged name or client", () => {
  const source = read(ADAPTER);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "../../application/professional-records.ts",
    "../../application/professional-identity.ts",
    "../../application/staff-configuration.ts",
    "../../application/staff-verification.ts",
    "../environment/environment-configuration.ts",
    "../identity/server-session-source.ts",
    "../observability/log.ts",
    "../observability/request-log.ts",
    "../professional/professional-request-client.ts",
  ]);
  assert.doesNotMatch(
    code,
    /ROSUNO_SUPABASE|service_role|sb_secret_|createClient\b|adminKey|\badmin\b|process\.env|\bconsole\b|\.insert\(|\.update\(|\.upsert\(|\.delete\(|select\("\*"\)/,
  );
  // Every literal table name is one of the configuration relations, and
  // the four by-id reads name theirs through one keyed helper.
  assert.deepEqual(
    [
      ...new Set([...code.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])),
    ].sort(),
    [
      "capability_definitions",
      "capability_grants",
      "intake_question_sets",
      "jurisdictions",
      "launch_authorizations",
      "launch_gate_evaluations",
      "launch_gates",
      // MVP-001 S2: the operational job view, read under its row policy.
      "operational_jobs",
      "policy_authority_references",
      "policy_types",
      "policy_versions",
      "practice_areas",
      "service_areas",
      "staff_profiles",
      "users",
    ],
  );
  assert.equal(code.match(/\.from\(table\)/g)?.length, 1);
  // The application module is provider-neutral.
  const application = read("src/application/staff-configuration.ts");
  for (const specifier of importsOf(application)) {
    assert.match(specifier, /^\.\/[a-z-]+\.ts$/, specifier);
  }
  assert.doesNotMatch(
    codeOf(application),
    /\bprocess\b|\bfetch\s*\(|\bconsole\b|Date\.now\(\)|new Date\(\)|Math\.random|\brpc\b|supabase/i,
  );
});
