// P5-001: the generic intake question-set model (format 1).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  answersByteLength,
  answersProblem,
  carryOver,
  characterCount,
  jsonbText,
  NOT_SURE,
  parseDefinition,
  readQuestionSet,
} from "../src/application/intake-question-set.ts";

const V1_TEXT = readFileSync(
  new URL("./fixtures/intake-questions-v1.canonical.txt", import.meta.url),
  "utf8",
);
const V1 = JSON.parse(V1_TEXT);
const V1_SHA256 =
  "31a3245be9ecb6135f93e5141bd9d2314c7f30fb8cfd3389d5e8645fbfbdf395";
const J_A = "00000000-0000-4000-8000-00000000000a";
const J_B = "00000000-0000-4000-8000-00000000000b";
const AREA = "00000000-0000-4000-8000-0000000000a1";
const KNOWN = new Set([J_A, J_B]);

test("1. the adopted v1 fixture is the exact Packet definition and parses", () => {
  assert.equal(
    createHash("sha256").update(V1_TEXT, "utf8").digest("hex"),
    V1_SHA256,
  );
  assert.equal(Buffer.byteLength(V1_TEXT, "utf8"), 1296);
  const definition = parseDefinition(V1);
  assert.ok(definition);
  assert.deepEqual(
    definition.questions.map((q) => [q.id, q.kind, q.required]),
    [
      ["practice_area", "practice_area", true],
      ["jurisdictions", "jurisdictions", true],
      ["court_case", "single_choice", true],
      ["assistance_type", "single_choice", true],
    ],
  );
  assert.deepEqual(
    definition.questions[3].choices.map((c) => c.id),
    ["understand_options", "document_help", "representation", "not_sure"],
  );
  assert.equal(definition.description.required, false);
  assert.deepEqual(definition.limits, {
    descriptionMaxCharacters: 4000,
    structuredAnswersMaxBytes: 4096,
    revisionSavesPerClient: { max: 60, windowSeconds: 3600 },
    intakeStartsPerClient: { max: 10, windowSeconds: 86400 },
  });
});

test("2. jsonbText reproduces PostgreSQL's canonical jsonb text for the v1 definition exactly", () => {
  assert.equal(jsonbText(V1), V1_TEXT);
  assert.equal(
    jsonbText({ bb: 1, a: [true, null, "x"] }),
    '{"a": [true, null, "x"], "bb": 1}',
  );
});

test("3. the model rejects every malformed definition the database rejects", () => {
  const clone = () => structuredClone(V1);
  const variants = [
    null,
    [],
    { ...clone(), extra: 1 },
    { ...clone(), format: 2 },
    { ...clone(), questions: [] },
    (() => {
      const d = clone();
      d.questions[2].id = "Court";
      return d;
    })(),
    (() => {
      const d = clone();
      d.questions[3].id = "court_case";
      return d;
    })(),
    (() => {
      const d = clone();
      d.questions[2].kind = "free_text";
      return d;
    })(),
    (() => {
      const d = clone();
      d.questions[2].prompt = "Line\nbreak";
      return d;
    })(),
    (() => {
      const d = clone();
      d.questions[2].prompt = " Leading";
      return d;
    })(),
    (() => {
      const d = clone();
      d.questions[2].choices = [{ id: "yes", label: "Yes" }];
      return d;
    })(),
    (() => {
      const d = clone();
      delete d.questions[1].not_sure_label;
      return d;
    })(),
    (() => {
      const d = clone();
      d.questions.push({ ...d.questions[0], id: "practice_area_two" });
      return d;
    })(),
    (() => {
      const d = clone();
      d.limits.description_max_characters = 20001;
      return d;
    })(),
    (() => {
      const d = clone();
      d.limits.description_max_characters = 1.5;
      return d;
    })(),
    (() => {
      const d = clone();
      d.limits.revision_saves_per_client.window_seconds = 59;
      return d;
    })(),
  ];
  for (const [index, variant] of variants.entries()) {
    assert.equal(parseDefinition(variant), null, `variant ${index}`);
  }
});

