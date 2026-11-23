// Server-only staff operations and administration adapter (MVP-001 S11 pass
// 2).
//
// Builds the ports of the audit workspace, the operations dashboard and
// system health, referral operations, the financial activity summary, client
// administration, attorney lifecycle operations and the compliance workspace
// for one request. Every database call goes through the request-scoped,
// unprivileged server client (the publishable key and the request's own
// cookie session), so the database decides the actor, the aal2 session, the
// capability and its scope from the request's own authenticated session.
// Each function is called by its literal name, exactly once in this module.
// No privileged credential or client is used or seen here, and nothing reads
// a table directly. Every call is bounded in time; anything that fails,
// throws, or is too slow is reported as unreadable, a malformed argument is
// refused before anything is sent, and each command answer is read strictly
// against its own fixed outcomes. Each failure writes one log line naming
// the call and how it failed (the error code and HTTP status only), and
// nothing the call carried or answered.
//
// System health's provider status is computed here from the providers' own
// settings declarations (their shape checks for the current environment
// class): configured or not configured, never a value. The AI provider is
// not adopted (gate D-4), so it always reports not configured.

import {
  ACCOUNT_STATES,
  CLIENT_INTENTS,
  CLIENT_OUTCOMES,
  COMPLIANCE_SECTIONS,
  LIFECYCLE_INTENTS,
  LIFECYCLE_OUTCOMES,
  MAX_STAFF_NOTE,
  type AccountState,
  type AdministrationReads,
  type AdministrationSources,
  type AdministrationWrites,
  type ClientIntent,
  type ComplianceSection,
  type LifecycleIntent,
} from "../../application/administration-workspace.ts";
import type {
  AuditQuery,
  OperationsReads,
  OperationsSources,
  ProviderArea,
  ProviderStatus,
} from "../../application/operations-workspace.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import type { CommandAnswer } from "../../application/workspace-support.ts";
import { textAnswerOf } from "../consultations/completion-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
import { readProviderConfiguration } from "../environment/provider-configuration.ts";
import {
  DAILY_API_KEY_SETTING,
  DAILY_DOMAIN_SETTING,
  readDailyWebhookSecret,
} from "../media/daily-provider.ts";
import {
  emailDeliveryConfigured,
  emailWebhookConfigured,
} from "../notifications/notification-jobs.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  readStripeApiConfiguration,
  readStripeWebhookSecret,
} from "../payments/stripe-provider.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";
import { STAFF_CONFIGURATION_SOURCES } from "./staff-configuration-adapter.ts";

