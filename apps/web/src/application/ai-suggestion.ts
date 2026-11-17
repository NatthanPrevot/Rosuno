// AI Suggestions on a client's own Intake (MVP-001 S3 part 2; MVP-001
// Packet section 3 gate D-4; MBS section 8 AI boundary; PS section 13; TA
// sections 3.3 and 30; ROS rule R17; MB sections 100 to 103).
//
// Provider-neutral and injectable. generate -> persist -> human
// confirmation -> canonical change only through the ordinary workflow:
// - generate: the client asks for suggestions on their own draft Intake; the
//   request is built from the client's own saved revision and the current
//   catalogs, and handed to the provider port. The provider, its capability
//   and its data authorization are undecided (gate D-4): the production
//   adapter answers "unavailable" without any network call, and the
//   workflow continues exactly as without AI;
// - persist: an answer is read strictly. Only the two TA section 30
//   permitted classes this slice uses are accepted (a practice category, and
//   potentially relevant jurisdictions), each naming only active catalog
//   entries; anything else is discarded inference and is never stored or
//   shown (PS section 13; ROS rule R17). Each accepted item is presented
//   only after the database recorded it, through the server-only recording
//   port (ai_record_intake_suggestion, service_role), with the server's time
//   of the answer and the model reference; the page then shows what the
//   database holds;
// - confirm: the client confirms or dismisses each suggestion once (the
//   client intake use cases). A confirmation changes no Intake content: a
//   confirmed category or place is filled in on the form, and only the
//   client's ordinary save makes it canonical (MB section 102).
// AI never names, ranks or selects an attorney, decides eligibility, merits
// or governing law, or writes any protected state.

import {
  intakeContentOf,
  isRevisionNumber,
  MAX_SUGGESTED_JURISDICTIONS,
  readSuggestedJurisdictions,
  SUGGESTION_TYPES,
  type CatalogEntry,
  type ClientIntakeSources,
  type SuggestionType,
} from "./client-intake.ts";
import { NOT_SURE, type Definition } from "./intake-question-set.ts";
import {
  attempt,
  portFrom,
  UNAVAILABLE,
  type Refusal,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
} from "./professional-records.ts";

export { SUGGESTION_TYPES, type SuggestionType };

// A model reference as the database accepts it.
const MODEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

// ---------------------------------------------------------------------------
// The provider port
// ---------------------------------------------------------------------------

// What a provider may receive: the client's own saved statements, in their
// question wording and catalog names, and the catalog entries a suggestion
// may name. No identity, Intake id, contact detail or attorney data.
export type SuggestionRequest = {
  readonly classes: readonly SuggestionType[];
  readonly description: string | null;
  readonly answers: readonly {
    readonly question: string;
    readonly answer: string;
  }[];
  readonly practiceAreas: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly jurisdictions: readonly {
    readonly id: string;
    readonly name: string;
  }[];
};

// A provider's answer: unavailable, or a model reference and raw items that
// are read strictly before anything is kept.
export type ProviderAnswer =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "suggestions";
      readonly modelReference: string;
      readonly items: readonly unknown[];
    };

export const PROVIDER_UNAVAILABLE: ProviderAnswer = Object.freeze({
  kind: "unavailable",
});

export type IntakeSuggestionProvider = {
  readonly suggest: (request: SuggestionRequest) => Promise<ProviderAnswer>;
};

// ---------------------------------------------------------------------------
// The recording port (server-only, privileged)
// ---------------------------------------------------------------------------

export type SuggestionValue =
  | { readonly practice_area_id: string }
  | { readonly jurisdiction_ids: readonly string[] };

export type RecordInput = {
  readonly userId: string;
  readonly intakeId: string;
  readonly revisionNumber: number;
  readonly type: SuggestionType;
  readonly value: SuggestionValue;
  readonly modelReference: string;
  readonly generatedAt: string;
};

export const RECORD_OUTCOMES = Object.freeze([
  "recorded",
  "invalid",
  "not_found",
  "not_editable",
  "stale",
  "rate_limited",
] as const);
export type RecordOutcome = (typeof RECORD_OUTCOMES)[number];

