// Server-only completion adapter (MVP-001 S11).
//
// Builds the ports of the completion workspaces for one request: the
// participants' cancellation and the attorney's early completion, the
// client's Consultation list, the staff consultation operations and review
// items, Verified Client Reviews, the Complaint foundation and Legal Holds.
// Every database call goes through the request-scoped, unprivileged server
// client (the publishable key and the request's own cookie session), so the
// database decides the actor, the aal2 session, the participant, the
// capability and its jurisdiction from the request's own authenticated
// session. Each function is called by its literal name, exactly once in this
// module. No privileged credential or client is used or seen here, and
// nothing reads a table directly. Every call is bounded in time; anything
// that fails, throws, or is too slow is reported as unreadable, a malformed
// identifier is refused before anything is sent, and each answer is read
// strictly against its own fixed outcomes. Each such failure writes one log
// line naming the call and how it failed (the error code and HTTP status
// only, MVP-001 D-8), and nothing the call carried or answered.
//
// The production sources join these ports to the trusted server session, the
// client intake sources (the verified client), the attorney principal source,
// the staff configuration sources (the verified staff identity and its
// capabilities), the finance adapter's two review item changes (the database
// decides by the item's own family), the server-side environment setting and
// one bounded worker run.

import {
  CANCEL_OUTCOMES,
  END_EARLY_OUTCOMES,
  RECORD_OUTCOMES,
  REVIEW_FAMILIES,
  STAFF_OUTCOME_CODES,
  type AttorneyOutcomeSources,
  type ClientOutcomeSources,
  type ExceptionStatus,
  type OperationsReads,
  type OperationsSources,
  type OperationsWrites,
  type ParticipantOutcomeReads,
  type ParticipantOutcomeWrites,
  type ReviewFamily,
  type StaffOutcomeCode,
} from "../../application/consultation-outcomes.ts";
import {
  CASE_ACTIONS,
  COMPLAINT_STATES,
  DECIDE_OUTCOMES,
  MAX_STATEMENT,
  OPEN_OUTCOMES,
  UPDATE_OUTCOMES,
  type AttorneyComplaintSources,
  type CaseAction,
  type ClientComplaintSources,
  type ComplaintReads,
  type ComplaintState,
  type ComplaintWrites,
  type StaffComplaintSources,
} from "../../application/complaints.ts";
import {
  HOLD_SCOPES,
  HOLD_STATUSES,
  MAX_HOLD_REASON,
  PLACE_OUTCOMES,
  RELEASE_OUTCOMES,
  type HoldScope,
  type HoldStatus,
  type LegalHoldReads,
  type LegalHoldSources,
  type LegalHoldWrites,
} from "../../application/legal-holds.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { isTimestamp } from "../../application/professional-records.ts";
import {
  MAX_REVIEW_TEXT,
  MODERATE_OUTCOMES,
  MODERATION_DECISIONS,
  RATINGS,
  REVIEW_STATES,
  SUBMIT_OUTCOMES,
  type AttorneyReviewSources,
  type ClientReviewSources,
  type ModerationDecision,
  type ModerationSources,
  type PublicReviewReads,
  type PublicReviewSources,
  type Rating,
  type ReviewReads,
  type ReviewState,
  type ReviewWrites,
} from "../../application/reviews.ts";
import type { CommandAnswer } from "../../application/workspace-support.ts";
import { CLIENT_INTAKE_SOURCES } from "../client/client-intake-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import {
  AFTER_COMMIT_BOUNDS,
  drainOperationalJobs,
} from "../jobs/job-worker-adapter.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import { createFinanceWrites } from "../payments/payment-adapter.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../staff/staff-configuration-adapter.ts";

const CALL_FAILED = "completion.call_failed";
const EXPIRED = Symbol("expired");

