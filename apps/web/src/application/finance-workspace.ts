// The staff finance workspace (MVP-001 S7; Packet S7 "reconciliation
// exceptions and finance workspace"; TA sections 18 (Finance), 26 and 41; PS
// sections 22.2-22.5 and 30.4).
//
// Provider-neutral and injectable. Access is decided afresh on the server
// for every read and change: the verified staff identity of the staff
// configuration surfaces holding the global manage_financial_operations
// capability at aal2 (the database's own predicate), and the database
// decides again in every function. A Staff Profile alone grants nothing.
//
// Staff see payments (state, amounts, the Fee Calculation components, the
// provider reference and the FP-1 provenance; Rosuno holds no card data),
// their ledger entries, their provider event receipts (type and outcome; no
// payload) and the Reconciliation Exceptions. Changes are one database
// function each, audited in its own transaction:
// - a refund within what remains of each Fee Calculation component, with a
//   required reason; staff choose the allocation. Whether a refund is owed is
//   refund policy, which is gated: nothing here decides it, and the payment's
//   refund policy version is recorded with the request;
// - assigning an open exception (to oneself, or clearing it) and resolving it
//   once with notes;
// - asking the worker to reconcile one payment, or every live one, with the
//   provider.
// Before a refund is asked for the environment binding is checked (PS-A2
// section 6; Packet rule 7). Only the database's own outcomes are reported.

import { currencyMinorDigits } from "./consultation-offers.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  isAmountMinor,
  isCurrencyCode,
  isProviderReference,
  MAX_AMOUNT_MINOR,
  PAYMENT_STATES,
  PROCESSING_STATES,
  type PaymentState,
} from "./payments.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  textField,
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
import type { StepUpRequired } from "./session-assurance.ts";
import {
  verifiedStaffWith,
  type ConfigurationSources,
} from "./staff-configuration.ts";

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

export const FINANCE_CAPABILITY = "manage_financial_operations";

export const PAYMENT_GROUPS = Object.freeze([
  "open",
  "collected",
  "ended",
  "all",
] as const);
export type PaymentGroup = (typeof PAYMENT_GROUPS)[number];

export const EXCEPTION_STATUSES = Object.freeze(["open", "resolved"] as const);
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const SEVERITIES = Object.freeze([
  "low",
  "medium",
  "high",
  "critical",
] as const);

export const LEDGER_ENTRY_TYPES = Object.freeze([
  "client_payment",
  "attorney_share",
  "platform_fee",
  "client_fee",
  "other_required_fee",
] as const);
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

// The four refundable Fee Calculation components (the client payment entry
// is their sum).
export const REFUND_COMPONENTS = Object.freeze([
  "attorney_share",
  "platform_fee",
  "client_fee",
  "other_required_fee",
] as const);
export type RefundComponent = (typeof REFUND_COMPONENTS)[number];

// The page size of the finance lists; the database answers one more row to
// tell whether another page follows.
export const FINANCE_PAGE_SIZE = 25;
const MAX_PAGE = 4000;

export const PAYMENT_ROW_COLUMNS = Object.freeze([
  "payment_transaction_id",
  "consultation_request_id",
  "state",
  "currency_code",
  "total_client_amount_minor",
  "amount_authorized_minor",
  "amount_captured_minor",
  "amount_refunded_minor",
  "created_at",
  "updated_at",
  "open_exceptions",
]);

export const PAYMENT_DETAIL_COLUMNS = Object.freeze([
  "payment_transaction_id",
  "consultation_request_id",
  "request_path",
  "request_state",
  "state",
  "currency_code",
  "attorney_listed_price_minor",
  "platform_fee_minor",
  "client_fee_minor",
  "tax_or_other_required_fee_minor",
  "total_client_amount_minor",
  "amount_authorized_minor",
  "amount_captured_minor",
  "amount_refunded_minor",
  "provider_code",
  "provider_payment_reference",
  "jurisdiction_id",
  "regulatory_mode_id",
  "referral_policy_version_id",
  "payment_policy_version_id",
  "fee_policy_version_id",
  "payment_flow_policy_version_id",
  "engagement_policy_version_id",
  "cancellation_policy_version_id",
  "refund_policy_version_id",
  "created_at",
  "authorized_at",
  "captured_at",
  "failed_at",
  "updated_at",
]);

