// Server-only client intake adapter (P5-001).
//
// Builds the client intake ports for one request. Every read goes through
// the request-scoped, unprivileged server client under the database's
// own-row policies, keyed only by the verified account, User, Client
// Profile, and Intake ids the application boundary derives; the two catalog
// reads are the client catalog functions. Every change is one client database
// function called through that same client, so the database decides the actor
// from the request's own authenticated session. No privileged credential or
// client is used or seen here. Every call is bounded in time; anything that
// fails, throws, or is too slow is reported as unreadable, and a write's
// answer is read strictly against that function's own outcomes.

import {
  ASSESSMENT_COLUMNS,
  CLIENT_PROFILE_COLUMNS,
  CLOSE_OUTCOMES,
  CREATE_OUTCOMES,
  INTAKE_COLUMNS,
  QUESTION_SET_COLUMNS,
  REVISION_COLUMNS,
  REVISION_SUMMARY_COLUMNS,
  SAVE_OUTCOMES,
  SUBMIT_OUTCOMES,
  type CallAnswer,
  type ClientIntakeReads,
  type ClientIntakeSources,
  type ClientIntakeWrites,
  type RevisionInput,
} from "../../application/client-intake.ts";
import {
  rowsResultOf,
  USER_COLUMNS,
  withinDeadline,
} from "../../application/professional-identity.ts";
import { CLIENT_PRINCIPAL_SOURCE } from "../identity/client-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";

const MAX_INTAKES = 200;
const MAX_REVISION_SUMMARIES = 5000;
const MAX_VERSIONS = 200;
const MAX_ASSESSMENTS = 100;

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;

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
// connection-class errors and operator interventions, which can end a
// session around its commit.
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

// A scalar text function's answer.
export function textAnswerOf(
  result: unknown,
  outcomes: readonly string[],
): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const data = ownField(result, "data");
  return typeof data === "string" && outcomes.includes(data)
    ? Object.freeze({ kind: "answer", outcome: data, value: null })
    : UNREADABLE;
}

// A set-returning function's one row, { outcome, <valueColumn> }.
export function rowAnswerOf(
  result: unknown,
  outcomes: readonly string[],
  valueColumn: string,
): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return UNREADABLE;
  }
  const row = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).length !== 2
  ) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  const value = ownField(row, valueColumn);
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome) ||
    !(value === null || typeof value === "string" || typeof value === "number")
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome, value });
}

export function createClientIntakeReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientIntakeReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        usersOf: async (accountId: string) =>
          rowsResultOf(
            await client
              .from("users")
              .select(USER_COLUMNS)
              .eq("auth_user_id", accountId)
              .limit(2),
          ),
        clientProfilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("client_profiles")
              .select(CLIENT_PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        intakesOf: async (clientId: string) =>
          rowsResultOf(
            await client
              .from("intakes")
              .select(INTAKE_COLUMNS)
              .eq("client_id", clientId)
              .order("created_at", { ascending: false })
              .limit(MAX_INTAKES + 1),
          ),
        intakeOf: async (clientId: string, intakeId: string) =>
          rowsResultOf(
            await client
              .from("intakes")
              .select(INTAKE_COLUMNS)
              .eq("id", intakeId)
              .eq("client_id", clientId)
              .limit(2),
          ),
        revisionSummariesOf: async (intakeIds: readonly string[]) =>
          rowsResultOf(
            await client
              .from("intake_revisions")
              .select(REVISION_SUMMARY_COLUMNS)
              .in("intake_id", [...intakeIds])
              .order("revision_number", { ascending: false })
              .limit(MAX_REVISION_SUMMARIES),
          ),
        latestRevisionOf: async (intakeId: string) =>
          rowsResultOf(
            await client
              .from("intake_revisions")
              .select(REVISION_COLUMNS)
              .eq("intake_id", intakeId)
              .order("revision_number", { ascending: false })
              .limit(1),
          ),
        questionSets: async () =>
          rowsResultOf(
            await client
              .from("intake_question_sets")
              .select(QUESTION_SET_COLUMNS)
              .order("published_at", { ascending: false })
              .limit(MAX_VERSIONS),
          ),
        assessmentsOf: async (intakeId: string) =>
          rowsResultOf(
            await client
              .from("jurisdiction_assessments")
              .select(ASSESSMENT_COLUMNS)
              .eq("intake_id", intakeId)
              .order("created_at", { ascending: true })
              .limit(MAX_ASSESSMENTS),
          ),
        practiceAreas: async () =>
          rowsResultOf(await client.rpc("client_intake_practice_areas")),
        jurisdictions: async () =>
          rowsResultOf(await client.rpc("client_intake_jurisdictions")),
      },
      deadlineMs,
    );
  };
}

function boundedWrite(
  work: () => Promise<CallAnswer>,
  deadlineMs: number,
): Promise<CallAnswer> {
  return withinDeadline(work, UNREADABLE, deadlineMs);
}

export function createClientIntakeWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientIntakeWrites | null> {
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
    return Object.freeze({
      createIntake: () =>
        boundedWrite(
          async () =>
            rowAnswerOf(
              await client.rpc("client_create_intake"),
              CREATE_OUTCOMES,
              "intake_id",
            ),
          deadlineMs,
        ),
      saveRevision: (input: RevisionInput) =>
        boundedWrite(
          async () =>
            rowAnswerOf(
              await client.rpc("client_save_intake_revision", {
                p_intake_id: input.intakeId,
                p_expected_revision: input.expectedRevision,
                p_question_set_id: input.questionSetId,
                p_practice_area_id: input.practiceAreaId,
                p_description: input.description,
                p_answers: input.answers,
              }),
              SAVE_OUTCOMES,
              "revision_number",
            ),
          deadlineMs,
        ),
      submitIntake: (intakeId: string, expectedRevision: number | null) =>
        boundedWrite(
          async () =>
            textAnswerOf(
              await client.rpc("client_submit_intake", {
                p_intake_id: intakeId,
                p_expected_revision: expectedRevision,
              }),
              SUBMIT_OUTCOMES,
            ),
          deadlineMs,
        ),
      closeIntake: (intakeId: string) =>
        boundedWrite(
          async () =>
            textAnswerOf(
              await client.rpc("client_close_intake", {
                p_intake_id: intakeId,
              }),
              CLOSE_OUTCOMES,
            ),
          deadlineMs,
        ),
    } satisfies ClientIntakeWrites);
  };
}

// The production sources: the trusted server session, the trusted client
// principal source for the Security Shell, a fresh Auth read, and the
// request-scoped ports above.
export const CLIENT_INTAKE_SOURCES: ClientIntakeSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  contexts: CLIENT_PRINCIPAL_SOURCE,
  account: createRequestAccountSource(),
  reads: createClientIntakeReads(),
  writes: createClientIntakeWrites(),
});