const REJECTED = Object.freeze({ kind: "rejected" } as const);
const UNREADABLE = Object.freeze({ kind: "unreadable" } as const);

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
// The staff list offsets the database pages by (25 rows a page).
const MAX_OFFSET = 100000;

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// A database error inside the call (its transaction rolled back), excluding
// connection-class errors and operator interventions.
function rejectedCall(result: unknown): boolean {
  const code = ownField(ownField(result, "error"), "code");
  const status = ownField(result, "status");
  return (
    typeof code === "string" &&
    SQLSTATE.test(code) &&
    !code.startsWith("08") &&
    !code.startsWith("57P") &&
    typeof status === "number" &&
    status >= 400 &&
    status <= 599
  );
}

// The one row of a table-returning command with exactly these keys, or null.
function oneRow(result: unknown, keys: readonly string[]): object | null {
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return null;
  }
  const row: unknown = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key))
  ) {
    return null;
  }
  return row;
}

// One extra column of a command's row: null, an identifier, an instant or a
// lower-snake code (the problem or the window basis).
function plainValue(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      (UUID.test(value) || isTimestamp(value) || CODE.test(value)))
  );
}

// A table-returning command's one row: { outcome, ...plain columns }. The
// first extra column (the identifier or instant of the success) accompanies
// exactly the success.
export function rowAnswerOf(
  result: unknown,
  keys: readonly string[],
  outcomes: readonly string[],
  success: string,
  successKey: string,
): CommandAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const row = oneRow(result, ["outcome", ...keys]);
  if (row === null) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome) ||
    !keys.every((key) => plainValue(ownField(row, key))) ||
    (outcome === success) !== (ownField(row, successKey) !== null)
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome });
}

// A text-returning command's answer: one of its fixed outcomes.
export function textAnswerOf(
  result: unknown,
  outcomes: readonly string[],
): CommandAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const outcome = ownField(result, "data");
  return typeof outcome === "string" && outcomes.includes(outcome)
    ? Object.freeze({ kind: "answer", outcome })
    : UNREADABLE;
}

export const cancelAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(
    result,
    ["problem", "cancelled_at"],
    CANCEL_OUTCOMES,
    "cancelled",
    "cancelled_at",
  );
export const endEarlyAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(
    result,
    ["problem", "ended_at"],
    END_EARLY_OUTCOMES,
    "completed",
    "ended_at",
  );
export const recordAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(
    result,
    ["problem", "recorded_at", "closes_at"],
    RECORD_OUTCOMES,
    "recorded",
    "recorded_at",
  );
export const submitAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(result, ["review_id"], SUBMIT_OUTCOMES, "submitted", "review_id");
export const openAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(
    result,
    ["complaint_case_id"],
    OPEN_OUTCOMES,
    "opened",
    "complaint_case_id",
  );
export const placeAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(
    result,
    ["legal_hold_id"],
    PLACE_OUTCOMES,
    "placed",
    "legal_hold_id",
  );

function failureOf(result: unknown): LogFields {
  const status = ownField(result, "status");
  return {
    ...errorFieldsOf(ownField(result, "error")),
    ...(typeof status === "number" ? { status } : {}),
  };
}

type Observation<T> = {
  readonly answer: T;
  readonly failure: LogFields | null;
};

// Runs one call within the deadline; a call that threw, failed, or ran out
// of time answers the fallback and writes one log line.
async function observed<T>(
  operation: string,
  deadlineMs: number,
  fallback: T,
  call: () => Promise<Observation<T>>,
): Promise<T> {
  const settled = await withinDeadline<Observation<T> | typeof EXPIRED>(
    async () => {
      try {
        return await call();
      } catch (error) {
        return {
          answer: fallback,
          failure: { outcome: "threw", ...errorFieldsOf(error) },
        };
      }
    },
    EXPIRED,
    deadlineMs,
  );
  if (settled === EXPIRED) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      outcome: "deadline",
    });
    return fallback;
  }
  if (settled.failure !== null) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...settled.failure,
    });
  }
  return settled.answer;
}

