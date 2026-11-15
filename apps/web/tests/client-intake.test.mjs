// P5-001: client intake use cases, driven through fake ports.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  closeIntake,
  resolveClientWorkspace,
  resolveIntake,
  saveIntakeRevision,
  startIntake,
  submitIntake,
} from "../src/application/client-intake.ts";
import { NOT_SURE } from "../src/application/intake-question-set.ts";

const V1 = JSON.parse(
  readFileSync(
    new URL("./fixtures/intake-questions-v1.canonical.txt", import.meta.url),
    "utf8",
  ),
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(101);
const USER = id(201);
const CLIENT = id(301);
const OTHER_CLIENT = id(302);
const INTAKE = id(401);
const SUBMITTED = id(402);
const FOREIGN = id(403);
const V1_ID = id(501);
const V2_ID = id(502);
const AREA = id(601);
const AREA_OFF = id(602);
const J_A = id(701);
const J_B = id(702);
const T = (minute) =>
  `2026-11-15T10:${String(minute).padStart(2, "0")}:00+00:00`;

const V1_ROW = {
  id: V1_ID,
  version_key: "intake-questions-v1",
  definition: V1,
  published_at: T(0),
};
const V2_ROW = {
  id: V2_ID,
  version_key: "intake-questions-v2",
  definition: {
    ...V1,
    questions: [
      V1.questions[0],
      V1.questions[1],
      { ...V1.questions[2], prompt: "Has a court case started?" },
      {
        ...V1.questions[3],
        choices: V1.questions[3].choices.filter(
          (c) => c.id !== "representation",
        ),
      },
    ],
  },
  published_at: T(30),
};

const rows = (list) => ({ kind: "rows", rows: list });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

function revision(intake, n, fields = {}) {
  return {
    intake_id: intake,
    revision_number: n,
    question_set_id: V1_ID,
    practice_area_id: AREA,
    description: "Synthetic words.",
    structured_answers: {
      jurisdictions: [J_A],
      court_case: "no",
      assistance_type: "representation",
    },
    created_at: T(10 + n),
    ...fields,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const state = {
    subject: ACCOUNT,
    contexts: ["client"],
    confirmed: "2026-11-01T00:00:00Z",
    users: [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }],
    profiles: [{ id: CLIENT, user_id: USER }],
    intakes: [
      {
        id: INTAKE,
        client_id: CLIENT,
        state: "draft",
        created_at: T(5),
        closed_at: null,
      },
      {
        id: SUBMITTED,
        client_id: CLIENT,
        state: "submitted",
        created_at: T(1),
        closed_at: null,
      },
      {
        id: FOREIGN,
        client_id: OTHER_CLIENT,
        state: "draft",
        created_at: T(2),
        closed_at: null,
      },
    ],
    revisions: [revision(INTAKE, 1), revision(SUBMITTED, 1)],
    sets: [V1_ROW],
    areas: [
      { id: AREA, code: "SYN_FAMILY", name: "Synthetic Family", active: true },
    ],
    jurisdictions: [
      { id: J_A, code: "SYN_A", name: "Synthetic State A" },
      { id: J_B, code: "SYN_B", name: "Synthetic State B" },
    ],
    assessments: [
      {
        jurisdiction_id: J_A,
        source_type: "client_statement",
        review_status: "unreviewed",
        created_at: T(20),
      },
    ],
    answers: {
      create: answer("created", id(499)),
      save: answer("saved", 2),
      submit: answer("submitted"),
      close: answer("closed"),
    },
    readsAvailable: true,
    ...overrides,
  };
  const sources = {
    session: { currentSubject: async () => state.subject },
    contexts: {
      contextsOf: async () => {
        if (state.contexts instanceof Error) {
          throw state.contexts;
        }
        return state.contexts;
      },
    },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: state.subject,
        emailConfirmedAt: state.confirmed,
      }),
    },
    reads: async () =>
      state.readsAvailable
        ? {
            usersOf: async (a) =>
              rows(state.users.filter((u) => u.auth_user_id === a)),
            clientProfilesOf: async (u) =>
              rows(state.profiles.filter((p) => p.user_id === u)),
            intakesOf: async (c) =>
              rows(state.intakes.filter((i) => i.client_id === c)),
            intakeOf: async (c, intake) =>
              rows(
                state.intakes.filter(
                  (i) => i.client_id === c && i.id === intake,
                ),
              ),
            revisionSummariesOf: async (ids) =>
              rows(
                state.revisions
                  .filter((r) => ids.includes(r.intake_id))
                  .map((r) => ({
                    intake_id: r.intake_id,
                    revision_number: r.revision_number,
                    created_at: r.created_at,
                  })),
              ),
            latestRevisionOf: async (intake) =>
              rows(
                state.revisions
                  .filter((r) => r.intake_id === intake)
                  .sort((a, b) => b.revision_number - a.revision_number)
                  .slice(0, 1),
              ),
            questionSets: async () => rows(state.sets),
            assessmentsOf: async () => rows(state.assessments),
            practiceAreas: async () => rows(state.areas),
            jurisdictions: async () => rows(state.jurisdictions),
          }
        : null,
    writes: async () => ({
      createIntake: async () => {
        calls.push(["create"]);
        return state.answers.create;
      },
      saveRevision: async (input) => {
        calls.push(["save", input]);
        return state.answers.save;
      },
      submitIntake: async (intake, expected) => {
        calls.push(["submit", intake, expected]);
        return state.answers.submit;
      },
      closeIntake: async (intake) => {
        calls.push(["close", intake]);
        return state.answers.close;
      },
    }),
  };
  return { sources, calls, state };
}

