// P3-003 infrastructure and source contract tests (fixture-only).
//
// The two narrow P3-003 privileged ports and the request-scoped adapters run
// against recording stand-ins for the installed client: every query chain
// they build is captured and compared exactly, and nothing is sent anywhere.
// Synthetic project values only; no provider, network, credential, or
// database is contacted.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  DISCIPLINE_COLUMNS,
  EVALUATION_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  JURISDICTION_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
} from "../src/application/professional-records.ts";
import { POLICY_VERSION_COLUMNS } from "../src/application/policy-selection.ts";
import { auditEventOf } from "../src/application/professional-audit.ts";
import {
  createAttorneyProfessionalProvisioning,
  createStaffVerificationProvisioning,
} from "../src/infrastructure/identity/registration-provisioning.ts";
import {
  ATTORNEY_PROFESSIONAL_SOURCES,
  createAttorneyProfessionalReads,
  createBoundedProfessionalProvisioning,
} from "../src/infrastructure/professional/attorney-professional-adapter.ts";
import { createRequestAccountSource } from "../src/infrastructure/professional/professional-request-client.ts";
import {
  createStaffReads,
  STAFF_VERIFICATION_SOURCES,
} from "../src/infrastructure/staff/staff-verification-adapter.ts";

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
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT_REF = "syntheticprojectrefa";
const ENVIRONMENT = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic7f3a",
  ROSUNO_SUPABASE_ADMIN_KEY: "sb_secret_synthetic7f3a",
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: PROJECT_REF,
});

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
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: ID(1),
            email_confirmed_at: "2026-10-01T00:00:00Z",
            email: "x@synthetic.invalid",
          },
        },
        error: null,
      }),
    },
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

function factoryOf(client) {
  const made = [];
  return {
    made,
    create: (...args) => {
      made.push(args);
      return client;
    },
  };
}

test("M4-I1. both P3-003 privileged ports are built only for a verified project binding, as one cookie-free client each, with exact operation lists", async () => {
  for (const factory of [
    createAttorneyProfessionalProvisioning,
    createStaffVerificationProvisioning,
  ]) {
    for (const broken of [
      { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined },
      { ROSUNO_SUPABASE_ADMIN_KEY: "sb_publishable_synthetic7f3a" },
      { NEXT_PUBLIC_SUPABASE_URL: "https://elsewhere.invalid" },
    ]) {
      const recorder = factoryOf(recordingClient().client);
      assert.equal(
        await factory({ ...ENVIRONMENT, ...broken }, recorder.create),
        null,
      );
      assert.deepEqual(recorder.made, []);
    }
    assert.equal(await factory(), null);
    const recorder = factoryOf(recordingClient().client);
    assert.ok(Object.isFrozen(await factory(ENVIRONMENT, recorder.create)));
    assert.deepEqual(recorder.made, [
      [
        ENVIRONMENT.NEXT_PUBLIC_SUPABASE_URL,
        ENVIRONMENT.ROSUNO_SUPABASE_ADMIN_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        },
      ],
    ]);
  }
  const attorney = await createAttorneyProfessionalProvisioning(
    ENVIRONMENT,
    factoryOf(recordingClient().client).create,
  );
  assert.deepEqual(Object.keys(attorney), [
    "jurisdictions",
    "evidenceSubjectsOf",
    "evidenceFlagsOf",
    "evaluationsOf",
    "informationRequestsOf",
    "updateProfileDetails",
    "insertLicense",
    "updateLicense",
    "insertInsurance",
    "updateInsurance",
    "insertAuthorisationRequest",
    "updateAuthorisationRequest",
    "submitApplication",
    "insertAuditEvent",
  ]);
  const staff = await createStaffVerificationProvisioning(
    ENVIRONMENT,
    factoryOf(recordingClient().client).create,
  );
  assert.deepEqual(Object.keys(staff), [
    "jurisdictions",
    "attorneyProfileOf",
    "accountStateOf",
    "licensesIn",
    "insuranceIn",
    "disciplineIn",
    "authorisationsIn",
    "evidenceSubjectsOf",
    "evidenceOf",
    "policyVersionsFor",
    "authorityReferencesFor",
    "insertEvidence",
    "linkEvidence",
    "recordLicenseObservation",
    "insertDiscipline",
    "updateDisciplineStatus",
    "decideAuthorisation",
    "transitionProfile",
    "insertEvaluation",
    "insertAuditEvent",
    "profileHistoryOf",
  ]);
  // The unconfigured deployed wiring builds nothing privileged.
  assert.equal(await ATTORNEY_PROFESSIONAL_SOURCES.provisioning(), null);
  assert.equal(await STAFF_VERIFICATION_SOURCES.provisioning(), null);
});

