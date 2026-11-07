// P3-003 synthetic test world (not a test file; loaded by the M4 tests).
//
// An isolated, in-memory stand-in for the existing M4 tables and their
// read policies, used only by the P3-003 fixture tests. Its visibility rules
// mirror the committed migrations: own-row reads for users, attorney
// profiles, and staff profiles; professional records readable by their own
// attorney or by a caller holding the manage_attorney_verification scope for
// the record's jurisdiction; evidence, evidence links, and evaluations
// readable only with that scope; and the scope predicate itself evaluated
// exactly as has_manage_attorney_verification_scope defines it (granted,
// not revoked, not expired, not resource-scoped, global or same
// jurisdiction, for an active User whose Staff Profile is active, as
// corrected by P3-904). Privileged ports only read. The request-scoped write
// ports stand in for the P3-904 database write functions: each decides the
// caller's authority, the target's stage, and the record's version on the
// current state, then writes the change and exactly one audit row together,
// or nothing, and answers one fixed outcome. Every id, account, and value is
// synthetic test data; nothing here contacts a provider, network, or
// database.

import {
  DISCIPLINE_COLUMNS,
  EVALUATION_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  JURISDICTION_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AREA_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
} from "../src/application/professional-records.ts";
import {
  AUTHORITY_REFERENCE_COLUMNS,
  ELIGIBILITY_POLICY_SCHEMA,
  ELIGIBILITY_POLICY_TYPE,
  POLICY_VERSION_COLUMNS,
} from "../src/application/policy-selection.ts";
import { USER_COLUMNS } from "../src/application/professional-identity.ts";
import { STAFF_PROFILE_COLUMNS } from "../src/application/staff-verification.ts";

export const T0 = Date.parse("2026-11-04T12:00:00Z");
export const CONFIRMED_AT = "2026-10-01T00:00:00Z";

const SUBJECT_COLUMN = {
  license: "license_id",
  insurance: "insurance_record_id",
  discipline: "discipline_record_id",
  practice_area_authorisation: "practice_area_authorisation_id",
};
const RECORD_TABLE = {
  license: "licenses",
  insurance: "insurance_records",
  discipline: "discipline_records",
  practice_area_authorisation: "practice_area_authorisations",
};
const RECORD_COLUMNS = {
  licenses: LICENSE_COLUMNS,
  insurance_records: INSURANCE_COLUMNS,
  discipline_records: DISCIPLINE_COLUMNS,
  practice_area_authorisations: PRACTICE_AUTHORISATION_COLUMNS,
};

// A synthetic, canonical, version-4-shaped id for a label and a number.
export function idOf(group, n) {
  return `00000000-0000-4000-8000-${String(group).padStart(4, "0")}${String(n).padStart(8, "0")}`;
}

export function pick(row, columns) {
  const out = {};
  for (const column of columns.split(", ")) {
    out[column] = row[column];
  }
  return out;
}

const rows = (list) => Object.freeze({ kind: "rows", rows: list });
export const UNREADABLE = Object.freeze({ kind: "unreadable" });

// A PostgREST-like timestamp with microseconds and an explicit offset.
export function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

export function createWorld() {
  let counter = 0;
  const world = {
    now: T0,
    tick() {
      world.now += 1000;
      return world.now;
    },
    nextId() {
      counter += 1;
      return idOf(9000, counter);
    },
    auth: new Map(),
    users: [],
    attorney_profiles: [],
    staff_profiles: [],
    client_profiles: [],
    capability_grants: [],
    jurisdictions: [],
    practice_areas: [],
    licenses: [],
    insurance_records: [],
    discipline_records: [],
    practice_area_authorisations: [],
    verification_evidence: [],
    verification_evidence_subjects: [],
    eligibility_evaluations: [],
    audit_events: [],
    policy_versions: [],
    policy_authority_references: [],
    calls: [],
    failures: new Set(),
    lost: new Set(),
    hooks: new Map(),
  };
  return world;
}

// Seeding helpers (test-only synthetic records).
export function addAccount(
  world,
  n,
  { confirmed = true, state = "active" } = {},
) {
  const authId = idOf(1, n);
  world.auth.set(authId, {
    id: authId,
    email_confirmed_at: confirmed ? CONFIRMED_AT : null,
  });
  const userId = idOf(2, n);
  world.users.push({ id: userId, auth_user_id: authId, account_state: state });
  return { authId, userId };
}

export function addAttorney(world, n, state = "applicant", details = {}) {
  const { authId, userId } = addAccount(world, n);
  const id = idOf(3, n);
  world.attorney_profiles.push({
    id,
    user_id: userId,
    display_name: details.display_name ?? null,
    headline: null,
    bio: null,
    years_experience: null,
    profile_state: state,
    created_at: stamp(world.now),
    updated_at: stamp(world.now),
  });
  return { authId, userId, attorneyId: id };
}

export function addStaff(world, n, { state = "active", account } = {}) {
  const ids = account ?? addAccount(world, n);
  world.staff_profiles.push({
    id: idOf(4, n),
    user_id: ids.userId,
    staff_state: state,
  });
  return ids;
}