export const LEDGER_COLUMNS = Object.freeze([
  "ledger_entry_id",
  "entry_type",
  "direction",
  "amount_minor",
  "currency_code",
  "effective_at",
  "source_reference",
  "reason_code",
]);

export const RECEIPT_ROW_COLUMNS = Object.freeze([
  "provider_code",
  "provider_event_reference",
  "event_type",
  "processing_state",
  "received_at",
  "processed_at",
]);

export const EXCEPTION_COLUMNS = Object.freeze([
  "exception_id",
  "exception_type",
  "severity",
  "status",
  "source_type",
  "source_id",
  "canonical_type",
  "canonical_id",
  "detected_at",
  "evidence_reference",
  "assigned_to_user_id",
  "assigned_to_me",
  "resolved_at",
  "resolution_notes",
]);

export const REFUND_OUTCOMES = Object.freeze([
  "requested",
  "invalid",
  "denied",
  "not_found",
  "refund_in_progress",
  "not_refundable",
  "exceeds_refundable",
  "policy_unavailable",
]);
export const ASSIGN_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "invalid_transition",
]);
export const RESOLVE_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "invalid_transition",
]);
export const RECONCILE_OUTCOMES = Object.freeze([
  "requested",
  "invalid",
  "denied",
  "not_found",
]);

