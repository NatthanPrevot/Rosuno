// MVP-001 S1 staff configuration synthetic test world (not a test file;
// loaded by the staff configuration tests).
//
// An isolated, in-memory stand-in for the configuration relations and the
// read policies the configuration-administration migration defines: the
// has_staff_capability predicate evaluated exactly as the migration defines
// it (an active User with an active Staff Profile and one granted, unrevoked,
// unexpired, non-resource-scoped grant covering the scope; a null scope needs
// a global grant; the any-jurisdiction mode accepts any grant), and each
// relation readable exactly as its row policy says. The write port stands in
// for the staff configuration functions only as far as the application
// boundary can see them: it records each call with its exact arguments and
// answers what the test configures, so every outcome can be driven. MVP-001
// S2: operational jobs are readable exactly as their row policy says (the
// global manage_operational_jobs grant). MVP-001 S3 part 2: reviewable
// Intakes and their jurisdiction assessments are read exactly as the two
// review read functions answer them (manage_intake_configuration at aal2,
// scoped by the assessment's jurisdiction; the unnamed group for a global
// grant only), and never their client or content. Every id, account, and value is
// synthetic test data; nothing here contacts a provider, network, or
// database.

import { USER_COLUMNS } from "../src/application/professional-identity.ts";
import { PRACTICE_AREA_COLUMNS } from "../src/application/professional-records.ts";
import {
  AUTHORITY_COLUMNS,
  CAPABILITY_DEFINITION_COLUMNS,
  CONFIGURATION_JURISDICTION_COLUMNS,
  CONFIGURATION_POLICY_COLUMNS,
  GATE_EVALUATION_COLUMNS,
  GRANT_COLUMNS,
  JOB_GROUP_STATES,
  LAUNCH_AUTHORIZATION_COLUMNS,
  LAUNCH_GATE_COLUMNS,
  MEMBER_USER_COLUMNS,
  OPERATIONAL_JOB_COLUMNS,
  POLICY_TYPE_COLUMNS,
  QUESTION_SET_COLUMNS,
  REVIEW_ASSESSMENT_COLUMNS,
  REVIEW_INTAKE_COLUMNS,
  SERVICE_AREA_COLUMNS,
} from "../src/application/staff-configuration.ts";
import { STAFF_PROFILE_COLUMNS } from "../src/application/staff-verification.ts";

export const T0 = Date.parse("2026-11-17T12:00:00Z");
export const CONFIRMED_AT = "2026-10-01T00:00:00Z";
export const UNREADABLE = Object.freeze({ kind: "unreadable" });
export const PROJECT_REF = "syntheticprojectrefa";

// A synthetic, canonical, version-4-shaped id for a group and a number.
export function idOf(group, n) {
  return `00000000-0000-4000-8000-${String(group).padStart(4, "0")}${String(n).padStart(8, "0")}`;
}

// A PostgREST-like timestamp with microseconds and an explicit offset.
export function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

export function pick(row, columns) {
  const out = {};
  for (const column of columns.split(", ")) {
    out[column] = row[column];
  }
  return out;
}

const rows = (list) => Object.freeze({ kind: "rows", rows: list });

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createWorld() {
  let counter = 0;
  const world = {
    now: T0,
    nextId() {
      counter += 1;
      return idOf(9000, counter);
    },
    auth: new Map(),
    users: [],
    staff_profiles: [],
    capability_grants: [],
    capability_definitions: [
      "authorize_jurisdiction_launch",
      "manage_attorney_verification",
      "manage_intake_configuration",
      "manage_jurisdiction_configuration",
      "manage_operational_jobs",
      "manage_policy_configuration",
      "manage_staff_capabilities",
    ].map((capability_code) => ({ capability_code })),
    jurisdictions: [],
    service_areas: [],
    policy_types: [],
    policy_versions: [],
    policy_authority_references: [],
    launch_gates: [],
    launch_gate_evaluations: [],
    launch_authorizations: [],
    practice_areas: [],
    intake_question_sets: [],
    operational_jobs: [],
    // MVP-001 S3 part 2: Intakes (id, state, created_at only) and their
    // jurisdiction assessments, as the review functions read them.
    intakes: [],
    jurisdiction_assessments: [],
    // PS-A2: the one recorded deployment environment (null = unrecorded).
    deployment_environment: {
      environment_class: "development",
      project_ref: null,
    },
    // The server-side configuration; by default it matches the record.
    configuration: null,
    calls: [],
    writes: [],
    answers: new Map(),
    failures: new Set(),
  };
  return world;
}