test("4. a published version row is read strictly", () => {
  const row = {
    id: "00000000-0000-4000-8000-0000000000f1",
    version_key: "intake-questions-v1",
    definition: V1,
    published_at: "2026-11-15T14:06:53.123456+00:00",
  };
  assert.equal(readQuestionSet(row)?.versionKey, "intake-questions-v1");
  assert.equal(readQuestionSet({ ...row, extra: 1 }), null);
  assert.equal(readQuestionSet({ ...row, version_key: "V1" }), null);
  assert.equal(
    readQuestionSet({ ...row, definition: { ...V1, format: 2 } }),
    null,
  );
});

test("5. practice-area answers: Not sure is complete, unanswered is incomplete, both is invalid, and absence of the question is respected", () => {
  const definition = parseDefinition(V1);
  const rest = {
    jurisdictions: [J_A],
    court_case: "no",
    assistance_type: "not_sure",
  };
  assert.equal(
    answersProblem(
      definition,
      { ...rest, practice_area: NOT_SURE },
      null,
      true,
      KNOWN,
    ),
    null,
  );
  assert.equal(answersProblem(definition, rest, AREA, true, KNOWN), null);
  assert.equal(
    answersProblem(definition, rest, null, true, KNOWN),
    "incomplete",
  );
  assert.equal(answersProblem(definition, rest, null, false, KNOWN), null);
  assert.equal(
    answersProblem(
      definition,
      { ...rest, practice_area: NOT_SURE },
      AREA,
      false,
      KNOWN,
    ),
    "practice_area_answer",
  );
  const optional = parseDefinition({
    ...V1,
    questions: V1.questions.map((q) =>
      q.id === "practice_area" ? { ...q, required: false } : q,
    ),
  });
  assert.equal(answersProblem(optional, rest, null, true, KNOWN), null);
  const none = parseDefinition({ ...V1, questions: V1.questions.slice(1) });
  assert.equal(answersProblem(none, rest, null, true, KNOWN), null);
  assert.equal(
    answersProblem(none, rest, AREA, false, KNOWN),
    "practice_area_question",
  );
  assert.equal(
    answersProblem(
      none,
      { ...rest, practice_area: NOT_SURE },
      null,
      false,
      KNOWN,
    ),
    "unknown_question",
  );
});

test("6. jurisdiction and choice answers are checked like the database checks them", () => {
  const definition = parseDefinition(V1);
  const check = (answers) =>
    answersProblem(definition, answers, AREA, false, KNOWN);
  assert.equal(check({ jurisdictions: NOT_SURE }), null);
  assert.equal(check({ jurisdictions: [J_A, J_B] }), null);
  assert.equal(check({ jurisdictions: [] }), "jurisdiction_answer");
  assert.equal(check({ jurisdictions: [J_A, J_A] }), "jurisdiction_answer");
  assert.equal(
    check({ jurisdictions: [J_A.toUpperCase()] }),
    "jurisdiction_answer",
  );
  assert.equal(check({ jurisdictions: ["SYN_A"] }), "jurisdiction_answer");
  assert.equal(
    check({ jurisdictions: ["00000000-0000-4000-8000-0000000000ff"] }),
    "jurisdiction_unknown",
  );
  assert.equal(check({ court_case: "maybe" }), "choice_answer");
  assert.equal(check({ extra: "x" }), "unknown_question");
  assert.equal(check([]), "answers");
  assert.equal(check({ court_case: "x".repeat(5000) }), "answers_size");
});

test("7. answer size is measured as the UTF-8 length of the canonical jsonb text", () => {
  assert.equal(
    answersByteLength({ court_case: "no" }),
    '{"court_case": "no"}'.length,
  );
  assert.equal(
    answersByteLength({ a: "é" }),
    Buffer.byteLength('{"a": "é"}', "utf8"),
  );
  assert.equal(characterCount("é😀"), 2);
});

test("8. carry-over keeps only answers whose meaning is unchanged in the newer version", () => {
  const from = parseDefinition(V1);
  const to = parseDefinition({
    ...V1,
    questions: [
      V1.questions[0],
      { ...V1.questions[2], prompt: "Has a court case started?" },
      {
        ...V1.questions[3],
        choices: V1.questions[3].choices.filter(
          (c) => c.id !== "representation",
        ),
      },
    ],
  });
  const carried = carryOver(to, from, {
    practice_area: NOT_SURE,
    jurisdictions: [J_A],
    court_case: "yes",
    assistance_type: "representation",
  });
  assert.deepEqual(carried, { practice_area: NOT_SURE, court_case: "yes" });
});
