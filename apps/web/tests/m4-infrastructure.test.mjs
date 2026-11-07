// P3-003 infrastructure and source contract tests (fixture-only).
//
// The two narrow P3-003 privileged read ports and the request-scoped read
// and write adapters (P3-904) run against recording stand-ins for the
// installed client: every query chain and write function call they build is
// captured and compared exactly, and nothing is sent anywhere.
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
import {
  createAttorneyProfessionalProvisioning,
  createStaffVerificationProvisioning,
} from "../src/infrastructure/identity/registration-provisioning.ts";
import {
  ATTORNEY_PROFESSIONAL_SOURCES,
  createAttorneyProfessionalReads,
  createAttorneyProfessionalWrites,
  createBoundedProfessionalProvisioning,
} from "../src/infrastructure/professional/attorney-professional-adapter.ts";
import {
  createRequestAccountSource,
  writeAnswerOf,
} from "../src/infrastructure/professional/professional-request-client.ts";
import {
  createStaffReads,
  createStaffWrites,
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

test("M4-I1. both P3-003 privileged ports are built only for a verified project binding, as one cookie-free client each, and offer reads only", async () => {
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
    "profileHistoryOf",
  ]);
  // The privileged module itself no longer contains any write builder.
  const privileged = codeOf(
    read("src/infrastructure/identity/registration-provisioning.ts"),
  );
  const professional = privileged.slice(
    privileged.indexOf(
      "export async function createAttorneyProfessionalProvisioning",
    ),
    privileged.indexOf("type QuotaDigests"),
  );
  assert.doesNotMatch(professional, /\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(professional, /\brpc\b/);
  assert.ok(professional.includes("createAttorneyApplicantProvisioning"));
  // The unconfigured deployed wiring builds nothing privileged, and no
  // request client exists to write through.
  assert.equal(await ATTORNEY_PROFESSIONAL_SOURCES.provisioning(), null);
  assert.equal(await STAFF_VERIFICATION_SOURCES.provisioning(), null);
  assert.equal(await ATTORNEY_PROFESSIONAL_SOURCES.writes(), null);
  assert.equal(await STAFF_VERIFICATION_SOURCES.writes(), null);
});

test("M4-I2. the attorney write port calls exactly one fixed write function per change through the request's own client, with only named arguments and no actor, User, or profile", async () => {
  const { client, log } = recordingClient(() => ({
    data: "applied",
    error: null,
    status: 200,
  }));
  const writes = await createAttorneyProfessionalWrites(
    async () => client,
    50,
  )();
  assert.ok(Object.isFrozen(writes));
  assert.deepEqual(Object.keys(writes), [
    "saveProfileDetails",
    "saveLicense",
    "saveInsurance",
    "requestPracticeArea",
    "changePracticeAreaRequest",
    "submitApplication",
  ]);
  const claim = {
    jurisdiction_id: ID(5),
    license_number: "SYN-1",
    license_type: null,
    effective_from: null,
    effective_until: null,
  };
  const insurance = {
    jurisdiction_id: ID(5),
    carrier_name: "Synthetic",
    policy_reference: null,
    coverage_type: null,
    per_occurrence_limit_minor: 100,
    aggregate_limit_minor: null,
    currency_code: "XTS",
    coverage_from: null,
    coverage_until: null,
  };
  const applied = { kind: "outcome", outcome: "applied" };
  assert.deepEqual(
    await writes.saveProfileDetails("approved", {
      display_name: "S",
      headline: null,
      bio: null,
      years_experience: 1,
    }),
    applied,
  );
  await writes.saveLicense(ID(7), null, claim);
  await writes.saveLicense(ID(7), "2026-11-04T12:00:00.000000+00:00", claim);
  await writes.saveInsurance(ID(8), null, insurance);
  await writes.requestPracticeArea(ID(9), ID(5), ID(6));
  await writes.changePracticeAreaRequest(
    ID(9),
    "withdraw",
    "2026-11-04T12:00:00.000000+00:00",
  );
  await writes.submitApplication();
  assert.deepEqual(log, [
    [
      [
        "rpc",
        "attorney_save_profile_details",
        {
          p_expected_state: "approved",
          p_display_name: "S",
          p_headline: null,
          p_bio: null,
          p_years_experience: 1,
        },
      ],
    ],
    [
      [
        "rpc",
        "attorney_save_license_claim",
        {
          p_license_id: ID(7),
          p_expected_updated_at: null,
          p_jurisdiction_id: ID(5),
          p_license_number: "SYN-1",
          p_license_type: null,
          p_effective_from: null,
          p_effective_until: null,
        },
      ],
    ],
    [
      [
        "rpc",
        "attorney_save_license_claim",
        {
          p_license_id: ID(7),
          p_expected_updated_at: "2026-11-04T12:00:00.000000+00:00",
          p_jurisdiction_id: ID(5),
          p_license_number: "SYN-1",
          p_license_type: null,
          p_effective_from: null,
          p_effective_until: null,
        },
      ],
    ],
    [
      [
        "rpc",
        "attorney_save_insurance_claim",
        {
          p_record_id: ID(8),
          p_expected_updated_at: null,
          p_jurisdiction_id: ID(5),
          p_carrier_name: "Synthetic",
          p_policy_reference: null,
          p_coverage_type: null,
          p_per_occurrence_limit_minor: 100,
          p_aggregate_limit_minor: null,
          p_currency_code: "XTS",
          p_coverage_from: null,
          p_coverage_until: null,
        },
      ],
    ],
    [
      [
        "rpc",
        "attorney_request_practice_area",
        {
          p_authorisation_id: ID(9),
          p_jurisdiction_id: ID(5),
          p_practice_area_id: ID(6),
        },
      ],
    ],
    [
      [
        "rpc",
        "attorney_change_practice_area_request",
        {
          p_authorisation_id: ID(9),
          p_intent: "withdraw",
          p_expected_updated_at: "2026-11-04T12:00:00.000000+00:00",
        },
      ],
    ],
    [["rpc", "attorney_submit_application", {}]],
  ]);
  // No request client: no port. A slow or throwing client: unreadable.
  assert.equal(
    await createAttorneyProfessionalWrites(async () => null, 50)(),
    null,
  );
  const slow = await createAttorneyProfessionalWrites(
    async () => ({
      rpc: () => new Promise(() => {}),
    }),
    25,
  )();
  assert.deepEqual(await slow.submitApplication(), { kind: "unreadable" });
});