function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}

const SAVE_FIELDS = {
  intake: INTAKE,
  expected_revision: "1",
  version: "governing",
  "q:practice_area": AREA,
  "q:jurisdictions": [J_A],
  "q:court_case": "yes",
  "q:assistance_type": "representation",
  description: "  New synthetic words.  ",
};

test("1. every operation refuses before reading or writing intake data when the Security Shell or identity checks fail", async () => {
  const cases = [
    [{ subject: null }, "sign-in-required"],
    [{ contexts: [] }, "denied"],
    [{ contexts: ["attorney"] }, "denied"],
    [{ contexts: new Error("synthetic") }, "unavailable"],
    [{ confirmed: null }, "denied"],
    [
      {
        users: [
          { id: USER, auth_user_id: ACCOUNT, account_state: "suspended" },
        ],
      },
      "denied",
    ],
    [{ profiles: [] }, "denied"],
    [
      {
        profiles: [
          { id: CLIENT, user_id: USER },
          { id: OTHER_CLIENT, user_id: USER },
        ],
      },
      "unavailable",
    ],
    [{ readsAvailable: false }, "unavailable"],
  ];
  for (const [overrides, expected] of cases) {
    const { sources, calls } = harness(overrides);
    assert.equal((await resolveClientWorkspace(sources)).status, expected);
    assert.equal(
      (await resolveIntake(sources, INTAKE, false)).status,
      expected,
    );
    assert.equal(
      (await saveIntakeRevision(sources, form(SAVE_FIELDS))).status,
      expected,
    );
    assert.equal(
      (
        await submitIntake(
          sources,
          form({ intake: INTAKE, expected_revision: "1" }),
        )
      ).status,
      expected,
    );
    assert.equal(
      (await closeIntake(sources, form({ intake: INTAKE }))).status,
      expected,
    );
    assert.equal((await startIntake(sources)).status, expected);
    assert.deepEqual(calls, [], JSON.stringify(overrides));
  }
});

test("2. the workspace lists only the client's own Intakes, newest first, with the last saved version", async () => {
  const { sources } = harness();
  const view = await resolveClientWorkspace(sources);
  assert.equal(view.status, "ready");
  assert.equal(view.canStart, true);
  assert.deepEqual(
    view.intakes.map((i) => [i.id, i.state, i.revisions]),
    [
      [INTAKE, "draft", 1],
      [SUBMITTED, "submitted", 1],
    ],
  );
  const empty = harness({ sets: [] });
  assert.equal((await resolveClientWorkspace(empty.sources)).canStart, false);
});