export function addGrant(world, userId, overrides = {}) {
  world.capability_grants.push({
    id: world.nextId(),
    user_id: userId,
    capability_code: "manage_attorney_verification",
    jurisdiction_id: null,
    resource_scope: null,
    granted_at: world.now - 86_400_000,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  });
}

export function addJurisdiction(world, n, code) {
  const id = idOf(5, n);
  world.jurisdictions.push({
    id,
    code,
    name: `Synthetic ${code}`,
    lifecycle_state: "staged",
  });
  return id;
}

export function addPracticeArea(world, n, active = true) {
  const id = idOf(6, n);
  world.practice_areas.push({
    id,
    code: `AREA_${n}`,
    name: `Synthetic area ${n}`,
    active,
  });
  return id;
}

export function addLicense(world, attorneyId, jurisdictionId, overrides = {}) {
  const row = {
    id: world.nextId(),
    attorney_id: attorneyId,
    jurisdiction_id: jurisdictionId,
    license_number: `SYN-${world.licenses.length + 1}`,
    license_type: null,
    effective_from: null,
    effective_until: null,
    reported_status: null,
    created_at: stamp(world.now),
    updated_at: stamp(world.now),
    ...overrides,
  };
  world.licenses.push(row);
  return row;
}

export function addInsurance(
  world,
  attorneyId,
  jurisdictionId,
  overrides = {},
) {
  const row = {
    id: world.nextId(),
    attorney_id: attorneyId,
    jurisdiction_id: jurisdictionId,
    carrier_name: "Synthetic carrier",
    policy_reference: null,
    coverage_type: null,
    per_occurrence_limit_minor: null,
    aggregate_limit_minor: null,
    currency_code: null,
    coverage_from: null,
    coverage_until: null,
    created_at: stamp(world.now),
    updated_at: stamp(world.now),
    ...overrides,
  };
  world.insurance_records.push(row);
  return row;
}

export function addAuthorisation(
  world,
  attorneyId,
  jurisdictionId,
  practiceAreaId,
  overrides = {},
) {
  const row = {
    id: world.nextId(),
    attorney_id: attorneyId,
    jurisdiction_id: jurisdictionId,
    practice_area_id: practiceAreaId,
    status: "requested",
    requested_at: stamp(world.now - 3_600_000),
    decided_at: null,
    effective_from: null,
    effective_until: null,
    criteria_policy_version_id: null,
    created_at: stamp(world.now),
    updated_at: stamp(world.now),
    ...overrides,
  };
  world.practice_area_authorisations.push(row);
  return row;
}

export function addEvidence(world, kind, record, overrides = {}) {
  const evidence = {
    id: world.nextId(),
    jurisdiction_id: record.jurisdiction_id,
    source_type: "synthetic register",
    source_uri: null,
    source_reference: "synthetic entry",
    retrieved_at: stamp(world.now - 3_600_000),
    retrieved_by_user_id: null,
    evidence_summary: "synthetic finding",
    evidence_digest: null,
    verification_method: "synthetic lookup",
    discrepancy_flag: false,
    retention_class: null,
    created_at: stamp(world.now),
    ...overrides,
  };
  world.verification_evidence.push(evidence);
  world.verification_evidence_subjects.push({
    id: world.nextId(),
    verification_evidence_id: evidence.id,
    license_id: null,
    insurance_record_id: null,
    discipline_record_id: null,
    practice_area_authorisation_id: null,
    [SUBJECT_COLUMN[kind]]: record.id,
    created_at: stamp(world.now),
  });
  return evidence;
}

export const POLICY_PARAMETERS = Object.freeze({
  schema: ELIGIBILITY_POLICY_SCHEMA,
  license: {
    qualifying_reported_statuses: ["synthetic-active"],
    evidence_max_age_days: 365,
  },
  insurance: {
    required: true,
    evidence_max_age_days: 365,
    minimum_per_occurrence_minor: 100000,
    minimum_aggregate_minor: null,
    currency_code: "XTS",
  },
  discipline: {
    disqualifying_statuses: ["synthetic-revoked"],
    cleared_statuses: ["synthetic-dismissed"],
  },
  practice_area: { authorisation_required: true },
});

// A synthetic, test-only active policy with verified synthetic provenance.
export function addPolicy(
  world,
  jurisdictionId,
  overrides = {},
  authority = "verified",
) {
  const id = world.nextId();
  world.policy_versions.push({
    id,
    policy_type_code: ELIGIBILITY_POLICY_TYPE,
    jurisdiction_id: jurisdictionId,
    regulatory_mode_id: null,
    version_label: "synthetic-v1",
    parameters: JSON.parse(JSON.stringify(POLICY_PARAMETERS)),
    status: "active",
    effective_from: stamp(world.now - 30 * 86_400_000),
    effective_until: null,
    approved_at: stamp(world.now - 31 * 86_400_000),
    approved_by_user_id: idOf(2, 999),
    ...overrides,
  });
  if (authority !== null) {
    world.policy_authority_references.push({
      id: world.nextId(),
      policy_version_id: id,
      verification_status: authority,
      verified_by_user_id: authority === "verified" ? idOf(2, 999) : null,
    });
  }
  return id;
}

// ---------------------------------------------------------------------------
// The read policies and the scope predicate, as the migrations define them.
// ---------------------------------------------------------------------------

