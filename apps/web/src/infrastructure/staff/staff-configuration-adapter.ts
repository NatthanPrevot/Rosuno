// Server-only staff configuration adapter (MVP-001 S1).
//
// Builds the staff configuration ports for one request. Every read goes
// through the request-scoped, unprivileged server client, so the database's
// own row policies decide what it returns, and every read names its exact
// columns and is paged or bounded by the count the application asks for.
// The capability question is answered by the database's own
// has_staff_capability predicate, called through that same session, so it is
// decided for the caller's own Auth identity and never for an id this module
// passes in. Every change is one operation-specific staff function called
// through that same client with only its named arguments: none carries an
// actor, staff User, grant, or scope, so the database derives and locks the
// caller's authority itself and writes the change with its audit event in
// one transaction. A function's answer is read strictly against that
// function's own outcomes. Nothing privileged is seen or used here. Every
// call is bounded in time; anything that fails, throws, or is too slow is
// unreadable, and each such failure writes one log line naming the call and
// how it failed, with the error code and HTTP status reported, and nothing
// the call carried or answered. MVP-001 S2: the operational job reads and the
// two audited staff job functions (retry, cancel) follow the same rules.

import {
  isUuid,
  PRACTICE_AREA_COLUMNS,
} from "../../application/professional-records.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  USER_COLUMNS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import {
  ADD_REFERENCE_OUTCOMES,
  AUTHORITY_COLUMNS,
  CANCEL_JOB_OUTCOMES,
  CAPABILITY_DEFINITION_COLUMNS,
  CONFIGURATION_JURISDICTION_COLUMNS,
  CONFIGURATION_POLICY_COLUMNS,
  CREATE_JURISDICTION_OUTCOMES,
  CREATE_POLICY_OUTCOMES,
  CREATE_PRACTICE_AREA_OUTCOMES,
  CREATE_SERVICE_AREA_OUTCOMES,
  DECIDE_REFERENCE_OUTCOMES,
  DEFINE_GATE_OUTCOMES,
  END_POLICY_OUTCOMES,
  GATE_EVALUATION_COLUMNS,
  GATE_EVALUATION_OUTCOMES,
  GRANT_CAPABILITY_OUTCOMES,
  GRANT_COLUMNS,
  GRANT_LAUNCH_OUTCOMES,
  JOB_GROUP_STATES,
  JOB_GROUPS,
  LAUNCH_AUTHORIZATION_COLUMNS,
  LAUNCH_GATE_COLUMNS,
  LIFECYCLE_OUTCOMES,
  MEMBER_USER_COLUMNS,
  OPERATIONAL_JOB_COLUMNS,
  POLICY_TYPE_COLUMNS,
  PRACTICE_AREA_ACTIVITY_OUTCOMES,
  PUBLISH_QUESTION_SET_OUTCOMES,
  QUESTION_SET_COLUMNS,
  RETRY_JOB_OUTCOMES,
  REVIEW_ASSESSMENT_OUTCOMES,
  REVIEW_DECISIONS,
  REVIEW_GROUPS,
  REVISE_POLICY_OUTCOMES,
  REVOKE_CAPABILITY_OUTCOMES,
  REVOKE_LAUNCH_OUTCOMES,
  SERVICE_AREA_COLUMNS,
  STAFF_CAPABILITIES,
  TRANSITION_POLICY_OUTCOMES,
  type CallAnswer,
  type CapabilityAnswer,
  type ConfigurationReads,
  type ConfigurationSources,
  type ConfigurationWrites,
  type JobGroup,
  type ReviewDecision,
  type ReviewGroup,
} from "../../application/staff-configuration.ts";
import { STAFF_PROFILE_COLUMNS } from "../../application/staff-verification.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  writeAnswerOf,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";

// The most rows any one read may ask for.
const MAX_COUNT = 1000;

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });
const UNREADABLE_CAPABILITY: CapabilityAnswer = Object.freeze({
  kind: "unreadable",
});

