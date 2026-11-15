// Generic intake question configuration, format 1 (P5-001, PS-A1).
//
// A published question-set version is immutable configuration held in the
// database: ordered questions with stable identifiers, a supported kind,
// ordinary-language wording and a required flag; the description field; and
// the intake operating limits. Nothing here holds any question wording,
// choice, or limit: every value comes from a version the database published
// and validated. This module reads a version strictly, mirrors the
// database's answer rules so the page can explain a problem before anything
// is sent, and carries answers to a newer version only where their meaning
// is unchanged. The database decides again on every save and submission.

import { isTimestamp, isUuid, readExact } from "./professional-records.ts";

export const QUESTION_SET_COLUMNS = "id, version_key, definition, published_at";

// The answer value that records an explicit "Not sure" for the practice-area
// and jurisdiction kinds. It is a complete answer, distinct from no answer.
export const NOT_SURE = "not_sure";

export type Choice = { readonly id: string; readonly label: string };

type QuestionBase = {
  readonly id: string;
  readonly prompt: string;
  readonly help: string | null;
  readonly required: boolean;
};

export type Question =
  | (QuestionBase & {
      readonly kind: "practice_area";
      readonly notSureLabel: string;
    })
  | (QuestionBase & {
      readonly kind: "jurisdictions";
      readonly notSureLabel: string;
    })
  | (QuestionBase & {
      readonly kind: "single_choice";
      readonly choices: readonly Choice[];
    });

export type RateLimit = {
  readonly max: number;
  readonly windowSeconds: number;
};

export type Definition = {
  readonly questions: readonly Question[];
  readonly description: {
    readonly prompt: string;
    readonly help: string | null;
    readonly required: boolean;
  };
  readonly limits: {
    readonly descriptionMaxCharacters: number;
    readonly structuredAnswersMaxBytes: number;
    readonly revisionSavesPerClient: RateLimit;
    readonly intakeStartsPerClient: RateLimit;
  };
};

export type QuestionSet = {
  readonly id: string;
  readonly versionKey: string;
  readonly publishedAt: string;
  readonly definition: Definition;
};

// An answer value: one choice or catalog identifier, "not_sure", or a list
// of jurisdiction identifiers.
export type AnswerValue = string | readonly string[];
export type Answers = Readonly<Record<string, AnswerValue>>;

const ID = /^[a-z][a-z0-9_]{1,39}$/;
const VERSION_KEY = /^[a-z][a-z0-9-]{2,63}$/;
const CONTROL = /[\u0001-\u001f\u007f]/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function keysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = keysOf(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

// The number of Unicode code points, as PostgreSQL's char_length counts.
export function characterCount(text: string): number {
  return [...text].length;
}

function label(value: unknown, maxLength: number): string | null {
  if (
    typeof value !== "string" ||
    characterCount(value) < 1 ||
    characterCount(value) > maxLength ||
    /^\s|\s$/.test(value) ||
    CONTROL.test(value)
  ) {
    return null;
  }
  return value;
}

function wholeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function rateLimit(value: unknown): RateLimit | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["max", "window_seconds"])
  ) {
    return null;
  }
  const max = wholeNumber(value.max, 1, 10000);
  const windowSeconds = wholeNumber(value.window_seconds, 60, 604800);
  return max === null || windowSeconds === null
    ? null
    : Object.freeze({ max, windowSeconds });
}