export type RecordAnswer =
  | { readonly kind: "recorded"; readonly suggestionId: string }
  | {
      readonly kind: "refused";
      readonly outcome: Exclude<RecordOutcome, "recorded">;
    }
  | { readonly kind: "unknown" };

export const UNKNOWN_RECORD: RecordAnswer = Object.freeze({ kind: "unknown" });

export type SuggestionRecorder = {
  readonly record: (input: RecordInput) => Promise<RecordAnswer>;
};

// Whether a value is exactly the item of its type: one practice area id, or
// one to ten distinct jurisdiction ids, and nothing else.
export function isSuggestionValue(
  type: unknown,
  value: unknown,
): value is SuggestionValue {
  if (type === "practice_category") {
    return isUuid(
      readExact(value, ["practice_area_id"])?.get("practice_area_id"),
    );
  }
  if (type === "potentially_relevant_jurisdictions") {
    return (
      readSuggestedJurisdictions(
        readExact(value, ["jurisdiction_ids"])?.get("jurisdiction_ids"),
      ) !== null
    );
  }
  return false;
}

// Whether every argument of one recording call is within the database's own
// bounds, so nothing else can reach the privileged call.
export function isRecordInput(input: unknown): input is RecordInput {
  const fields = readExact(input, [
    "userId",
    "intakeId",
    "revisionNumber",
    "type",
    "value",
    "modelReference",
    "generatedAt",
  ]);
  const model = fields?.get("modelReference");
  return (
    fields !== null &&
    isUuid(fields.get("userId")) &&
    isUuid(fields.get("intakeId")) &&
    isRevisionNumber(fields.get("revisionNumber")) &&
    isOneOf(SUGGESTION_TYPES, fields.get("type")) &&
    isSuggestionValue(fields.get("type"), fields.get("value")) &&
    typeof model === "string" &&
    MODEL_REFERENCE.test(model) &&
    isTimestamp(fields.get("generatedAt"))
  );
}

// The recording function's one row, read strictly; anything else is
// unknown, so nothing is ever presented that the database did not record.
export function recordAnswerOf(data: unknown): RecordAnswer {
  if (!Array.isArray(data) || data.length !== 1) {
    return UNKNOWN_RECORD;
  }
  const row = readExact(data[0], ["outcome", "suggestion_id"]);
  const outcome = row?.get("outcome");
  const id = row?.get("suggestion_id");
  if (outcome === "recorded") {
    return isUuid(id)
      ? Object.freeze({ kind: "recorded", suggestionId: id })
      : UNKNOWN_RECORD;
  }
  return isOneOf(RECORD_OUTCOMES, outcome) && id === null
    ? Object.freeze({
        kind: "refused",
        outcome: outcome as Exclude<RecordOutcome, "recorded">,
      })
    : UNKNOWN_RECORD;
}

// ---------------------------------------------------------------------------
// The request use case
// ---------------------------------------------------------------------------

export type AiSuggestionSources = ClientIntakeSources & {
  // The provider port, or null when none is configured.
  readonly provider: () => IntakeSuggestionProvider | null;
  // The server-only recording port, or null without a verified binding.
  readonly recorder: () => Promise<SuggestionRecorder | null>;
  readonly clock: () => number;
};

export type SuggestionActionState =
  | { readonly status: "idle" }
  | { readonly status: "suggested"; readonly count: number }
  | { readonly status: "no-suggestion" }
  | { readonly status: "ai-unavailable" }
  | { readonly status: "conflict" }
  | { readonly status: "not-editable" }
  | { readonly status: "not-found" }
  | { readonly status: "rate-limited" }
  | { readonly status: "outcome-unknown" }
  | Refusal;

export const INITIAL_SUGGESTION_STATE: SuggestionActionState = Object.freeze({
  status: "idle",
});

const fixed = <S extends SuggestionActionState["status"]>(status: S) =>
  Object.freeze({ status }) as { readonly status: S };

const STATES = Object.freeze({
  noSuggestion: fixed("no-suggestion"),
  aiUnavailable: fixed("ai-unavailable"),
  conflict: fixed("conflict"),
  notEditable: fixed("not-editable"),
  notFound: fixed("not-found"),
  rateLimited: fixed("rate-limited"),
  outcomeUnknown: fixed("outcome-unknown"),
});

