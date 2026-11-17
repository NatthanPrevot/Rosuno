// MVP-001 S3 part 2: the staff jurisdiction assessment review, driven
// through the synthetic configuration world (fixture-only). The read port
// answers exactly as the database's review read functions do for the
// caller's grant; the write port records each call and answers what the test
// configures. Every staff member, Intake, assessment and value is synthetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  REFUSAL_REASONS,
  REVIEW_ASSESSMENT_OUTCOMES,
  resolveJurisdictionReview,
  reviewGroupOf,
  reviewJurisdictionAssessment,
} from "../src/application/staff-configuration.ts";
import {
  AMBIGUITY_LABELS,
  ASSESSMENT_STATUS_LABELS,
  outcomeMessage,
  REVIEW_DECISION_LABELS,
  REVIEW_NOTE,
} from "../src/presentation/staff-configuration-labels.ts";
import {
  addAssessment,
  addJurisdiction,
  addReviewIntake,
  addStaff,
  answer,
  configurationSources,
  createWorld,
  form,
  grant,
  UNREADABLE,
} from "./configuration-fixtures.mjs";

function setup() {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  const global = addStaff(world, 10, { name: "Synthetic Reviewer" });
  grant(world, global.userId, "manage_intake_configuration");
  const scoped = addStaff(world, 11, { name: "Synthetic Scoped Reviewer" });
  grant(world, scoped.userId, "manage_intake_configuration", {
    jurisdiction_id: a,
  });
  const other = addStaff(world, 12, { name: "Synthetic Other Staff" });
  grant(world, other.userId, "manage_policy_configuration");
  // An Intake naming two jurisdictions, one naming one (already reviewed),
  // one naming none, a draft holding an AI-sourced assessment, and a closed
  // Intake.
  const several = addReviewIntake(world);
  const inA = addAssessment(world, several.id, a);
  const inB = addAssessment(world, several.id, b, {
    source_type: "ai_suggestion",
    assessment_basis: "ai_suggestion:confirmed_by_client:intake_revision:1",
  });
  const one = addReviewIntake(world, "active");
  addAssessment(world, one.id, b, {
    review_status: "confirmed",
    reviewed_at: "2026-11-17T11:00:00.000000+00:00",
    reviewed_by_user_id: global.userId,
  });
  const none = addReviewIntake(world);
  const draft = addReviewIntake(world, "draft");
  addAssessment(world, draft.id, a, { source_type: "ai_suggestion" });
  const closed = addReviewIntake(world, "closed");
  addAssessment(world, closed.id, a);
  return { world, a, b, global, scoped, other, several, inA, inB, one, none, draft, closed };
}

const sources = (s, who) => configurationSources(s.world, who.authId);

test("JR-1. a global reviewer sees the Intakes holding unreviewed assessments with every assessment, the candidate count and the ambiguity; never a client or Intake content", async () => {
  const s = setup();
  const view = await resolveJurisdictionReview(sources(s, s.global));
  assert.equal(view.status, "ready");
  assert.equal(view.group, "unreviewed");
  assert.equal(view.global, true);
  assert.deepEqual(
    view.intakes.map((i) => [i.intakeId, i.state, i.candidates, i.ambiguity, i.unreviewed]),
    [[s.several.id, "submitted", 2, "several", 2]],
  );
  const [row] = view.intakes;
  assert.deepEqual(
    row.assessments.map((a) => [a.id, a.jurisdiction, a.source, a.status, a.reviewable, a.reviewedBy]),
    [
      [s.inA.id, "Synthetic SYN_A (SYN_A)", "client_statement", "unreviewed", true, null],
      [s.inB.id, "Synthetic SYN_B (SYN_B)", "ai_suggestion", "unreviewed", true, null],
    ],
  );
  assert.deepEqual(Object.keys(row).sort(), [
    "ambiguity",
    "assessments",
    "candidates",
    "createdAt",
    "intakeId",
    "state",
    "unreviewed",
  ]);
  // The unnamed group: the Intake naming no jurisdiction, with nothing to
  // review.
  const unnamed = await resolveJurisdictionReview(sources(s, s.global), "unnamed");
  assert.deepEqual(
    unnamed.intakes.map((i) => [i.intakeId, i.candidates, i.ambiguity, i.assessments.length]),
    [[s.none.id, 0, "none", 0]],
  );
  assert.equal(reviewGroupOf("anything"), "unreviewed");
  assert.equal(reviewGroupOf(["unnamed"]), "unreviewed");
});