function userOfAuth(world, authId) {
  return world.users.find((user) => user.auth_user_id === authId) ?? null;
}

// has_manage_attorney_verification_scope(required, false) for one caller,
// as corrected by P3-904: an active User with an active Staff Profile and a
// current grant in scope.
export function predicate(world, authId, required) {
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
      g.capability_code === "manage_attorney_verification" &&
      g.granted_at <= world.now &&
      g.revoked_at === null &&
      (g.expires_at === null || g.expires_at > world.now) &&
      g.resource_scope === null &&
      (g.jurisdiction_id === null ||
        (required !== null && g.jurisdiction_id === required)),
  );
}

function ownsAttorney(world, authId, attorneyId) {
  const profile = world.attorney_profiles.find((p) => p.id === attorneyId);
  const user = profile && world.users.find((u) => u.id === profile.user_id);
  return user !== undefined && user.auth_user_id === authId;
}

function recordVisible(world, authId, row) {
  return (
    predicate(world, authId, row.jurisdiction_id) ||
    ownsAttorney(world, authId, row.attorney_id)
  );
}

function subjectRecordOf(world, link) {
  for (const [kind, column] of Object.entries(SUBJECT_COLUMN)) {
    if (link[column] !== null) {
      return (
        world[RECORD_TABLE[kind]].find((r) => r.id === link[column]) ?? null
      );
    }
  }
  return null;
}

// The one audit row a write function appends with its change.
function auditRow(world, actor, actorType, fields) {
  return {
    id: world.nextId(),
    actor_user_id: actor,
    actor_type: actorType,
    action_code: fields.action,
    resource_type: fields.resourceType,
    resource_id: fields.resourceId,
    before_snapshot: fields.before ?? null,
    after_snapshot: fields.after ?? null,
    reason_code: fields.reasonCode ?? null,
    policy_references: fields.policyReferences ?? null,
    jurisdiction_id: fields.jurisdictionId ?? null,
    occurred_at: stamp(world.now),
  };
}

// Wraps every method of a port so that a test can run a hook just before a
// named call (to revoke a grant or change a record mid-operation), make the
// call fail without effect (failures), or apply it but lose its answer
// (lost), exactly as an uncertain network write would.
export function instrument(world, prefix, port) {
  const wrapped = {};
  for (const [name, call] of Object.entries(port)) {
    wrapped[name] = async (...args) => {
      const key = `${prefix}.${name}`;
      const hook = world.hooks.get(key);
      if (hook !== undefined) {
        world.hooks.delete(key);
        await hook(...args);
      }
      if (world.failures.has(key)) {
        world.calls.push(`failed:${key}`);
        return name === "holdsVerificationScope"
          ? { kind: "unreadable" }
          : UNREADABLE;
      }
      const answer = await call(...args);
      if (world.lost.has(key)) {
        world.calls.push(`lost:${key}`);
        return UNREADABLE;
      }
      return answer;
    };
  }
  return wrapped;
}

function fail(world, name) {
  world.calls.push(name);
  return world.failures.has(name);
}

// The request-scoped attorney read port, as the request client under RLS.
export function attorneyReadsFor(world, authId) {
  const own = (table) => (attorneyId) =>
    fail(world, `reads.${table}`)
      ? UNREADABLE
      : rows(
          world[table]
            .filter(
              (r) =>
                r.attorney_id === attorneyId && recordVisible(world, authId, r),
            )
            .map((r) => pick(r, RECORD_COLUMNS[table])),
        );
  return {
    usersOf: async (accountId) =>
      fail(world, "reads.users")
        ? UNREADABLE
        : rows(
            world.users
              .filter(
                (u) => u.auth_user_id === accountId && accountId === authId,
              )
              .map((u) => pick(u, USER_COLUMNS)),
          ),
    profilesOf: async (userId) =>
      fail(world, "reads.profiles")
        ? UNREADABLE
        : rows(
            world.attorney_profiles
              .filter(
                (p) =>
                  p.user_id === userId &&
                  (ownsAttorney(world, authId, p.id) ||
                    predicate(world, authId, null)),
              )
              .map((p) => pick(p, PROFILE_COLUMNS)),
          ),
    licensesOf: async (id) => own("licenses")(id),
    insuranceOf: async (id) => own("insurance_records")(id),
    authorisationsOf: async (id) => own("practice_area_authorisations")(id),
    practiceAreas: async () =>
      rows(
        world.practice_areas
          .filter((a) => a.active || predicate(world, authId, null))
          .map((a) => pick(a, PRACTICE_AREA_COLUMNS)),
      ),
  };
}