export type FinanceReads = {
  // staff_finance_payments(group, offset)
  readonly payments: (
    group: PaymentGroup,
    offset: number,
  ) => Promise<RowsResult>;
  // staff_finance_payment(payment)
  readonly payment: (paymentId: string) => Promise<RowsResult>;
  // staff_finance_ledger(payment)
  readonly ledger: (paymentId: string) => Promise<RowsResult>;
  // staff_finance_receipts(payment)
  readonly receipts: (paymentId: string) => Promise<RowsResult>;
  // staff_finance_exceptions(status, offset)
  readonly exceptions: (
    status: ExceptionStatus,
    offset: number,
  ) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type FinanceAnswer =
  | { readonly kind: "answer"; readonly outcome: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type RefundRequestInput = {
  readonly paymentId: string;
  readonly amounts: Readonly<Record<RefundComponent, number>>;
  readonly reason: string;
};

export type FinanceWrites = {
  readonly requestRefund: (input: RefundRequestInput) => Promise<FinanceAnswer>;
  readonly assignException: (
    exceptionId: string,
    assign: boolean,
  ) => Promise<FinanceAnswer>;
  readonly resolveException: (
    exceptionId: string,
    notes: string,
  ) => Promise<FinanceAnswer>;
  readonly requestReconciliation: (
    paymentId: string | null,
  ) => Promise<FinanceAnswer>;
};

export type FinanceSources = {
  // The staff configuration sources decide the verified staff identity and
  // the capability.
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<FinanceReads | null>;
  readonly writes: () => Promise<FinanceWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const nullableAmount = (value: unknown): value is number | null =>
  value === null || isAmountMinor(value);
const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const nullableId = (value: unknown): value is string | null =>
  value === null || isUuid(value);

export type FinancePaymentRow = {
  readonly id: string;
  readonly requestId: string;
  readonly state: PaymentState;
  readonly currency: string;
  readonly totalMinor: number;
  readonly authorizedMinor: number | null;
  readonly capturedMinor: number | null;
  readonly refundedMinor: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly openExceptions: number;
};

function readPaymentRow(row: unknown): FinancePaymentRow | null {
  const f = readExact(row, PAYMENT_ROW_COLUMNS);
  if (f === null) {
    return null;
  }
  const values = {
    id: f.get("payment_transaction_id"),
    requestId: f.get("consultation_request_id"),
    state: f.get("state"),
    currency: f.get("currency_code"),
    totalMinor: f.get("total_client_amount_minor"),
    authorizedMinor: f.get("amount_authorized_minor"),
    capturedMinor: f.get("amount_captured_minor"),
    refundedMinor: f.get("amount_refunded_minor"),
    createdAt: f.get("created_at"),
    updatedAt: f.get("updated_at"),
    openExceptions: f.get("open_exceptions"),
  };
  if (
    !isUuid(values.id) ||
    !isUuid(values.requestId) ||
    !isOneOf(PAYMENT_STATES, values.state) ||
    !isCurrencyCode(values.currency) ||
    !isAmountMinor(values.totalMinor) ||
    !nullableAmount(values.authorizedMinor) ||
    !nullableAmount(values.capturedMinor) ||
    !isAmountMinor(values.refundedMinor) ||
    !isTimestamp(values.createdAt) ||
    !isTimestamp(values.updatedAt) ||
    !Number.isSafeInteger(values.openExceptions) ||
    (values.openExceptions as number) < 0
  ) {
    return null;
  }
  return Object.freeze(values) as FinancePaymentRow;
}

export type FinancePaymentDetail = FinancePaymentRow & {
  readonly requestPath: "instant" | "scheduled";
  readonly requestState: string;
  readonly listedPriceMinor: number;
  readonly platformFeeMinor: number;
  readonly clientFeeMinor: number;
  readonly otherFeeMinor: number;
  readonly providerCode: string;
  readonly providerReference: string | null;
  readonly jurisdictionId: string;
  readonly regulatoryModeId: string;
  readonly policies: Readonly<Record<string, string>>;
  readonly authorizedAt: string | null;
  readonly capturedAt: string | null;
  readonly failedAt: string | null;
};

const POLICY_COLUMNS = Object.freeze([
  ["referral", "referral_policy_version_id"],
  ["payment", "payment_policy_version_id"],
  ["fee", "fee_policy_version_id"],
  ["payment_flow", "payment_flow_policy_version_id"],
  ["engagement", "engagement_policy_version_id"],
  ["cancellation", "cancellation_policy_version_id"],
  ["refund", "refund_policy_version_id"],
] as const);

function readPaymentDetail(
  row: unknown,
  paymentId: string,
): FinancePaymentDetail | null {
  const f = readExact(row, PAYMENT_DETAIL_COLUMNS);
  if (f === null || f.get("payment_transaction_id") !== paymentId) {
    return null;
  }
  const policies: Record<string, string> = {};
  for (const [type, column] of POLICY_COLUMNS) {
    const id = f.get(column);
    if (!isUuid(id)) {
      return null;
    }
    policies[type] = id;
  }
  const path = f.get("request_path");
  const requestState = f.get("request_state");
  const reference = f.get("provider_payment_reference");
  const providerCode = f.get("provider_code");
  const detail = {
    id: paymentId,
    requestId: f.get("consultation_request_id"),
    state: f.get("state"),
    currency: f.get("currency_code"),
    totalMinor: f.get("total_client_amount_minor"),
    authorizedMinor: f.get("amount_authorized_minor"),
    capturedMinor: f.get("amount_captured_minor"),
    refundedMinor: f.get("amount_refunded_minor"),
    createdAt: f.get("created_at"),
    updatedAt: f.get("updated_at"),
    openExceptions: 0,
    requestPath: path,
    requestState,
    listedPriceMinor: f.get("attorney_listed_price_minor"),
    platformFeeMinor: f.get("platform_fee_minor"),
    clientFeeMinor: f.get("client_fee_minor"),
    otherFeeMinor: f.get("tax_or_other_required_fee_minor"),
    providerCode,
    providerReference: reference,
    jurisdictionId: f.get("jurisdiction_id"),
    regulatoryModeId: f.get("regulatory_mode_id"),
    policies: Object.freeze(policies),
    authorizedAt: f.get("authorized_at"),
    capturedAt: f.get("captured_at"),
    failedAt: f.get("failed_at"),
  };
  if (
    !isUuid(detail.requestId) ||
    !isOneOf(PAYMENT_STATES, detail.state) ||
    !isCurrencyCode(detail.currency) ||
    !isAmountMinor(detail.totalMinor) ||
    !nullableAmount(detail.authorizedMinor) ||
    !nullableAmount(detail.capturedMinor) ||
    !isAmountMinor(detail.refundedMinor) ||
    !isTimestamp(detail.createdAt) ||
    !isTimestamp(detail.updatedAt) ||
    !(path === "instant" || path === "scheduled") ||
    typeof requestState !== "string" ||
    !/^[a-z_]{1,40}$/.test(requestState) ||
    !isAmountMinor(detail.listedPriceMinor) ||
    !isAmountMinor(detail.platformFeeMinor) ||
    !isAmountMinor(detail.clientFeeMinor) ||
    !isAmountMinor(detail.otherFeeMinor) ||
    typeof providerCode !== "string" ||
    !/^[a-z][a-z0-9_]{1,31}$/.test(providerCode) ||
    !(reference === null || isProviderReference(reference)) ||
    !isUuid(detail.jurisdictionId) ||
    !isUuid(detail.regulatoryModeId) ||
    !nullableTime(detail.authorizedAt) ||
    !nullableTime(detail.capturedAt) ||
    !nullableTime(detail.failedAt)
  ) {
    return null;
  }
  return Object.freeze(detail) as FinancePaymentDetail;
}

export type LedgerLine = {
  readonly id: string;
  readonly entryType: LedgerEntryType;
  readonly direction: "debit" | "credit";
  readonly amountMinor: number;
  readonly currency: string;
  readonly effectiveAt: string;
  readonly sourceReference: string;
  readonly reasonCode: "payment_captured" | "payment_refunded";
};

function readLedgerLine(row: unknown): LedgerLine | null {
  const f = readExact(row, LEDGER_COLUMNS);
  if (f === null) {
    return null;
  }
  const line = {
    id: f.get("ledger_entry_id"),
    entryType: f.get("entry_type"),
    direction: f.get("direction"),
    amountMinor: f.get("amount_minor"),
    currency: f.get("currency_code"),
    effectiveAt: f.get("effective_at"),
    sourceReference: f.get("source_reference"),
    reasonCode: f.get("reason_code"),
  };
  if (
    !isUuid(line.id) ||
    !isOneOf(LEDGER_ENTRY_TYPES, line.entryType) ||
    !(line.direction === "debit" || line.direction === "credit") ||
    !isAmountMinor(line.amountMinor) ||
    (line.amountMinor as number) < 1 ||
    !isCurrencyCode(line.currency) ||
    !isTimestamp(line.effectiveAt) ||
    typeof line.sourceReference !== "string" ||
    !/^(capture|refund):[0-9a-f-]{36}$/.test(line.sourceReference) ||
    !(
      line.reasonCode === "payment_captured" ||
      line.reasonCode === "payment_refunded"
    )
  ) {
    return null;
  }
  return Object.freeze(line) as LedgerLine;
}

export type ReceiptLine = {
  readonly providerCode: string;
  readonly eventReference: string;
  readonly eventType: string;
  readonly processing: string;
  readonly receivedAt: string;
  readonly processedAt: string | null;
};

function readReceiptLine(row: unknown): ReceiptLine | null {
  const f = readExact(row, RECEIPT_ROW_COLUMNS);
  if (f === null) {
    return null;
  }
  const line = {
    providerCode: f.get("provider_code"),
    eventReference: f.get("provider_event_reference"),
    eventType: f.get("event_type"),
    processing: f.get("processing_state"),
    receivedAt: f.get("received_at"),
    processedAt: f.get("processed_at"),
  };
  if (
    typeof line.providerCode !== "string" ||
    !/^[a-z][a-z0-9_]{1,31}$/.test(line.providerCode) ||
    !isProviderReference(line.eventReference) ||
    typeof line.eventType !== "string" ||
    !/^[a-z][a-z0-9_.]{2,99}$/.test(line.eventType) ||
    !isOneOf(PROCESSING_STATES, line.processing) ||
    !isTimestamp(line.receivedAt) ||
    !nullableTime(line.processedAt)
  ) {
    return null;
  }
  return Object.freeze(line) as ReceiptLine;
}

export type ExceptionRow = {
  readonly id: string;
  readonly exceptionType: string;
  readonly severity: (typeof SEVERITIES)[number];
  readonly status: ExceptionStatus;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly canonicalType: string;
  readonly canonicalId: string | null;
  readonly detectedAt: string;
  // The evidence the database kept, as compact text (identifiers, amounts,
  // statuses; never card data or a raw provider payload).
  readonly evidence: string;
  readonly assigned: boolean;
  readonly assignedToMe: boolean;
  readonly resolvedAt: string | null;
  readonly resolutionNotes: string | null;
};

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

function readExceptionRow(row: unknown): ExceptionRow | null {
  const f = readExact(row, EXCEPTION_COLUMNS);
  if (f === null) {
    return null;
  }
  const evidence = f.get("evidence_reference");
  const assignedTo = f.get("assigned_to_user_id");
  const value = {
    id: f.get("exception_id"),
    exceptionType: f.get("exception_type"),
    severity: f.get("severity"),
    status: f.get("status"),
    sourceType: f.get("source_type"),
    sourceId: f.get("source_id"),
    canonicalType: f.get("canonical_type"),
    canonicalId: f.get("canonical_id"),
    detectedAt: f.get("detected_at"),
    assignedToMe: f.get("assigned_to_me"),
    resolvedAt: f.get("resolved_at"),
    resolutionNotes: f.get("resolution_notes"),
  };
  if (
    !isUuid(value.id) ||
    typeof value.exceptionType !== "string" ||
    !CODE.test(value.exceptionType) ||
    !isOneOf(SEVERITIES, value.severity) ||
    !isOneOf(EXCEPTION_STATUSES, value.status) ||
    typeof value.sourceType !== "string" ||
    !CODE.test(value.sourceType) ||
    !nullableId(value.sourceId) ||
    typeof value.canonicalType !== "string" ||
    !CODE.test(value.canonicalType) ||
    !nullableId(value.canonicalId) ||
    !isTimestamp(value.detectedAt) ||
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    !nullableId(assignedTo) ||
    typeof value.assignedToMe !== "boolean" ||
    (value.assignedToMe && assignedTo === null) ||
    !nullableTime(value.resolvedAt) ||
    !(
      value.resolutionNotes === null ||
      typeof value.resolutionNotes === "string"
    ) ||
    (value.status === "resolved") !== (value.resolvedAt !== null)
  ) {
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(evidence);
  } catch {
    return null;
  }
  return Object.freeze({
    ...value,
    evidence: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
    assigned: assignedTo !== null,
  }) as ExceptionRow;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type FinancePager = {
  readonly page: number;
  readonly hasNext: boolean;
};

const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);
const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

export function financePageOf(value: unknown): number {
  const text = Array.isArray(value) ? undefined : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,3}$/.test(text)) {
    return 1;
  }
  return Math.min(Number(text), MAX_PAGE);
}

export function paymentGroupOf(value: unknown): PaymentGroup {
  return isOneOf(PAYMENT_GROUPS, value) ? value : "open";
}

export function exceptionStatusOf(value: unknown): ExceptionStatus {
  return isOneOf(EXCEPTION_STATUSES, value) ? value : "open";
}

async function financeContext(
  sources: FinanceSources,
): Promise<
  { readonly userId: string; readonly reads: FinanceReads } | Refusal
> {
  const staff = await verifiedStaffWith(sources.staff, FINANCE_CAPABILITY);
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { userId: staff.userId, reads };
}

function pageOf<T>(
  rows: readonly unknown[] | null,
  reader: (row: unknown) => T | null,
  page: number,
): { readonly rows: readonly T[]; readonly pager: FinancePager } | null {
  if (rows === null || rows.length > FINANCE_PAGE_SIZE + 1) {
    return null;
  }
  const read = readRows(rows, reader);
  if (read === null) {
    return null;
  }
  return {
    rows: Object.freeze(read.slice(0, FINANCE_PAGE_SIZE)),
    pager: Object.freeze({ page, hasNext: read.length > FINANCE_PAGE_SIZE }),
  };
}

export type FinancePaymentsView =
  | {
      readonly status: "ready";
      readonly group: PaymentGroup;
      readonly payments: readonly FinancePaymentRow[];
      readonly pager: FinancePager;
    }
  | Refusal;

export async function resolveFinancePayments(
  sources: FinanceSources,
  groupValue: unknown,
  pageValue: unknown,
): Promise<FinancePaymentsView> {
  try {
    const group = paymentGroupOf(groupValue);
    const page = financePageOf(pageValue);
    const context = await financeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    const read = pageOf(
      rowsOf(
        await attempt(() =>
          context.reads.payments(group, (page - 1) * FINANCE_PAGE_SIZE),
        ),
      ),
      readPaymentRow,
      page,
    );
    return read === null
      ? UNAVAILABLE
      : Object.freeze({
          status: "ready",
          group,
          payments: read.rows,
          pager: read.pager,
        });
  } catch {
    return UNAVAILABLE;
  }
}

export type Refundable = Readonly<Record<RefundComponent, number>>;

export type FinancePaymentView =
  | {
      readonly status: "ready";
      readonly payment: FinancePaymentDetail;
      readonly ledger: readonly LedgerLine[];
      readonly receipts: readonly ReceiptLine[];
      // What remains refundable of each component: its capture credit less
      // its refund debits, from the ledger.
      readonly refundable: Refundable;
    }
  | typeof NOT_FOUND
  | Refusal;

export function refundableOf(ledger: readonly LedgerLine[]): Refundable {
  const remaining: Record<RefundComponent, number> = {
    attorney_share: 0,
    platform_fee: 0,
    client_fee: 0,
    other_required_fee: 0,
  };
  for (const line of ledger) {
    if (line.entryType === "client_payment") {
      continue;
    }
    remaining[line.entryType] +=
      line.direction === "credit" ? line.amountMinor : -line.amountMinor;
  }
  return Object.freeze(remaining);
}

export async function resolveFinancePayment(
  sources: FinanceSources,
  paymentId: unknown,
): Promise<FinancePaymentView> {
  try {
    if (!isUuid(paymentId)) {
      return NOT_FOUND;
    }
    const context = await financeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    const [detailRows, ledgerRows, receiptRows] = (
      await Promise.all([
        attempt(() => context.reads.payment(paymentId)),
        attempt(() => context.reads.ledger(paymentId)),
        attempt(() => context.reads.receipts(paymentId)),
      ])
    ).map(rowsOf);
    if (detailRows === null || ledgerRows === null || receiptRows === null) {
      return UNAVAILABLE;
    }
    if (detailRows.length === 0) {
      return NOT_FOUND;
    }
    const payment =
      detailRows.length === 1
        ? readPaymentDetail(detailRows[0], paymentId)
        : null;
    const ledger =
      ledgerRows.length <= 200 ? readRows(ledgerRows, readLedgerLine) : null;
    const receipts =
      receiptRows.length <= 200 ? readRows(receiptRows, readReceiptLine) : null;
    if (
      payment === null ||
      ledger === null ||
      receipts === null ||
      ledger.some((line) => line.currency !== payment.currency)
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      payment,
      ledger,
      receipts,
      refundable: refundableOf(ledger),
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type FinanceExceptionsView =
  | {
      readonly status: "ready";
      readonly exceptionStatus: ExceptionStatus;
      readonly exceptions: readonly ExceptionRow[];
      readonly pager: FinancePager;
    }
  | Refusal;

export async function resolveFinanceExceptions(
  sources: FinanceSources,
  statusValue: unknown,
  pageValue: unknown,
): Promise<FinanceExceptionsView> {
  try {
    const exceptionStatus = exceptionStatusOf(statusValue);
    const page = financePageOf(pageValue);
    const context = await financeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    const read = pageOf(
      rowsOf(
        await attempt(() =>
          context.reads.exceptions(
            exceptionStatus,
            (page - 1) * FINANCE_PAGE_SIZE,
          ),
        ),
      ),
      readExceptionRow,
      page,
    );
    return read === null
      ? UNAVAILABLE
      : Object.freeze({
          status: "ready",
          exceptionStatus,
          exceptions: read.rows,
          pager: read.pager,
        });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Changes (server actions)
// ---------------------------------------------------------------------------

export type FinanceActionState =
  | { readonly status: "idle" }
  | { readonly status: "recorded" }
  | { readonly status: "invalid" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "outcome-unknown" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_FINANCE_STATE: FinanceActionState = Object.freeze({
  status: "idle",
});

const STATE = (
  status: Exclude<FinanceActionState["status"], "refused" | "step-up-required">,
) => Object.freeze({ status }) as FinanceActionState;

// Each named field at most once and as text; null when repeated or not text.
function fieldsOf(
  formData: FormData,
  names: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, string> | null {
  const fields = new Map<string, string>();
  for (const name of [...names, ...optional]) {
    const values = formData.getAll(name);
    if (values.length === 0 && optional.includes(name)) {
      continue;
    }
    const [value] = values;
    if (values.length !== 1 || typeof value !== "string") {
      return null;
    }
    fields.set(name, value);
  }
  return fields;
}

// An amount typed in a currency's major unit, zero allowed, as minor units,
// or null.
export function componentMinorOf(
  text: string,
  currency: string,
): number | null {
  const digits = currencyMinorDigits(currency);
  const pattern =
    digits === 0
      ? /^(\d{1,13})$/
      : new RegExp(`^(\\d{1,13})(?:\\.(\\d{1,${digits}}))?$`);
  const match = pattern.exec(text.trim());
  if (match === null) {
    return null;
  }
  const minor =
    Number(match[1]) * 10 ** digits +
    (digits === 0 ? 0 : Number((match[2] ?? "").padEnd(digits, "0")));
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= MAX_AMOUNT_MINOR
    ? minor
    : null;
}

function answerOf(answer: unknown, outcomes: readonly string[]): FinanceAnswer {
  const kind = readExact(answer, ["kind"])?.get("kind");
  if (kind === "rejected" || kind === "unreadable") {
    return Object.freeze({ kind });
  }
  const f = readExact(answer, ["kind", "outcome"]);
  const outcome = f?.get("outcome");
  return f?.get("kind") === "answer" &&
    typeof outcome === "string" &&
    outcomes.includes(outcome)
    ? Object.freeze({ kind: "answer", outcome })
    : Object.freeze({ kind: "unreadable" });
}

function stateOf(answer: FinanceAnswer, success: string): FinanceActionState {
  if (answer.kind === "rejected") {
    return STATE("unavailable");
  }
  if (answer.kind === "unreadable") {
    return STATE("outcome-unknown");
  }
  if (answer.outcome === success || answer.outcome === "applied") {
    return STATE("recorded");
  }
  if (answer.outcome === "denied") {
    return STATE("denied");
  }
  if (answer.outcome === "invalid") {
    return STATE("invalid");
  }
  return Object.freeze({ status: "refused", reason: answer.outcome });
}

async function writeContext(sources: FinanceSources): Promise<
  | {
      readonly userId: string;
      readonly reads: FinanceReads;
      readonly writes: FinanceWrites;
    }
  | Refusal
> {
  const context = await financeContext(sources);
  if (!("userId" in context)) {
    return context;
  }
  const writes = await portFrom(sources.writes);
  return writes === null ? UNAVAILABLE : { ...context, writes };
}

// A staff refund with a chosen allocation and a required reason. The
// payment's currency comes from the database (never the form); the database
// decides the remaining amounts again and records the refund policy version.
export async function requestFinanceRefund(
  sources: FinanceSources,
  formData: unknown,
): Promise<FinanceActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return STATE("unavailable");
    }
    const fields = fieldsOf(formData, [
      "payment",
      ...REFUND_COMPONENTS,
      "reason",
    ]);
    const paymentId = fields?.get("payment");
    const reason = textField(fields?.get("reason"), 500);
    if (
      fields === null ||
      !isUuid(paymentId) ||
      reason === null ||
      reason === ""
    ) {
      return STATE("invalid");
    }
    const context = await writeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    const detailRows = rowsOf(
      await attempt(() => context.reads.payment(paymentId)),
    );
    if (detailRows === null || detailRows.length > 1) {
      return STATE("unavailable");
    }
    if (detailRows.length === 0) {
      return Object.freeze({ status: "refused", reason: "not_found" });
    }
    const detail = readPaymentDetail(detailRows[0], paymentId);
    if (detail === null) {
      return STATE("unavailable");
    }
    const amounts: Partial<Record<RefundComponent, number>> = {};
    for (const component of REFUND_COMPONENTS) {
      const minor = componentMinorOf(
        fields.get(component) ?? "",
        detail.currency,
      );
      if (minor === null) {
        return STATE("invalid");
      }
      amounts[component] = minor;
    }
    if (
      Object.values(amounts).reduce((sum, value) => sum + (value ?? 0), 0) < 1
    ) {
      return STATE("invalid");
    }
    const binding = bindEnvironment(
      rowsOf(await attempt(() => context.reads.environmentIdentity())),
      sources.environment(),
    );
    if (binding === "unrecorded" || binding === "mismatch") {
      return STATE("unavailable");
    }
    return stateOf(
      answerOf(
        await attempt(() =>
          context.writes.requestRefund({
            paymentId,
            amounts: Object.freeze(amounts) as Readonly<
              Record<RefundComponent, number>
            >,
            reason,
          }),
        ),
        REFUND_OUTCOMES,
      ),
      "requested",
    );
  } catch {
    return STATE("unavailable");
  }
}

// Assigns an open exception to the caller, or clears its assignment.
export async function assignFinanceException(
  sources: FinanceSources,
  formData: unknown,
): Promise<FinanceActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return STATE("unavailable");
    }
    const fields = fieldsOf(formData, ["exception", "assign"]);
    const exceptionId = fields?.get("exception");
    const assign = fields?.get("assign");
    if (!isUuid(exceptionId) || (assign !== "me" && assign !== "nobody")) {
      return STATE("invalid");
    }
    const context = await writeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    return stateOf(
      answerOf(
        await attempt(() =>
          context.writes.assignException(exceptionId, assign === "me"),
        ),
        ASSIGN_OUTCOMES,
      ),
      "applied",
    );
  } catch {
    return STATE("unavailable");
  }
}

// Resolves an open exception once, with the staff member's notes.
export async function resolveFinanceException(
  sources: FinanceSources,
  formData: unknown,
): Promise<FinanceActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return STATE("unavailable");
    }
    const fields = fieldsOf(formData, ["exception", "notes"]);
    const exceptionId = fields?.get("exception");
    const notes = textField(fields?.get("notes"), 2000);
    if (!isUuid(exceptionId) || notes === null || notes === "") {
      return STATE("invalid");
    }
    const context = await writeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    return stateOf(
      answerOf(
        await attempt(() =>
          context.writes.resolveException(exceptionId, notes),
        ),
        RESOLVE_OUTCOMES,
      ),
      "applied",
    );
  } catch {
    return STATE("unavailable");
  }
}

// Asks the worker to reconcile one payment (a payment field) or every live
// payment (no payment field) with the provider.
export async function requestFinanceReconciliation(
  sources: FinanceSources,
  formData: unknown,
): Promise<FinanceActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return STATE("unavailable");
    }
    const fields = fieldsOf(formData, [], ["payment"]);
    const paymentId = fields?.get("payment") ?? null;
    if (fields === null || !(paymentId === null || isUuid(paymentId))) {
      return STATE("invalid");
    }
    const context = await writeContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    return stateOf(
      answerOf(
        await attempt(() => context.writes.requestReconciliation(paymentId)),
        RECONCILE_OUTCOMES,
      ),
      "requested",
    );
  } catch {
    return STATE("unavailable");
  }
}