function singleValue(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  return values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : null;
}

type Accepted = {
  readonly type: SuggestionType;
  readonly value: SuggestionValue;
};

function named(entries: readonly CatalogEntry[]) {
  return Object.freeze(
    entries.map((entry) => Object.freeze({ id: entry.id, name: entry.name })),
  );
}

// The client's saved statements in their question wording and catalog
// names; an explicit "not sure" is shown as the question's own label.
function statementsOf(
  definition: Definition,
  answers: Readonly<Record<string, unknown>>,
  practiceAreaId: string | null,
  areas: readonly CatalogEntry[],
  jurisdictions: readonly CatalogEntry[],
): SuggestionRequest["answers"] {
  const statements: { question: string; answer: string }[] = [];
  for (const q of definition.questions) {
    const value = answers[q.id];
    if (q.kind === "practice_area") {
      const area = areas.find((a) => a.id === practiceAreaId);
      if (area !== undefined) {
        statements.push({ question: q.prompt, answer: area.name });
      } else if (value === NOT_SURE) {
        statements.push({ question: q.prompt, answer: q.notSureLabel });
      }
    } else if (q.kind === "jurisdictions") {
      if (value === NOT_SURE) {
        statements.push({ question: q.prompt, answer: q.notSureLabel });
      } else if (Array.isArray(value)) {
        statements.push({
          question: q.prompt,
          answer: value
            .map((id) => jurisdictions.find((j) => j.id === id)?.name)
            .filter((name): name is string => typeof name === "string")
            .join(", "),
        });
      }
    } else if (typeof value === "string") {
      const choice = q.choices.find((c) => c.id === value);
      if (choice !== undefined) {
        statements.push({ question: q.prompt, answer: choice.label });
      }
    }
  }
  return Object.freeze(statements.map((s) => Object.freeze(s)));
}

// The items of an answer that are exactly one permitted class naming only
// current catalog entries, at most one per class; everything else is
// discarded inference.
function acceptedItems(
  items: readonly unknown[],
  classes: readonly SuggestionType[],
  areas: readonly CatalogEntry[],
  jurisdictions: readonly CatalogEntry[],
): readonly Accepted[] {
  const accepted: Accepted[] = [];
  for (const item of items.slice(0, SUGGESTION_TYPES.length * 2)) {
    const practice = readExact(item, ["type", "practiceAreaId"]);
    const places = readExact(item, ["type", "jurisdictionIds"]);
    if (
      practice?.get("type") === "practice_category" &&
      classes.includes("practice_category") &&
      !accepted.some((a) => a.type === "practice_category")
    ) {
      const id = practice.get("practiceAreaId");
      if (isUuid(id) && areas.some((a) => a.id === id && a.active)) {
        accepted.push(
          Object.freeze({
            type: "practice_category",
            value: Object.freeze({ practice_area_id: id }),
          }),
        );
      }
    } else if (
      places?.get("type") === "potentially_relevant_jurisdictions" &&
      classes.includes("potentially_relevant_jurisdictions") &&
      !accepted.some((a) => a.type === "potentially_relevant_jurisdictions")
    ) {
      const ids = readSuggestedJurisdictions(places.get("jurisdictionIds"));
      if (
        ids !== null &&
        ids.length <= MAX_SUGGESTED_JURISDICTIONS &&
        ids.every((id) => jurisdictions.some((j) => j.id === id))
      ) {
        accepted.push(
          Object.freeze({
            type: "potentially_relevant_jurisdictions",
            value: Object.freeze({ jurisdiction_ids: ids }),
          }),
        );
      }
    }
  }
  return Object.freeze(accepted);
}

// The provider answer read strictly: null when unavailable or malformed
// (both mean nothing can be presented).
function answerOf(answer: unknown): {
  readonly modelReference: string;
  readonly items: readonly unknown[];
} | null {
  const unavailable = readExact(answer, ["kind"]);
  if (unavailable?.get("kind") === "unavailable") {
    return null;
  }
  const fields = readExact(answer, ["kind", "modelReference", "items"]);
  const model = fields?.get("modelReference");
  const items = fields?.get("items");
  return fields?.get("kind") === "suggestions" &&
    typeof model === "string" &&
    MODEL_REFERENCE.test(model) &&
    Array.isArray(items)
    ? { modelReference: model, items }
    : null;
}