// The privileged attorney professional port: reads only.
export function attorneyProvisioningFor(world) {
  return {
    jurisdictions: async () =>
      fail(world, "prov.jurisdictions")
        ? UNREADABLE
        : rows(world.jurisdictions.map((j) => pick(j, JURISDICTION_COLUMNS))),
    evidenceSubjectsOf: async (kind, ids) =>
      fail(world, "prov.subjects")
        ? UNREADABLE
        : rows(
            world.verification_evidence_subjects
              .filter((s) => ids.includes(s[SUBJECT_COLUMN[kind]]))
              .map((s) =>
                pick(s, `verification_evidence_id, ${SUBJECT_COLUMN[kind]}`),
              ),
          ),
    evidenceFlagsOf: async (ids) =>
      rows(
        world.verification_evidence
          .filter((e) => ids.includes(e.id))
          .map((e) => pick(e, "id, discrepancy_flag, retrieved_at")),
      ),
    evaluationsOf: async (attorneyId) =>
      rows(
        world.eligibility_evaluations
          .filter((e) => e.attorney_id === attorneyId)
          .map((e) =>
            pick(
              e,
              "id, jurisdiction_id, context_type, context_id, result, evaluated_at",
            ),
          ),
      ),
    informationRequestsOf: async (attorneyId) =>
      rows(
        world.audit_events
          .filter(
            (a) =>
              a.resource_type === "attorney_profile" &&
              a.resource_id === attorneyId &&
              a.action_code === "attorney_information_requested",
          )
          .map((a) => pick(a, "id, occurred_at, action_code, after_snapshot")),
      ),
  };
}

// The request-scoped staff read port, as the request client under RLS.
export function staffReadsFor(world, authId) {
  const visible = (table) => (r) => recordVisible(world, authId, r);
  const ofAttorney = (table) => async (attorneyId) =>
    rows(
      world[table]
        .filter((r) => r.attorney_id === attorneyId && visible(table)(r))
        .map((r) => pick(r, RECORD_COLUMNS[table])),
    );
  return {
    usersOf: async (accountId) =>
      rows(
        world.users
          .filter((u) => u.auth_user_id === accountId && accountId === authId)
          .map((u) => pick(u, USER_COLUMNS)),
      ),
    staffProfilesOf: async (userId) =>
      rows(
        world.staff_profiles
          .filter(
            (s) =>
              s.user_id === userId && userOfAuth(world, authId)?.id === userId,
          )
          .map((s) => pick(s, STAFF_PROFILE_COLUMNS)),
      ),
    ownAttorneyProfilesOf: async (userId) =>
      rows(
        world.attorney_profiles
          .filter(
            (p) => p.user_id === userId && ownsAttorney(world, authId, p.id),
          )
          .map((p) => pick(p, PROFILE_COLUMNS)),
      ),
    holdsVerificationScope: async (jurisdictionId) => {
      world.calls.push(`scope:${jurisdictionId}`);
      return fail(world, "reads.scope")
        ? { kind: "unreadable" }
        : { kind: "answer", granted: predicate(world, authId, jurisdictionId) };
    },
    attorneyProfiles: async () =>
      rows(
        world.attorney_profiles
          .filter(
            (p) =>
              ownsAttorney(world, authId, p.id) ||
              predicate(world, authId, null),
          )
          .map((p) => pick(p, PROFILE_COLUMNS)),
      ),
    attorneyProfileById: async (id) =>
      rows(
        world.attorney_profiles
          .filter(
            (p) =>
              p.id === id &&
              (ownsAttorney(world, authId, p.id) ||
                predicate(world, authId, null)),
          )
          .map((p) => pick(p, PROFILE_COLUMNS)),
      ),
    licensesOf: ofAttorney("licenses"),
    insuranceOf: ofAttorney("insurance_records"),
    disciplineOf: ofAttorney("discipline_records"),
    authorisationsOf: ofAttorney("practice_area_authorisations"),
    pendingAuthorisations: async () =>
      rows(
        world.practice_area_authorisations
          .filter((r) => r.status === "requested" && visible("x")(r))
          .map((r) => pick(r, PRACTICE_AUTHORISATION_COLUMNS)),
      ),
    visibleLicenses: async () =>
      rows(
        world.licenses
          .filter(visible("licenses"))
          .map((r) => pick(r, LICENSE_COLUMNS)),
      ),
    recordById: async (kind, id) => {
      const table = RECORD_TABLE[kind];
      return rows(
        world[table]
          .filter((r) => r.id === id && visible(table)(r))
          .map((r) => pick(r, RECORD_COLUMNS[table])),
      );
    },
    evidenceSubjectsFor: async (kind, ids) =>
      rows(
        world.verification_evidence_subjects
          .filter((s) => ids.includes(s[SUBJECT_COLUMN[kind]]))
          .filter((s) => {
            const record = subjectRecordOf(world, s);
            return (
              record !== null &&
              predicate(world, authId, record.jurisdiction_id)
            );
          })
          .map((s) => pick(s, EVIDENCE_SUBJECT_COLUMNS)),
      ),
    evidenceByIds: async (ids) =>
      rows(
        world.verification_evidence
          .filter(
            (e) =>
              ids.includes(e.id) && predicate(world, authId, e.jurisdiction_id),
          )
          .map((e) => pick(e, EVIDENCE_COLUMNS)),
      ),
    evaluationsOf: async (attorneyId) =>
      rows(
        world.eligibility_evaluations
          .filter(
            (e) =>
              e.attorney_id === attorneyId &&
              predicate(world, authId, e.jurisdiction_id),
          )
          .map((e) => pick(e, EVALUATION_COLUMNS)),
      ),
    practiceAreas: async () =>
      rows(world.practice_areas.map((a) => pick(a, PRACTICE_AREA_COLUMNS))),
  };
}

