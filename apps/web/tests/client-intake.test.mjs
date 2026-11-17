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
  WORKSPACE_PAGE_SIZE,
  workspacePageOf,
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
    // MVP-001 S3 part 2: the Intake's presented AI suggestions (none by
    // default) and the decision and change answers.
    suggestions: [],
    answers: {
      create: answer("created", id(499)),
      save: answer("saved", 2),
      submit: answer("submitted"),
      close: answer("closed"),
      decide: answer("confirmed"),
      change: answer("not_configured"),
    },
    readsAvailable: true,
    readLog: [],
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
            // The client's Intakes, newest first, one bounded slice at a time.
            intakesOf: async (c, offset, count) => {
              state.readLog.push(["intakesOf", offset, count]);
              return rows(
                state.intakes
                  .filter((i) => i.client_id === c)
                  .sort(
                    (a, b) =>
                      Date.parse(b.created_at) - Date.parse(a.created_at),
                  )
                  .slice(offset, offset + count),
              );
            },
            intakeOf: async (c, intake) =>
              rows(
                state.intakes.filter(
                  (i) => i.client_id === c && i.id === intake,
                ),
              ),
            // One Intake's latest revision summary, or none.
            latestRevisionSummaryOf: async (intake) => {
              state.readLog.push(["latestRevisionSummaryOf", intake]);
              return rows(
                state.revisions
                  .filter((r) => r.intake_id === intake)
                  .sort((a, b) => b.revision_number - a.revision_number)
                  .slice(0, 1)
                  .map((r) => ({
                    intake_id: r.intake_id,
                    revision_number: r.revision_number,
                    created_at: r.created_at,
                  })),
              );
            },
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
            suggestionsOf: async (intake) => {
              state.readLog.push(["suggestionsOf", intake]);
              return rows(state.suggestions);
            },
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
      decideSuggestion: async (suggestion, decision) => {
        calls.push(["decide", suggestion, decision]);
        return state.answers.decide;
      },
      requestChange: async (intake, change) => {
        calls.push(["change", intake, change]);
        return state.answers.change;
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

// MVP-001 D-3: many synthetic Intakes for the one client, newest last, each
// with its own number of synthetic revisions.
function manyIntakes(count, revisionsOf = () => 1) {
  const intakes = [];
  const revisions = [];
  for (let n = 1; n <= count; n += 1) {
    const intake = id(10000 + n);
    intakes.push({
      id: intake,
      client_id: CLIENT,
      state: "draft",
      created_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
      closed_at: null,
    });
    for (let r = 1; r <= revisionsOf(n); r += 1) {
      revisions.push({
        intake_id: intake,
        revision_number: r,
        created_at: new Date(Date.UTC(2026, 10, 2, 0, n, r % 60)).toISOString(),
      });
    }
  }
  return { intakes, revisions };
}

test("2a. the workspace stays usable at any number of Intakes: one page at a time, newest first, saying when newer or older ones exist", async () => {
  assert.equal(WORKSPACE_PAGE_SIZE, 20);
  const { intakes, revisions } = manyIntakes(45, (n) => n % 4);
  const { sources, state } = harness({ intakes, revisions });
  const page = async (value) => resolveClientWorkspace(sources, value);
  const newest = intakes.map((i) => i.id).reverse();

  const first = await page(undefined);
  assert.equal(first.status, "ready");
  assert.deepEqual(
    first.intakes.map((i) => i.id),
    newest.slice(0, 20),
  );
  assert.deepEqual(
    [first.page, first.pageSize, first.newerPage, first.olderPage],
    [1, 20, null, 2],
  );
  // Each shown Intake carries its own latest saved version.
  for (const shown of first.intakes) {
    const n = Number(shown.id.slice(-5)) - 10000;
    assert.equal(shown.revisions, n % 4, shown.id);
    assert.equal(shown.lastSavedAt === null, n % 4 === 0, shown.id);
  }
  const second = await page("2");
  assert.deepEqual(
    second.intakes.map((i) => i.id),
    newest.slice(20, 40),
  );
  assert.deepEqual(
    [second.page, second.newerPage, second.olderPage],
    [2, 1, 3],
  );
  state.readLog.length = 0;
  const last = await page("3");
  assert.deepEqual(
    last.intakes.map((i) => i.id),
    newest.slice(40),
  );
  assert.deepEqual([last.page, last.newerPage, last.olderPage], [3, 2, null]);
  // The page asks for exactly one page and one more Intake, after skipping
  // the earlier pages, and reads only the shown Intakes' summaries.
  assert.deepEqual(state.readLog, [
    ["intakesOf", 40, 21],
    ...newest.slice(40).map((intake) => ["latestRevisionSummaryOf", intake]),
  ]);
  // A page past the last one is empty and points back.
  const beyond = await page("4");
  assert.equal(beyond.status, "ready");
  assert.deepEqual(beyond.intakes, []);
  assert.deepEqual(
    [beyond.page, beyond.newerPage, beyond.olderPage],
    [4, 3, null],
  );

  // Exactly one full page has no older page; one more Intake makes one.
  for (const [count, older] of [
    [20, null],
    [21, 2],
  ]) {
    const exact = harness(manyIntakes(count));
    const view = await resolveClientWorkspace(exact.sources);
    assert.equal(view.intakes.length, 20);
    assert.equal(view.olderPage, older, String(count));
  }

  // Only a plain page number from 1 to 999999 is a page; anything else is
  // the first page.
  for (const [value, expected] of [
    ["1", 1],
    ["2", 2],
    ["999999", 999999],
    [undefined, 1],
    ["0", 1],
    ["-1", 1],
    ["01", 1],
    ["1.5", 1],
    ["2 ", 1],
    [" 2", 1],
    ["1e3", 1],
    ["1000000", 1],
    ["abc", 1],
    [["2"], 1],
    [["2", "3"], 1],
    [2, 1],
    [null, 1],
  ]) {
    assert.equal(workspacePageOf(value), expected, JSON.stringify(value));
  }
  assert.equal((await page(["2"])).page, 1);
});

test("2b. each shown Intake's latest version is read on its own, so none is silently dropped; a port that breaks its bounds is unavailable", async () => {
  // One Intake with far more revisions than any batch bound would hold.
  const { intakes, revisions } = manyIntakes(3, (n) => (n === 2 ? 6000 : 1));
  const { sources } = harness({ intakes, revisions });
  const view = await resolveClientWorkspace(sources);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.intakes.map((i) => i.revisions),
    [1, 6000, 1],
  );

  const broken = [
    // More Intakes than asked for.
    (reads) => ({
      ...reads,
      intakesOf: async (c, offset, count) => {
        const all = await reads.intakesOf(c, offset, count);
        return rows(
          Array.from(
            { length: count + 1 },
            (_, index) => all.rows[index % all.rows.length],
          ),
        );
      },
    }),
    // Two latest summaries for one Intake.
    (reads) => ({
      ...reads,
      latestRevisionSummaryOf: async (intake) => {
        const one = await reads.latestRevisionSummaryOf(intake);
        return rows([...one.rows, ...one.rows]);
      },
    }),
    // A summary of another Intake.
    (reads) => ({
      ...reads,
      latestRevisionSummaryOf: async (intake) =>
        reads.latestRevisionSummaryOf(
          intake === intakes[0].id ? intakes[1].id : intake,
        ),
    }),
    // An unreadable summary.
    (reads) => ({
      ...reads,
      latestRevisionSummaryOf: async () => ({ kind: "unreadable" }),
    }),
    // A thrown summary read.
    (reads) => ({
      ...reads,
      latestRevisionSummaryOf: async () => {
        throw new Error("synthetic");
      },
    }),
  ];
  for (const [index, breakReads] of broken.entries()) {
    const { sources: original } = harness({ intakes, revisions });
    const sources = {
      ...original,
      reads: async () => breakReads(await original.reads()),
    };
    assert.equal(
      (await resolveClientWorkspace(sources)).status,
      "unavailable",
      String(index),
    );
  }
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
    [answer("denied"), "outcome-unknown"],
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