test("JR-2. a scoped reviewer sees only its own jurisdiction's assessments and not the unnamed group; staff without the capability, clients and unreadable answers are refused", async () => {
  const s = setup();
  const scoped = await resolveJurisdictionReview(sources(s, s.scoped));
  assert.equal(scoped.global, false);
  assert.deepEqual(
    scoped.intakes.map((i) => [i.intakeId, i.candidates, i.ambiguity, i.unreviewed]),
    [[s.several.id, 2, "several", 1]],
  );
  assert.deepEqual(
    scoped.intakes[0].assessments.map((a) => a.id),
    [s.inA.id],
  );
  assert.deepEqual(
    await resolveJurisdictionReview(sources(s, s.scoped), "unnamed"),
    { status: "denied" },
  );
  assert.deepEqual(await resolveJurisdictionReview(sources(s, s.other)), {
    status: "denied",
  });
  assert.deepEqual(
    await resolveJurisdictionReview(configurationSources(s.world, null)),
    { status: "sign-in-required" },
  );
  s.world.failures.add("reads.reviewAssessmentsOf");
  assert.deepEqual(await resolveJurisdictionReview(sources(s, s.global)), {
    status: "unavailable",
  });
  const t = setup();
  t.world.failures.add("reads.holdsCapability");
  assert.deepEqual(await resolveJurisdictionReview(sources(t, t.global)), {
    status: "unavailable",
  });
});

test("JR-3. a row the database's rules do not allow is not trusted: the page is unavailable rather than shown", async () => {
  const cases = [
    (reads) => ({
      ...reads,
      reviewIntakes: async () => ({
        kind: "rows",
        rows: [
          {
            intake_id: "00000000-0000-4000-8000-000000000001",
            intake_state: "draft",
            intake_created_at: "2026-11-17T10:00:00.000000+00:00",
            candidate_count: 1,
            unreviewed_count: 1,
          },
        ],
      }),
    }),
    (reads) => ({
      ...reads,
      reviewIntakes: async () => ({
        kind: "rows",
        rows: [
          {
            intake_id: "00000000-0000-4000-8000-000000000001",
            intake_state: "submitted",
            intake_created_at: "2026-11-17T10:00:00.000000+00:00",
            candidate_count: 1,
            unreviewed_count: 0,
          },
        ],
      }),
    }),
    (reads) => ({
      ...reads,
      reviewAssessmentsOf: async () => ({
        kind: "rows",
        rows: [
          {
            assessment_id: "00000000-0000-4000-8000-000000000002",
            jurisdiction_id: "00000000-0000-4000-8000-000000000003",
            jurisdiction_code: "SYN_A",
            jurisdiction_name: "Synthetic A",
            source_type: "staff_choice",
            assessment_basis: "b",
            review_status: "unreviewed",
            created_at: "2026-11-17T10:00:00.000000+00:00",
            reviewed_at: null,
            reviewed_by_user_id: null,
          },
        ],
      }),
    }),
    (reads) => ({
      ...reads,
      reviewAssessmentsOf: async () => ({
        kind: "rows",
        rows: [
          {
            assessment_id: "00000000-0000-4000-8000-000000000002",
            jurisdiction_id: "00000000-0000-4000-8000-000000000003",
            jurisdiction_code: "SYN_A",
            jurisdiction_name: "Synthetic A",
            source_type: "client_statement",
            assessment_basis: "b",
            review_status: "confirmed",
            created_at: "2026-11-17T10:00:00.000000+00:00",
            reviewed_at: null,
            reviewed_by_user_id: null,
          },
        ],
      }),
    }),
  ];
  for (const change of cases) {
    const s = setup();
    const base = configurationSources(s.world, s.global.authId);
    const view = await resolveJurisdictionReview({
      ...base,
      reads: async () => change(await base.reads()),
    });
    assert.deepEqual(view, { status: "unavailable" });
  }
});