const CALL_FAILED = "staff_configuration.call_failed";
const EXPIRED = Symbol("expired");

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// An error answer: "rejected" when the database raised the error inside the
// call's own transaction (so it rolled back), by the same rule the
// professional write port applies; otherwise unknown.
function errorAnswerOf(result: unknown): CallAnswer {
  return writeAnswerOf(result).kind === "rejected" ? REJECTED : UNREADABLE;
}

// A scalar text function's answer: one of its own outcomes, or unknown.
export function textAnswerOf(
  result: unknown,
  outcomes: readonly string[],
): CallAnswer {
  if (ownField(result, "error") !== null) {
    return errorAnswerOf(result);
  }
  const data = ownField(result, "data");
  return typeof data === "string" && outcomes.includes(data)
    ? Object.freeze({ kind: "answer", outcome: data, value: null })
    : UNREADABLE;
}

// A set-returning function's one row { outcome, <idColumn> }: one of its own
// outcomes with a generated id or null, or unknown.
export function rowAnswerOf(
  result: unknown,
  outcomes: readonly string[],
  idColumn: string,
): CallAnswer {
  if (ownField(result, "error") !== null) {
    return errorAnswerOf(result);
  }
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return UNREADABLE;
  }
  const row: unknown = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 2
  ) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  const value = ownField(row, idColumn);
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome) ||
    !(value === null || isUuid(value))
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome, value });
}

// The error code and HTTP status a call's answer reported, and nothing else.
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

// Runs one call within the deadline. It answers what the call answered, or
// the fallback when the call threw or was still running at the deadline. A
// call that threw, answered with a failure, or ran out of time writes one log
// line; the outcome is never changed by it.
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
  read: (result: unknown) => CallAnswer,
): Promise<CallAnswer> {
  return observed(operation, deadlineMs, UNREADABLE, async () => {
    const result = await call();
    const answer = read(result);
    return {
      answer,
      failure:
        answer.kind === "answer"
          ? null
          : { outcome: answer.kind, ...failureOf(result) },
    };
  });
}

function isCount(count: unknown): count is number {
  return (
    Number.isSafeInteger(count) &&
    (count as number) >= 1 &&
    (count as number) <= MAX_COUNT
  );
}

function isPage(offset: unknown, count: unknown): boolean {
  return (
    Number.isSafeInteger(offset) && (offset as number) >= 0 && isCount(count)
  );
}

// A paged query: the first page skips nothing, so it needs no offset.
type Rangeable<Q> = {
  readonly limit: (count: number) => Q;
  readonly range: (from: number, to: number) => Q;
};
function pageQuery<Q>(query: Rangeable<Q>, offset: number, count: number): Q {
  return offset === 0
    ? query.limit(count)
    : query.range(offset, offset + count - 1);
}