test("3. an Intake view shows its governing version's questions and the saved answers; a foreign, missing or malformed id is not found", async () => {
  const { sources } = harness();
  for (const target of [FOREIGN, id(999), "not-a-uuid", null]) {
    assert.equal(
      (await resolveIntake(sources, target, false)).status,
      "not-found",
    );
  }
  const view = await resolveIntake(sources, INTAKE, false);
  assert.equal(view.status, "ready");
  assert.equal(view.editable, true);
  assert.equal(view.version, "governing");
  assert.equal(view.versionKey, "intake-questions-v1");
  assert.equal(view.updateAvailable, false);
  assert.equal(view.latestRevision, 1);
  assert.deepEqual(
    view.questions.map((q) => [q.field, q.kind]),
    [
      ["q:practice_area", "practice_area"],
      ["q:jurisdictions", "jurisdictions"],
      ["q:court_case", "single_choice"],
      ["q:assistance_type", "single_choice"],
    ],
  );
  assert.equal(view.questions[0].value, AREA);
  assert.deepEqual(view.questions[1].values, [J_A]);
  assert.equal(view.practiceArea, "selected");
  assert.deepEqual(view.jurisdiction, {
    kind: "stated",
    names: ["Synthetic State A"],
  });
  assert.equal(view.description.maxCharacters, 4000);
  assert.equal(view.description.value, "Synthetic words.");
});

test("4. when a newer version is published, a draft stays on its own version until the client asks for the current one; carry-over drops answers whose meaning changed", async () => {
  const { sources } = harness({ sets: [V1_ROW, V2_ROW] });
  const governing = await resolveIntake(sources, INTAKE, false);
  assert.equal(governing.updateAvailable, true);
  assert.equal(governing.version, "governing");
  assert.equal(governing.versionKey, "intake-questions-v1");
  const current = await resolveIntake(sources, INTAKE, true);
  assert.equal(current.version, "current");
  assert.equal(current.versionKey, "intake-questions-v2");
  assert.equal(current.questions[2].prompt, "Has a court case started?");
  assert.equal(current.questions[2].value, "no");
  assert.equal(
    current.questions[3].value,
    "",
    "representation no longer exists",
  );
  const submitted = await resolveIntake(sources, SUBMITTED, true);
  assert.equal(submitted.editable, false);
  assert.equal(submitted.updateAvailable, false);
  assert.equal(submitted.versionKey, "intake-questions-v1");
});

test("5. a submitted Intake shows its unreviewed client-statement suggestions; Not sure answers are shown as unresolved", async () => {
  const { sources } = harness({
    revisions: [
      revision(SUBMITTED, 1, {
        practice_area_id: null,
        structured_answers: {
          practice_area: NOT_SURE,
          jurisdictions: NOT_SURE,
          court_case: "not_sure",
          assistance_type: "not_sure",
        },
      }),
    ],
    assessments: [],
  });
  const view = await resolveIntake(sources, SUBMITTED, false);
  assert.equal(view.practiceArea, "not_sure");
  assert.deepEqual(view.jurisdiction, { kind: "not_sure" });
  assert.deepEqual(view.suggestedJurisdictions, []);
  assert.equal(view.questions[0].answerLabel, "Not sure");
  const stated = await resolveIntake(harness().sources, SUBMITTED, false);
  assert.deepEqual(stated.suggestedJurisdictions, ["Synthetic State A"]);
});

