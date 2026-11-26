// Server-only payment adapter (MVP-001 S7).
//
// Builds the request-scoped payment ports for one request. Every call goes
// through the request-scoped, unprivileged server client (the publishable
// key and the request's own cookie session), so the database decides the
// caller from the request's own authenticated session: the client's payment
// step, receipt and checkout reads and the client's authorization; the
// attorney's ledger-derived earnings; the finance staff reads and changes;
// and the PS-A2 environment accessor. Each function is called by its literal
// name, exactly once in this module. No privileged credential or client is
// used or seen here, and nothing reads a table directly. Every call is
// bounded in time; anything that fails, throws, or is too slow is reported as
// unreadable, a malformed input is refused before anything is sent, and each
// write function's answer is read strictly against its own fixed outcomes.
// Each such failure writes one log line naming the call and how it failed
// (the error code and HTTP status only, MVP-001 D-8), and nothing the call
// carried or answered.
//
// The production sources join these ports to the trusted server session, the
// client intake sources (the verified client), the attorney principal source,
// the staff configuration sources (the verified staff identity), the
// provider's hosted checkout links (the server-only Stripe adapter; null when
// payments are not configured) and one bounded worker run after an attempt
// is created.

import {
  AUTHORIZE_OUTCOMES,
  type AuthorizeAnswer,
  type ClientPaymentReads,
  type ClientPaymentSources,
  type ClientPaymentWrites,
  type EarningsReads,
  type EarningsSources,
} from "../../application/client-payments.ts";
import {
  ASSIGN_OUTCOMES,
  EXCEPTION_STATUSES,
  PAYMENT_GROUPS,
  RECONCILE_OUTCOMES,
  REFUND_COMPONENTS,
  REFUND_OUTCOMES,
  RESOLVE_OUTCOMES,
  type ExceptionStatus,
  type FinanceAnswer,
  type FinanceReads,
  type FinanceSources,
  type FinanceWrites,
  type PaymentGroup,
  type RefundRequestInput,
} from "../../application/finance-workspace.ts";
import { isAmountMinor } from "../../application/payments.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
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
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../staff/staff-configuration-adapter.ts";
import { createStripeProvider } from "./stripe-provider.ts";

const CALL_FAILED = "payments.call_failed";
const EXPIRED = Symbol("expired");

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isOffset = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 100000;

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

// The one row of a write function with exactly these columns, or null.
function singleRow(result: unknown, columns: readonly string[]): unknown {
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return null;
  }
  const row = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).length !== columns.length ||
    columns.some((column) => !Object.hasOwn(row, column))
  ) {
    return null;
  }
  return row;
}

const REJECTED_AUTHORIZE: AuthorizeAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE_AUTHORIZE: AuthorizeAnswer = Object.freeze({
  kind: "unreadable",
});
const REJECTED: FinanceAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: FinanceAnswer = Object.freeze({ kind: "unreadable" });

// client_authorize_payment's one row, { outcome, payment_transaction_id, problem }.
export function authorizeAnswerOf(result: unknown): AuthorizeAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED_AUTHORIZE : UNREADABLE_AUTHORIZE;
  }
  const row = singleRow(result, [
    "outcome",
    "payment_transaction_id",
    "problem",
  ]);
  const outcome = ownField(row, "outcome");
  const paymentId = ownField(row, "payment_transaction_id");
  const problem = ownField(row, "problem");
  if (
    row === null ||
    typeof outcome !== "string" ||
    !(AUTHORIZE_OUTCOMES as readonly string[]).includes(outcome) ||
    !(paymentId === null || isId(paymentId)) ||
    !(problem === null || typeof problem === "string")
  ) {
    return UNREADABLE_AUTHORIZE;
  }
  return Object.freeze({
    kind: "answer",
    outcome: outcome as (typeof AUTHORIZE_OUTCOMES)[number],
    paymentId: paymentId as string | null,
    problem: problem as string | null,
  });
}

// A finance write's outcome: a text answer, or the outcome column of its one
// row (with exactly the given columns).
export function financeAnswerOf(
  result: unknown,
  outcomes: readonly string[],
  columns: readonly string[] | null,
): FinanceAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const outcome =
    columns === null
      ? ownField(result, "data")
      : ownField(singleRow(result, columns), "outcome");
  return typeof outcome === "string" && outcomes.includes(outcome)
    ? Object.freeze({ kind: "answer", outcome })
    : UNREADABLE;
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