function question(value: unknown, seen: Set<string>): Question | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      ["id", "kind", "prompt", "required"],
      ["help", "not_sure_label", "choices"],
    )
  ) {
    return null;
  }
  const id = value.id;
  const prompt = label(value.prompt, 200);
  const help = value.help === undefined ? null : label(value.help, 500);
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    seen.has(id) ||
    prompt === null ||
    (value.help !== undefined && help === null) ||
    typeof value.required !== "boolean"
  ) {
    return null;
  }
  seen.add(id);
  const base = { id, prompt, help, required: value.required };
  if (value.kind === "practice_area" || value.kind === "jurisdictions") {
    const notSureLabel = label(value.not_sure_label, 80);
    if (value.choices !== undefined || notSureLabel === null) {
      return null;
    }
    return value.kind === "practice_area"
      ? Object.freeze({ ...base, kind: "practice_area", notSureLabel })
      : Object.freeze({ ...base, kind: "jurisdictions", notSureLabel });
  }
  if (value.kind === "single_choice") {
    const choices = value.choices;
    if (
      value.not_sure_label !== undefined ||
      !Array.isArray(choices) ||
      choices.length < 2 ||
      choices.length > 20
    ) {
      return null;
    }
    const ids = new Set<string>();
    const read: Choice[] = [];
    for (const choice of choices) {
      if (!isPlainRecord(choice) || !hasExactKeys(choice, ["id", "label"])) {
        return null;
      }
      const choiceLabel = label(choice.label, 80);
      if (
        typeof choice.id !== "string" ||
        !ID.test(choice.id) ||
        ids.has(choice.id) ||
        choiceLabel === null
      ) {
        return null;
      }
      ids.add(choice.id);
      read.push(Object.freeze({ id: choice.id, label: choiceLabel }));
    }
    return Object.freeze({
      ...base,
      kind: "single_choice",
      choices: Object.freeze(read),
    });
  }
  return null;
}

// A format-1 definition read strictly, or null. It mirrors the database's
// publication rules (except the cross-version identifier check, which only
// the database can make); anything else means the version is unusable here.
export function parseDefinition(value: unknown): Definition | null {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["description", "format", "limits", "questions"]) ||
      value.format !== 1 ||
      !Array.isArray(value.questions) ||
      value.questions.length < 1 ||
      value.questions.length > 20
    ) {
      return null;
    }
    const seen = new Set<string>();
    const questions: Question[] = [];
    for (const entry of value.questions) {
      const read = question(entry, seen);
      if (read === null) {
        return null;
      }
      questions.push(read);
    }
    if (
      questions.filter((q) => q.kind === "practice_area").length > 1 ||
      questions.filter((q) => q.kind === "jurisdictions").length > 1
    ) {
      return null;
    }
    const description = value.description;
    if (
      !isPlainRecord(description) ||
      !hasExactKeys(description, ["prompt", "required"], ["help"])
    ) {
      return null;
    }
    const descriptionPrompt = label(description.prompt, 200);
    const descriptionHelp =
      description.help === undefined ? null : label(description.help, 500);
    if (
      descriptionPrompt === null ||
      (description.help !== undefined && descriptionHelp === null) ||
      typeof description.required !== "boolean"
    ) {
      return null;
    }
    const limits = value.limits;
    if (
      !isPlainRecord(limits) ||
      !hasExactKeys(limits, [
        "description_max_characters",
        "intake_starts_per_client",
        "revision_saves_per_client",
        "structured_answers_max_bytes",
      ])
    ) {
      return null;
    }
    const descriptionMaxCharacters = wholeNumber(
      limits.description_max_characters,
      1,
      20000,
    );
    const structuredAnswersMaxBytes = wholeNumber(
      limits.structured_answers_max_bytes,
      256,
      16384,
    );
    const revisionSavesPerClient = rateLimit(limits.revision_saves_per_client);
    const intakeStartsPerClient = rateLimit(limits.intake_starts_per_client);
    if (
      descriptionMaxCharacters === null ||
      structuredAnswersMaxBytes === null ||
      revisionSavesPerClient === null ||
      intakeStartsPerClient === null
    ) {
      return null;
    }
    return Object.freeze({
      questions: Object.freeze(questions),
      description: Object.freeze({
        prompt: descriptionPrompt,
        help: descriptionHelp,
        required: description.required,
      }),
      limits: Object.freeze({
        descriptionMaxCharacters,
        structuredAnswersMaxBytes,
        revisionSavesPerClient,
        intakeStartsPerClient,
      }),
    });
  } catch {
    return null;
  }
}

// One published version row, read strictly, or null.
export function readQuestionSet(row: unknown): QuestionSet | null {
  const fields = readExact(row, QUESTION_SET_COLUMNS.split(", "));
  if (fields === null) {
    return null;
  }
  const id = fields.get("id");
  const versionKey = fields.get("version_key");
  const publishedAt = fields.get("published_at");
  const definition = parseDefinition(fields.get("definition"));
  if (
    !isUuid(id) ||
    typeof versionKey !== "string" ||
    !VERSION_KEY.test(versionKey) ||
    !isTimestamp(publishedAt) ||
    definition === null
  ) {
    return null;
  }
  return Object.freeze({ id, versionKey, publishedAt, definition });
}