test("6. a save sends exactly the parsed content under the governing version; the current version only when asked; a first save uses the current version", async () => {
  const { sources, calls } = harness({ sets: [V1_ROW, V2_ROW] });
  assert.deepEqual(await saveIntakeRevision(sources, form(SAVE_FIELDS)), {
    status: "saved",
    revision: 2,
  });
  assert.deepEqual(calls[0], [
    "save",
    {
      intakeId: INTAKE,
      expectedRevision: 1,
      questionSetId: V1_ID,
      practiceAreaId: AREA,
      description: "New synthetic words.",
      answers: {
        jurisdictions: [J_A],
        court_case: "yes",
        assistance_type: "representation",
      },
    },
  ]);
  await saveIntakeRevision(
    sources,
    form({
      ...SAVE_FIELDS,
      version: "current",
      "q:assistance_type": "document_help",
    }),
  );
  assert.equal(calls[1][1].questionSetId, V2_ID);
  const fresh = harness({ sets: [V1_ROW, V2_ROW], revisions: [] });
  await saveIntakeRevision(
    fresh.sources,
    form({
      ...SAVE_FIELDS,
      expected_revision: "",
      "q:assistance_type": "document_help",
    }),
  );
  assert.equal(fresh.calls[0][1].questionSetId, V2_ID);
  assert.equal(fresh.calls[0][1].expectedRevision, null);
});

test("7. practice-area Not sure is sent as the not_sure answer with no practice area; unanswered questions are simply absent", async () => {
  const { sources, calls } = harness();
  await saveIntakeRevision(
    sources,
    form({
      intake: INTAKE,
      expected_revision: "1",
      version: "governing",
      "q:practice_area": NOT_SURE,
      "q:jurisdictions": [NOT_SURE],
      "q:court_case": "",
    }),
  );
  assert.deepEqual(calls[0][1].answers, {
    practice_area: NOT_SURE,
    jurisdictions: NOT_SURE,
  });
  assert.equal(calls[0][1].practiceAreaId, null);
  assert.equal(calls[0][1].description, null);
});

test("8. invalid input is refused with a field message and nothing is sent", async () => {
  const invalid = {
    jurisdictions_and_not_sure: { "q:jurisdictions": [J_A, NOT_SURE] },
    unknown_jurisdiction: { "q:jurisdictions": [id(799)] },
    unknown_choice: { "q:court_case": "maybe" },
    repeated_choice: { "q:court_case": ["yes", "no"] },
    inactive_area: { "q:practice_area": AREA_OFF },
    unknown_area: { "q:practice_area": id(698) },
    description_too_long: { description: "x".repeat(4001) },
    description_control: { description: "bell\u0007" },
  };
  for (const [label, fields] of Object.entries(invalid)) {
    const { sources, calls } = harness({
      areas: [
        {
          id: AREA,
          code: "SYN_FAMILY",
          name: "Synthetic Family",
          active: true,
        },
        { id: AREA_OFF, code: "SYN_OFF", name: "Synthetic Off", active: false },
      ],
    });
    const state = await saveIntakeRevision(
      sources,
      form({ ...SAVE_FIELDS, ...fields }),
    );
    assert.equal(state.status, "invalid", label);
    assert.deepEqual(calls, [], label);
  }
  const { sources, calls } = harness();
  const empty = await saveIntakeRevision(
    sources,
    form({ intake: INTAKE, expected_revision: "1", version: "governing" }),
  );
  assert.equal(empty.status, "invalid");
  assert.match(empty.fieldErrors.submit[0], /at least one question/);
  assert.equal(
    (
      await saveIntakeRevision(
        sources,
        form({ ...SAVE_FIELDS, description: "x".repeat(4000) }),
      )
    ).status,
    "saved",
  );
  assert.equal(calls.length, 1);
});

test("9. stale pages, closed Intakes, foreign Intakes and malformed tokens are refused before any write", async () => {
  const cases = [
    [{ expected_revision: "2" }, "conflict"],
    [{ expected_revision: "" }, "conflict"],
    [{ expected_revision: "1.5" }, "conflict"],
    [{ version: "v1" }, "conflict"],
    [{ intake: SUBMITTED }, "not-editable"],
    [{ intake: FOREIGN }, "not-found"],
    [{ intake: "not-a-uuid" }, "not-found"],
  ];
  for (const [fields, expected] of cases) {
    const { sources, calls } = harness();
    assert.equal(
      (await saveIntakeRevision(sources, form({ ...SAVE_FIELDS, ...fields })))
        .status,
      expected,
      JSON.stringify(fields),
    );
    assert.deepEqual(calls, []);
  }
});