type QueryAnswer = { readonly data: unknown; readonly error: unknown };

function observedRead(
  operation: string,
  deadlineMs: number,
  query: () => PromiseLike<QueryAnswer>,
): Promise<RowsResult> {
  return observed(operation, deadlineMs, UNREADABLE_ROWS, async () => {
    const result = await query();
    const rows = rowsResultOf(result);
    return {
      answer: rows,
      failure:
        rows.kind === "rows"
          ? null
          : {
              outcome: result.error === null ? "malformed" : "error",
              ...failureOf(result),
            },
    };
  });
}

function observedWrite(
  operation: string,
  deadlineMs: number,
  call: () => PromiseLike<unknown>,
  read: (result: unknown) => CommandAnswer,
): Promise<CommandAnswer> {
  return observed<CommandAnswer>(
    operation,
    deadlineMs,
    UNREADABLE,
    async () => {
      const result = await call();
      const answer = read(result);
      return {
        answer,
        failure:
          answer.kind === "answer"
            ? null
            : { outcome: answer.kind, ...failureOf(result) },
      };
    },
  );
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isOffset = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_OFFSET &&
  (value as number) % 25 === 0;
const isListed = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T => list.some((entry) => entry === value);

const refusedRead = () => Promise.resolve(UNREADABLE_ROWS);
const refusedWrite = () => Promise.resolve<CommandAnswer>(REJECTED);

// Every call of this module, bound to one request client. Each database
// function is named exactly once, here.
function callsOf(client: RequestClient, deadlineMs: number) {
  return Object.freeze({
    environmentIdentity: () =>
      observedRead("deployment_environment_identity", deadlineMs, () =>
        client.rpc("deployment_environment_identity"),
      ),
    clientList: () =>
      observedRead("client_consultations", deadlineMs, () =>
        client.rpc("client_consultations"),
      ),
    clientParties: () =>
      observedRead("client_consultation_parties", deadlineMs, () =>
        client.rpc("client_consultation_parties"),
      ),
    cancel: (consultationId: string) =>
      isId(consultationId)
        ? observedWrite(
            "consultation_cancel",
            deadlineMs,
            () =>
              client.rpc("consultation_cancel", {
                p_consultation_id: consultationId,
              }),
            cancelAnswerOf,
          )
        : refusedWrite(),
    endEarly: (consultationId: string) =>
      isId(consultationId)
        ? observedWrite(
            "consultation_end_early",
            deadlineMs,
            () =>
              client.rpc("consultation_end_early", {
                p_consultation_id: consultationId,
              }),
            endEarlyAnswerOf,
          )
        : refusedWrite(),
    stale: (offset: number) =>
      isOffset(offset)
        ? observedRead("staff_stale_consultations", deadlineMs, () =>
            client.rpc("staff_stale_consultations", { p_offset: offset }),
          )
        : refusedRead(),
    consultation: (consultationId: string) =>
      isId(consultationId)
        ? observedRead("staff_consultation", deadlineMs, () =>
            client.rpc("staff_consultation", {
              p_consultation_id: consultationId,
            }),
          )
        : refusedRead(),
    exceptions: (
      family: ReviewFamily,
      status: ExceptionStatus,
      offset: number,
    ) =>
      isListed(REVIEW_FAMILIES, family) &&
      (status === "open" || status === "resolved") &&
      isOffset(offset)
        ? observedRead("staff_review_exceptions", deadlineMs, () =>
            client.rpc("staff_review_exceptions", {
              p_family: family,
              p_status: status,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    recordOutcome: (
      consultationId: string,
      outcomeCode: StaffOutcomeCode,
      acknowledgeConflict: boolean,
    ) =>
      isId(consultationId) &&
      isListed(STAFF_OUTCOME_CODES, outcomeCode) &&
      typeof acknowledgeConflict === "boolean"
        ? observedWrite(
            "staff_record_consultation_outcome",
            deadlineMs,
            () =>
              client.rpc("staff_record_consultation_outcome", {
                p_consultation_id: consultationId,
                p_outcome_code: outcomeCode,
                p_acknowledge_evidence_conflict: acknowledgeConflict,
              }),
            recordAnswerOf,
          )
        : refusedWrite(),
    clientReviews: () =>
      observedRead("client_reviews", deadlineMs, () =>
        client.rpc("client_reviews"),
      ),
    attorneyReviews: () =>
      observedRead("attorney_reviews", deadlineMs, () =>
        client.rpc("attorney_reviews"),
      ),
    reviewQueue: (state: ReviewState, offset: number) =>
      isListed(REVIEW_STATES, state) && isOffset(offset)
        ? observedRead("staff_review_queue", deadlineMs, () =>
            client.rpc("staff_review_queue", {
              p_state: state,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    publicReviews: (attorneyId: string) =>
      isId(attorneyId)
        ? observedRead("public_attorney_reviews", deadlineMs, () =>
            client.rpc("public_attorney_reviews", {
              p_attorney_id: attorneyId,
            }),
          )
        : refusedRead(),
    submit: (consultationId: string, rating: Rating, text: string | null) =>
      isId(consultationId) &&
      RATINGS.some((entry) => entry === rating) &&
      (text === null ||
        (typeof text === "string" &&
          text.trim() !== "" &&
          text.length <= MAX_REVIEW_TEXT))
        ? observedWrite(
            "review_submit",
            deadlineMs,
            () =>
              client.rpc("review_submit", {
                p_consultation_id: consultationId,
                p_rating: rating,
                p_review_text: text,
              }),
            submitAnswerOf,
          )
        : refusedWrite(),
    moderate: (reviewId: string, decision: ModerationDecision) =>
      isId(reviewId) && isListed(MODERATION_DECISIONS, decision)
        ? observedWrite(
            "staff_moderate_review",
            deadlineMs,
            () =>
              client.rpc("staff_moderate_review", {
                p_review_id: reviewId,
                p_decision: decision,
              }),
            (result) => textAnswerOf(result, MODERATE_OUTCOMES),
          )
        : refusedWrite(),
    mine: () =>
      observedRead("complaint_cases_mine", deadlineMs, () =>
        client.rpc("complaint_cases_mine"),
      ),
    complaintQueue: (state: ComplaintState, offset: number) =>
      isListed(COMPLAINT_STATES, state) && isOffset(offset)
        ? observedRead("staff_complaint_queue", deadlineMs, () =>
            client.rpc("staff_complaint_queue", {
              p_state: state,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    complaintCase: (caseId: string) =>
      isId(caseId)
        ? observedRead("staff_complaint_case", deadlineMs, () =>
            client.rpc("staff_complaint_case", {
              p_complaint_case_id: caseId,
            }),
          )
        : refusedRead(),
    open: (
      consultationId: string | null,
      referralId: string | null,
      statement: string | null,
    ) =>
      (consultationId === null || isId(consultationId)) &&
      (referralId === null || isId(referralId)) &&
      (statement === null ||
        (typeof statement === "string" &&
          statement.trim() !== "" &&
          statement.length <= MAX_STATEMENT))
        ? observedWrite(
            "complaint_open",
            deadlineMs,
            () =>
              client.rpc("complaint_open", {
                p_consultation_id: consultationId,
                p_referral_id: referralId,
                p_statement: statement,
              }),
            openAnswerOf,
          )
        : refusedWrite(),
    update: (caseId: string, action: CaseAction) =>
      isId(caseId) && isListed(CASE_ACTIONS, action)
        ? observedWrite(
            "staff_update_complaint",
            deadlineMs,
            () =>
              client.rpc("staff_update_complaint", {
                p_complaint_case_id: caseId,
                p_action: action,
              }),
            (result) => textAnswerOf(result, UPDATE_OUTCOMES),
          )
        : refusedWrite(),
    classify: (caseId: string, code: string) =>
      isId(caseId) && typeof code === "string" && CODE.test(code)
        ? observedWrite(
            "staff_classify_complaint",
            deadlineMs,
            () =>
              client.rpc("staff_classify_complaint", {
                p_complaint_case_id: caseId,
                p_category_code: code,
              }),
            (result) => textAnswerOf(result, DECIDE_OUTCOMES),
          )
        : refusedWrite(),
    resolve: (caseId: string, code: string) =>
      isId(caseId) && typeof code === "string" && CODE.test(code)
        ? observedWrite(
            "staff_resolve_complaint",
            deadlineMs,
            () =>
              client.rpc("staff_resolve_complaint", {
                p_complaint_case_id: caseId,
                p_resolution_code: code,
              }),
            (result) => textAnswerOf(result, DECIDE_OUTCOMES),
          )
        : refusedWrite(),
    holds: (status: HoldStatus, offset: number) =>
      isListed(HOLD_STATUSES, status) && isOffset(offset)
        ? observedRead("staff_legal_holds", deadlineMs, () =>
            client.rpc("staff_legal_holds", {
              p_status: status,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    place: (scope: HoldScope, scopeId: string, reason: string) =>
      isListed(HOLD_SCOPES, scope) &&
      isId(scopeId) &&
      typeof reason === "string" &&
      reason.trim() !== "" &&
      reason.length <= MAX_HOLD_REASON
        ? observedWrite(
            "staff_place_legal_hold",
            deadlineMs,
            () =>
              client.rpc("staff_place_legal_hold", {
                p_scope_type: scope,
                p_scope_id: scopeId,
                p_reason: reason,
              }),
            placeAnswerOf,
          )
        : refusedWrite(),
    release: (holdId: string) =>
      isId(holdId)
        ? observedWrite(
            "staff_release_legal_hold",
            deadlineMs,
            () =>
              client.rpc("staff_release_legal_hold", {
                p_legal_hold_id: holdId,
              }),
            (result) => textAnswerOf(result, RELEASE_OUTCOMES),
          )
        : refusedWrite(),
  });
}

type Calls = ReturnType<typeof callsOf>;

// One port source: a fresh request client per port, every call bounded.
function portSource<Port extends object>(
  pick: (calls: Calls) => Port,
  clientSource: RequestClientSource,
  deadlineMs: number,
): () => Promise<Port | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client: RequestClient | null = await withinDeadline(
      clientSource,
      null,
      deadlineMs,
    );
    if (client === null) {
      return null;
    }
    return boundedPort(
      pick(callsOf(client, deadlineMs)) as never,
      deadlineMs,
    ) as Port;
  };
}

export function createParticipantOutcomeReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ParticipantOutcomeReads | null> {
  return portSource(
    (calls): ParticipantOutcomeReads => ({
      clientList: calls.clientList,
      clientParties: calls.clientParties,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createParticipantOutcomeWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ParticipantOutcomeWrites | null> {
  return portSource(
    (calls): ParticipantOutcomeWrites => ({
      cancel: calls.cancel,
      endEarly: calls.endEarly,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createOperationsReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<OperationsReads | null> {
  return portSource(
    (calls): OperationsReads => ({
      stale: calls.stale,
      consultation: calls.consultation,
      exceptions: calls.exceptions,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createOperationsWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<OperationsWrites | null> {
  return portSource(
    (calls): OperationsWrites => ({ recordOutcome: calls.recordOutcome }),
    clientSource,
    deadlineMs,
  );
}

export function createReviewReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ReviewReads | null> {
  return portSource(
    (calls): ReviewReads => ({
      clientReviews: calls.clientReviews,
      attorneyReviews: calls.attorneyReviews,
      queue: calls.reviewQueue,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createReviewWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ReviewWrites | null> {
  return portSource(
    (calls): ReviewWrites => ({
      submit: calls.submit,
      moderate: calls.moderate,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createPublicReviewReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<PublicReviewReads | null> {
  return portSource(
    (calls): PublicReviewReads => ({ attorneyReviews: calls.publicReviews }),
    clientSource,
    deadlineMs,
  );
}

export function createComplaintReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ComplaintReads | null> {
  return portSource(
    (calls): ComplaintReads => ({
      mine: calls.mine,
      queue: calls.complaintQueue,
      complaintCase: calls.complaintCase,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createComplaintWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ComplaintWrites | null> {
  return portSource(
    (calls): ComplaintWrites => ({
      open: calls.open,
      update: calls.update,
      classify: calls.classify,
      resolve: calls.resolve,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createLegalHoldReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<LegalHoldReads | null> {
  return portSource(
    (calls): LegalHoldReads => ({
      list: calls.holds,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createLegalHoldWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<LegalHoldWrites | null> {
  return portSource(
    (calls): LegalHoldWrites => ({
      place: calls.place,
      release: calls.release,
    }),
    clientSource,
    deadlineMs,
  );
}

const environment = () => readEnvironmentConfiguration();
const drain = async () => {
  await drainOperationalJobs(AFTER_COMMIT_BOUNDS);
};
const ATTORNEY = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  attorney: ATTORNEY_PRINCIPAL_SOURCE,
});

const PARTICIPANT = Object.freeze({
  reads: createParticipantOutcomeReads(),
  writes: createParticipantOutcomeWrites(),
  environment,
  drain,
});

export const CLIENT_OUTCOME_SOURCES: ClientOutcomeSources = Object.freeze({
  ...PARTICIPANT,
  clientIntake: CLIENT_INTAKE_SOURCES,
});

export const ATTORNEY_OUTCOME_SOURCES: AttorneyOutcomeSources = Object.freeze({
  ...PARTICIPANT,
  ...ATTORNEY,
});

export const OPERATIONS_SOURCES: OperationsSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createOperationsReads(),
  writes: createOperationsWrites(),
  exceptionWrites: createFinanceWrites(),
  environment,
  drain,
});

const REVIEWS = Object.freeze({
  reads: createReviewReads(),
  writes: createReviewWrites(),
  environment,
});

export const CLIENT_REVIEW_SOURCES: ClientReviewSources = Object.freeze({
  ...REVIEWS,
  clientIntake: CLIENT_INTAKE_SOURCES,
});

export const ATTORNEY_REVIEW_SOURCES: AttorneyReviewSources = Object.freeze({
  ...REVIEWS,
  ...ATTORNEY,
});

export const MODERATION_SOURCES: ModerationSources = Object.freeze({
  ...REVIEWS,
  staff: STAFF_CONFIGURATION_SOURCES,
});

export const PUBLIC_REVIEW_SOURCES: PublicReviewSources = Object.freeze({
  reads: createPublicReviewReads(),
});

const COMPLAINTS = Object.freeze({
  reads: createComplaintReads(),
  writes: createComplaintWrites(),
  environment,
});

export const CLIENT_COMPLAINT_SOURCES: ClientComplaintSources = Object.freeze({
  ...COMPLAINTS,
  clientIntake: CLIENT_INTAKE_SOURCES,
});

export const ATTORNEY_COMPLAINT_SOURCES: AttorneyComplaintSources =
  Object.freeze({
    ...COMPLAINTS,
    ...ATTORNEY,
  });

export const STAFF_COMPLAINT_SOURCES: StaffComplaintSources = Object.freeze({
  ...COMPLAINTS,
  staff: STAFF_CONFIGURATION_SOURCES,
});

export const LEGAL_HOLD_SOURCES: LegalHoldSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createLegalHoldReads(),
  writes: createLegalHoldWrites(),
  environment,
});