// The privileged staff verification port: reads only.
export function staffProvisioningFor(world) {
  const recordsIn = (table) => async (attorneyId, jurisdictionId) =>
    rows(
      world[table]
        .filter(
          (r) =>
            r.attorney_id === attorneyId &&
            r.jurisdiction_id === jurisdictionId,
        )
        .map((r) => pick(r, RECORD_COLUMNS[table])),
    );
  return {
    jurisdictions: async () =>
      rows(world.jurisdictions.map((j) => pick(j, JURISDICTION_COLUMNS))),
    attorneyProfileOf: async (id) =>
      rows(
        world.attorney_profiles
          .filter((p) => p.id === id)
          .map((p) => pick(p, PROFILE_COLUMNS)),
      ),
    accountStateOf: async (userId) =>
      rows(
        world.users
          .filter((u) => u.id === userId)
          .map((u) => pick(u, "id, account_state")),
      ),
    licensesIn: recordsIn("licenses"),
    insuranceIn: recordsIn("insurance_records"),
    disciplineIn: recordsIn("discipline_records"),
    authorisationsIn: recordsIn("practice_area_authorisations"),
    evidenceSubjectsOf: async (kind, ids) =>
      rows(
        world.verification_evidence_subjects
          .filter((s) => ids.includes(s[SUBJECT_COLUMN[kind]]))
          .map((s) => pick(s, EVIDENCE_SUBJECT_COLUMNS)),
      ),
    evidenceOf: async (ids) =>
      rows(
        world.verification_evidence
          .filter((e) => ids.includes(e.id))
          .map((e) => pick(e, EVIDENCE_COLUMNS)),
      ),
    policyVersionsFor: async (type, jurisdictionId) =>
      type !== ELIGIBILITY_POLICY_TYPE
        ? UNREADABLE
        : rows(
            world.policy_versions
              .filter(
                (v) =>
                  v.policy_type_code === type &&
                  v.jurisdiction_id === jurisdictionId,
              )
              .map((v) => pick(v, POLICY_VERSION_COLUMNS)),
          ),
    authorityReferencesFor: async (ids) =>
      rows(
        world.policy_authority_references
          .filter((r) => ids.includes(r.policy_version_id))
          .map((r) => pick(r, AUTHORITY_REFERENCE_COLUMNS)),
      ),
    profileHistoryOf: async (attorneyId) =>
      rows(
        world.audit_events
          .filter(
            (a) =>
              a.resource_type === "attorney_profile" &&
              a.resource_id === attorneyId,
          )
          .map((a) => pick(a, "occurred_at, action_code, after_snapshot")),
      ),
  };
}

// ---------------------------------------------------------------------------
// The P3-904 write functions, as request-scoped write ports. Each answers
// exactly what the database function returns. The synthetic world is
// single-threaded, so deciding and writing in one call is atomic, as one
// database transaction is. A test can make the mandatory audit append fail
// ("writes.audit"): the function then raises, nothing is written, and the
// adapter reports a database refusal.
// ---------------------------------------------------------------------------

const outcome = (value) => Object.freeze({ kind: "outcome", outcome: value });
export const REJECTED = Object.freeze({ kind: "rejected" });

function activeUserOf(world, authId) {
  const user = userOfAuth(world, authId);
  return user !== null && user.account_state === "active" ? user : null;
}

// Applies one change and its audit row together, or neither.
function commit(world, apply, audit) {
  if (world.failures.has("writes.audit")) {
    world.calls.push("writes.audit:failed");
    return REJECTED;
  }
  apply();
  world.audit_events.push(audit);
  return outcome("applied");
}

const FINDING_STAGES = ["under_review", "approved", "suspended"];
const DECISION_STAGES = ["under_review", "approved"];
const TRANSITIONS = {
  approve: ["under_review", "approved"],
  request_information: ["under_review", "applicant"],
  suspend: ["approved", "suspended"],
};
const RESOURCE_OF = {
  license: "license",
  insurance: "insurance_record",
  discipline: "discipline_record",
  practice_area_authorisation: "practice_area_authorisation",
};

