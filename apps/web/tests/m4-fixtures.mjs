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
// jurisdiction). Privileged ports apply the same guarded writes the real
// ports send. Every id, account, and value is synthetic test data; nothing
// here contacts a provider, network, or database.

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

// has_manage_attorney_verification_scope(required, false) for one caller.
export function predicate(world, authId, required) {
  const user = userOfAuth(world, authId);
  if (user === null) {
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

// One audit append, failing when the test says so: for every append
// (prov.audit), or only for attempt or outcome rows.
function auditInsert(world, event) {
  const phase = event.after_snapshot?.audit_phase ?? "single";
  world.calls.push(`audit:${phase}`);
  if (
    world.failures.has("prov.audit") ||
    world.failures.has(`prov.audit.${phase}`)
  ) {
    return UNREADABLE;
  }
  return insert(world, "audit_events", { id: world.nextId(), ...event }, "id");
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

function guardedUpdate(world, table, match, changes, columns) {
  const target = world[table].filter(match);
  for (const row of target) {
    Object.assign(row, changes, { updated_at: stamp(world.tick()) });
  }
  return rows(target.map((row) => pick(row, columns)));
}

function insert(world, table, row, columns) {
  world[table].push(row);
  return rows([pick(row, columns)]);
}

// The privileged attorney professional port, applying the real guards.
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
              (a.action_code === "attorney_information_requested" ||
                a.action_code === "audited_change_outcome"),
          )
          .map((a) => pick(a, "id, occurred_at, action_code, after_snapshot")),
      ),
    updateProfileDetails: async (attorneyId, userId, details) =>
      fail(world, "prov.updateProfileDetails")
        ? UNREADABLE
        : guardedUpdate(
            world,
            "attorney_profiles",
            (p) =>
              p.id === attorneyId &&
              p.user_id === userId &&
              p.profile_state === "applicant",
            details,
            PROFILE_COLUMNS,
          ),
    insertLicense: async (attorneyId, id, claim) => {
      if (fail(world, "prov.insertLicense")) {
        return UNREADABLE;
      }
      if (
        world.licenses.some(
          (l) =>
            l.jurisdiction_id === claim.jurisdiction_id &&
            l.license_number === claim.license_number,
        )
      ) {
        return UNREADABLE;
      }
      return insert(
        world,
        "licenses",
        {
          id,
          attorney_id: attorneyId,
          ...claim,
          reported_status: null,
          created_at: stamp(world.now),
          updated_at: stamp(world.now),
        },
        LICENSE_COLUMNS,
      );
    },
    updateLicense: async (attorneyId, id, expected, claim) =>
      guardedUpdate(
        world,
        "licenses",
        (l) =>
          l.id === id &&
          l.attorney_id === attorneyId &&
          l.updated_at === expected &&
          l.reported_status === null,
        claim,
        LICENSE_COLUMNS,
      ),
    insertInsurance: async (attorneyId, id, claim) =>
      insert(
        world,
        "insurance_records",
        {
          id,
          attorney_id: attorneyId,
          ...claim,
          created_at: stamp(world.now),
          updated_at: stamp(world.now),
        },
        INSURANCE_COLUMNS,
      ),
    updateInsurance: async (attorneyId, id, expected, claim) =>
      guardedUpdate(
        world,
        "insurance_records",
        (r) =>
          r.id === id &&
          r.attorney_id === attorneyId &&
          r.updated_at === expected,
        claim,
        INSURANCE_COLUMNS,
      ),
    insertAuthorisationRequest: async (
      attorneyId,
      id,
      jurisdictionId,
      practiceAreaId,
      requestedAt,
    ) =>
      insert(
        world,
        "practice_area_authorisations",
        {
          id,
          attorney_id: attorneyId,
          jurisdiction_id: jurisdictionId,
          practice_area_id: practiceAreaId,
          status: "requested",
          requested_at: requestedAt,
          decided_at: null,
          effective_from: null,
          effective_until: null,
          criteria_policy_version_id: null,
          created_at: stamp(world.now),
          updated_at: stamp(world.now),
        },
        PRACTICE_AUTHORISATION_COLUMNS,
      ),
    updateAuthorisationRequest: async (
      attorneyId,
      id,
      expectedStatus,
      expected,
      next,
    ) =>
      guardedUpdate(
        world,
        "practice_area_authorisations",
        (r) =>
          r.id === id &&
          r.attorney_id === attorneyId &&
          r.status === expectedStatus &&
          r.updated_at === expected &&
          r.decided_at === null,
        next.status === "withdrawn"
          ? { status: "withdrawn" }
          : { status: "requested", requested_at: next.requestedAt },
        PRACTICE_AUTHORISATION_COLUMNS,
      ),
    submitApplication: async (attorneyId, userId) =>
      guardedUpdate(
        world,
        "attorney_profiles",
        (p) =>
          p.id === attorneyId &&
          p.user_id === userId &&
          p.profile_state === "applicant",
        { profile_state: "under_review" },
        PROFILE_COLUMNS,
      ),
    insertAuditEvent: async (event) => auditInsert(world, event),
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

// The privileged staff verification port, applying the real guards.
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
    insertEvidence: async (evidence) =>
      fail(world, "prov.insertEvidence")
        ? UNREADABLE
        : insert(
            world,
            "verification_evidence",
            {
              ...evidence,
              retention_class: null,
              created_at: stamp(world.tick()),
            },
            EVIDENCE_COLUMNS,
          ),
    linkEvidence: async (evidenceId, kind, recordId) =>
      fail(world, "prov.linkEvidence")
        ? UNREADABLE
        : insert(
            world,
            "verification_evidence_subjects",
            {
              id: world.nextId(),
              verification_evidence_id: evidenceId,
              license_id: null,
              insurance_record_id: null,
              discipline_record_id: null,
              practice_area_authorisation_id: null,
              [SUBJECT_COLUMN[kind]]: recordId,
              created_at: stamp(world.now),
            },
            EVIDENCE_SUBJECT_COLUMNS,
          ),
    recordLicenseObservation: async (attorneyId, id, expected, status) =>
      guardedUpdate(
        world,
        "licenses",
        (l) =>
          l.id === id &&
          l.attorney_id === attorneyId &&
          l.updated_at === expected,
        { reported_status: status },
        LICENSE_COLUMNS,
      ),
    insertDiscipline: async (attorneyId, id, record) =>
      insert(
        world,
        "discipline_records",
        {
          id,
          attorney_id: attorneyId,
          ...record,
          created_at: stamp(world.now),
          updated_at: stamp(world.now),
        },
        DISCIPLINE_COLUMNS,
      ),
    updateDisciplineStatus: async (
      attorneyId,
      id,
      expected,
      status,
      resolvedAt,
    ) =>
      guardedUpdate(
        world,
        "discipline_records",
        (r) =>
          r.id === id &&
          r.attorney_id === attorneyId &&
          r.updated_at === expected,
        resolvedAt === null ? { status } : { status, resolved_at: resolvedAt },
        DISCIPLINE_COLUMNS,
      ),
    decideAuthorisation: async (attorneyId, id, expected, decision) =>
      guardedUpdate(
        world,
        "practice_area_authorisations",
        (r) =>
          r.id === id &&
          r.attorney_id === attorneyId &&
          r.status === "requested" &&
          r.updated_at === expected,
        decision,
        PRACTICE_AUTHORISATION_COLUMNS,
      ),
    transitionProfile: async (attorneyId, transition) =>
      guardedUpdate(
        world,
        "attorney_profiles",
        (p) => p.id === attorneyId && p.profile_state === transition.from,
        { profile_state: transition.to },
        PROFILE_COLUMNS,
      ),
    insertEvaluation: async (row) =>
      fail(world, "prov.insertEvaluation")
        ? UNREADABLE
        : insert(
            world,
            "eligibility_evaluations",
            {
              ...JSON.parse(JSON.stringify(row)),
              created_at: stamp(world.now),
            },
            EVALUATION_COLUMNS,
          ),
    insertAuditEvent: async (event) => auditInsert(world, event),
    evaluationById: async (id) =>
      rows(
        world.eligibility_evaluations
          .filter((e) => e.id === id)
          .map((e) => pick(e, EVALUATION_COLUMNS)),
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

// The latest attempt row for an action and the outcome row that references
// it (undefined when absent), under the write-ahead audit protocol.
export function auditPair(world, action) {
  const attempt = [...world.audit_events]
    .reverse()
    .find(
      (event) =>
        event.action_code === action &&
        event.after_snapshot?.audit_phase === "attempt",
    );
  const outcome =
    attempt === undefined
      ? undefined
      : world.audit_events.find(
          (event) =>
            event.action_code === "audited_change_outcome" &&
            event.after_snapshot?.attempt_event_id === attempt.id,
        );
  return { attempt, outcome };
}