function observedWrite<T extends { readonly kind: string }>(
  operation: string,
  deadlineMs: number,
  fallback: T,
  read: (result: unknown) => T,
  call: () => PromiseLike<unknown>,
): Promise<T> {
  return observed(operation, deadlineMs, fallback, async () => {
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

async function clientOf(
  clientSource: RequestClientSource,
  deadlineMs: number,
): Promise<RequestClient | null> {
  return withinDeadline(clientSource, null, deadlineMs);
}

// The PS-A2 environment accessor, read before a payment attempt or a refund.
function environmentRead(
  client: RequestClient,
  deadlineMs: number,
): Promise<RowsResult> {
  return observedRead("deployment_environment_identity", deadlineMs, () =>
    client.rpc("deployment_environment_identity"),
  );
}

// ---------------------------------------------------------------------------
// The client's payment ports
// ---------------------------------------------------------------------------

export function createClientPaymentReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientPaymentReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await clientOf(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        requestPayment: async (requestId: string) =>
          isId(requestId)
            ? observedRead("client_request_payment", deadlineMs, () =>
                client.rpc("client_request_payment", {
                  p_request_id: requestId,
                }),
              )
            : UNREADABLE_ROWS,
        receipt: async (paymentId: string) =>
          isId(paymentId)
            ? observedRead("client_payment_receipt", deadlineMs, () =>
                client.rpc("client_payment_receipt", {
                  p_payment_id: paymentId,
                }),
              )
            : UNREADABLE_ROWS,
        checkout: async (paymentId: string) =>
          isId(paymentId)
            ? observedRead("client_payment_checkout", deadlineMs, () =>
                client.rpc("client_payment_checkout", {
                  p_payment_id: paymentId,
                }),
              )
            : UNREADABLE_ROWS,
        environmentIdentity: () => environmentRead(client, deadlineMs),
      },
      deadlineMs,
    );
  };
}

export function createClientPaymentWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientPaymentWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await clientOf(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return Object.freeze({
      authorize: async (requestId: string) =>
        isId(requestId)
          ? observedWrite(
              "client_authorize_payment",
              deadlineMs,
              UNREADABLE_AUTHORIZE,
              authorizeAnswerOf,
              () =>
                client.rpc("client_authorize_payment", {
                  p_request_id: requestId,
                }),
            )
          : REJECTED_AUTHORIZE,
    } satisfies ClientPaymentWrites);
  };
}

// ---------------------------------------------------------------------------
// The attorney's earnings port
// ---------------------------------------------------------------------------

export function createEarningsReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<EarningsReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await clientOf(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        earnings: () =>
          observedRead("attorney_payment_earnings", deadlineMs, () =>
            client.rpc("attorney_payment_earnings"),
          ),
      },
      deadlineMs,
    );
  };
}

// ---------------------------------------------------------------------------
// The finance staff ports
// ---------------------------------------------------------------------------

const isGroup = (value: unknown): value is PaymentGroup =>
  (PAYMENT_GROUPS as readonly unknown[]).includes(value);
const isExceptionStatus = (value: unknown): value is ExceptionStatus =>
  (EXCEPTION_STATUSES as readonly unknown[]).includes(value);
const isNotes = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const isRefundInput = (input: RefundRequestInput): boolean =>
  isId(input.paymentId) &&
  REFUND_COMPONENTS.every((component) =>
    isAmountMinor(input.amounts[component]),
  ) &&
  REFUND_COMPONENTS.reduce(
    (sum, component) => sum + input.amounts[component],
    0,
  ) >= 1 &&
  isNotes(input.reason, 500);