export function createConfigurationReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ConfigurationReads | null> {
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
    const byId =
      (operation: string, table: string, columns: string) => (id: string) =>
        isUuid(id)
          ? observedRead(operation, deadlineMs, () =>
              client.from(table).select(columns).eq("id", id).limit(2),
            )
          : Promise.resolve(UNREADABLE_ROWS);
    return boundedPort(
      {
        usersOf: (accountId: string) =>
          observedRead("usersOf", deadlineMs, () =>
            client
              .from("users")
              .select(USER_COLUMNS)
              .eq("auth_user_id", accountId)
              .limit(2),
          ),
        staffProfilesOf: (userId: string) =>
          observedRead("staffProfilesOf", deadlineMs, () =>
            client
              .from("staff_profiles")
              .select(STAFF_PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        // The one predicate call: a known capability, an exact scope, and
        // only a boolean answer counts.
        holdsCapability: async (
          capability,
          jurisdictionId,
          anyJurisdiction,
        ) => {
          if (
            !STAFF_CAPABILITIES.includes(capability) ||
            (jurisdictionId !== null && !isUuid(jurisdictionId)) ||
            typeof anyJurisdiction !== "boolean"
          ) {
            return UNREADABLE_CAPABILITY;
          }
          return observed(
            "holdsCapability",
            deadlineMs,
            UNREADABLE_CAPABILITY,
            async () => {
              const result = await client.rpc("has_staff_capability", {
                p_capability: capability,
                p_jurisdiction: jurisdictionId,
                p_any_jurisdiction: anyJurisdiction,
              });
              return result.error === null && typeof result.data === "boolean"
                ? {
                    answer: Object.freeze({
                      kind: "answer",
                      granted: result.data,
                    }),
                    failure: null,
                  }
                : {
                    answer: UNREADABLE_CAPABILITY,
                    failure: {
                      outcome: result.error === null ? "malformed" : "error",
                      ...failureOf(result),
                    },
                  };
            },
          );
        },
        // PS-A2 section 5: the database's own environment record.
        environmentIdentity: () =>
          observedRead("environmentIdentity", deadlineMs, () =>
            client.rpc("deployment_environment_identity"),
          ),
        policyTypes: async (count: number) =>
          isCount(count)
            ? observedRead("policyTypes", deadlineMs, () =>
                client
                  .from("policy_types")
                  .select(POLICY_TYPE_COLUMNS)
                  .order("code")
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        policyVersions: async (offset: number, count: number) =>
          isPage(offset, count)
            ? observedRead("policyVersions", deadlineMs, () =>
                pageQuery(
                  client
                    .from("policy_versions")
                    .select(CONFIGURATION_POLICY_COLUMNS)
                    .order("created_at", { ascending: false })
                    .order("id", { ascending: false }),
                  offset,
                  count,
                ),
              )
            : UNREADABLE_ROWS,
        policyVersionById: byId(
          "policyVersionById",
          "policy_versions",
          CONFIGURATION_POLICY_COLUMNS,
        ),
        authorityReferencesOf: async (versionId: string, count: number) =>
          isUuid(versionId) && isCount(count)
            ? observedRead("authorityReferencesOf", deadlineMs, () =>
                client
                  .from("policy_authority_references")
                  .select(AUTHORITY_COLUMNS)
                  .eq("policy_version_id", versionId)
                  .order("created_at")
                  .order("id")
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        authorityReferenceById: byId(
          "authorityReferenceById",
          "policy_authority_references",
          AUTHORITY_COLUMNS,
        ),
        jurisdictions: async (offset: number, count: number) =>
          isPage(offset, count)
            ? observedRead("jurisdictions", deadlineMs, () =>
                pageQuery(
                  client
                    .from("jurisdictions")
                    .select(CONFIGURATION_JURISDICTION_COLUMNS)
                    .order("code")
                    .order("id"),
                  offset,
                  count,
                ),
              )
            : UNREADABLE_ROWS,
        jurisdictionById: byId(
          "jurisdictionById",
          "jurisdictions",
          CONFIGURATION_JURISDICTION_COLUMNS,
        ),
        serviceAreasOf: async (jurisdictionId: string, count: number) =>
          isUuid(jurisdictionId) && isCount(count)
            ? observedRead("serviceAreasOf", deadlineMs, () =>
                client
                  .from("service_areas")
                  .select(SERVICE_AREA_COLUMNS)
                  .eq("jurisdiction_id", jurisdictionId)
                  .order("code")
                  .order("id")
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        launchGatesOf: async (jurisdictionId: string, count: number) =>
          isUuid(jurisdictionId) && isCount(count)
            ? observedRead("launchGatesOf", deadlineMs, () =>
                client
                  .from("launch_gates")
                  .select(LAUNCH_GATE_COLUMNS)
                  .eq("jurisdiction_id", jurisdictionId)
                  .order("gate_code")
                  .order("id")
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        launchGateById: byId(
          "launchGateById",
          "launch_gates",
          LAUNCH_GATE_COLUMNS,
        ),
        // Newest first, in the order the database decides a gate's latest
        // evaluation by.
        gateEvaluationsOf: async (gateId: string, count: number) =>
          isUuid(gateId) && isCount(count)
            ? observedRead("gateEvaluationsOf", deadlineMs, () =>
                client
                  .from("launch_gate_evaluations")
                  .select(GATE_EVALUATION_COLUMNS)
                  .eq("launch_gate_id", gateId)
                  .order("evaluated_at", { ascending: false })
                  .order("id", { ascending: false })
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        launchAuthorizationsOf: async (
          jurisdictionId: string,
          count: number,
        ) =>
          isUuid(jurisdictionId) && isCount(count)
            ? observedRead("launchAuthorizationsOf", deadlineMs, () =>
                client
                  .from("launch_authorizations")
                  .select(LAUNCH_AUTHORIZATION_COLUMNS)
                  .eq("jurisdiction_id", jurisdictionId)
                  .order("authorized_at", { ascending: false })
                  .order("id", { ascending: false })
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        launchAuthorizationById: byId(
          "launchAuthorizationById",
          "launch_authorizations",
          LAUNCH_AUTHORIZATION_COLUMNS,
        ),
        practiceAreas: async (offset: number, count: number) =>
          isPage(offset, count)
            ? observedRead("practiceAreas", deadlineMs, () =>
                pageQuery(
                  client
                    .from("practice_areas")
                    .select(PRACTICE_AREA_COLUMNS)
                    .order("code")
                    .order("id"),
                  offset,
                  count,
                ),
              )
            : UNREADABLE_ROWS,
        staffMembers: async (offset: number, count: number) =>
          isPage(offset, count)
            ? observedRead("staffMembers", deadlineMs, () =>
                pageQuery(
                  client
                    .from("staff_profiles")
                    .select(STAFF_PROFILE_COLUMNS)
                    .order("created_at")
                    .order("id"),
                  offset,
                  count,
                ),
              )
            : UNREADABLE_ROWS,
        // One more row than ids asked for, so an answer can never be cut.
        memberUsers: async (userIds: readonly string[]) => {
          const ids = [...new Set(userIds)];
          return ids.length > 0 && isCount(ids.length) && ids.every(isUuid)
            ? observedRead("memberUsers", deadlineMs, () =>
                client
                  .from("users")
                  .select(MEMBER_USER_COLUMNS)
                  .in("id", ids)
                  .limit(ids.length + 1),
              )
            : UNREADABLE_ROWS;
        },
        grantsOf: async (userId: string, count: number) =>
          isUuid(userId) && isCount(count)
            ? observedRead("grantsOf", deadlineMs, () =>
                client
                  .from("capability_grants")
                  .select(GRANT_COLUMNS)
                  .eq("user_id", userId)
                  .order("granted_at", { ascending: false })
                  .order("id", { ascending: false })
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        capabilityDefinitions: async (count: number) =>
          isCount(count)
            ? observedRead("capabilityDefinitions", deadlineMs, () =>
                client
                  .from("capability_definitions")
                  .select(CAPABILITY_DEFINITION_COLUMNS)
                  .order("capability_code")
                  .limit(count),
              )
            : UNREADABLE_ROWS,
        questionSets: async (offset: number, count: number) =>
          isPage(offset, count)
            ? observedRead("questionSets", deadlineMs, () =>
                pageQuery(
                  client
                    .from("intake_question_sets")
                    .select(QUESTION_SET_COLUMNS)
                    .order("published_at", { ascending: false })
                    .order("id", { ascending: false }),
                  offset,
                  count,
                ),
              )
            : UNREADABLE_ROWS,
        // MVP-001 S2: one group of states, ordered for staff: escalated jobs
        // newest escalation first, open jobs soonest due first, and finished
        // jobs newest first.
        operationalJobs: async (
          group: JobGroup,
          offset: number,
          count: number,
        ) => {
          if (!isPage(offset, count) || !JOB_GROUPS.includes(group)) {
            return UNREADABLE_ROWS;
          }
          return observedRead("operationalJobs", deadlineMs, () => {
            const query = client
              .from("operational_jobs")
              .select(OPERATIONAL_JOB_COLUMNS)
              .in("state", [...JOB_GROUP_STATES[group]]);
            const ordered =
              group === "open"
                ? query.order("available_at").order("id")
                : query
                    .order(group === "escalated" ? "failed_at" : "created_at", {
                      ascending: false,
                    })
                    .order("id", { ascending: false });
            return pageQuery(ordered, offset, count);
          });
        },
        // MVP-001 S3 part 2: the database's own review read functions, which
        // decide the caller's capability, scope and aal2 themselves.
        reviewIntakes: async (
          group: ReviewGroup,
          offset: number,
          count: number,
        ) =>
          isPage(offset, count) && REVIEW_GROUPS.includes(group)
            ? observedRead("reviewIntakes", deadlineMs, () =>
                client.rpc("staff_jurisdiction_review_intakes", {
                  p_group: group,
                  p_offset: offset,
                  p_count: count,
                }),
              )
            : UNREADABLE_ROWS,
        reviewAssessmentsOf: (intakeId: string) =>
          observedRead("reviewAssessmentsOf", deadlineMs, () =>
            client.rpc("staff_jurisdiction_review_assessments", {
              p_intake_id: intakeId,
            }),
          ),
      } satisfies ConfigurationReads,
      deadlineMs,
    );
  };
}

// The staff configuration write port over one request-scoped client: each
// call is one fixed staff function with exactly its named arguments.
export function createConfigurationWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ConfigurationWrites | null> {
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
      createPolicyVersion: (input) =>
        observedWrite(
          "staff_create_policy_version",
          deadlineMs,
          () =>
            client.rpc("staff_create_policy_version", {
              p_policy_type_code: input.policyTypeCode,
              p_jurisdiction_id: input.jurisdictionId,
              p_regulatory_mode_id: input.regulatoryModeId,
              p_version_label: input.versionLabel,
              p_parameters: input.parameters,
              p_effective_from: input.effectiveFrom,
              p_effective_until: input.effectiveUntil,
              p_supersedes_policy_version_id: input.supersedesId,
              p_development_only: input.developmentOnly,
            }),
          (result) =>
            rowAnswerOf(result, CREATE_POLICY_OUTCOMES, "policy_version_id"),
        ),
      revisePolicyDraft: (input) =>
        observedWrite(
          "staff_revise_policy_draft",
          deadlineMs,
          () =>
            client.rpc("staff_revise_policy_draft", {
              p_policy_version_id: input.versionId,
              p_expected_updated_at: input.expectedUpdatedAt,
              p_version_label: input.versionLabel,
              p_parameters: input.parameters,
              p_effective_from: input.effectiveFrom,
              p_effective_until: input.effectiveUntil,
            }),
          (result) => textAnswerOf(result, REVISE_POLICY_OUTCOMES),
        ),
      transitionPolicyVersion: (versionId, expectedUpdatedAt, target) =>
        observedWrite(
          "staff_transition_policy_version",
          deadlineMs,
          () =>
            client.rpc("staff_transition_policy_version", {
              p_policy_version_id: versionId,
              p_expected_updated_at: expectedUpdatedAt,
              p_target_status: target,
            }),
          (result) => textAnswerOf(result, TRANSITION_POLICY_OUTCOMES),
        ),
      endPolicyVersion: (versionId, effectiveUntil) =>
        observedWrite(
          "staff_end_policy_version",
          deadlineMs,
          () =>
            client.rpc("staff_end_policy_version", {
              p_policy_version_id: versionId,
              p_effective_until: effectiveUntil,
            }),
          (result) => textAnswerOf(result, END_POLICY_OUTCOMES),
        ),
      addAuthorityReference: (input) =>
        observedWrite(
          "staff_add_policy_authority_reference",
          deadlineMs,
          () =>
            client.rpc("staff_add_policy_authority_reference", {
              p_policy_version_id: input.versionId,
              p_authority_type: input.authorityType,
              p_citation_text: input.citationText,
              p_source_uri: input.sourceUri,
              p_source_title: input.sourceTitle,
              p_retrieved_at: input.retrievedAt,
            }),
          (result) =>
            rowAnswerOf(result, ADD_REFERENCE_OUTCOMES, "reference_id"),
        ),
      decideAuthorityReference: (referenceId, decision) =>
        observedWrite(
          "staff_decide_policy_authority_reference",
          deadlineMs,
          () =>
            client.rpc("staff_decide_policy_authority_reference", {
              p_reference_id: referenceId,
              p_decision: decision,
            }),
          (result) => textAnswerOf(result, DECIDE_REFERENCE_OUTCOMES),
        ),
      createJurisdiction: (code, name, regionType) =>
        observedWrite(
          "staff_create_jurisdiction",
          deadlineMs,
          () =>
            client.rpc("staff_create_jurisdiction", {
              p_code: code,
              p_name: name,
              p_region_type: regionType,
            }),
          (result) =>
            rowAnswerOf(
              result,
              CREATE_JURISDICTION_OUTCOMES,
              "jurisdiction_id",
            ),
        ),
      changeJurisdictionLifecycle: (
        jurisdictionId,
        expectedUpdatedAt,
        target,
      ) =>
        observedWrite(
          "staff_change_jurisdiction_lifecycle",
          deadlineMs,
          () =>
            client.rpc("staff_change_jurisdiction_lifecycle", {
              p_jurisdiction_id: jurisdictionId,
              p_expected_updated_at: expectedUpdatedAt,
              p_target_state: target,
            }),
          (result) => textAnswerOf(result, LIFECYCLE_OUTCOMES),
        ),
      createServiceArea: (input) =>
        observedWrite(
          "staff_create_service_area",
          deadlineMs,
          () =>
            client.rpc("staff_create_service_area", {
              p_jurisdiction_id: input.jurisdictionId,
              p_code: input.code,
              p_name: input.name,
              p_active_from: input.activeFrom,
              p_active_until: input.activeUntil,
            }),
          (result) =>
            rowAnswerOf(
              result,
              CREATE_SERVICE_AREA_OUTCOMES,
              "service_area_id",
            ),
        ),
      createPracticeArea: (code, name) =>
        observedWrite(
          "staff_create_practice_area",
          deadlineMs,
          () =>
            client.rpc("staff_create_practice_area", {
              p_code: code,
              p_name: name,
            }),
          (result) =>
            rowAnswerOf(
              result,
              CREATE_PRACTICE_AREA_OUTCOMES,
              "practice_area_id",
            ),
        ),
      setPracticeAreaActive: (practiceAreaId, active) =>
        observedWrite(
          "staff_set_practice_area_active",
          deadlineMs,
          () =>
            client.rpc("staff_set_practice_area_active", {
              p_practice_area_id: practiceAreaId,
              p_active: active,
            }),
          (result) => textAnswerOf(result, PRACTICE_AREA_ACTIVITY_OUTCOMES),
        ),
      defineLaunchGate: (jurisdictionId, gateCode, required, description) =>
        observedWrite(
          "staff_define_launch_gate",
          deadlineMs,
          () =>
            client.rpc("staff_define_launch_gate", {
              p_jurisdiction_id: jurisdictionId,
              p_gate_code: gateCode,
              p_required: required,
              p_description: description,
            }),
          (result) =>
            rowAnswerOf(result, DEFINE_GATE_OUTCOMES, "launch_gate_id"),
        ),
      recordLaunchGateEvaluation: (gateId, status, evidenceReference, reason) =>
        observedWrite(
          "staff_record_launch_gate_evaluation",
          deadlineMs,
          () =>
            client.rpc("staff_record_launch_gate_evaluation", {
              p_launch_gate_id: gateId,
              p_evaluation_status: status,
              p_evidence_reference: evidenceReference,
              p_reason: reason,
            }),
          (result) =>
            rowAnswerOf(result, GATE_EVALUATION_OUTCOMES, "evaluation_id"),
        ),
      grantLaunchAuthorization: (jurisdictionId, reason) =>
        observedWrite(
          "staff_grant_launch_authorization",
          deadlineMs,
          () =>
            client.rpc("staff_grant_launch_authorization", {
              p_jurisdiction_id: jurisdictionId,
              p_reason: reason,
            }),
          (result) =>
            rowAnswerOf(
              result,
              GRANT_LAUNCH_OUTCOMES,
              "launch_authorization_id",
            ),
        ),
      revokeLaunchAuthorization: (authorizationId, reason) =>
        observedWrite(
          "staff_revoke_launch_authorization",
          deadlineMs,
          () =>
            client.rpc("staff_revoke_launch_authorization", {
              p_launch_authorization_id: authorizationId,
              p_reason: reason,
            }),
          (result) => textAnswerOf(result, REVOKE_LAUNCH_OUTCOMES),
        ),
      grantCapability: (userId, capabilityCode, jurisdictionId, expiresAt) =>
        observedWrite(
          "staff_grant_capability",
          deadlineMs,
          () =>
            client.rpc("staff_grant_capability", {
              p_user_id: userId,
              p_capability_code: capabilityCode,
              p_jurisdiction_id: jurisdictionId,
              p_expires_at: expiresAt,
            }),
          (result) =>
            rowAnswerOf(result, GRANT_CAPABILITY_OUTCOMES, "grant_id"),
        ),
      revokeCapability: (grantId) =>
        observedWrite(
          "staff_revoke_capability",
          deadlineMs,
          () =>
            client.rpc("staff_revoke_capability", {
              p_grant_id: grantId,
            }),
          (result) => textAnswerOf(result, REVOKE_CAPABILITY_OUTCOMES),
        ),
      publishQuestionSet: (versionKey, definition) =>
        observedWrite(
          "staff_publish_intake_question_set",
          deadlineMs,
          () =>
            client.rpc("staff_publish_intake_question_set", {
              p_version_key: versionKey,
              p_definition: definition,
            }),
          (result) =>
            rowAnswerOf(
              result,
              PUBLISH_QUESTION_SET_OUTCOMES,
              "question_set_id",
            ),
        ),
      retryOperationalJob: (jobId) =>
        observedWrite(
          "staff_retry_job",
          deadlineMs,
          () =>
            client.rpc("staff_retry_job", {
              p_job_id: jobId,
            }),
          (result) => textAnswerOf(result, RETRY_JOB_OUTCOMES),
        ),
      cancelOperationalJob: (jobId) =>
        observedWrite(
          "staff_cancel_job",
          deadlineMs,
          () =>
            client.rpc("staff_cancel_job", {
              p_job_id: jobId,
            }),
          (result) => textAnswerOf(result, CANCEL_JOB_OUTCOMES),
        ),
      // MVP-001 S3 part 2.
      reviewJurisdictionAssessment: async (
        assessmentId: string,
        decision: ReviewDecision,
      ) =>
        REVIEW_DECISIONS.includes(decision)
          ? observedWrite(
              "staff_review_jurisdiction_assessment",
              deadlineMs,
              () =>
                client.rpc("staff_review_jurisdiction_assessment", {
                  p_assessment_id: assessmentId,
                  p_decision: decision,
                }),
              (result) => textAnswerOf(result, REVIEW_ASSESSMENT_OUTCOMES),
            )
          : UNREADABLE,
    } satisfies ConfigurationWrites);
  };
}

// The trusted wiring for one request of the staff configuration surfaces.
export const STAFF_CONFIGURATION_SOURCES: ConfigurationSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  account: createRequestAccountSource(),
  reads: createConfigurationReads(),
  writes: createConfigurationWrites(),
  clock: () => Date.now(),
  environment: () => readEnvironmentConfiguration(),
});