test("M4-I2. the attorney port writes only keyed, guarded claims and never a lifecycle, observed status, or decision chosen elsewhere", async () => {
  const { client, log } = recordingClient(() => ({ data: [{}], error: null }));
  const port = await createAttorneyProfessionalProvisioning(
    ENVIRONMENT,
    factoryOf(client).create,
  );
  const claim = {
    jurisdiction_id: ID(5),
    license_number: "SYN-1",
    license_type: null,
    effective_from: null,
    effective_until: null,
  };
  await port.updateLicense(
    ID(3),
    ID(7),
    "2026-11-04T12:00:00.000000+00:00",
    claim,
  );
  await port.insertLicense(ID(3), claim);
  await port.submitApplication(ID(3), ID(2));
  await port.updateAuthorisationRequest(
    ID(3),
    ID(8),
    "requested",
    "2026-11-04T12:00:00.000000+00:00",
    { status: "withdrawn" },
  );
  await port.updateProfileDetails(ID(3), ID(2), {
    display_name: "S",
    headline: null,
    bio: null,
    years_experience: 1,
  });
  assert.deepEqual(log, [
    [
      ["from", "licenses"],
      ["update", claim],
      ["eq", "id", ID(7)],
      ["eq", "attorney_id", ID(3)],
      ["eq", "updated_at", "2026-11-04T12:00:00.000000+00:00"],
      ["is", "reported_status", null],
      ["select", LICENSE_COLUMNS],
    ],
    [
      ["from", "licenses"],
      ["insert", { attorney_id: ID(3), ...claim }],
      ["select", LICENSE_COLUMNS],
    ],
    [
      ["from", "attorney_profiles"],
      ["update", { profile_state: "under_review" }],
      ["eq", "id", ID(3)],
      ["eq", "user_id", ID(2)],
      ["eq", "profile_state", "applicant"],
      ["select", PROFILE_COLUMNS],
    ],
    [
      ["from", "practice_area_authorisations"],
      ["update", { status: "withdrawn" }],
      ["eq", "id", ID(8)],
      ["eq", "attorney_id", ID(3)],
      ["eq", "status", "requested"],
      ["eq", "updated_at", "2026-11-04T12:00:00.000000+00:00"],
      ["is", "decided_at", null],
      ["select", PRACTICE_AUTHORISATION_COLUMNS],
    ],
    [
      ["from", "attorney_profiles"],
      [
        "update",
        { display_name: "S", headline: null, bio: null, years_experience: 1 },
      ],
      ["eq", "id", ID(3)],
      ["eq", "user_id", ID(2)],
      ["eq", "profile_state", "applicant"],
      ["select", PROFILE_COLUMNS],
    ],
  ]);
  log.length = 0;
  // Id lists must be canonical, bounded, and non-empty; audit rows must be
  // the attorney's own exact shape. Anything else sends nothing.
  for (const call of [
    () => port.evidenceSubjectsOf("license", ["not-an-id"]),
    () => port.evidenceSubjectsOf("license", []),
    () =>
      port.evidenceFlagsOf(Array.from({ length: 501 }, (_v, i) => ID(i + 1))),
    () =>
      port.insertAuditEvent(
        auditEventOf({
          actorUserId: ID(2),
          actorType: "staff",
          action: "attorney_claim_recorded",
          resourceType: "license",
          resourceId: ID(7),
          occurredAtMs: 0,
        }),
      ),
    () =>
      port.insertAuditEvent({
        ...auditEventOf({
          actorUserId: ID(2),
          actorType: "attorney",
          action: "attorney_claim_recorded",
          resourceType: "license",
          resourceId: ID(7),
          occurredAtMs: 0,
        }),
        extra: 1,
      }),
  ]) {
    assert.deepEqual(await call(), { kind: "unreadable" });
  }
  assert.deepEqual(log, []);
  await port.evidenceSubjectsOf("insurance", [ID(9), ID(9)]);
  assert.deepEqual(log[0], [
    ["from", "verification_evidence_subjects"],
    ["select", "verification_evidence_id, insurance_record_id"],
    ["in", "insurance_record_id", [ID(9)]],
    ["limit", 500],
  ]);
  const errored = await createAttorneyProfessionalProvisioning(
    ENVIRONMENT,
    factoryOf(
      recordingClient(() => ({ data: null, error: { message: "synthetic" } }))
        .client,
    ).create,
  );
  assert.deepEqual(await errored.jurisdictions(), { kind: "unreadable" });
});