// The PostgreSQL jsonb text of a JSON value: object keys ordered by byte
// length and then bytewise, ", " between members and ": " after keys. The
// database bounds structured answers by the UTF-8 length of this text.
export function jsonbText(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jsonbText).join(", ")}]`;
  }
  if (typeof value === "object") {
    const encoder = new TextEncoder();
    const keys = Object.keys(value).sort((a, b) => {
      const left = encoder.encode(a);
      const right = encoder.encode(b);
      if (left.length !== right.length) {
        return left.length - right.length;
      }
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
          return left[index] - right[index];
        }
      }
      return 0;
    });
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}: ${jsonbText((value as Record<string, unknown>)[key])}`,
      )
      .join(", ")}}`;
  }
  throw new TypeError("not a JSON value");
}

export function answersByteLength(answers: Answers): number {
  return new TextEncoder().encode(jsonbText(answers)).length;
}

export type AnswerProblem =
  | "answers"
  | "answers_size"
  | "practice_area_question"
  | "unknown_question"
  | "practice_area_answer"
  | "jurisdiction_answer"
  | "jurisdiction_unknown"
  | "choice_answer"
  | "incomplete";

// The database's answer rules, mirrored: null when valid, otherwise the
// problem. A practice-area question is answered by exactly one of a selected
// practice area or its explicit "not_sure" answer; neither is unanswered;
// both is invalid. With complete, every required question must be answered.
export function answersProblem(
  definition: Definition,
  answers: unknown,
  practiceAreaId: string | null,
  complete: boolean,
  knownJurisdictions: ReadonlySet<string>,
): AnswerProblem | null {
  if (!isPlainRecord(answers)) {
    return "answers";
  }
  if (
    answersByteLength(answers as Answers) >
    definition.limits.structuredAnswersMaxBytes
  ) {
    return "answers_size";
  }
  const byId = new Map(definition.questions.map((q) => [q.id, q]));
  if (
    practiceAreaId !== null &&
    !definition.questions.some((q) => q.kind === "practice_area")
  ) {
    return "practice_area_question";
  }
  for (const [key, value] of Object.entries(answers)) {
    const asked = byId.get(key);
    if (asked === undefined) {
      return "unknown_question";
    }
    if (asked.kind === "practice_area") {
      if (value !== NOT_SURE || practiceAreaId !== null) {
        return "practice_area_answer";
      }
    } else if (asked.kind === "jurisdictions") {
      if (value === NOT_SURE) {
        continue;
      }
      if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
        return "jurisdiction_answer";
      }
      const ids = new Set<string>();
      for (const element of value) {
        if (
          typeof element !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            element,
          ) ||
          ids.has(element)
        ) {
          return "jurisdiction_answer";
        }
        ids.add(element);
      }
      if ([...ids].some((id) => !knownJurisdictions.has(id))) {
        return "jurisdiction_unknown";
      }
    } else if (
      typeof value !== "string" ||
      !asked.choices.some((choice) => choice.id === value)
    ) {
      return "choice_answer";
    }
  }
  if (complete) {
    for (const asked of definition.questions) {
      if (!asked.required) {
        continue;
      }
      const answered =
        asked.kind === "practice_area"
          ? practiceAreaId !== null || key(answers, asked.id)
          : key(answers, asked.id);
      if (!answered) {
        return "incomplete";
      }
    }
  }
  return null;
}

function key(record: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, name);
}

// The answers that keep their meaning in a newer version: those whose
// question identifier and kind are unchanged there and, for a choice, whose
// choice identifier still exists. Nothing is translated; the client reviews
// and saves the result as a new statement under the newer version.
export function carryOver(
  to: Definition,
  from: Definition,
  answers: Answers,
): Answers {
  const carried: Record<string, AnswerValue> = {};
  for (const [id, value] of Object.entries(answers)) {
    const before = from.questions.find((q) => q.id === id);
    const after = to.questions.find((q) => q.id === id);
    if (
      before === undefined ||
      after === undefined ||
      before.kind !== after.kind
    ) {
      continue;
    }
    if (
      after.kind === "single_choice" &&
      !after.choices.some((choice) => choice.id === value)
    ) {
      continue;
    }
    carried[id] = value;
  }
  return Object.freeze(carried);
}
