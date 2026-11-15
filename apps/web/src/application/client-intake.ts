// Client intake (P5-001, M5 first slice).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Every read and change first asks the unchanged Security Shell for the
// client principal context, then establishes afresh, on the server, the
// trusted session subject, a fresh Auth read of that account with a
// confirmed email, the account's one active Rosuno User, and that User's own
// Client Profile. Nothing the browser sends chooses an identity, User,
// profile, lifecycle state, or authority: a submitted Intake id only names
// which of the client's own Intakes to act on, the expected revision is a
// stale-page token, and the version choice is one of exactly two named
// options (the draft's own version, or the current one) that the server
// resolves itself.
//
// Intake content is append-only: each save is one immutable revision, and
// nothing here edits, deletes, or reinterprets an earlier one. Questions and
// limits are read from the published, immutable question-set versions; this
// module holds no question wording, choice, or limit of its own. Every change
// is one call of one client database function through the request's own
// authenticated session; the database decides again, on locked rows and for
// the session's own identity, and only its own answer is reported. Category
// and jurisdiction answers are the client's statements: nothing here
// classifies, routes, decides eligibility, or decides which law applies.

import {
  activeUserOf,
  attempt,
  confirmedAccountOf,
  DENIED,
  portFrom,
  rowsOf,
  SIGN_IN_REQUIRED,
  UNAVAILABLE,
  type AccountSource,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import {
  answersProblem,
  carryOver,
  characterCount,
  NOT_SURE,
  readQuestionSet,
  type AnswerProblem,
  type Answers,
  type AnswerValue,
  type Definition,
  type QuestionSet,
} from "./intake-question-set.ts";
import {
  authorize,
  type CapabilitySource,
  type PrincipalContextSource,
  type SecurityRequirement,
} from "./security.ts";
import type { ServerSessionSource } from "./session.ts";

export { QUESTION_SET_COLUMNS } from "./intake-question-set.ts";

export const CLIENT_PROFILE_COLUMNS = "id, user_id";
export const INTAKE_COLUMNS = "id, client_id, state, created_at, closed_at";
export const REVISION_SUMMARY_COLUMNS =
  "intake_id, revision_number, created_at";
export const REVISION_COLUMNS =
  "intake_id, revision_number, question_set_id, practice_area_id, description, structured_answers, created_at";
export const ASSESSMENT_COLUMNS =
  "jurisdiction_id, source_type, review_status, created_at";

export const INTAKE_STATES = Object.freeze([
  "draft",
  "submitted",
  "active",
  "expired",
  "superseded",
  "closed",
] as const);

export type IntakeState = (typeof INTAKE_STATES)[number];

// Request-scoped, unprivileged reads under the database's own-row policies,
// keyed only by the verified account, User, Client Profile, and Intake, plus
// the two client catalog functions.
export type ClientIntakeReads = {
  readonly usersOf: (accountId: string) => Promise<RowsResult>;
  readonly clientProfilesOf: (userId: string) => Promise<RowsResult>;
  readonly intakesOf: (clientId: string) => Promise<RowsResult>;
  readonly intakeOf: (
    clientId: string,
    intakeId: string,
  ) => Promise<RowsResult>;
  readonly revisionSummariesOf: (
    intakeIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly latestRevisionOf: (intakeId: string) => Promise<RowsResult>;
  readonly questionSets: () => Promise<RowsResult>;
  readonly assessmentsOf: (intakeId: string) => Promise<RowsResult>;
  readonly practiceAreas: () => Promise<RowsResult>;
  readonly jurisdictions: () => Promise<RowsResult>;
};

export type RevisionInput = {
  readonly intakeId: string;
  readonly expectedRevision: number | null;
  readonly questionSetId: string;
  readonly practiceAreaId: string | null;
  readonly description: string | null;
  readonly answers: Answers;
};

// One write call's answer as the adapter reports it: the function's own
// outcome (with its identifier or revision number, when it returns one);
// "rejected" when the database raised an error inside the call, so nothing
// committed; or "unreadable" when the outcome is unknown.
export type CallAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly value: string | number | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export const CREATE_OUTCOMES = Object.freeze([
  "created",
  "denied",
  "rate_limited",
  "unavailable",
] as const);
export const SAVE_OUTCOMES = Object.freeze([
  "saved",
  "unchanged",
  "conflict",
  "version_not_allowed",
  "invalid",
  "not_editable",
  "rate_limited",
  "not_found",
  "unavailable",
] as const);
export const SUBMIT_OUTCOMES = Object.freeze([
  "submitted",
  "already_submitted",
  "conflict",
  "incomplete",
  "needs_update",
  "not_editable",
  "not_found",
  "unavailable",
] as const);
export const CLOSE_OUTCOMES = Object.freeze([
  "closed",
  "already_closed",
  "not_found",
  "unavailable",
] as const);

// Request-scoped write port: each call is one client database function run
// for the request's own authenticated session. None takes an actor, User, or
// Client Profile; the database derives the caller itself.
export type ClientIntakeWrites = {
  readonly createIntake: () => Promise<CallAnswer>;
  readonly saveRevision: (input: RevisionInput) => Promise<CallAnswer>;
  readonly submitIntake: (
    intakeId: string,
    expectedRevision: number | null,
  ) => Promise<CallAnswer>;
  readonly closeIntake: (intakeId: string) => Promise<CallAnswer>;
};

export type ClientIntakeSources = {
  readonly session: ServerSessionSource;
  // The trusted client principal source the Security Shell consults.
  readonly contexts: PrincipalContextSource;
  readonly account: AccountSource;
  readonly reads: () => Promise<ClientIntakeReads | null>;
  readonly writes: () => Promise<ClientIntakeWrites | null>;
};

const CLIENT_REQUIREMENT: SecurityRequirement = Object.freeze({
  context: "client",
});

// No client intake operation requires a capability.
const NO_CAPABILITIES: CapabilitySource = Object.freeze({
  isGranted: async () => false,
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

type ClientContext = { readonly userId: string; readonly clientId: string };

// The verified client of the request, or a fixed refusal. The Security Shell
// decides the client context first; the Client Profile is then read only by
// the verified User id.
async function clientContextOf(
  sources: ClientIntakeSources,
  reads: ClientIntakeReads,
): Promise<ClientContext | Refusal> {
  const authorization = await authorize(
    {
      session: sources.session,
      contexts: sources.contexts,
      capabilities: NO_CAPABILITIES,
    },
    CLIENT_REQUIREMENT,
  );
  if (authorization.status === "unauthenticated") {
    return SIGN_IN_REQUIRED;
  }
  if (authorization.status === "forbidden") {
    return DENIED;
  }
  if (authorization.status !== "authorized") {
    return UNAVAILABLE;
  }
  const account = await confirmedAccountOf(sources.session, sources.account);
  if (!("accountId" in account)) {
    return account;
  }
  const user = await activeUserOf(reads.usersOf, account.accountId);
  if (!("userId" in user)) {
    return user;
  }
  const profiles = rowsOf(
    await attempt(() => reads.clientProfilesOf(user.userId)),
  );
  if (profiles === null || profiles.length > 1) {
    return UNAVAILABLE;
  }
  if (profiles.length === 0) {
    return DENIED;
  }
  const profile = readExact(profiles[0], CLIENT_PROFILE_COLUMNS.split(", "));
  const clientId = profile?.get("id");
  if (!isUuid(clientId) || profile?.get("user_id") !== user.userId) {
    return UNAVAILABLE;
  }
  return { userId: user.userId, clientId };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type IntakeRecord = {
  readonly id: string;
  readonly clientId: string;
  readonly state: IntakeState;
  readonly createdAt: string;
  readonly closedAt: string | null;
};

function readIntake(row: unknown): IntakeRecord | null {
  const fields = readExact(row, INTAKE_COLUMNS.split(", "));
  if (fields === null) {
    return null;
  }
  const id = fields.get("id");
  const clientId = fields.get("client_id");
  const state = fields.get("state");
  const createdAt = fields.get("created_at");
  const closedAt = fields.get("closed_at");
  if (
    !isUuid(id) ||
    !isUuid(clientId) ||
    !isOneOf(INTAKE_STATES, state) ||
    !isTimestamp(createdAt) ||
    (closedAt !== null && !isTimestamp(closedAt))
  ) {
    return null;
  }
  return Object.freeze({
    id,
    clientId,
    state,
    createdAt,
    closedAt: closedAt as string | null,
  });
}

type RevisionSummary = {
  readonly intakeId: string;
  readonly revisionNumber: number;
  readonly createdAt: string;
};

function readRevisionSummary(row: unknown): RevisionSummary | null {
  const fields = readExact(row, REVISION_SUMMARY_COLUMNS.split(", "));
  const intakeId = fields?.get("intake_id");
  const revisionNumber = fields?.get("revision_number");
  const createdAt = fields?.get("created_at");
  if (
    !isUuid(intakeId) ||
    !Number.isSafeInteger(revisionNumber) ||
    (revisionNumber as number) < 1 ||
    !isTimestamp(createdAt)
  ) {
    return null;
  }
  return Object.freeze({
    intakeId,
    revisionNumber: revisionNumber as number,
    createdAt,
  });
}

type RevisionRecord = RevisionSummary & {
  readonly questionSetId: string;
  readonly practiceAreaId: string | null;
  readonly description: string | null;
  readonly answers: Answers;
};

function readAnswerValue(value: unknown): AnswerValue | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return Object.freeze([...value]);
  }
  return null;
}

function readRevision(row: unknown): RevisionRecord | null {
  const fields = readExact(row, REVISION_COLUMNS.split(", "));
  if (fields === null) {
    return null;
  }
  const summary = readRevisionSummary({
    intake_id: fields.get("intake_id"),
    revision_number: fields.get("revision_number"),
    created_at: fields.get("created_at"),
  });
  const questionSetId = fields.get("question_set_id");
  const practiceAreaId = fields.get("practice_area_id");
  const description = fields.get("description");
  const raw = fields.get("structured_answers");
  if (
    summary === null ||
    !isUuid(questionSetId) ||
    (practiceAreaId !== null && !isUuid(practiceAreaId)) ||
    (description !== null && typeof description !== "string") ||
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return null;
  }
  const answers: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    const read = readAnswerValue(value);
    if (read === null) {
      return null;
    }
    answers[key] = read;
  }
  return Object.freeze({
    ...summary,
    questionSetId,
    practiceAreaId: practiceAreaId as string | null,
    description: description as string | null,
    answers: Object.freeze(answers),
  });
}

type CatalogEntry = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
};

function readPracticeAreaEntry(row: unknown): CatalogEntry | null {
  const fields = readExact(row, ["id", "code", "name", "active"]);
  const id = fields?.get("id");
  const code = fields?.get("code");
  const name = fields?.get("name");
  const active = fields?.get("active");
  return isUuid(id) &&
    typeof code === "string" &&
    typeof name === "string" &&
    name.trim() !== "" &&
    typeof active === "boolean"
    ? Object.freeze({ id, code, name, active })
    : null;
}

function readJurisdictionEntry(row: unknown): CatalogEntry | null {
  const fields = readExact(row, ["id", "code", "name"]);
  const id = fields?.get("id");
  const code = fields?.get("code");
  const name = fields?.get("name");
  return isUuid(id) &&
    typeof code === "string" &&
    typeof name === "string" &&
    name.trim() !== ""
    ? Object.freeze({ id, code, name, active: true })
    : null;
}

type Assessment = {
  readonly jurisdictionId: string;
  readonly sourceType: string;
  readonly reviewStatus: string | null;
};

function readAssessment(row: unknown): Assessment | null {
  const fields = readExact(row, ASSESSMENT_COLUMNS.split(", "));
  const jurisdictionId = fields?.get("jurisdiction_id");
  const sourceType = fields?.get("source_type");
  const reviewStatus = fields?.get("review_status");
  const createdAt = fields?.get("created_at");
  return isUuid(jurisdictionId) &&
    typeof sourceType === "string" &&
    (reviewStatus === null || typeof reviewStatus === "string") &&
    isTimestamp(createdAt)
    ? Object.freeze({
        jurisdictionId,
        sourceType,
        reviewStatus: reviewStatus as string | null,
      })
    : null;
}

function listOf<T>(
  result: unknown,
  reader: (row: unknown) => T | null,
): readonly T[] | null {
  const rows = rowsOf(result);
  return rows === null ? null : readRows(rows, reader);
}

// Every published version, newest first, or null when any is unreadable.
async function questionSetsOf(
  reads: ClientIntakeReads,
): Promise<readonly QuestionSet[] | null> {
  const sets = listOf(
    await attempt(() => reads.questionSets()),
    readQuestionSet,
  );
  if (sets === null) {
    return null;
  }
  return Object.freeze(
    [...sets].sort(
      (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
    ),
  );
}

async function ownIntakeOf(
  reads: ClientIntakeReads,
  context: ClientContext,
  intakeId: string,
): Promise<IntakeRecord | null | "unreadable"> {
  const intakes = listOf(
    await attempt(() => reads.intakeOf(context.clientId, intakeId)),
    readIntake,
  );
  if (intakes === null || intakes.length > 1) {
    return "unreadable";
  }
  const [intake] = intakes;
  if (intake === undefined) {
    return null;
  }
  return intake.id === intakeId && intake.clientId === context.clientId
    ? intake
    : "unreadable";
}

async function latestRevisionOf(
  reads: ClientIntakeReads,
  intakeId: string,
): Promise<RevisionRecord | null | "unreadable"> {
  const revisions = listOf(
    await attempt(() => reads.latestRevisionOf(intakeId)),
    readRevision,
  );
  if (revisions === null || revisions.length > 1) {
    return "unreadable";
  }
  const [revision] = revisions;
  if (revision === undefined) {
    return null;
  }
  return revision.intakeId === intakeId ? revision : "unreadable";
}

// ---------------------------------------------------------------------------
// Workspace view
// ---------------------------------------------------------------------------

export type IntakeSummary = {
  readonly id: string;
  readonly state: IntakeState;
  readonly createdAt: string;
  readonly lastSavedAt: string | null;
  readonly revisions: number;
};

export type WorkspaceView =
  | Refusal
  | {
      readonly status: "ready";
      readonly intakes: readonly IntakeSummary[];
      // Whether a published question set exists, so an Intake can start.
      readonly canStart: boolean;
    };

const MAX_INTAKES = 200;

export async function resolveClientWorkspace(
  sources: ClientIntakeSources,
): Promise<WorkspaceView> {
  try {
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const context = await clientContextOf(sources, reads);
    if (!("clientId" in context)) {
      return context;
    }
    const intakes = listOf(
      await attempt(() => reads.intakesOf(context.clientId)),
      readIntake,
    );
    if (
      intakes === null ||
      intakes.length > MAX_INTAKES ||
      intakes.some((intake) => intake.clientId !== context.clientId)
    ) {
      return UNAVAILABLE;
    }
    const ids = intakes.map((intake) => intake.id);
    const summaries =
      ids.length === 0
        ? []
        : listOf(
            await attempt(() => reads.revisionSummariesOf(ids)),
            readRevisionSummary,
          );
    if (
      summaries === null ||
      summaries.some((s) => !ids.includes(s.intakeId))
    ) {
      return UNAVAILABLE;
    }
    const sets = await questionSetsOf(reads);
    if (sets === null) {
      return UNAVAILABLE;
    }
    const view = intakes
      .map((intake) => {
        const own = summaries.filter((s) => s.intakeId === intake.id);
        const latest = own.reduce<RevisionSummary | null>(
          (best, s) =>
            best === null || s.revisionNumber > best.revisionNumber ? s : best,
          null,
        );
        return Object.freeze({
          id: intake.id,
          state: intake.state,
          createdAt: intake.createdAt,
          lastSavedAt: latest?.createdAt ?? null,
          revisions: latest?.revisionNumber ?? 0,
        });
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return Object.freeze({
      status: "ready",
      intakes: Object.freeze(view),
      canStart: sets.length > 0,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Intake view
// ---------------------------------------------------------------------------

export type Option = { readonly value: string; readonly label: string };

type QuestionViewBase = {
  readonly id: string;
  readonly field: string;
  readonly prompt: string;
  readonly help: string | null;
  readonly required: boolean;
};

export type QuestionView =
  | (QuestionViewBase & {
      readonly kind: "practice_area";
      readonly notSureLabel: string;
      readonly options: readonly Option[];
      // A practice-area id, "not_sure", or "" when unanswered.
      readonly value: string;
      readonly answerLabel: string | null;
    })
  | (QuestionViewBase & {
      readonly kind: "jurisdictions";
      readonly notSureLabel: string;
      readonly options: readonly Option[];
      // Jurisdiction ids, ["not_sure"], or [] when unanswered.
      readonly values: readonly string[];
      readonly answerLabels: readonly string[];
    })
  | (QuestionViewBase & {
      readonly kind: "single_choice";
      readonly choices: readonly Option[];
      readonly value: string;
      readonly answerLabel: string | null;
    });

// What the client stated about jurisdiction, for the suggestion wording.
export type JurisdictionStatement =
  | { readonly kind: "unanswered" }
  | { readonly kind: "not_sure" }
  | { readonly kind: "stated"; readonly names: readonly string[] };

export type IntakeView =
  | Refusal
  | { readonly status: "not-found" }
  | {
      readonly status: "ready";
      readonly intakeId: string;
      readonly state: IntakeState;
      readonly editable: boolean;
      readonly closable: boolean;
      // Which version the form shows: the draft's own (governing) version,
      // or the current one after the client chose to move to it.
      readonly version: "governing" | "current";
      readonly versionKey: string;
      // The draft's own version is older than the current one.
      readonly updateAvailable: boolean;
      readonly latestRevision: number | null;
      readonly lastSavedAt: string | null;
      readonly questions: readonly QuestionView[];
      readonly description: {
        readonly prompt: string;
        readonly help: string | null;
        readonly required: boolean;
        readonly maxCharacters: number;
        readonly value: string;
      };
      readonly practiceArea: "selected" | "not_sure" | "unanswered";
      readonly jurisdiction: JurisdictionStatement;
      // Unreviewed client-statement suggestions recorded at submission.
      readonly suggestedJurisdictions: readonly string[];
    };

export const QUESTION_FIELD_PREFIX = "q:";

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

function questionViews(
  definition: Definition,
  answers: Answers,
  practiceAreaId: string | null,
  areas: readonly CatalogEntry[],
  jurisdictions: readonly CatalogEntry[],
): readonly QuestionView[] {
  return Object.freeze(
    definition.questions.map((q): QuestionView => {
      const base = {
        id: q.id,
        field: `${QUESTION_FIELD_PREFIX}${q.id}`,
        prompt: q.prompt,
        help: q.help,
        required: q.required,
      };
      const answer = answers[q.id];
      if (q.kind === "practice_area") {
        const value = practiceAreaId ?? (answer === NOT_SURE ? NOT_SURE : "");
        const selected = areas.find((area) => area.id === practiceAreaId);
        return Object.freeze({
          ...base,
          kind: "practice_area",
          notSureLabel: q.notSureLabel,
          options: Object.freeze(
            areas
              .filter((area) => area.active || area.id === practiceAreaId)
              .map((area) =>
                Object.freeze({
                  value: area.id,
                  label: area.active
                    ? area.name
                    : `${area.name} (no longer offered)`,
                }),
              ),
          ),
          value,
          answerLabel:
            value === ""
              ? null
              : value === NOT_SURE
                ? q.notSureLabel
                : (selected?.name ?? null),
        });
      }
      if (q.kind === "jurisdictions") {
        const values =
          answer === NOT_SURE
            ? [NOT_SURE]
            : Array.isArray(answer)
              ? [...answer]
              : [];
        return Object.freeze({
          ...base,
          kind: "jurisdictions",
          notSureLabel: q.notSureLabel,
          options: Object.freeze(
            jurisdictions.map((j) =>
              Object.freeze({ value: j.id, label: j.name }),
            ),
          ),
          values: Object.freeze(values),
          answerLabels: Object.freeze(
            values.map((value) =>
              value === NOT_SURE
                ? q.notSureLabel
                : (jurisdictions.find((j) => j.id === value)?.name ??
                  "Unknown"),
            ),
          ),
        });
      }
      const value = typeof answer === "string" ? answer : "";
      return Object.freeze({
        ...base,
        kind: "single_choice",
        choices: Object.freeze(
          q.choices.map((choice) =>
            Object.freeze({ value: choice.id, label: choice.label }),
          ),
        ),
        value,
        answerLabel:
          q.choices.find((choice) => choice.id === value)?.label ?? null,
      });
    }),
  );
}

async function catalogsOf(reads: ClientIntakeReads): Promise<{
  readonly areas: readonly CatalogEntry[];
  readonly jurisdictions: readonly CatalogEntry[];
} | null> {
  const areas = listOf(
    await attempt(() => reads.practiceAreas()),
    readPracticeAreaEntry,
  );
  const jurisdictions = listOf(
    await attempt(() => reads.jurisdictions()),
    readJurisdictionEntry,
  );
  return areas === null || jurisdictions === null
    ? null
    : { areas, jurisdictions };
}

export async function resolveIntake(
  sources: ClientIntakeSources,
  intakeId: unknown,
  showCurrentVersion: boolean,
): Promise<IntakeView> {
  try {
    if (!isUuid(intakeId)) {
      return NOT_FOUND;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const context = await clientContextOf(sources, reads);
    if (!("clientId" in context)) {
      return context;
    }
    const intake = await ownIntakeOf(reads, context, intakeId);
    if (intake === "unreadable") {
      return UNAVAILABLE;
    }
    if (intake === null) {
      return NOT_FOUND;
    }
    const latest = await latestRevisionOf(reads, intakeId);
    const sets = await questionSetsOf(reads);
    const catalogs = await catalogsOf(reads);
    if (latest === "unreadable" || sets === null || catalogs === null) {
      return UNAVAILABLE;
    }
    const current = sets[0];
    const governing =
      latest === null
        ? null
        : (sets.find((set) => set.id === latest.questionSetId) ?? null);
    if (
      (latest !== null && governing === null) ||
      (latest === null && current === undefined)
    ) {
      return UNAVAILABLE;
    }
    const editable = intake.state === "draft";
    const updateAvailable =
      editable &&
      governing !== null &&
      current !== undefined &&
      governing.id !== current.id;
    const useCurrent = updateAvailable && showCurrentVersion;
    const shown = useCurrent ? current : (governing ?? current);
    if (shown === undefined) {
      return UNAVAILABLE;
    }
    const answers =
      latest === null
        ? {}
        : useCurrent && governing !== null
          ? carryOver(shown.definition, governing.definition, latest.answers)
          : latest.answers;
    let practiceAreaId = latest?.practiceAreaId ?? null;
    if (
      practiceAreaId !== null &&
      !shown.definition.questions.some((q) => q.kind === "practice_area")
    ) {
      practiceAreaId = null;
    }
    const questions = questionViews(
      shown.definition,
      answers,
      practiceAreaId,
      catalogs.areas,
      catalogs.jurisdictions,
    );
    const areaQuestion = questions.find((q) => q.kind === "practice_area");
    const jurisdictionQuestion = questions.find(
      (q) => q.kind === "jurisdictions",
    );
    let suggested: readonly string[] = [];
    if (intake.state !== "draft") {
      const assessments = listOf(
        await attempt(() => reads.assessmentsOf(intakeId)),
        readAssessment,
      );
      if (assessments === null) {
        return UNAVAILABLE;
      }
      suggested = Object.freeze(
        assessments
          .filter((a) => a.sourceType === "client_statement")
          .map(
            (a) =>
              catalogs.jurisdictions.find((j) => j.id === a.jurisdictionId)
                ?.name ?? "Unknown",
          ),
      );
    }
    const jurisdictionStatement: JurisdictionStatement =
      jurisdictionQuestion?.kind !== "jurisdictions" ||
      jurisdictionQuestion.values.length === 0
        ? { kind: "unanswered" }
        : jurisdictionQuestion.values[0] === NOT_SURE
          ? { kind: "not_sure" }
          : { kind: "stated", names: jurisdictionQuestion.answerLabels };
    return Object.freeze({
      status: "ready",
      intakeId,
      state: intake.state,
      editable,
      closable: isOneOf(
        ["draft", "submitted", "active"] as const,
        intake.state,
      ),
      version: useCurrent ? "current" : "governing",
      versionKey: shown.versionKey,
      updateAvailable,
      latestRevision: latest?.revisionNumber ?? null,
      lastSavedAt: latest?.createdAt ?? null,
      questions,
      description: Object.freeze({
        prompt: shown.definition.description.prompt,
        help: shown.definition.description.help,
        required: shown.definition.description.required,
        maxCharacters: shown.definition.limits.descriptionMaxCharacters,
        value: latest?.description ?? "",
      }),
      practiceArea:
        areaQuestion?.kind !== "practice_area" || areaQuestion.value === ""
          ? "unanswered"
          : areaQuestion.value === NOT_SURE
            ? "not_sure"
            : "selected",
      jurisdiction: jurisdictionStatement,
      suggestedJurisdictions: suggested,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export type ClientIntakeActionState =
  | { readonly status: "idle" }
  | { readonly status: "created"; readonly intakeId: string }
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "unchanged" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "conflict" }
  | { readonly status: "version-not-allowed" }
  | { readonly status: "not-editable" }
  | { readonly status: "rate-limited" }
  | { readonly status: "submitted" }
  | { readonly status: "already-submitted" }
  | { readonly status: "incomplete" }
  | { readonly status: "needs-update" }
  | { readonly status: "closed" }
  | { readonly status: "already-closed" }
  | { readonly status: "not-found" }
  | { readonly status: "outcome-unknown" }
  | Refusal;

export const INITIAL_CLIENT_INTAKE_STATE: ClientIntakeActionState =
  Object.freeze({ status: "idle" });

const fixed = <S extends ClientIntakeActionState["status"]>(status: S) =>
  Object.freeze({ status }) as { readonly status: S };

const STATES = Object.freeze({
  unchanged: fixed("unchanged"),
  conflict: fixed("conflict"),
  versionNotAllowed: fixed("version-not-allowed"),
  notEditable: fixed("not-editable"),
  rateLimited: fixed("rate-limited"),
  submitted: fixed("submitted"),
  alreadySubmitted: fixed("already-submitted"),
  incomplete: fixed("incomplete"),
  needsUpdate: fixed("needs-update"),
  closed: fixed("closed"),
  alreadyClosed: fixed("already-closed"),
  notFound: fixed("not-found"),
  outcomeUnknown: fixed("outcome-unknown"),
});

function invalid(
  fieldErrors: Record<string, string[]>,
): ClientIntakeActionState {
  return Object.freeze({
    status: "invalid",
    fieldErrors: Object.freeze(
      Object.fromEntries(
        Object.entries(fieldErrors).map(([field, messages]) => [
          field,
          Object.freeze([...messages]),
        ]),
      ),
    ),
  });
}

function ownField(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// One write call's answer, read strictly against the function's outcomes.
function answerOf<T extends string>(
  answer: unknown,
  outcomes: readonly T[],
): { readonly outcome: T; readonly value: unknown } | "rejected" | "unknown" {
  try {
    if (answer === null || typeof answer !== "object") {
      return "unknown";
    }
    const kind = ownField(answer, "kind");
    if (kind === "rejected") {
      return "rejected";
    }
    if (kind !== "answer") {
      return "unknown";
    }
    const outcome = ownField(answer, "outcome");
    return isOneOf(outcomes, outcome)
      ? { outcome, value: ownField(answer, "value") }
      : "unknown";
  } catch {
    return "unknown";
  }
}

function singleValue(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") {
    return null;
  }
  return values[0];
}

function intakeIdOf(formData: FormData): string | null {
  const value = singleValue(formData, "intake");
  return isUuid(value) ? value : null;
}

// The expected revision token: "" for none, or a positive whole number.
function expectedRevisionOf(formData: FormData): number | null | undefined {
  const value = singleValue(formData, "expected_revision");
  if (value === null) {
    return undefined;
  }
  if (value === "") {
    return null;
  }
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

type ParsedContent = {
  readonly answers: Answers;
  readonly practiceAreaId: string | null;
  readonly description: string | null;
};

const CHOOSE_LISTED = "Choose one of the listed options.";

function contentOf(
  definition: Definition,
  formData: FormData,
  areas: readonly CatalogEntry[],
  jurisdictions: readonly CatalogEntry[],
):
  | { readonly content: ParsedContent }
  | { readonly errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  const answers: Record<string, AnswerValue> = {};
  let practiceAreaId: string | null = null;
  for (const q of definition.questions) {
    const field = `${QUESTION_FIELD_PREFIX}${q.id}`;
    const values = formData.getAll(field);
    if (values.some((value) => typeof value !== "string")) {
      errors[field] = [CHOOSE_LISTED];
      continue;
    }
    const strings = values as string[];
    if (q.kind === "jurisdictions") {
      const chosen = [...new Set(strings.filter((value) => value !== ""))];
      if (chosen.includes(NOT_SURE)) {
        if (chosen.length > 1) {
          errors[field] = [
            `Choose one or more states, or ${q.notSureLabel}, but not both.`,
          ];
        } else {
          answers[q.id] = NOT_SURE;
        }
      } else if (chosen.length > 0) {
        if (chosen.some((id) => !jurisdictions.some((j) => j.id === id))) {
          errors[field] = [CHOOSE_LISTED];
        } else {
          answers[q.id] = Object.freeze(chosen);
        }
      }
      continue;
    }
    if (strings.length > 1) {
      errors[field] = [CHOOSE_LISTED];
      continue;
    }
    const value = strings[0] ?? "";
    if (value === "") {
      continue;
    }
    if (q.kind === "practice_area") {
      if (value === NOT_SURE) {
        answers[q.id] = NOT_SURE;
      } else if (areas.some((area) => area.id === value && area.active)) {
        practiceAreaId = value;
      } else {
        errors[field] = [
          areas.some((area) => area.id === value)
            ? "That category is no longer offered. Choose another, or Not sure."
            : CHOOSE_LISTED,
        ];
      }
    } else if (q.choices.some((choice) => choice.id === value)) {
      answers[q.id] = value;
    } else {
      errors[field] = [CHOOSE_LISTED];
    }
  }
  const rawDescription = formData.getAll("description");
  let description: string | null = null;
  if (
    rawDescription.length > 1 ||
    rawDescription.some((v) => typeof v !== "string")
  ) {
    errors.description = ["Enter your description as plain text."];
  } else {
    const text = ((rawDescription[0] as string | undefined) ?? "").trim();
    if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      errors.description = [
        "Remove the unsupported characters from your description.",
      ];
    } else if (
      characterCount(text) > definition.limits.descriptionMaxCharacters
    ) {
      errors.description = [
        `Keep your description to ${definition.limits.descriptionMaxCharacters} characters or fewer.`,
      ];
    } else if (text !== "") {
      description = text;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    content: Object.freeze({
      answers: Object.freeze(answers),
      practiceAreaId,
      description,
    }),
  };
}

function problemErrors(problem: AnswerProblem): Record<string, string[]> {
  return problem === "answers_size"
    ? {
        submit: [
          "Your answers are too long to save. Shorten them and try again.",
        ],
      }
    : {
        submit: ["Some answers could not be saved. Check them and try again."],
      };
}

async function writableContext(sources: ClientIntakeSources): Promise<
  | {
      readonly reads: ClientIntakeReads;
      readonly writes: ClientIntakeWrites;
      readonly context: ClientContext;
    }
  | Refusal
> {
  const reads = await portFrom(sources.reads);
  const writes = await portFrom(sources.writes);
  if (reads === null || writes === null) {
    return UNAVAILABLE;
  }
  const context = await clientContextOf(sources, reads);
  if (!("clientId" in context)) {
    return context;
  }
  return { reads, writes, context };
}

export async function startIntake(
  sources: ClientIntakeSources,
): Promise<ClientIntakeActionState> {
  try {
    const writable = await writableContext(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const answer = answerOf(
      await attempt(() => writable.writes.createIntake()),
      CREATE_OUTCOMES,
    );
    if (answer === "rejected") {
      return UNAVAILABLE;
    }
    if (answer === "unknown") {
      return STATES.outcomeUnknown;
    }
    switch (answer.outcome) {
      case "created":
        return isUuid(answer.value)
          ? Object.freeze({ status: "created", intakeId: answer.value })
          : STATES.outcomeUnknown;
      case "rate_limited":
        return STATES.rateLimited;
      case "denied":
        return DENIED;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

export async function saveIntakeRevision(
  sources: ClientIntakeSources,
  formData: unknown,
): Promise<ClientIntakeActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const intakeId = intakeIdOf(formData);
    if (intakeId === null) {
      return STATES.notFound;
    }
    const expected = expectedRevisionOf(formData);
    const version = singleValue(formData, "version");
    if (
      expected === undefined ||
      (version !== "governing" && version !== "current")
    ) {
      return STATES.conflict;
    }
    const writable = await writableContext(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { reads, writes, context } = writable;
    const intake = await ownIntakeOf(reads, context, intakeId);
    if (intake === "unreadable") {
      return UNAVAILABLE;
    }
    if (intake === null) {
      return STATES.notFound;
    }
    if (intake.state !== "draft") {
      return STATES.notEditable;
    }
    const latest = await latestRevisionOf(reads, intakeId);
    const sets = await questionSetsOf(reads);
    const catalogs = await catalogsOf(reads);
    if (latest === "unreadable" || sets === null || catalogs === null) {
      return UNAVAILABLE;
    }
    if (expected !== (latest?.revisionNumber ?? null)) {
      return STATES.conflict;
    }
    const current = sets[0];
    if (current === undefined) {
      return UNAVAILABLE;
    }
    const target =
      version === "current" || latest === null
        ? current
        : sets.find((set) => set.id === latest.questionSetId);
    if (target === undefined) {
      return UNAVAILABLE;
    }
    const parsed = contentOf(
      target.definition,
      formData,
      catalogs.areas,
      catalogs.jurisdictions,
    );
    if ("errors" in parsed) {
      return invalid(parsed.errors);
    }
    const { content } = parsed;
    const problem = answersProblem(
      target.definition,
      content.answers,
      content.practiceAreaId,
      false,
      new Set(catalogs.jurisdictions.map((j) => j.id)),
    );
    if (problem !== null) {
      return invalid(problemErrors(problem));
    }
    if (
      content.practiceAreaId === null &&
      content.description === null &&
      Object.keys(content.answers).length === 0
    ) {
      return invalid({
        submit: [
          "Answer at least one question or add a description before saving.",
        ],
      });
    }
    const answer = answerOf(
      await attempt(() =>
        writes.saveRevision(
          Object.freeze({
            intakeId,
            expectedRevision: expected,
            questionSetId: target.id,
            practiceAreaId: content.practiceAreaId,
            description: content.description,
            answers: content.answers,
          }),
        ),
      ),
      SAVE_OUTCOMES,
    );
    if (answer === "rejected") {
      return UNAVAILABLE;
    }
    if (answer === "unknown") {
      return STATES.outcomeUnknown;
    }
    switch (answer.outcome) {
      case "saved":
        return Number.isSafeInteger(answer.value) &&
          (answer.value as number) >= 1
          ? Object.freeze({ status: "saved", revision: answer.value as number })
          : STATES.outcomeUnknown;
      case "unchanged":
        return STATES.unchanged;
      case "conflict":
        return STATES.conflict;
      case "version_not_allowed":
        return STATES.versionNotAllowed;
      case "invalid":
        return invalid({
          submit: [
            "Some answers could not be saved. Check them and try again.",
          ],
        });
      case "not_editable":
        return STATES.notEditable;
      case "rate_limited":
        return STATES.rateLimited;
      case "not_found":
        return STATES.notFound;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

export async function submitIntake(
  sources: ClientIntakeSources,
  formData: unknown,
): Promise<ClientIntakeActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const intakeId = intakeIdOf(formData);
    if (intakeId === null) {
      return STATES.notFound;
    }
    const expected = expectedRevisionOf(formData);
    if (expected === undefined) {
      return STATES.conflict;
    }
    const writable = await writableContext(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const answer = answerOf(
      await attempt(() => writable.writes.submitIntake(intakeId, expected)),
      SUBMIT_OUTCOMES,
    );
    if (answer === "rejected") {
      return UNAVAILABLE;
    }
    if (answer === "unknown") {
      return STATES.outcomeUnknown;
    }
    switch (answer.outcome) {
      case "submitted":
        return STATES.submitted;
      case "already_submitted":
        return STATES.alreadySubmitted;
      case "conflict":
        return STATES.conflict;
      case "incomplete":
        return STATES.incomplete;
      case "needs_update":
        return STATES.needsUpdate;
      case "not_editable":
        return STATES.notEditable;
      case "not_found":
        return STATES.notFound;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

export async function closeIntake(
  sources: ClientIntakeSources,
  formData: unknown,
): Promise<ClientIntakeActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const intakeId = intakeIdOf(formData);
    if (intakeId === null) {
      return STATES.notFound;
    }
    const writable = await writableContext(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const answer = answerOf(
      await attempt(() => writable.writes.closeIntake(intakeId)),
      CLOSE_OUTCOMES,
    );
    if (answer === "rejected") {
      return UNAVAILABLE;
    }
    if (answer === "unknown") {
      return STATES.outcomeUnknown;
    }
    switch (answer.outcome) {
      case "closed":
        return STATES.closed;
      case "already_closed":
        return STATES.alreadyClosed;
      case "not_found":
        return STATES.notFound;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}