export function attorneyWritesFor(world, authId) {
  // The caller's own profile, or a fixed refusal.
  const own = (stages) => {
    const user = activeUserOf(world, authId);
    const profile =
      user === null
        ? undefined
        : world.attorney_profiles.find((p) => p.user_id === user.id);
    if (
      profile === undefined ||
      profile.profile_state === "suspended" ||
      profile.profile_state === "removed"
    ) {
      return { refusal: outcome("denied") };
    }
    if (!stages.includes(profile.profile_state)) {
      return { refusal: outcome("locked") };
    }
    return { user, profile };
  };
  const linked = (column, id) =>
    world.verification_evidence_subjects.some((s) => s[column] === id);
  const audit = (user, fields) => auditRow(world, user.id, "attorney", fields);
  const claimWrite = (table, column, snapshotKeys, id, expected, claim) => {
    const ctx = own(["applicant"]);
    if (ctx.refusal) {
      return ctx.refusal;
    }
    const now = stamp(world.tick());
    const duplicate = (row) =>
      table === "licenses" &&
      row.id !== id &&
      row.jurisdiction_id === claim.jurisdiction_id &&
      row.license_number === claim.license_number;
    const snapshot = (row) =>
      Object.fromEntries(snapshotKeys.map((k) => [k, row[k]]));
    if (expected === null) {
      if (world[table].some((r) => r.id === id || duplicate(r))) {
        return outcome("conflict");
      }
      const row = {
        id,
        attorney_id: ctx.profile.id,
        ...claim,
        ...(table === "licenses" ? { reported_status: null } : {}),
        created_at: now,
        updated_at: now,
      };
      return commit(
        world,
        () => world[table].push(row),
        audit(ctx.user, {
          action: "attorney_claim_recorded",
          resourceType: table === "licenses" ? "license" : "insurance_record",
          resourceId: id,
          after: snapshot(row),
          jurisdictionId: claim.jurisdiction_id,
        }),
      );
    }
    const row = world[table].find(
      (r) => r.id === id && r.attorney_id === ctx.profile.id,
    );
    if (row === undefined) {
      return outcome("denied");
    }
    if (
      (table === "licenses" && row.reported_status !== null) ||
      linked(column, id)
    ) {
      return outcome("locked");
    }
    if (row.updated_at !== expected || world[table].some(duplicate)) {
      return outcome("conflict");
    }
    const before = snapshot(row);
    return commit(
      world,
      () => Object.assign(row, claim, { updated_at: now }),
      audit(ctx.user, {
        action: "attorney_claim_revised",
        resourceType: table === "licenses" ? "license" : "insurance_record",
        resourceId: id,
        before,
        after: snapshot({ ...row, ...claim }),
        jurisdictionId: claim.jurisdiction_id,
      }),
    );
  };
  return {
    saveProfileDetails: async (expectedStage, details) => {
      const ctx = own(["applicant", "approved"]);
      if (ctx.refusal) {
        return ctx.refusal;
      }
      if (ctx.profile.profile_state !== expectedStage) {
        return outcome("locked");
      }
      if (
        expectedStage === "approved" &&
        details.years_experience !== ctx.profile.years_experience
      ) {
        return outcome("invalid");
      }
      const keys = ["display_name", "headline", "bio", "years_experience"];
      const before = Object.fromEntries(keys.map((k) => [k, ctx.profile[k]]));
      return commit(
        world,
        () =>
          Object.assign(ctx.profile, details, {
            updated_at: stamp(world.tick()),
          }),
        audit(ctx.user, {
          action: "attorney_profile_details_revised",
          resourceType: "attorney_profile",
          resourceId: ctx.profile.id,
          before,
          after: { ...details },
          reasonCode: expectedStage === "approved" ? "presentation_only" : null,
        }),
      );
    },
    saveLicense: async (id, expected, claim) =>
      claimWrite(
        "licenses",
        "license_id",
        [
          "jurisdiction_id",
          "license_number",
          "license_type",
          "effective_from",
          "effective_until",
        ],
        id,
        expected,
        claim,
      ),
    saveInsurance: async (id, expected, claim) =>
      claimWrite(
        "insurance_records",
        "insurance_record_id",
        Object.keys(claim),
        id,
        expected,
        claim,
      ),
    requestPracticeArea: async (id, jurisdictionId, practiceAreaId) => {
      const ctx = own(["applicant"]);
      if (ctx.refusal) {
        return ctx.refusal;
      }
      if (
        !world.practice_areas.some((a) => a.id === practiceAreaId && a.active)
      ) {
        return outcome("invalid");
      }
      if (
        world.practice_area_authorisations.some(
          (r) =>
            r.id === id ||
            (r.attorney_id === ctx.profile.id &&
              r.jurisdiction_id === jurisdictionId &&
              r.practice_area_id === practiceAreaId),
        )
      ) {
        return outcome("conflict");
      }
      const now = stamp(world.tick());
      return commit(
        world,
        () =>
          world.practice_area_authorisations.push({
            id,
            attorney_id: ctx.profile.id,
            jurisdiction_id: jurisdictionId,
            practice_area_id: practiceAreaId,
            status: "requested",
            requested_at: now,
            decided_at: null,
            effective_from: null,
            effective_until: null,
            criteria_policy_version_id: null,
            created_at: now,
            updated_at: now,
          }),
        audit(ctx.user, {
          action: "practice_area_request_changed",
          resourceType: "practice_area_authorisation",
          resourceId: id,
          after: { status: "requested", practice_area_id: practiceAreaId },
          jurisdictionId,
        }),
      );
    },
    changePracticeAreaRequest: async (id, intent, expected) => {
      const ctx = own(["applicant"]);
      if (ctx.refusal) {
        return ctx.refusal;
      }
      const row = world.practice_area_authorisations.find(
        (r) => r.id === id && r.attorney_id === ctx.profile.id,
      );
      if (row === undefined) {
        return outcome("denied");
      }
      const from = intent === "withdraw" ? "requested" : "withdrawn";
      if (row.status !== from || row.decided_at !== null) {
        return outcome("locked");
      }
      if (row.updated_at !== expected) {
        return outcome("conflict");
      }
      const to = intent === "withdraw" ? "withdrawn" : "requested";
      const now = stamp(world.tick());
      return commit(
        world,
        () =>
          Object.assign(row, {
            status: to,
            ...(to === "requested" ? { requested_at: now } : {}),
            updated_at: now,
          }),
        audit(ctx.user, {
          action: "practice_area_request_changed",
          resourceType: "practice_area_authorisation",
          resourceId: id,
          before: { status: from },
          after: { status: to },
          jurisdictionId: row.jurisdiction_id,
        }),
      );
    },
    submitApplication: async () => {
      const ctx = own(["applicant"]);
      if (ctx.refusal) {
        return ctx.refusal;
      }
      return commit(
        world,
        () =>
          Object.assign(ctx.profile, {
            profile_state: "under_review",
            updated_at: stamp(world.tick()),
          }),
        audit(ctx.user, {
          action: "attorney_application_submitted",
          resourceType: "attorney_profile",
          resourceId: ctx.profile.id,
          before: { profile_state: "applicant" },
          after: { profile_state: "under_review" },
        }),
      );
    },
  };
}