export function createFinanceReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<FinanceReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await clientOf(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        payments: async (group: PaymentGroup, offset: number) =>
          isGroup(group) && isOffset(offset)
            ? observedRead("staff_finance_payments", deadlineMs, () =>
                client.rpc("staff_finance_payments", {
                  p_group: group,
                  p_offset: offset,
                }),
              )
            : UNREADABLE_ROWS,
        payment: async (paymentId: string) =>
          isId(paymentId)
            ? observedRead("staff_finance_payment", deadlineMs, () =>
                client.rpc("staff_finance_payment", {
                  p_payment_id: paymentId,
                }),
              )
            : UNREADABLE_ROWS,
        ledger: async (paymentId: string) =>
          isId(paymentId)
            ? observedRead("staff_finance_ledger", deadlineMs, () =>
                client.rpc("staff_finance_ledger", { p_payment_id: paymentId }),
              )
            : UNREADABLE_ROWS,
        receipts: async (paymentId: string) =>
          isId(paymentId)
            ? observedRead("staff_finance_receipts", deadlineMs, () =>
                client.rpc("staff_finance_receipts", {
                  p_payment_id: paymentId,
                }),
              )
            : UNREADABLE_ROWS,
        exceptions: async (status: ExceptionStatus, offset: number) =>
          isExceptionStatus(status) && isOffset(offset)
            ? observedRead("staff_finance_exceptions", deadlineMs, () =>
                client.rpc("staff_finance_exceptions", {
                  p_status: status,
                  p_offset: offset,
                }),
              )
            : UNREADABLE_ROWS,
        disputeEvents: async (paymentId: string) =>
          isId(paymentId)
            ? observedRead("staff_payment_dispute_events", deadlineMs, () =>
                client.rpc("staff_payment_dispute_events", {
                  p_payment_id: paymentId,
                }),
              )
            : UNREADABLE_ROWS,
        environmentIdentity: () => environmentRead(client, deadlineMs),
      },
      deadlineMs,
    );
  };
}

export function createFinanceWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<FinanceWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await clientOf(clientSource, deadlineMs);
    if (client === null) {
      return null;
    }
    return Object.freeze({
      requestRefund: async (input: RefundRequestInput) =>
        isRefundInput(input)
          ? observedWrite(
              "staff_request_refund",
              deadlineMs,
              UNREADABLE,
              (result) =>
                financeAnswerOf(result, REFUND_OUTCOMES, [
                  "outcome",
                  "refund_request_id",
                ]),
              () =>
                client.rpc("staff_request_refund", {
                  p_payment_id: input.paymentId,
                  p_attorney_share_minor: input.amounts.attorney_share,
                  p_platform_fee_minor: input.amounts.platform_fee,
                  p_client_fee_minor: input.amounts.client_fee,
                  p_other_required_fee_minor: input.amounts.other_required_fee,
                  p_reason: input.reason,
                }),
            )
          : REJECTED,
      assignException: async (exceptionId: string, assign: boolean) =>
        isId(exceptionId) && typeof assign === "boolean"
          ? observedWrite(
              "staff_assign_reconciliation_exception",
              deadlineMs,
              UNREADABLE,
              (result) => financeAnswerOf(result, ASSIGN_OUTCOMES, null),
              () =>
                client.rpc("staff_assign_reconciliation_exception", {
                  p_exception_id: exceptionId,
                  p_assign: assign,
                }),
            )
          : REJECTED,
      resolveException: async (exceptionId: string, notes: string) =>
        isId(exceptionId) && isNotes(notes, 2000)
          ? observedWrite(
              "staff_resolve_reconciliation_exception",
              deadlineMs,
              UNREADABLE,
              (result) => financeAnswerOf(result, RESOLVE_OUTCOMES, null),
              () =>
                client.rpc("staff_resolve_reconciliation_exception", {
                  p_exception_id: exceptionId,
                  p_notes: notes,
                }),
            )
          : REJECTED,
      requestReconciliation: async (paymentId: string | null) =>
        paymentId === null || isId(paymentId)
          ? observedWrite(
              "staff_request_reconciliation",
              deadlineMs,
              UNREADABLE,
              (result) =>
                financeAnswerOf(result, RECONCILE_OUTCOMES, [
                  "outcome",
                  "enqueued",
                ]),
              () =>
                client.rpc("staff_request_reconciliation", {
                  p_payment_id: paymentId,
                }),
            )
          : REJECTED,
    } satisfies FinanceWrites);
  };
}

// ---------------------------------------------------------------------------
// The production sources
// ---------------------------------------------------------------------------

export const CLIENT_PAYMENT_SOURCES: ClientPaymentSources = Object.freeze({
  clientIntake: CLIENT_INTAKE_SOURCES,
  reads: createClientPaymentReads(),
  writes: createClientPaymentWrites(),
  environment: () => readEnvironmentConfiguration(),
  checkoutLinks: async () => createStripeProvider(),
  drain: async () => {
    await drainOperationalJobs(AFTER_COMMIT_BOUNDS);
  },
});

export const EARNINGS_SOURCES: EarningsSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  attorney: ATTORNEY_PRINCIPAL_SOURCE,
  reads: createEarningsReads(),
});

export const FINANCE_SOURCES: FinanceSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createFinanceReads(),
  writes: createFinanceWrites(),
  environment: () => readEnvironmentConfiguration(),
});