test("10. every database save outcome maps to its fixed state; a lost or malformed answer is never reported as saved", async () => {
  const cases = [
    [answer("saved", 2), "saved"],
    [answer("saved", "2"), "outcome-unknown"],
    [answer("unchanged"), "unchanged"],
    [answer("conflict"), "conflict"],
    [answer("version_not_allowed"), "version-not-allowed"],
    [answer("invalid"), "invalid"],
    [answer("not_editable"), "not-editable"],
    [answer("rate_limited"), "rate-limited"],
    [answer("not_found"), "not-found"],
    [answer("unavailable"), "unavailable"],
    [answer("submitted"), "outcome-unknown"],
    [{ kind: "rejected" }, "unavailable"],
    [{ kind: "unreadable" }, "outcome-unknown"],
    [null, "outcome-unknown"],
  ];
  for (const [reply, expected] of cases) {
    const { sources } = harness({
      answers: { ...harness().state.answers, save: reply },
    });
    assert.equal(
      (await saveIntakeRevision(sources, form(SAVE_FIELDS))).status,
      expected,
      JSON.stringify(reply),
    );
  }
});

test("11. submit, close and start send exactly the named Intake and token and map every outcome", async () => {
  const submitCases = [
    ["submitted", "submitted"],
    ["already_submitted", "already-submitted"],
    ["conflict", "conflict"],
    ["incomplete", "incomplete"],
    ["needs_update", "needs-update"],
    ["not_editable", "not-editable"],
    ["not_found", "not-found"],
    ["unavailable", "unavailable"],
    ["closed", "outcome-unknown"],
  ];
  for (const [outcome, expected] of submitCases) {
    const { sources, calls } = harness({
      answers: { ...harness().state.answers, submit: answer(outcome) },
    });
    assert.equal(
      (
        await submitIntake(
          sources,
          form({ intake: INTAKE, expected_revision: "1" }),
        )
      ).status,
      expected,
    );
    assert.deepEqual(calls, [["submit", INTAKE, 1]]);
  }
  const closeCases = [
    ["closed", "closed"],
    ["already_closed", "already-closed"],
    ["not_found", "not-found"],
    ["unavailable", "unavailable"],
  ];
  for (const [outcome, expected] of closeCases) {
    const { sources, calls } = harness({
      answers: { ...harness().state.answers, close: answer(outcome) },
    });
    assert.equal(
      (await closeIntake(sources, form({ intake: INTAKE }))).status,
      expected,
    );
    assert.deepEqual(calls, [["close", INTAKE]]);
  }
  const started = await startIntake(harness().sources);
  assert.deepEqual(started, { status: "created", intakeId: id(499) });
  for (const [reply, expected] of [
    [answer("created", "x"), "outcome-unknown"],
    [answer("rate_limited"), "rate-limited"],
    [answer("denied"), "denied"],
    [answer("unavailable"), "unavailable"],
    [{ kind: "unreadable" }, "outcome-unknown"],
  ]) {
    const { sources } = harness({
      answers: { ...harness().state.answers, create: reply },
    });
    assert.equal((await startIntake(sources)).status, expected);
  }
  const { sources, calls } = harness();
  assert.equal(
    (
      await submitIntake(
        sources,
        form({ intake: INTAKE, expected_revision: "x" }),
      )
    ).status,
    "conflict",
  );
  assert.equal((await closeIntake(sources, form({}))).status, "not-found");
  assert.equal(
    (await saveIntakeRevision(sources, { not: "form data" })).status,
    "unavailable",
  );
  assert.deepEqual(calls, []);
});