export function staffWritesFor(world, authId) {
  // The caller's staff User when it holds the scope for exactly this
  // jurisdiction (null: the global scope), decided on the current state.
  const authority = (jurisdictionId) => {
    const user = activeUserOf(world, authId);
    return user !== null && predicate(world, authId, jurisdictionId)
      ? user
      : null;
  };
  const target = (attorneyId, staffUser) => {
    const profile = world.attorney_profiles.find((p) => p.id === attorneyId);
    return profile === undefined || profile.user_id === staffUser.id
      ? null
      : profile;
  };
  const recordOf = (kind, id) =>
    world[RECORD_TABLE[kind]]?.find((r) => r.id === id);
  const audit = (user, fields) => auditRow(world, user.id, "staff", fields);
  const evidenceRow = (id, jurisdictionId, user, evidence) => ({
    id,
    jurisdiction_id: jurisdictionId,
    ...evidence,
    retrieved_by_user_id: user.id,
    retention_class: null,
    created_at: stamp(world.now),
  });
  const linkRow = (evidenceId, kind, recordId) => ({
    id: world.nextId(),
    verification_evidence_id: evidenceId,
    license_id: null,
    insurance_record_id: null,
    discipline_record_id: null,
    practice_area_authorisation_id: null,
    [SUBJECT_COLUMN[kind]]: recordId,
    created_at: stamp(world.now),
  });
  return {
    recordFinding: async (w) => {
      const record = recordOf(w.subjectKind, w.subjectId);
      if (record === undefined) {
        return outcome("denied");
      }
      const user = authority(record.jurisdiction_id);
      const profile = user === null ? null : target(record.attorney_id, user);
      if (profile === null) {
        return outcome("denied");
      }
      if (!FINDING_STAGES.includes(profile.profile_state)) {
        return outcome("locked");
      }
      if (
        record.updated_at !== w.expectedUpdatedAt ||
        world.verification_evidence.some((e) => e.id === w.evidenceId)
      ) {
        return outcome("conflict");
      }
      return commit(
        world,
        () => {
          world.verification_evidence.push(
            evidenceRow(w.evidenceId, record.jurisdiction_id, user, w.evidence),
          );
          world.verification_evidence_subjects.push(
            linkRow(w.evidenceId, w.subjectKind, w.subjectId),
          );
          if (w.observedStatus !== null) {
            Object.assign(record, {
              reported_status: w.observedStatus,
              updated_at: stamp(world.tick()),
            });
          }
          if (w.disciplineStatus !== null) {
            Object.assign(record, {
              status: w.disciplineStatus,
              ...(w.resolvedAt === null ? {} : { resolved_at: w.resolvedAt }),
              updated_at: stamp(world.tick()),
            });
          }
        },
        audit(user, {
          action: "verification_evidence_recorded",
          resourceType: "verification_evidence",
          resourceId: w.evidenceId,
          after: {
            subject_kind: w.subjectKind,
            subject_id: w.subjectId,
            discrepancy: w.evidence.discrepancy_flag,
            observed_status: w.observedStatus,
            discipline_status: w.disciplineStatus,
          },
          jurisdictionId: record.jurisdiction_id,
        }),
      );
    },
    recordSourceUnavailable: async (kind, id, note) => {
      const record = recordOf(kind, id);
      if (record === undefined) {
        return outcome("denied");
      }
      const user = authority(record.jurisdiction_id);
      const profile = user === null ? null : target(record.attorney_id, user);
      if (profile === null) {
        return outcome("denied");
      }
      if (!FINDING_STAGES.includes(profile.profile_state)) {
        return outcome("locked");
      }
      return commit(
        world,
        () => {},
        audit(user, {
          action: "verification_source_unavailable",
          resourceType: RESOURCE_OF[kind],
          resourceId: id,
          after: { note },
          reasonCode: "verification_source_unavailable",
          jurisdictionId: record.jurisdiction_id,
        }),
      );
    },
    recordDisciplineFinding: async (w) => {
      const user = authority(w.record.jurisdiction_id);
      const profile = user === null ? null : target(w.attorneyId, user);
      if (profile === null) {
        return outcome("denied");
      }
      if (!FINDING_STAGES.includes(profile.profile_state)) {
        return outcome("locked");
      }
      if (
        world.discipline_records.some((r) => r.id === w.disciplineId) ||
        world.verification_evidence.some((e) => e.id === w.evidenceId)
      ) {
        return outcome("conflict");
      }
      return commit(
        world,
        () => {
          world.discipline_records.push({
            id: w.disciplineId,
            attorney_id: w.attorneyId,
            ...w.record,
            details_reference: null,
            created_at: stamp(world.now),
            updated_at: stamp(world.now),
          });
          world.verification_evidence.push(
            evidenceRow(
              w.evidenceId,
              w.record.jurisdiction_id,
              user,
              w.evidence,
            ),
          );
          world.verification_evidence_subjects.push(
            linkRow(w.evidenceId, "discipline", w.disciplineId),
          );
        },
        audit(user, {
          action: "discipline_record_recorded",
          resourceType: "discipline_record",
          resourceId: w.disciplineId,
          after: {
            attorney_id: w.attorneyId,
            status: w.record.status,
            finding_type: w.record.finding_type,
            external_reference: w.record.external_reference,
            evidence_id: w.evidenceId,
          },
          jurisdictionId: w.record.jurisdiction_id,
        }),
      );
    },
    decidePracticeArea: async (id, expected, decision, note) => {
      const record = recordOf("practice_area_authorisation", id);
      if (record === undefined) {
        return outcome("denied");
      }
      const user = authority(record.jurisdiction_id);
      const profile = user === null ? null : target(record.attorney_id, user);
      if (profile === null) {
        return outcome("denied");
      }
      if (!DECISION_STAGES.includes(profile.profile_state)) {
        return outcome("locked");
      }
      if (record.status !== "requested" || record.decided_at !== null) {
        return outcome("locked");
      }
      if (record.updated_at !== expected) {
        return outcome("conflict");
      }
      const now = stamp(world.tick());
      return commit(
        world,
        () =>
          Object.assign(record, {
            status: decision.status,
            decided_at: now,
            effective_from: decision.effective_from,
            effective_until: decision.effective_until,
            updated_at: now,
          }),
        audit(user, {
          action: "practice_area_authorisation_decided",
          resourceType: "practice_area_authorisation",
          resourceId: id,
          before: { status: "requested" },
          after: { ...decision, decided_at: now, note },
          jurisdictionId: record.jurisdiction_id,
        }),
      );
    },
    changeProfileStage: async (attorneyId, intent, message, note) => {
      const user = authority(null);
      const profile = user === null ? null : target(attorneyId, user);
      if (profile === null) {
        return outcome("denied");
      }
      const [from, to] = TRANSITIONS[intent];
      if (profile.profile_state !== from) {
        return outcome("locked");
      }
      return commit(
        world,
        () =>
          Object.assign(profile, {
            profile_state: to,
            updated_at: stamp(world.tick()),
          }),
        audit(user, {
          action:
            intent === "request_information"
              ? "attorney_information_requested"
              : "attorney_profile_state_changed",
          resourceType: "attorney_profile",
          resourceId: attorneyId,
          before: { profile_state: from },
          after:
            intent === "request_information"
              ? { profile_state: to, message_to_applicant: message }
              : { profile_state: to, staff_note: note },
          reasonCode: `staff_review_${intent}`,
        }),
      );
    },
    recordEvaluation: async (row) => {
      const user = authority(row.jurisdiction_id);
      const profile = user === null ? null : target(row.attorney_id, user);
      if (profile === null) {
        return outcome("denied");
      }
      if (world.eligibility_evaluations.some((e) => e.id === row.id)) {
        return outcome("conflict");
      }
      const plain = JSON.parse(JSON.stringify(row));
      return commit(
        world,
        () =>
          world.eligibility_evaluations.push({
            ...plain,
            evaluated_at: stamp(world.now),
            created_at: stamp(world.now),
          }),
        audit(user, {
          action: "eligibility_evaluation_recorded",
          resourceType: "eligibility_evaluation",
          resourceId: row.id,
          after: {
            result: row.result,
            attorney_id: row.attorney_id,
            practice_area_id: row.context_id,
            as_of: row.as_of,
          },
          policyReferences: plain.policy_references,
          jurisdictionId: row.jurisdiction_id,
        }),
      );
    },
  };
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

export function attorneySources(world, authId, overrides = {}) {
  return {
    session: sessionOf(authId),
    account: accountOf(world, authId),
    reads: async () =>
      instrument(world, "reads", attorneyReadsFor(world, authId)),
    provisioning: async () =>
      instrument(world, "prov", attorneyProvisioningFor(world)),
    writes: async () =>
      instrument(world, "writes", attorneyWritesFor(world, authId)),
    clock: () => world.now,
    newId: () => world.nextId(),
    ...overrides,
  };
}

export function staffSources(world, authId, overrides = {}) {
  return {
    session: sessionOf(authId),
    account: accountOf(world, authId),
    reads: async () => instrument(world, "reads", staffReadsFor(world, authId)),
    provisioning: async () =>
      instrument(world, "prov", staffProvisioningFor(world)),
    writes: async () =>
      instrument(world, "writes", staffWritesFor(world, authId)),
    clock: () => world.now,
    newId: () => world.nextId(),
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

// The audit rows of one action, oldest first. Under P3-904 each applied
// change has exactly one, written together with the change.
export function auditsOf(world, action) {
  return world.audit_events.filter((event) => event.action_code === action);
}