test("M4-I3. the staff port refuses unsupported transitions, other policy types, malformed evaluations, and non-staff audit rows before sending anything", async () => {
  const { client, log } = recordingClient(() => ({ data: [{}], error: null }));
  const port = await createStaffVerificationProvisioning(
    ENVIRONMENT,
    factoryOf(client).create,
  );
  for (const [from, to] of [
    ["applicant", "approved"],
    ["suspended", "approved"],
    ["approved", "removed"],
    ["under_review", "removed"],
  ]) {
    assert.deepEqual(
      await port.transitionProfile(ID(3), { from, to }),
      { kind: "unreadable" },
      `${from}>${to}`,
    );
  }
  assert.deepEqual(
    await port.policyVersionsFor("synthetic_fee_policy", ID(5)),
    { kind: "unreadable" },
  );
  assert.deepEqual(
    await port.insertEvaluation({ attorney_id: ID(3), result: "eligible" }),
    { kind: "unreadable" },
  );
  assert.deepEqual(
    await port.insertAuditEvent(
      auditEventOf({
        actorUserId: ID(2),
        actorType: "attorney",
        action: "attorney_profile_state_changed",
        resourceType: "attorney_profile",
        resourceId: ID(3),
        occurredAtMs: 0,
      }),
    ),
    { kind: "unreadable" },
  );
  assert.deepEqual(log, []);
  await port.transitionProfile(ID(3), { from: "under_review", to: "approved" });
  await port.decideAuthorisation(ID(3), ID(8), "u", {
    status: "authorised",
    decided_at: "d",
    effective_from: "f",
    effective_until: null,
  });
  await port.updateDisciplineStatus(ID(3), ID(9), "u", "synthetic", null);
  await port.recordLicenseObservation(ID(3), ID(7), "u", "synthetic-active");
  await port.policyVersionsFor("attorney_eligibility", ID(5));
  await port.linkEvidence(ID(10), "discipline", ID(9));
  assert.deepEqual(log, [
    [
      ["from", "attorney_profiles"],
      ["update", { profile_state: "approved" }],
      ["eq", "id", ID(3)],
      ["eq", "profile_state", "under_review"],
      ["select", PROFILE_COLUMNS],
    ],
    [
      ["from", "practice_area_authorisations"],
      [
        "update",
        {
          status: "authorised",
          decided_at: "d",
          effective_from: "f",
          effective_until: null,
        },
      ],
      ["eq", "id", ID(8)],
      ["eq", "attorney_id", ID(3)],
      ["eq", "status", "requested"],
      ["eq", "updated_at", "u"],
      ["select", PRACTICE_AUTHORISATION_COLUMNS],
    ],
    [
      ["from", "discipline_records"],
      ["update", { status: "synthetic" }],
      ["eq", "id", ID(9)],
      ["eq", "attorney_id", ID(3)],
      ["eq", "updated_at", "u"],
      ["select", DISCIPLINE_COLUMNS],
    ],
    [
      ["from", "licenses"],
      ["update", { reported_status: "synthetic-active" }],
      ["eq", "id", ID(7)],
      ["eq", "attorney_id", ID(3)],
      ["eq", "updated_at", "u"],
      ["select", LICENSE_COLUMNS],
    ],
    [
      ["from", "policy_versions"],
      ["select", POLICY_VERSION_COLUMNS],
      ["eq", "policy_type_code", "attorney_eligibility"],
      ["eq", "jurisdiction_id", ID(5)],
      ["limit", 50],
    ],
    [
      ["from", "verification_evidence_subjects"],
      [
        "insert",
        { verification_evidence_id: ID(10), discipline_record_id: ID(9) },
      ],
      ["select", EVIDENCE_SUBJECT_COLUMNS],
    ],
  ]);
  void [
    EVALUATION_COLUMNS,
    EVIDENCE_COLUMNS,
    INSURANCE_COLUMNS,
    JURISDICTION_COLUMNS,
  ];
});