// Asks for suggestions on the client's own draft Intake, from the revision
// the page showed. Nothing is stored unless the provider answered a
// permitted suggestion and the database recorded it for presentation.
export async function requestIntakeSuggestions(
  sources: AiSuggestionSources,
  formData: unknown,
): Promise<SuggestionActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const intakeId = singleValue(formData, "intake");
    const expected = singleValue(formData, "expected_revision");
    if (!isUuid(intakeId)) {
      return STATES.notFound;
    }
    if (expected === null || !/^[1-9][0-9]{0,8}$/.test(expected)) {
      return STATES.conflict;
    }
    const content = await intakeContentOf(sources, intakeId);
    if (!("client" in content)) {
      return content.status === "not-found" ? STATES.notFound : content;
    }
    if (content.state !== "draft") {
      return STATES.notEditable;
    }
    if (
      content.latest === null ||
      content.definition === null ||
      content.latest.revisionNumber !== Number(expected)
    ) {
      return STATES.conflict;
    }
    let provider: IntakeSuggestionProvider | null = null;
    try {
      provider = sources.provider();
    } catch {
      provider = null;
    }
    if (provider === null) {
      return STATES.aiUnavailable;
    }
    const definition = content.definition;
    const classes = Object.freeze(
      SUGGESTION_TYPES.filter((type) =>
        definition.questions.some((q) =>
          type === "practice_category"
            ? q.kind === "practice_area"
            : q.kind === "jurisdictions",
        ),
      ),
    );
    if (classes.length === 0) {
      return STATES.noSuggestion;
    }
    const activeAreas = content.areas.filter((a) => a.active);
    const request: SuggestionRequest = Object.freeze({
      classes,
      description: content.latest.description,
      answers: statementsOf(
        definition,
        content.latest.answers,
        content.latest.practiceAreaId,
        content.areas,
        content.jurisdictions,
      ),
      practiceAreas: named(activeAreas),
      jurisdictions: named(content.jurisdictions),
    });
    const generated = answerOf(
      await attempt(() =>
        (provider as IntakeSuggestionProvider).suggest(request),
      ),
    );
    if (generated === null) {
      return STATES.aiUnavailable;
    }
    const generatedAt = new Date(sources.clock()).toISOString();
    const accepted = acceptedItems(
      generated.items,
      classes,
      activeAreas,
      content.jurisdictions,
    );
    if (accepted.length === 0) {
      return STATES.noSuggestion;
    }
    const recorder = await portFrom(sources.recorder);
    if (recorder === null) {
      return STATES.aiUnavailable;
    }
    let recorded = 0;
    let refusal: SuggestionActionState | null = null;
    for (const item of accepted) {
      const answer = await attempt(() =>
        recorder.record(
          Object.freeze({
            userId: content.client.userId,
            intakeId,
            revisionNumber: content.latest?.revisionNumber as number,
            type: item.type,
            value: item.value,
            modelReference: generated.modelReference,
            generatedAt,
          }),
        ),
      );
      const kind = readExact(answer, ["kind", "suggestionId"]);
      const refused = readExact(answer, ["kind", "outcome"]);
      if (
        kind?.get("kind") === "recorded" &&
        isUuid(kind.get("suggestionId"))
      ) {
        recorded += 1;
      } else if (refused?.get("kind") === "refused") {
        switch (refused.get("outcome")) {
          case "stale":
            refusal ??= STATES.conflict;
            break;
          case "not_editable":
            refusal ??= STATES.notEditable;
            break;
          case "not_found":
            refusal ??= STATES.notFound;
            break;
          case "rate_limited":
            refusal ??= STATES.rateLimited;
            break;
          default:
            refusal ??= STATES.noSuggestion;
        }
      } else {
        refusal ??= STATES.outcomeUnknown;
      }
    }
    if (recorded > 0) {
      return Object.freeze({ status: "suggested", count: recorded });
    }
    return refusal ?? STATES.noSuggestion;
  } catch {
    return UNAVAILABLE;
  }
}