test("M4-I3. the staff write port calls exactly one fixed write function per change with only named arguments and no reviewer, User, grant, or scope; a malformed evaluation row is refused before sending; answers are read strictly", async () => {
  const { client, log } = recordingClient(() => ({
    data: "applied",
    error: null,
    status: 200,
  }));
  const writes = await createStaffWrites(async () => client, 50)();
  assert.deepEqual(Object.keys(writes), [
    "recordFinding",
    "recordSourceUnavailable",
    "recordDisciplineFinding",
    "decidePracticeArea",
    "changeProfileStage",
    "recordEvaluation",
  ]);
  const evidence = {
    source_type: "synthetic register",
    source_uri: null,
    source_reference: "synthetic entry",
    retrieved_at: "2026-11-04T11:00:00.000Z",
    evidence_summary: "synthetic",
    evidence_digest: null,
    verification_method: "synthetic lookup",
    discrepancy_flag: false,
  };
  const evidenceArgs = {
    p_source_type: "synthetic register",
    p_source_uri: null,
    p_source_reference: "synthetic entry",
    p_retrieved_at: "2026-11-04T11:00:00.000Z",
    p_verification_method: "synthetic lookup",
    p_evidence_summary: "synthetic",
    p_evidence_digest: null,
    p_discrepancy_flag: false,
  };
  await writes.recordFinding({
    evidenceId: ID(10),
    subjectKind: "license",
    subjectId: ID(7),
    expectedUpdatedAt: "u",
    evidence,
    observedStatus: "synthetic-active",
    disciplineStatus: null,
    resolvedAt: null,
  });
  await writes.recordSourceUnavailable("insurance", ID(8), "synthetic");
  await writes.recordDisciplineFinding({
    disciplineId: ID(11),
    evidenceId: ID(12),
    attorneyId: ID(3),
    record: {
      jurisdiction_id: ID(5),
      external_reference: null,
      finding_type: null,
      opened_at: null,
      resolved_at: null,
      status: "synthetic",
    },
    evidence,
  });
  await writes.decidePracticeArea(
    ID(9),
    "u",
    { status: "authorised", effective_from: "f", effective_until: null },
    "basis",
  );
  await writes.changeProfileStage(ID(3), "request_information", "m", null);
  const row = {
    id: ID(13),
    attorney_id: ID(3),
    jurisdiction_id: ID(5),
    context_type: "jurisdiction",
    context_id: null,
    evaluated_at: "2026-11-04T12:00:00.000Z",
    as_of: "2026-11-04T12:00:00.000Z",
    result: "undetermined",
    factor_results: [],
    policy_references: [],
    evidence_references: { evidence_ids: [] },
  };
  await writes.recordEvaluation(row);
  assert.deepEqual(log, [
    [
      [
        "rpc",
        "staff_record_verification_finding",
        {
          p_evidence_id: ID(10),
          p_subject_kind: "license",
          p_subject_id: ID(7),
          p_expected_updated_at: "u",
          ...evidenceArgs,
          p_observed_status: "synthetic-active",
          p_discipline_status: null,
          p_resolved_at: null,
        },
      ],
    ],
    [
      [
        "rpc",
        "staff_record_source_unavailable",
        {
          p_subject_kind: "insurance",
          p_subject_id: ID(8),
          p_note: "synthetic",
        },
      ],
    ],
    [
      [
        "rpc",
        "staff_record_discipline_finding",
        {
          p_discipline_id: ID(11),
          p_evidence_id: ID(12),
          p_attorney_id: ID(3),
          p_jurisdiction_id: ID(5),
          p_external_reference: null,
          p_finding_type: null,
          p_opened_at: null,
          p_resolved_at: null,
          p_status: "synthetic",
          ...evidenceArgs,
        },
      ],
    ],
    [
      [
        "rpc",
        "staff_decide_practice_area",
        {
          p_authorisation_id: ID(9),
          p_expected_updated_at: "u",
          p_decision: "authorised",
          p_effective_from: "f",
          p_effective_until: null,
          p_note: "basis",
        },
      ],
    ],
    [
      [
        "rpc",
        "staff_change_profile_stage",
        {
          p_attorney_id: ID(3),
          p_intent: "request_information",
          p_message: "m",
          p_note: null,
        },
      ],
    ],
    [
      [
        "rpc",
        "staff_record_eligibility_evaluation",
        {
          p_evaluation_id: ID(13),
          p_attorney_id: ID(3),
          p_jurisdiction_id: ID(5),
          p_context_type: "jurisdiction",
          p_context_id: null,
          p_as_of: "2026-11-04T12:00:00.000Z",
          p_result: "undetermined",
          p_factor_results: [],
          p_policy_references: [],
          p_evidence_references: { evidence_ids: [] },
        },
      ],
    ],
  ]);
  log.length = 0;
  for (const malformed of [
    { ...row, extra: 1 },
    { id: ID(13), attorney_id: ID(3), result: "eligible" },
  ]) {
    assert.deepEqual(await writes.recordEvaluation(malformed), {
      kind: "rejected",
    });
  }
  assert.deepEqual(log, []);
  // The privileged staff read port still refuses other policy types.
  const port = await createStaffVerificationProvisioning(
    ENVIRONMENT,
    factoryOf(client).create,
  );
  assert.deepEqual(
    await port.policyVersionsFor("synthetic_fee_policy", ID(5)),
    { kind: "unreadable" },
  );
  assert.deepEqual(log, []);
  // Answers: only a fixed outcome counts; a database error code with an HTTP
  // error status means the call rolled back; anything else is unknown.
  const cases = [
    [
      { data: "applied", error: null, status: 200 },
      { kind: "outcome", outcome: "applied" },
    ],
    [
      { data: "conflict", error: null, status: 200 },
      { kind: "outcome", outcome: "conflict" },
    ],
    [{ data: "approved", error: null, status: 200 }, { kind: "unreadable" }],
    [{ data: ["applied"], error: null, status: 200 }, { kind: "unreadable" }],
    [
      { data: null, error: { code: "42501" }, status: 403 },
      { kind: "rejected" },
    ],
    [
      { data: null, error: { code: "40P01" }, status: 500 },
      { kind: "rejected" },
    ],
    [
      { data: null, error: { code: "08006" }, status: 503 },
      { kind: "unreadable" },
    ],
    [
      { data: null, error: { code: "57P01" }, status: 503 },
      { kind: "unreadable" },
    ],
    [
      { data: null, error: { code: "PGRST202" }, status: 404 },
      { kind: "unreadable" },
    ],
    [
      { data: null, error: { code: "EPIPE" }, status: 0 },
      { kind: "unreadable" },
    ],
    [{ data: null, error: { code: "" }, status: 504 }, { kind: "unreadable" }],
    [{ data: null, error: { message: "x" } }, { kind: "unreadable" }],
    [null, { kind: "unreadable" }],
  ];
  for (const [answer, expected] of cases) {
    assert.deepEqual(writeAnswerOf(answer), expected, JSON.stringify(answer));
  }
  void [
    DISCIPLINE_COLUMNS,
    EVALUATION_COLUMNS,
    EVIDENCE_COLUMNS,
    EVIDENCE_SUBJECT_COLUMNS,
    INSURANCE_COLUMNS,
    JURISDICTION_COLUMNS,
    LICENSE_COLUMNS,
    PRACTICE_AUTHORISATION_COLUMNS,
    PROFILE_COLUMNS,
    POLICY_VERSION_COLUMNS,
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