test("M4-I4. the staff adapter asks the scope predicate through the request's own session, with exact arguments, and counts only a boolean answer", async () => {
  const answers = [];
  const { client, log } = recordingClient(
    (chain) => answers.shift() ?? { data: [], error: null },
  );
  const reads = await createStaffReads(async () => client, 50)();
  answers.push({ data: true, error: null });
  assert.deepEqual(await reads.holdsVerificationScope(ID(5)), {
    kind: "answer",
    granted: true,
  });
  answers.push({ data: false, error: null });
  assert.deepEqual(await reads.holdsVerificationScope(null), {
    kind: "answer",
    granted: false,
  });
  answers.push({ data: "true", error: null });
  assert.deepEqual(await reads.holdsVerificationScope(ID(5)), {
    kind: "unreadable",
  });
  answers.push({ data: true, error: { message: "synthetic" } });
  assert.deepEqual(await reads.holdsVerificationScope(ID(5)), {
    kind: "unreadable",
  });
  assert.deepEqual(await reads.holdsVerificationScope("not-an-id"), {
    kind: "unreadable",
  });
  assert.deepEqual(
    log.slice(0, 4).map((chain) => chain[0]),
    [
      [
        "rpc",
        "has_manage_attorney_verification_scope",
        { required_jurisdiction: ID(5), allow_any_jurisdiction: false },
      ],
      [
        "rpc",
        "has_manage_attorney_verification_scope",
        { required_jurisdiction: null, allow_any_jurisdiction: false },
      ],
      [
        "rpc",
        "has_manage_attorney_verification_scope",
        { required_jurisdiction: ID(5), allow_any_jurisdiction: false },
      ],
      [
        "rpc",
        "has_manage_attorney_verification_scope",
        { required_jurisdiction: ID(5), allow_any_jurisdiction: false },
      ],
    ],
  );
  assert.equal(log.length, 4);
  // A slow call answers unreadable at the deadline; a missing client is null.
  const slow = await createStaffReads(
    async () => ({ ...client, rpc: () => new Promise(() => {}) }),
    20,
  )();
  assert.deepEqual(await slow.holdsVerificationScope(ID(5)), {
    kind: "unreadable",
  });
  assert.equal(await createStaffReads(async () => null, 20)(), null);
  assert.equal(
    await createAttorneyProfessionalReads(async () => null, 20)(),
    null,
  );
  // Attorney reads are keyed by the given ids only.
  const attorneyClient = recordingClient();
  const attorneyReads = await createAttorneyProfessionalReads(
    async () => attorneyClient.client,
    50,
  )();
  await attorneyReads.licensesOf(ID(3));
  assert.deepEqual(attorneyClient.log[0], [
    ["from", "licenses"],
    ["select", LICENSE_COLUMNS],
    ["eq", "attorney_id", ID(3)],
    ["order", "created_at"],
    ["limit", 200],
  ]);
  // The bounded privileged source times out and never throws.
  const never = createBoundedProfessionalProvisioning(
    () => new Promise(() => {}),
    20,
  );
  assert.equal(await never(), null);
  const account = createRequestAccountSource(async () => client, 50);
  assert.deepEqual(await account.currentAccount(), {
    kind: "user",
    id: ID(1),
    emailConfirmedAt: "2026-10-01T00:00:00Z",
  });
  assert.deepEqual(
    await createRequestAccountSource(async () => null, 50).currentAccount(),
    { kind: "unreadable" },
  );
});

// ---------------------------------------------------------------------------
// Source contracts.
// ---------------------------------------------------------------------------

const P3003_APP = [
  "app/attorney/professional/actions.ts",
  "app/attorney/professional/forms.tsx",
  "app/attorney/professional/page.tsx",
  "app/staff/verification/[attorney]/page.tsx",
  "app/staff/verification/actions.ts",
  "app/staff/verification/forms.tsx",
  "app/staff/verification/page.tsx",
];
const P3003_APPLICATION = [
  "src/application/attorney-professional.ts",
  "src/application/eligibility-assessment.ts",
  "src/application/policy-selection.ts",
  "src/application/professional-audit.ts",
  "src/application/professional-identity.ts",
  "src/application/professional-records.ts",
  "src/application/staff-verification.ts",
];
const P3003_INFRASTRUCTURE = [
  "src/infrastructure/professional/attorney-professional-adapter.ts",
  "src/infrastructure/professional/professional-request-client.ts",
  "src/infrastructure/staff/staff-verification-adapter.ts",
];