const CALL_FAILED = "operations.call_failed";
const EXPIRED = Symbol("expired");
const REJECTED = Object.freeze({ kind: "rejected" } as const);
const UNREADABLE = Object.freeze({ kind: "unreadable" } as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const DOTTED = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
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
  outcomes: readonly string[],
): Promise<CommandAnswer> {
  return observed<CommandAnswer>(
    operation,
    deadlineMs,
    UNREADABLE,
    async () => {
      const result = await call();
      const answer = textAnswerOf(result, outcomes);
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
const isOptionalId = (value: unknown): value is string | null =>
  value === null || isId(value);
const isInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  !Number.isNaN(Date.parse(value));
const isOffset = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_OFFSET &&
  (value as number) % 25 === 0;
const isListed = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T => list.some((entry) => entry === value);
const isNote = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length >= 1 &&
  value.length <= MAX_STAFF_NOTE;
const isOptionalCode = (value: unknown, pattern: RegExp): boolean =>
  value === null ||
  (typeof value === "string" && value.length <= 100 && pattern.test(value));

function isAuditQuery(query: unknown): query is AuditQuery {
  const from = ownField(query, "from");
  const until = ownField(query, "until");
  return (
    (from === null || isInstant(from)) &&
    (until === null || isInstant(until)) &&
    isOptionalCode(ownField(query, "actionCode"), DOTTED) &&
    isOptionalCode(ownField(query, "resourceType"), CODE) &&
    isOptionalId(ownField(query, "resourceId")) &&
    isOptionalCode(ownField(query, "performerType"), CODE) &&
    isOptionalId(ownField(query, "performerId")) &&
    typeof ownField(query, "securityOnly") === "boolean"
  );
}

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
    jurisdictionNames: () =>
      observedRead("staff_jurisdiction_names", deadlineMs, () =>
        client.rpc("staff_jurisdiction_names"),
      ),
    auditEvents: (query: AuditQuery, offset: number) =>
      isAuditQuery(query) && isOffset(offset)
        ? observedRead("staff_audit_events", deadlineMs, () =>
            client.rpc("staff_audit_events", {
              p_from: query.from,
              p_until: query.until,
              p_action_code: query.actionCode,
              p_resource_type: query.resourceType,
              p_resource_id: query.resourceId,
              p_performer_type: query.performerType,
              p_performer_id: query.performerId,
              p_security_only: query.securityOnly,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    auditEvent: (eventId: string) =>
      isId(eventId)
        ? observedRead("staff_audit_event", deadlineMs, () =>
            client.rpc("staff_audit_event", { p_audit_event_id: eventId }),
          )
        : refusedRead(),
    operationsSummary: () =>
      observedRead("staff_operations_summary", deadlineMs, () =>
        client.rpc("staff_operations_summary"),
      ),
    referrals: (offset: number) =>
      isOffset(offset)
        ? observedRead("staff_referrals", deadlineMs, () =>
            client.rpc("staff_referrals", { p_offset: offset }),
          )
        : refusedRead(),
    referralCounts: () =>
      observedRead("staff_referral_counts", deadlineMs, () =>
        client.rpc("staff_referral_counts"),
      ),
    financeSummary: (
      from: string,
      until: string,
      jurisdictionId: string | null,
    ) =>
      isInstant(from) && isInstant(until) && isOptionalId(jurisdictionId)
        ? observedRead("staff_finance_summary", deadlineMs, () =>
            client.rpc("staff_finance_summary", {
              p_from: from,
              p_until: until,
              p_jurisdiction_id: jurisdictionId,
            }),
          )
        : refusedRead(),
    clients: (state: AccountState | null, offset: number) =>
      (state === null || isListed(ACCOUNT_STATES, state)) && isOffset(offset)
        ? observedRead("staff_clients", deadlineMs, () =>
            client.rpc("staff_clients", {
              p_account_state: state,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    client: (clientId: string) =>
      isId(clientId)
        ? observedRead("staff_client", deadlineMs, () =>
            client.rpc("staff_client", { p_client_account_id: clientId }),
          )
        : refusedRead(),
    changeClientAccount: (
      clientId: string,
      intent: ClientIntent,
      note: string,
    ) =>
      isId(clientId) && isListed(CLIENT_INTENTS, intent) && isNote(note)
        ? observedWrite(
            "staff_change_client_account",
            deadlineMs,
            () =>
              client.rpc("staff_change_client_account", {
                p_client_account_id: clientId,
                p_intent: intent,
                p_note: note,
              }),
            CLIENT_OUTCOMES,
          )
        : refusedWrite(),
    attorneyProfile: (attorneyId: string) =>
      isId(attorneyId)
        ? observedRead("staff_attorney_profile", deadlineMs, () =>
            client.rpc("staff_attorney_profile", { p_attorney_id: attorneyId }),
          )
        : refusedRead(),
    changeAttorneyLifecycle: (
      attorneyId: string,
      intent: LifecycleIntent,
      note: string,
    ) =>
      isId(attorneyId) && isListed(LIFECYCLE_INTENTS, intent) && isNote(note)
        ? observedWrite(
            "staff_change_attorney_lifecycle",
            deadlineMs,
            () =>
              client.rpc("staff_change_attorney_lifecycle", {
                p_attorney_id: attorneyId,
                p_intent: intent,
                p_note: note,
              }),
            LIFECYCLE_OUTCOMES,
          )
        : refusedWrite(),
    complianceSummary: () =>
      observedRead("staff_compliance_summary", deadlineMs, () =>
        client.rpc("staff_compliance_summary"),
      ),
    complianceRecords: (section: ComplianceSection, offset: number) =>
      isListed(COMPLIANCE_SECTIONS, section) && isOffset(offset)
        ? observedRead("staff_compliance_records", deadlineMs, () =>
            client.rpc("staff_compliance_records", {
              p_section: section,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    policyChanges: (offset: number) =>
      isOffset(offset)
        ? observedRead("staff_policy_changes", deadlineMs, () =>
            client.rpc("staff_policy_changes", { p_offset: offset }),
          )
        : refusedRead(),
  });
}

type Calls = ReturnType<typeof callsOf>;

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

export function createOperationsReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<OperationsReads | null> {
  return portSource(
    (calls): OperationsReads => ({
      auditEvents: calls.auditEvents,
      auditEvent: calls.auditEvent,
      operationsSummary: calls.operationsSummary,
      referrals: calls.referrals,
      referralCounts: calls.referralCounts,
      financeSummary: calls.financeSummary,
      jurisdictionNames: calls.jurisdictionNames,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createAdministrationReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AdministrationReads | null> {
  return portSource(
    (calls): AdministrationReads => ({
      clients: calls.clients,
      client: calls.client,
      attorneyProfile: calls.attorneyProfile,
      complianceSummary: calls.complianceSummary,
      complianceRecords: calls.complianceRecords,
      policyChanges: calls.policyChanges,
      jurisdictionNames: calls.jurisdictionNames,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createAdministrationWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AdministrationWrites | null> {
  return portSource(
    (calls): AdministrationWrites => ({
      changeClientAccount: calls.changeClientAccount,
      changeAttorneyLifecycle: calls.changeAttorneyLifecycle,
    }),
    clientSource,
    deadlineMs,
  );
}

type Environment = Readonly<Record<string, string | undefined>>;

// Whether each provider's settings have their declared shape for the current
// environment class: configured or not configured, never a value. An area is
// configured only with its webhook signing setting too (the payment, media
// and email webhook routes answer unavailable without it).
export function providerStatuses(
  environment: Environment = process.env,
): Readonly<Record<ProviderArea, ProviderStatus>> {
  const status = (configured: boolean): ProviderStatus =>
    configured ? "configured" : "not_configured";
  // The signing settings are checked by the webhook routes' own readers; only
  // whether one answers is kept here.
  return Object.freeze({
    payments: status(
      readStripeApiConfiguration(environment) !== null &&
        readStripeWebhookSecret(environment) !== null,
    ),
    media: status(
      readProviderConfiguration(
        [DAILY_API_KEY_SETTING, DAILY_DOMAIN_SETTING],
        environment,
      ).kind === "configured" && readDailyWebhookSecret(environment) !== null,
    ),
    email: status(
      emailDeliveryConfigured(environment) &&
        emailWebhookConfigured(environment),
    ),
    // Gate D-4: no AI provider is adopted.
    ai: status(false),
  });
}

const environment = () => readEnvironmentConfiguration();

export const OPERATIONS_WORKSPACE_SOURCES: OperationsSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createOperationsReads(),
  environment,
  providers: () => providerStatuses(),
});

export const ADMINISTRATION_SOURCES: AdministrationSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createAdministrationReads(),
  writes: createAdministrationWrites(),
  environment,
});