// Seeding helpers (test-only synthetic records).
export function addAccount(
  world,
  n,
  { confirmed = true, state = "active", name = null } = {},
) {
  const authId = idOf(1, n);
  world.auth.set(authId, {
    id: authId,
    email_confirmed_at: confirmed ? CONFIRMED_AT : null,
  });
  const userId = idOf(2, n);
  world.users.push({
    id: userId,
    auth_user_id: authId,
    display_name: name,
    account_state: state,
  });
  return { authId, userId };
}

export function addStaff(world, n, { state = "active", ...account } = {}) {
  const ids = addAccount(world, n, account);
  world.staff_profiles.push({
    id: idOf(4, n),
    user_id: ids.userId,
    staff_state: state,
    created_at: stamp(world.now + n),
  });
  return ids;
}

export function grant(world, userId, capability, overrides = {}) {
  const row = {
    id: world.nextId(),
    user_id: userId,
    capability_code: capability,
    jurisdiction_id: null,
    resource_scope: null,
    granted_at: stamp(world.now - 86_400_000),
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
  world.capability_grants.push(row);
  return row;
}

export function addJurisdiction(world, n, code, state = "staged") {
  const id = idOf(5, n);
  world.jurisdictions.push({
    id,
    code,
    name: `Synthetic ${code}`,
    region_type: "synthetic",
    lifecycle_state: state,
    updated_at: stamp(world.now - 1000),
  });
  return id;
}

export function addPolicyType(world, code, name = `Synthetic ${code}`) {
  world.policy_types.push({ code, name });
  return code;
}

export function addPolicyVersion(world, overrides = {}) {
  const row = {
    id: world.nextId(),
    policy_type_code: "synthetic_type",
    jurisdiction_id: null,
    regulatory_mode_id: null,
    version_label: `synthetic-${world.policy_versions.length + 1}`,
    parameters: { synthetic: true },
    status: "draft",
    effective_from: null,
    effective_until: null,
    approved_at: null,
    approved_by_user_id: null,
    supersedes_policy_version_id: null,
    development_only: false,
    created_at: stamp(world.now - 60_000 + world.policy_versions.length),
    updated_at: stamp(world.now - 60_000),
    ...overrides,
  };
  world.policy_versions.push(row);
  return row;
}

export function addReference(world, versionId, overrides = {}) {
  const row = {
    id: world.nextId(),
    policy_version_id: versionId,
    authority_type: "synthetic authority",
    citation_text: "Synthetic citation",
    source_uri: null,
    source_title: "Synthetic source",
    retrieved_at: stamp(world.now - 3_600_000),
    verified_by_user_id: null,
    verification_status: "unverified",
    created_at: stamp(world.now),
    ...overrides,
  };
  world.policy_authority_references.push(row);
  return row;
}

export function addGate(world, jurisdictionId, code, required = true) {
  const row = {
    id: world.nextId(),
    jurisdiction_id: jurisdictionId,
    gate_code: code,
    required,
    description: null,
  };
  world.launch_gates.push(row);
  return row;
}

export function addEvaluation(world, gateId, status, overrides = {}) {
  const row = {
    id: world.nextId(),
    launch_gate_id: gateId,
    evaluation_status: status,
    evaluated_at: stamp(
      world.now - 1000 * (100 - world.launch_gate_evaluations.length),
    ),
    evaluated_by_user_id: null,
    reason: "Synthetic reason",
    ...overrides,
  };
  world.launch_gate_evaluations.push(row);
  return row;
}

export function addAuthorization(world, jurisdictionId, overrides = {}) {
  const row = {
    id: world.nextId(),
    jurisdiction_id: jurisdictionId,
    authorized_at: stamp(world.now - 3_600_000),
    authorized_by_user_id: idOf(2, 999),
    revoked_at: null,
    reason: "Synthetic authorization",
    ...overrides,
  };
  world.launch_authorizations.push(row);
  return row;
}

export function addPracticeArea(world, n, active = true) {
  const id = idOf(6, n);
  world.practice_areas.push({
    id,
    code: `synthetic_area_${String(n).padStart(3, "0")}`,
    name: `Synthetic area ${n}`,
    active,
  });
  return id;
}

// MVP-001 S3 part 2: one synthetic Intake (state and time only) and one
// jurisdiction assessment of it.
export function addReviewIntake(world, state = "submitted") {
  const row = {
    id: world.nextId(),
    state,
    created_at: stamp(world.now - 300_000 + world.intakes.length),
  };
  world.intakes.push(row);
  return row;
}

export function addAssessment(world, intakeId, jurisdictionId, overrides = {}) {
  const row = {
    id: world.nextId(),
    intake_id: intakeId,
    jurisdiction_id: jurisdictionId,
    source_type: "client_statement",
    assessment_basis: "client_statement:intake_revision:1:question_set:synthetic-v1",
    review_status: "unreviewed",
    created_at: stamp(world.now - 200_000 + world.jurisdiction_assessments.length),
    reviewed_at: null,
    reviewed_by_user_id: null,
    ...overrides,
  };
  world.jurisdiction_assessments.push(row);
  return row;
}

// One synthetic operational job in a consistent state (MVP-001 S2).
export function addJob(world, overrides = {}) {
  const state = overrides.state ?? "pending";
  const row = {
    id: world.nextId(),
    job_type: "synthetic.check",
    subject_type: "synthetic",
    subject_id: idOf(8, world.operational_jobs.length + 1),
    state,
    available_at: stamp(world.now - 60_000),
    locked_at: state === "running" ? stamp(world.now - 30_000) : null,
    attempt_count: state === "pending" ? 0 : 1,
    max_attempts: state === "escalated" ? 1 : 3,
    last_error_code: state === "escalated" ? "unknown_job_type" : null,
    completed_at: state === "completed" ? stamp(world.now - 10_000) : null,
    failed_at: state === "escalated" ? stamp(world.now - 20_000) : null,
    created_at: stamp(world.now - 120_000 + world.operational_jobs.length),
    // Never read by the staff view.
    locked_by: state === "running" ? "synthetic-worker" : null,
    last_error_message: "Synthetic message never shown",
    ...overrides,
  };
  world.operational_jobs.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// The predicate and the row policies, as the migration defines them.
// ---------------------------------------------------------------------------

function userOfAuth(world, authId) {
  return world.users.find((user) => user.auth_user_id === authId) ?? null;
}

// has_staff_capability(capability, jurisdiction, any) for one caller.
export function holdsFor(world, authId, capability, jurisdiction, any) {
  const user = userOfAuth(world, authId);
  if (user === null || user.account_state !== "active") {
    return false;
  }
  const staff = world.staff_profiles.find((p) => p.user_id === user.id);
  if (staff === undefined || staff.staff_state !== "active") {
    return false;
  }
  return world.capability_grants.some(
    (g) =>
      g.user_id === user.id &&
      g.capability_code === capability &&
      Date.parse(g.granted_at) <= world.now &&
      g.revoked_at === null &&
      (g.expires_at === null || Date.parse(g.expires_at) > world.now) &&
      g.resource_scope === null &&
      (any === true ||
        g.jurisdiction_id === null ||
        g.jurisdiction_id === jurisdiction),
  );
}

function policies(world, authId) {
  const holds = (capability, jurisdiction, any = false) =>
    holdsFor(world, authId, capability, jurisdiction, any);
  const versionVisible = (v) =>
    holds("manage_policy_configuration", v.jurisdiction_id);
  const launchVisible = (jurisdiction) =>
    holds("manage_jurisdiction_configuration", jurisdiction) ||
    holds("authorize_jurisdiction_launch", jurisdiction);
  return {
    users: (u) =>
      u.auth_user_id === authId ||
      (holds("manage_staff_capabilities", null) &&
        world.staff_profiles.some((s) => s.user_id === u.id)),
    staff_profiles: (s) =>
      userOfAuth(world, authId)?.id === s.user_id ||
      holds("manage_staff_capabilities", null),
    policy_versions: versionVisible,
    policy_authority_references: (r) => {
      const version = world.policy_versions.find(
        (v) => v.id === r.policy_version_id,
      );
      return version !== undefined && versionVisible(version);
    },
    policy_types: () => holds("manage_policy_configuration", null, true),
    jurisdictions: (j) =>
      holds("manage_jurisdiction_configuration", j.id) ||
      holds("manage_policy_configuration", j.id) ||
      holds("authorize_jurisdiction_launch", j.id) ||
      holds("manage_staff_capabilities", null),
    service_areas: (a) =>
      holds("manage_jurisdiction_configuration", a.jurisdiction_id),
    launch_gates: (g) => launchVisible(g.jurisdiction_id),
    launch_gate_evaluations: (e) => {
      const gate = world.launch_gates.find((g) => g.id === e.launch_gate_id);
      return gate !== undefined && launchVisible(gate.jurisdiction_id);
    },
    launch_authorizations: (a) => launchVisible(a.jurisdiction_id),
    practice_areas: (a) =>
      a.active ||
      holds("manage_attorney_verification", null, true) ||
      holds("manage_jurisdiction_configuration", null),
    capability_definitions: () => holds("manage_staff_capabilities", null),
    capability_grants: () => holds("manage_staff_capabilities", null),
    intake_question_sets: () => true,
    operational_jobs: () => holds("manage_operational_jobs", null),
  };
}

// The request-scoped configuration read port, as the request client under
// the row policies. Each call is recorded with its paging arguments.
export function configurationReadsFor(world, authId) {
  const visible = policies(world, authId);
  const call =
    (name, read) =>
    async (...args) => {
      world.calls.push(
        `reads.${name}:${args.map((a) => (Array.isArray(a) ? a.length : a)).join(":")}`,
      );
      if (world.failures.has(`reads.${name}`)) {
        return UNREADABLE;
      }
      return read(...args);
    };
  const list = (table, columns, order) => (offset, count) =>
    rows(
      world[table]
        .filter(visible[table])
        .sort(order)
        .slice(offset, offset + count)
        .map((r) => pick(r, columns)),
    );
  const byId = (table, columns) => (id) =>
    rows(
      world[table]
        .filter((r) => r.id === id && visible[table](r))
        .map((r) => pick(r, columns)),
    );
  const where = (table, columns, keep, order) => (key, count) =>
    rows(
      world[table]
        .filter((r) => keep(r, key) && visible[table](r))
        .sort(order)
        .slice(0, count)
        .map((r) => pick(r, columns)),
    );
  return {
    usersOf: call("usersOf", async (accountId) =>
      rows(
        world.users
          .filter((u) => u.auth_user_id === accountId && visible.users(u))
          .map((u) => pick(u, USER_COLUMNS)),
      ),
    ),
    staffProfilesOf: call("staffProfilesOf", async (userId) =>
      rows(
        world.staff_profiles
          .filter((s) => s.user_id === userId && visible.staff_profiles(s))
          .map((s) => pick(s, STAFF_PROFILE_COLUMNS)),
      ),
    ),
    holdsCapability: async (capability, jurisdiction, any) => {
      world.calls.push(`scope:${capability}:${jurisdiction}:${any}`);
      return world.failures.has("reads.holdsCapability")
        ? { kind: "unreadable" }
        : {
            kind: "answer",
            granted: holdsFor(world, authId, capability, jurisdiction, any),
          };
    },
    environmentIdentity: call("environmentIdentity", async () =>
      rows(
        world.deployment_environment === null
          ? [{ environment_class: "unrecorded", project_ref: null }]
          : [{ ...world.deployment_environment }],
      ),
    ),
    policyTypes: call("policyTypes", async (count) =>
      list("policy_types", POLICY_TYPE_COLUMNS, (a, b) =>
        compare(a.code, b.code),
      )(0, count),
    ),
    policyVersions: call("policyVersions", async (offset, count) =>
      list(
        "policy_versions",
        CONFIGURATION_POLICY_COLUMNS,
        (a, b) => compare(b.created_at, a.created_at) || compare(b.id, a.id),
      )(offset, count),
    ),
    policyVersionById: call("policyVersionById", async (id) =>
      byId("policy_versions", CONFIGURATION_POLICY_COLUMNS)(id),
    ),
    authorityReferencesOf: call("authorityReferencesOf", async (id, count) =>
      where(
        "policy_authority_references",
        AUTHORITY_COLUMNS,
        (r, key) => r.policy_version_id === key,
        (a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id),
      )(id, count),
    ),
    authorityReferenceById: call("authorityReferenceById", async (id) =>
      byId("policy_authority_references", AUTHORITY_COLUMNS)(id),
    ),
    jurisdictions: call("jurisdictions", async (offset, count) =>
      list(
        "jurisdictions",
        CONFIGURATION_JURISDICTION_COLUMNS,
        (a, b) => compare(a.code, b.code) || compare(a.id, b.id),
      )(offset, count),
    ),
    jurisdictionById: call("jurisdictionById", async (id) =>
      byId("jurisdictions", CONFIGURATION_JURISDICTION_COLUMNS)(id),
    ),
    serviceAreasOf: call("serviceAreasOf", async (id, count) =>
      where(
        "service_areas",
        SERVICE_AREA_COLUMNS,
        (r, key) => r.jurisdiction_id === key,
        (a, b) => compare(a.code, b.code),
      )(id, count),
    ),
    launchGatesOf: call("launchGatesOf", async (id, count) =>
      where(
        "launch_gates",
        LAUNCH_GATE_COLUMNS,
        (r, key) => r.jurisdiction_id === key,
        (a, b) => compare(a.gate_code, b.gate_code),
      )(id, count),
    ),
    launchGateById: call("launchGateById", async (id) =>
      byId("launch_gates", LAUNCH_GATE_COLUMNS)(id),
    ),
    gateEvaluationsOf: call("gateEvaluationsOf", async (id, count) =>
      where(
        "launch_gate_evaluations",
        GATE_EVALUATION_COLUMNS,
        (r, key) => r.launch_gate_id === key,
        (a, b) =>
          compare(b.evaluated_at, a.evaluated_at) || compare(b.id, a.id),
      )(id, count),
    ),
    launchAuthorizationsOf: call("launchAuthorizationsOf", async (id, count) =>
      where(
        "launch_authorizations",
        LAUNCH_AUTHORIZATION_COLUMNS,
        (r, key) => r.jurisdiction_id === key,
        (a, b) =>
          compare(b.authorized_at, a.authorized_at) || compare(b.id, a.id),
      )(id, count),
    ),
    launchAuthorizationById: call("launchAuthorizationById", async (id) =>
      byId("launch_authorizations", LAUNCH_AUTHORIZATION_COLUMNS)(id),
    ),
    practiceAreas: call("practiceAreas", async (offset, count) =>
      list(
        "practice_areas",
        PRACTICE_AREA_COLUMNS,
        (a, b) => compare(a.code, b.code) || compare(a.id, b.id),
      )(offset, count),
    ),
    staffMembers: call("staffMembers", async (offset, count) =>
      list(
        "staff_profiles",
        STAFF_PROFILE_COLUMNS,
        (a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id),
      )(offset, count),
    ),
    memberUsers: call("memberUsers", async (ids) =>
      rows(
        world.users
          .filter((u) => ids.includes(u.id) && visible.users(u))
          .map((u) => pick(u, MEMBER_USER_COLUMNS)),
      ),
    ),
    grantsOf: call("grantsOf", async (userId, count) =>
      where(
        "capability_grants",
        GRANT_COLUMNS,
        (r, key) => r.user_id === key,
        (a, b) => compare(b.granted_at, a.granted_at) || compare(b.id, a.id),
      )(userId, count),
    ),
    capabilityDefinitions: call("capabilityDefinitions", async (count) =>
      list("capability_definitions", CAPABILITY_DEFINITION_COLUMNS, (a, b) =>
        compare(a.capability_code, b.capability_code),
      )(0, count),
    ),
    questionSets: call("questionSets", async (offset, count) =>
      list(
        "intake_question_sets",
        QUESTION_SET_COLUMNS,
        (a, b) =>
          compare(b.published_at, a.published_at) || compare(b.id, a.id),
      )(offset, count),
    ),
    operationalJobs: call("operationalJobs", async (group, offset, count) =>
      rows(
        world.operational_jobs
          .filter(
            (j) =>
              JOB_GROUP_STATES[group].includes(j.state) &&
              visible.operational_jobs(j),
          )
          .sort((a, b) =>
            group === "open"
              ? compare(a.available_at, b.available_at) || compare(a.id, b.id)
              : group === "escalated"
                ? compare(b.failed_at, a.failed_at) || compare(b.id, a.id)
                : compare(b.created_at, a.created_at) || compare(b.id, a.id),
          )
          .slice(offset, offset + count)
          .map((j) => pick(j, OPERATIONAL_JOB_COLUMNS)),
      ),
    ),
    // MVP-001 S3 part 2: the review read functions, as the database answers
    // them for this caller.
    reviewIntakes: call("reviewIntakes", async (group, offset, count) => {
      const inScope = (a) =>
        holdsFor(
          world,
          authId,
          "manage_intake_configuration",
          a.jurisdiction_id,
          false,
        );
      const global = holdsFor(
        world,
        authId,
        "manage_intake_configuration",
        null,
        false,
      );
      return rows(
        world.intakes
          .filter((i) => i.state === "submitted" || i.state === "active")
          .map((i) => {
            const of = world.jurisdiction_assessments.filter(
              (a) => a.intake_id === i.id,
            );
            return {
              intake_id: i.id,
              intake_state: i.state,
              intake_created_at: i.created_at,
              candidate_count: new Set(of.map((a) => a.jurisdiction_id)).size,
              unreviewed_count: of.filter(
                (a) => a.review_status === "unreviewed" && inScope(a),
              ).length,
            };
          })
          .filter((r) =>
            group === "unreviewed"
              ? r.unreviewed_count > 0
              : group === "unnamed" && r.candidate_count === 0 && global,
          )
          .sort(
            (a, b) =>
              compare(a.intake_created_at, b.intake_created_at) ||
              compare(a.intake_id, b.intake_id),
          )
          .slice(offset, offset + count)
          .map((r) => pick(r, REVIEW_INTAKE_COLUMNS)),
      );
    }),
    reviewAssessmentsOf: call("reviewAssessmentsOf", async (intakeId) => {
      const intake = world.intakes.find((i) => i.id === intakeId);
      if (
        intake === undefined ||
        (intake.state !== "submitted" && intake.state !== "active")
      ) {
        return rows([]);
      }
      return rows(
        world.jurisdiction_assessments
          .filter(
            (a) =>
              a.intake_id === intakeId &&
              holdsFor(
                world,
                authId,
                "manage_intake_configuration",
                a.jurisdiction_id,
                false,
              ),
          )
          .sort(
            (a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id),
          )
          .map((a) => {
            const j = world.jurisdictions.find(
              (x) => x.id === a.jurisdiction_id,
            );
            return pick(
              {
                assessment_id: a.id,
                jurisdiction_id: a.jurisdiction_id,
                jurisdiction_code: j?.code ?? "SYN_UNKNOWN",
                jurisdiction_name: j?.name ?? "Synthetic unknown",
                source_type: a.source_type,
                assessment_basis: a.assessment_basis,
                review_status: a.review_status,
                created_at: a.created_at,
                reviewed_at: a.reviewed_at,
                reviewed_by_user_id: a.reviewed_by_user_id,
              },
              REVIEW_ASSESSMENT_COLUMNS,
            );
          }),
      );
    }),
  };
}

// The write functions that answer a row (outcome and a generated id); the
// others answer one outcome text.
export const ROW_WRITES = Object.freeze([
  "createPolicyVersion",
  "addAuthorityReference",
  "createJurisdiction",
  "createServiceArea",
  "createPracticeArea",
  "defineLaunchGate",
  "recordLaunchGateEvaluation",
  "grantLaunchAuthorization",
  "grantCapability",
  "publishQuestionSet",
]);

export const WRITE_NAMES = Object.freeze([
  "createPolicyVersion",
  "revisePolicyDraft",
  "transitionPolicyVersion",
  "endPolicyVersion",
  "addAuthorityReference",
  "decideAuthorityReference",
  "createJurisdiction",
  "changeJurisdictionLifecycle",
  "createServiceArea",
  "createPracticeArea",
  "setPracticeAreaActive",
  "defineLaunchGate",
  "recordLaunchGateEvaluation",
  "grantLaunchAuthorization",
  "revokeLaunchAuthorization",
  "grantCapability",
  "revokeCapability",
  "publishQuestionSet",
  "retryOperationalJob",
  "cancelOperationalJob",
  // MVP-001 S3 part 2.
  "reviewJurisdictionAssessment",
]);

export const answer = (outcome, value = null) =>
  Object.freeze({ kind: "answer", outcome, value });

// The request-scoped write port: records each call and answers what the test
// configured for it (a value, or a function of the call), or by default the
// function's own success outcome with a fresh id.
export function configurationWritesFor(world) {
  const port = {};
  for (const name of WRITE_NAMES) {
    port[name] = async (...args) => {
      world.writes.push({ name, args });
      const configured = world.answers.get(name);
      if (typeof configured === "function") {
        return configured(...args);
      }
      if (configured !== undefined) {
        return configured;
      }
      if (name === "publishQuestionSet") {
        return answer("published", world.nextId());
      }
      return ROW_WRITES.includes(name)
        ? answer("created", world.nextId())
        : answer("applied");
    };
  }
  return port;
}

export function sessionOf(authId) {
  return Object.freeze({ currentSubject: async () => authId });
}

export function accountOf(world, authId) {
  return Object.freeze({
    currentAccount: async () => {
      const account = world.auth.get(authId);
      return account === undefined
        ? { kind: "unreadable" }
        : {
            kind: "user",
            id: account.id,
            emailConfirmedAt: account.email_confirmed_at,
          };
    },
  });
}

export function configurationSources(world, authId, overrides = {}) {
  return {
    session: sessionOf(authId),
    account: accountOf(world, authId),
    reads: async () => configurationReadsFor(world, authId),
    writes: async () => configurationWritesFor(world),
    clock: () => world.now,
    environment: () =>
      world.configuration ?? {
        configuredClass:
          world.deployment_environment?.environment_class ?? "development",
        expectedProjectRef: world.deployment_environment?.project_ref ?? null,
      },
    ...overrides,
  };
}

export function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}

// Moves the world to a production database with a matching deployment.
export function production(world) {
  world.deployment_environment = {
    environment_class: "production",
    project_ref: PROJECT_REF,
  };
}

// A complete valid format-1 intake question-set definition (synthetic).
export function syntheticDefinition(overrides = {}) {
  return {
    format: 1,
    questions: [
      {
        id: "synthetic_area",
        kind: "practice_area",
        prompt: "Synthetic practice-area prompt",
        required: true,
        not_sure_label: "Synthetic not sure",
      },
      {
        id: "synthetic_choice",
        kind: "single_choice",
        prompt: "Synthetic choice prompt",
        required: false,
        choices: [
          { id: "synthetic_one", label: "Synthetic one" },
          { id: "synthetic_two", label: "Synthetic two" },
        ],
      },
    ],
    description: { prompt: "Synthetic description prompt", required: true },
    limits: {
      description_max_characters: 1000,
      structured_answers_max_bytes: 2048,
      revision_saves_per_client: { max: 10, window_seconds: 3600 },
      intake_starts_per_client: { max: 3, window_seconds: 86400 },
    },
    ...overrides,
  };
}

export function addQuestionSet(world, n, definition = syntheticDefinition()) {
  const row = {
    id: idOf(7, n),
    version_key: `synthetic-v${n}`,
    definition,
    published_at: stamp(world.now - 1000 * (1000 - n)),
  };
  world.intake_question_sets.push(row);
  return row;
}