test("JR-4. a review sends exactly one call with the assessment and one fixed decision; the database's answer is reported as it is, and nothing is sent without the capability or with another decision", async () => {
  const s = setup();
  const confirmed = await reviewJurisdictionAssessment(
    sources(s, s.global),
    form({ assessment: s.inA.id, decision: "confirmed" }),
  );
  assert.deepEqual(confirmed, { status: "recorded" });
  assert.deepEqual(s.world.writes, [
    { name: "reviewJurisdictionAssessment", args: [s.inA.id, "confirmed"] },
  ]);
  const scoped = await reviewJurisdictionAssessment(
    sources(s, s.scoped),
    form({ assessment: s.inB.id, decision: "not_confirmed" }),
  );
  assert.deepEqual(scoped, { status: "recorded" });
  assert.deepEqual(s.world.writes.at(-1).args, [s.inB.id, "not_confirmed"]);
  for (const [outcome, expected] of [
    ["already_reviewed", { status: "refused", reason: "already_reviewed" }],
    ["not_reviewable", { status: "refused", reason: "not_reviewable" }],
    ["not_found", { status: "refused", reason: "not_found" }],
    ["invalid", { status: "refused", reason: "invalid" }],
    ["denied", { status: "denied" }],
    ["confirmed", { status: "unconfirmed" }],
  ]) {
    const t = setup();
    t.world.answers.set("reviewJurisdictionAssessment", answer(outcome));
    assert.deepEqual(
      await reviewJurisdictionAssessment(
        sources(t, t.global),
        form({ assessment: t.inA.id, decision: "confirmed" }),
      ),
      expected,
      outcome,
    );
  }
  for (const [value, expected] of [
    [{ kind: "rejected" }, { status: "not-saved" }],
    [UNREADABLE, { status: "unconfirmed" }],
  ]) {
    const t = setup();
    t.world.answers.set("reviewJurisdictionAssessment", value);
    assert.deepEqual(
      await reviewJurisdictionAssessment(
        sources(t, t.global),
        form({ assessment: t.inA.id, decision: "confirmed" }),
      ),
      expected,
    );
  }
  // Nothing is sent: another decision (asserting governing law is not one),
  // a malformed id, staff without the capability, or no session.
  const u = setup();
  for (const [who, fields, expected] of [
    [u.global, { assessment: u.inA.id, decision: "governing_law" }, "invalid"],
    [u.global, { assessment: u.inA.id, decision: ["confirmed", "confirmed"] }, "invalid"],
    [u.global, { assessment: "x", decision: "confirmed" }, "unavailable"],
    [u.other, { assessment: u.inA.id, decision: "confirmed" }, "denied"],
  ]) {
    const state = await reviewJurisdictionAssessment(sources(u, who), form(fields));
    assert.equal(state.status, expected, JSON.stringify(fields));
  }
  assert.equal(
    (
      await reviewJurisdictionAssessment(
        configurationSources(u.world, null),
        form({ assessment: u.inA.id, decision: "confirmed" }),
      )
    ).status,
    "sign-in-required",
  );
  assert.deepEqual(u.world.writes, []);
  assert.deepEqual(REVIEW_ASSESSMENT_OUTCOMES, [
    "applied",
    "invalid",
    "denied",
    "not_found",
    "already_reviewed",
    "not_reviewable",
  ]);
  assert.ok(REFUSAL_REASONS.includes("already_reviewed"));
  assert.ok(REFUSAL_REASONS.includes("not_reviewable"));
});

test("JR-5. the review is stepped up (aal2) before anything: its page asks the step-up gate first and its action goes through the gated runner; the database refuses aal1 again", () => {
  const page = readFileSync(
    new URL("../app/staff/jurisdiction-review/page.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    page.includes('  await connection();\n  await requireSteppedUp("staff");\n'),
  );
  const actions = readFileSync(new URL("../app/staff/actions.ts", import.meta.url), "utf8");
  const run = actions.slice(actions.indexOf("async function run("));
  assert.ok(
    run.indexOf('const refusal = await stepUpRefusal("staff");') <
      run.indexOf("const state = await operation(STAFF_CONFIGURATION_SOURCES, formData);"),
  );
  assert.match(
    actions.replace(/\s+/g, " "),
    /export async function reviewJurisdictionAssessmentAction\( _previous: ConfigurationActionState, formData: FormData, \): Promise<ConfigurationActionState> \{ return run\( "reviewJurisdictionAssessment", reviewJurisdictionAssessment, "review", formData, \); \}/,
  );
  // The database's own functions require aal2 through has_staff_capability
  // and lock_current_capability_staff (proved in mvp-001-s3-db-proof).
  const migration = readFileSync(
    new URL(
      "../../../supabase/migrations/20261119060000_mvp_001_s3_jurisdiction_assessment_review.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /lock_current_capability_staff\('manage_intake_configuration', v_jurisdiction\)/);
  assert.equal(
    migration.match(/has_staff_capability\('manage_intake_configuration'/g).length,
    4,
  );
});

test("JR-6. the review wording never asserts governing law and never resolves several jurisdictions to one", () => {
  const texts = [
    REVIEW_NOTE,
    ...Object.values(REVIEW_DECISION_LABELS),
    ...Object.values(AMBIGUITY_LABELS).map((l) => l.label),
    ...Object.values(ASSESSMENT_STATUS_LABELS).map((l) => l.label),
    outcomeMessage({ status: "refused", reason: "already_reviewed" }).body,
    outcomeMessage({ status: "refused", reason: "not_reviewable" }).body,
  ];
  for (const text of texts) {
    assert.doesNotMatch(
      text,
      /(?<!which )law (definitely )?applies|is the governing law|governs this|best match|recommended attorney|perfect attorney|ai-selected|right lawyer/i,
      text,
    );
  }
  assert.match(ASSESSMENT_STATUS_LABELS.confirmed.label, /may be relevant/);
  assert.match(REVIEW_DECISION_LABELS.confirmed, /may be relevant/);
  assert.match(AMBIGUITY_LABELS.several.label, /none is chosen/);
  assert.match(REVIEW_NOTE, /never decides which law applies/);
});