test("M4-I5. the new routes are exactly these files, server-rendered per request, unindexed, and read no request input of their own", () => {
  assert.deepEqual(
    filesIn("app/attorney/professional/"),
    P3003_APP.slice(0, 3),
  );
  assert.deepEqual(filesIn("app/staff/"), P3003_APP.slice(3));
  for (const file of P3003_APP.filter((f) => f.endsWith("page.tsx"))) {
    const code = codeOf(read(file));
    assert.doesNotMatch(read(file), /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(
      code,
      /searchParams|headers\(|cookies\(|process\.env|\bconsole\b|dangerouslySetInnerHTML|\.from\(|getUser|\.insert\(|\.update\(/,
      file,
    );
  }
  for (const file of [
    "app/attorney/professional/actions.ts",
    "app/staff/verification/actions.ts",
  ]) {
    const source = read(file);
    assert.match(source, /^"use server";\n/, file);
    assert.doesNotMatch(
      codeOf(source),
      /_previous\.|process\.env|\bconsole\b|headers\(|cookies\(|redirect\(/,
      file,
    );
  }
  for (const file of [
    "app/attorney/professional/forms.tsx",
    "app/staff/verification/forms.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /^"use client";\n/, file);
    assert.ok(
      importsOf(source).every(
        (specifier) =>
          !/infrastructure|registration-provisioning/.test(specifier),
      ),
      file,
    );
  }
  // Only the review detail page reads a route segment, and only to name the
  // attorney the application boundary then authorizes.
  assert.match(
    codeOf(read("app/staff/verification/[attorney]/page.tsx")),
    /const \{ attorney \} = await params;\n {2}const view = await resolveStaffReview\(STAFF_VERIFICATION_SOURCES, attorney\);/,
  );
});

test("M4-I6. application modules stay provider-neutral and hard-code no jurisdiction, regulator answer, or fee value; privileged names stay in the one privileged module", () => {
  for (const file of P3003_APPLICATION) {
    const source = read(file);
    const code = codeOf(source);
    for (const specifier of importsOf(source)) {
      assert.match(
        specifier,
        /^\.\/[a-z-]+\.ts$/,
        `${file} imports ${specifier}`,
      );
    }
    assert.doesNotMatch(
      code,
      /\bprocess\b|\bfetch\s*\(|\bconsole\b|Date\.now\(\)|new Date\(\)|Math\.random/,
      file,
    );
  }
  for (const file of [
    ...P3003_APP,
    ...P3003_APPLICATION,
    ...P3003_INFRASTRUCTURE,
    "src/presentation/professional-labels.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /california|arizona|\bCA\b|\bAZ\b|state bar of/i,
      file,
    );
    assert.doesNotMatch(code, /\bfee\b|stripe|payment|price/i, file);
    assert.doesNotMatch(
      code,
      /ROSUNO_SUPABASE|service_role|sb_secret_|createClient\b|adminKey/,
      file,
    );
    assert.doesNotMatch(
      code,
      /\.signUp\(|createUser|inviteUserByEmail|generateLink|signInWithOtp|\.upsert\(|\.delete\(|auth\.admin/,
      file,
    );
  }
  // The P3-003 privileged section offers no generic executor or deletion.
  const provisioning = codeOf(
    read("src/infrastructure/identity/registration-provisioning.ts"),
  );
  const start = provisioning.indexOf("const MAX_IDS = 500;");
  const end = provisioning.indexOf(
    'const ATTORNEY_PROFILE_COLUMNS = "id, user_id, profile_state";',
  );
  const section = provisioning.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(
    section,
    /\.upsert\(|\.delete\(|\brpc\b|auth\.admin|return admin\b|admin[,;)]|process\.env|\.from\((?!")/,
  );
  assert.equal(
    section.match(
      /\bcreate\(binding\.url, binding\.adminKey, clientOptions\(\)\)/g,
    ).length,
    2,
  );
  // Every table it names is an existing M4, policy, identity, or audit table.
  assert.deepEqual(
    [
      ...new Set(
        [...section.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]),
      ),
    ].sort(),
    [
      "attorney_profiles",
      "audit_events",
      "discipline_records",
      "eligibility_evaluations",
      "insurance_records",
      "jurisdictions",
      "licenses",
      "policy_authority_references",
      "policy_versions",
      "practice_area_authorisations",
      "users",
      "verification_evidence",
      "verification_evidence_subjects",
    ],
  );
  // No new migration, schema, or configuration path is part of the app tree.
  assert.ok(filesIn("src/").every((file) => !/\.sql$/.test(file)));
});
