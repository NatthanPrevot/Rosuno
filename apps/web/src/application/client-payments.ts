// The client's payment step, authorization, status and receipts, and the
// attorney's ledger-derived earnings (MVP-001 S7; MBS section 12
// "client-facing payment status/receipt/refund surfaces"; Packet S7 "client
// payment status, receipts and refunds" and "ledger-derived attorney
// earnings"; Packet section 2 rules 7, 11 and 13).
//
// Provider-neutral and injectable: each request hands in its own ports.
//
// The database decides everything: whether the Request's payment flow asks
// for an authorization before the attorney decision (configuration; G-2 and
// G-3 stay unresolved), whether an attempt may be started, its provenance,
// its state, its amounts and every refund. This module reads its answers
// strictly (an unexpected column or value makes the whole answer
// unavailable) and reports only fixed outcomes. Before a payment attempt is
// created the server checks, in this order, that payments are configured at
// all (the provider adapter exists; otherwise one fixed "unavailable"
// outcome, nothing sent and no fallback), and the environment binding (PS-A2
// section 6; Packet rule 7). The client then goes to the provider's hosted
// page, so card data never reaches Rosuno; when the client returns, the page
// shows the state the database recorded, never what the browser or the
// provider page said. No legal, disclosure or entitlement text is shown: the
// wording is fixed and neutral.
//
// The attorney's earnings are the attorney_share entries the ledger holds
// for the attorney's own Requests, per payment and currency: what was
// attributed at capture, what refunds reversed, and the net. No balance,
// payout or settlement is stored or implied.

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
} from "./attorney-access.ts";
import { verifiedClientOf, type ClientIntakeSources } from "./client-intake.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  isAmountMinor,
  isCurrencyCode,
  PAYMENT_STATES,
  type PaymentState,
} from "./payments.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import type { ServerSessionSource } from "./session.ts";

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

export const PAYMENT_STEPS = Object.freeze([
  "authorization_required",
  "not_required_now",
  "unavailable",
  "not_applicable",
] as const);
export type PaymentStep = (typeof PAYMENT_STEPS)[number];

export const REQUEST_PAYMENT_COLUMNS = Object.freeze([
  "consultation_request_id",
  "payment_step",
  "payable",
  "payment_transaction_id",
  "payment_state",
  "amount_authorized_minor",
  "amount_captured_minor",
  "amount_refunded_minor",
  "total_client_amount_minor",
  "currency_code",
  "created_at",
  "authorized_at",
  "captured_at",
  "failed_at",
]);

export const RECEIPT_COLUMNS = Object.freeze([
  "payment_transaction_id",
  "consultation_request_id",
  "payment_state",
  "attorney_listed_price_minor",
  "client_fee_minor",
  "tax_or_other_required_fee_minor",
  "total_client_amount_minor",
  "currency_code",
  "amount_authorized_minor",
  "amount_captured_minor",
  "amount_refunded_minor",
  "created_at",
  "authorized_at",
  "captured_at",
  "refunds",
]);

export const CHECKOUT_COLUMNS = Object.freeze([
  "outcome",
  "checkout_reference",
  "consultation_request_id",
]);

export const EARNINGS_COLUMNS = Object.freeze([
  "payment_transaction_id",
  "consultation_request_id",
  "captured_at",
  "currency_code",
  "attributed_minor",
  "reversed_minor",
  "net_minor",
]);

// client_authorize_payment's own fixed outcomes.
export const AUTHORIZE_OUTCOMES = Object.freeze([
  "created",
  "pending",
  "invalid",
  "not_found",
  "expired",
  "not_payable",
  "not_required",
  "policy_unavailable",
  "production_gate_closed",
] as const);

export const CHECKOUT_OUTCOMES = Object.freeze([
  "ready",
  "preparing",
  "not_pending",
] as const);

// The most earning lines the database lists.
export const MAX_EARNINGS = 500;

export type ClientPaymentReads = {
  // client_request_payment(request)
  readonly requestPayment: (requestId: string) => Promise<RowsResult>;
  // client_payment_receipt(payment)
  readonly receipt: (paymentId: string) => Promise<RowsResult>;
  // client_payment_checkout(payment)
  readonly checkout: (paymentId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type AuthorizeAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: (typeof AUTHORIZE_OUTCOMES)[number];
      readonly paymentId: string | null;
      readonly problem: string | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type ClientPaymentWrites = {
  readonly authorize: (requestId: string) => Promise<AuthorizeAnswer>;
};

// The provider's hosted page of one open checkout (server-only; null when
// the checkout is not open or cannot be read).
export type CheckoutLinks = {
  readonly checkoutUrl: (checkoutReference: string) => Promise<string | null>;
};

export type ClientPaymentSources = {
  // The client intake sources decide the verified client.
  readonly clientIntake: ClientIntakeSources;
  readonly reads: () => Promise<ClientPaymentReads | null>;
  readonly writes: () => Promise<ClientPaymentWrites | null>;
  // The server-side environment setting compared with the database's own
  // record before an attempt is created (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
  // The provider's hosted checkout links; null when payments are not
  // configured (no fallback).
  readonly checkoutLinks: () => Promise<CheckoutLinks | null>;
  // One bounded run of the operational job worker, so the hosted checkout
  // the new attempt enqueued is usually ready at once. Never throws.
  readonly drain: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type LatestPayment = {
  readonly id: string;
  readonly state: PaymentState;
  readonly amountAuthorizedMinor: number | null;
  readonly amountCapturedMinor: number | null;
  readonly amountRefundedMinor: number;
  readonly createdAt: string;
  readonly authorizedAt: string | null;
  readonly capturedAt: string | null;
  readonly failedAt: string | null;
};

export type RequestPayment = {
  readonly requestId: string;
  readonly step: PaymentStep;
  readonly payable: boolean;
  readonly totalMinor: number | null;
  readonly currency: string | null;
  readonly latest: LatestPayment | null;
};

const nullableAmount = (value: unknown): value is number | null =>
  value === null || isAmountMinor(value);
const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);

function readRequestPayment(
  row: unknown,
  requestId: string,
): RequestPayment | null {
  const f = readExact(row, REQUEST_PAYMENT_COLUMNS);
  if (f === null) {
    return null;
  }
  const id = f.get("payment_transaction_id");
  const state = f.get("payment_state");
  const step = f.get("payment_step");
  const payable = f.get("payable");
  const total = f.get("total_client_amount_minor");
  const currency = f.get("currency_code");
  const authorized = f.get("amount_authorized_minor");
  const captured = f.get("amount_captured_minor");
  const refunded = f.get("amount_refunded_minor");
  const created = f.get("created_at");
  const authorizedAt = f.get("authorized_at");
  const capturedAt = f.get("captured_at");
  const failedAt = f.get("failed_at");
  if (
    f.get("consultation_request_id") !== requestId ||
    !isOneOf(PAYMENT_STEPS, step) ||
    typeof payable !== "boolean" ||
    (payable && step !== "authorization_required") ||
    !nullableAmount(total) ||
    !(currency === null || isCurrencyCode(currency)) ||
    !(id === null || isUuid(id)) ||
    !(state === null || isOneOf(PAYMENT_STATES, state)) ||
    !nullableAmount(authorized) ||
    !nullableAmount(captured) ||
    !nullableAmount(refunded) ||
    !nullableTime(created) ||
    !nullableTime(authorizedAt) ||
    !nullableTime(capturedAt) ||
    !nullableTime(failedAt)
  ) {
    return null;
  }
  let latest: LatestPayment | null = null;
  if (id !== null) {
    if (state === null || refunded === null || created === null) {
      return null;
    }
    latest = Object.freeze({
      id: id as string,
      state: state as PaymentState,
      amountAuthorizedMinor: authorized as number | null,
      amountCapturedMinor: captured as number | null,
      amountRefundedMinor: refunded as number,
      createdAt: created as string,
      authorizedAt: authorizedAt as string | null,
      capturedAt: capturedAt as string | null,
      failedAt: failedAt as string | null,
    });
  } else if (
    state !== null ||
    authorized !== null ||
    captured !== null ||
    refunded !== null ||
    created !== null
  ) {
    return null;
  }
  return Object.freeze({
    requestId,
    step,
    payable,
    totalMinor: total as number | null,
    currency: currency as string | null,
    latest,
  });
}

export type Refund = {
  readonly amountMinor: number;
  readonly effectiveAt: string;
};

export type PaymentReceipt = {
  readonly id: string;
  readonly requestId: string;
  readonly state: PaymentState;
  readonly listedPriceMinor: number;
  readonly clientFeeMinor: number;
  readonly otherFeeMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly amountAuthorizedMinor: number | null;
  readonly amountCapturedMinor: number | null;
  readonly amountRefundedMinor: number;
  readonly createdAt: string;
  readonly authorizedAt: string | null;
  readonly capturedAt: string | null;
  readonly refunds: readonly Refund[];
};

function readRefunds(value: unknown): readonly Refund[] | null {
  if (!Array.isArray(value) || value.length > 200) {
    return null;
  }
  const refunds: Refund[] = [];
  for (const entry of value) {
    const f = readExact(entry, ["amount_minor", "effective_at"]);
    const amount = f?.get("amount_minor");
    const at = f?.get("effective_at");
    if (
      f === null ||
      !isAmountMinor(amount) ||
      amount < 1 ||
      !isTimestamp(at)
    ) {
      return null;
    }
    refunds.push(Object.freeze({ amountMinor: amount, effectiveAt: at }));
  }
  return Object.freeze(refunds);
}

function readReceipt(row: unknown, paymentId: string): PaymentReceipt | null {
  const f = readExact(row, RECEIPT_COLUMNS);
  if (f === null) {
    return null;
  }
  const requestId = f.get("consultation_request_id");
  const state = f.get("payment_state");
  const listed = f.get("attorney_listed_price_minor");
  const clientFee = f.get("client_fee_minor");
  const other = f.get("tax_or_other_required_fee_minor");
  const total = f.get("total_client_amount_minor");
  const currency = f.get("currency_code");
  const authorized = f.get("amount_authorized_minor");
  const captured = f.get("amount_captured_minor");
  const refunded = f.get("amount_refunded_minor");
  const created = f.get("created_at");
  const authorizedAt = f.get("authorized_at");
  const capturedAt = f.get("captured_at");
  const refunds = readRefunds(f.get("refunds"));
  if (
    f.get("payment_transaction_id") !== paymentId ||
    !isUuid(requestId) ||
    !isOneOf(PAYMENT_STATES, state) ||
    !isAmountMinor(listed) ||
    !isAmountMinor(clientFee) ||
    !isAmountMinor(other) ||
    !isAmountMinor(total) ||
    !isCurrencyCode(currency) ||
    !nullableAmount(authorized) ||
    !nullableAmount(captured) ||
    !isAmountMinor(refunded) ||
    !isTimestamp(created) ||
    !nullableTime(authorizedAt) ||
    !nullableTime(capturedAt) ||
    refunds === null ||
    refunds.reduce((sum, refund) => sum + refund.amountMinor, 0) !== refunded
  ) {
    return null;
  }
  return Object.freeze({
    id: paymentId,
    requestId,
    state,
    listedPriceMinor: listed,
    clientFeeMinor: clientFee,
    otherFeeMinor: other,
    totalMinor: total,
    currency,
    amountAuthorizedMinor: authorized as number | null,
    amountCapturedMinor: captured as number | null,
    amountRefundedMinor: refunded,
    createdAt: created,
    authorizedAt: authorizedAt as string | null,
    capturedAt: capturedAt as string | null,
    refunds,
  });
}

// ---------------------------------------------------------------------------
// The payment step of one Request (read on the request page)
// ---------------------------------------------------------------------------

export type RequestPaymentView =
  | { readonly status: "ready"; readonly payment: RequestPayment }
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);

// Reads the payment step and latest attempt of one of the client's own
// Requests. It never throws; another client's or an unknown Request is
// not-found.
export async function resolveRequestPayment(
  sources: ClientPaymentSources,
  requestId: unknown,
): Promise<RequestPaymentView> {
  try {
    if (!isUuid(requestId)) {
      return NOT_FOUND;
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return client;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.requestPayment(requestId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const payment = readRequestPayment(rows[0], requestId);
    return payment === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", payment });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Authorizing a payment (server action)
// ---------------------------------------------------------------------------

export type AuthorizeActionState =
  | { readonly status: "idle" }
  | { readonly status: "redirect"; readonly url: string }
  | { readonly status: "preparing" }
  | { readonly status: "invalid" }
  | { readonly status: "not-found" }
  | { readonly status: "expired" }
  | { readonly status: "not-payable" }
  | { readonly status: "not-required" }
  | { readonly status: "configuration-unavailable" }
  | { readonly status: "payments-unavailable" }
  | { readonly status: "outcome-unknown" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

export const INITIAL_AUTHORIZE_STATE: AuthorizeActionState = Object.freeze({
  status: "idle",
});

type PlainAuthorizeStatus = Exclude<AuthorizeActionState["status"], "redirect">;
const AUTHORIZE_STATE = (status: PlainAuthorizeStatus) =>
  Object.freeze({ status }) as AuthorizeActionState;

function authorizeAnswerOf(answer: unknown): AuthorizeAnswer {
  const kind = readExact(answer, ["kind"])?.get("kind");
  if (kind === "rejected" || kind === "unreadable") {
    return Object.freeze({ kind });
  }
  const f = readExact(answer, ["kind", "outcome", "paymentId", "problem"]);
  const outcome = f?.get("outcome");
  const paymentId = f?.get("paymentId");
  const problem = f?.get("problem");
  if (
    f?.get("kind") !== "answer" ||
    !isOneOf(AUTHORIZE_OUTCOMES, outcome) ||
    !(paymentId === null || isUuid(paymentId)) ||
    !(problem === null || typeof problem === "string")
  ) {
    return Object.freeze({ kind: "unreadable" });
  }
  return Object.freeze({ kind: "answer", outcome, paymentId, problem });
}

// The hosted page of one of the client's own pending attempts, once its
// checkout is recorded.
async function checkoutStateOf(
  reads: ClientPaymentReads,
  links: CheckoutLinks,
  paymentId: string,
  requestId: string,
): Promise<AuthorizeActionState> {
  const rows = rowsOf(await attempt(() => reads.checkout(paymentId)));
  if (rows === null || rows.length !== 1) {
    return AUTHORIZE_STATE("outcome-unknown");
  }
  const f = readExact(rows[0], CHECKOUT_COLUMNS);
  const outcome = f?.get("outcome");
  const reference = f?.get("checkout_reference");
  if (
    f === null ||
    f.get("consultation_request_id") !== requestId ||
    !isOneOf(CHECKOUT_OUTCOMES, outcome) ||
    (outcome === "ready") !== (typeof reference === "string")
  ) {
    return AUTHORIZE_STATE("outcome-unknown");
  }
  if (outcome === "not_pending") {
    return AUTHORIZE_STATE("not-payable");
  }
  if (outcome === "preparing") {
    return AUTHORIZE_STATE("preparing");
  }
  let url: string | null = null;
  try {
    url = await links.checkoutUrl(reference as string);
  } catch {
    url = null;
  }
  return url === null
    ? AUTHORIZE_STATE("preparing")
    : Object.freeze({ status: "redirect", url });
}

// Starts (or continues) the payment attempt of one of the client's own
// Requests and answers where the client goes next: the provider's hosted
// page, or a fixed outcome. Payments must be configured and the environment
// bound before anything is sent; the database decides everything else.
export async function authorizeRequestPayment(
  sources: ClientPaymentSources,
  formData: unknown,
): Promise<AuthorizeActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return AUTHORIZE_STATE("unavailable");
    }
    const values = formData.getAll("request");
    const requestId = values.length === 1 ? values[0] : null;
    if (!isUuid(requestId)) {
      return AUTHORIZE_STATE("invalid");
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return AUTHORIZE_STATE(client.status);
    }
    const links = await portFrom(sources.checkoutLinks);
    if (links === null) {
      return AUTHORIZE_STATE("payments-unavailable");
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (reads === null || writes === null) {
      return AUTHORIZE_STATE("unavailable");
    }
    const binding = bindEnvironment(
      rowsOf(await attempt(() => reads.environmentIdentity())),
      sources.environment(),
    );
    if (binding === "unrecorded" || binding === "mismatch") {
      return AUTHORIZE_STATE("unavailable");
    }
    const answer = authorizeAnswerOf(
      await attempt(() => writes.authorize(requestId)),
    );
    if (answer.kind === "rejected") {
      return AUTHORIZE_STATE("unavailable");
    }
    if (answer.kind === "unreadable") {
      return AUTHORIZE_STATE("outcome-unknown");
    }
    switch (answer.outcome) {
      case "created":
      case "pending": {
        if (answer.paymentId === null) {
          return AUTHORIZE_STATE("outcome-unknown");
        }
        try {
          await sources.drain();
        } catch {
          // The checkout job stays pending until the next worker run.
        }
        return await checkoutStateOf(reads, links, answer.paymentId, requestId);
      }
      case "invalid":
        return AUTHORIZE_STATE("invalid");
      case "not_found":
        return AUTHORIZE_STATE("not-found");
      case "expired":
        return AUTHORIZE_STATE("expired");
      case "not_payable":
        return AUTHORIZE_STATE("not-payable");
      case "not_required":
        return AUTHORIZE_STATE("not-required");
      case "policy_unavailable":
      case "production_gate_closed":
        return AUTHORIZE_STATE("configuration-unavailable");
      default:
        return AUTHORIZE_STATE("outcome-unknown");
    }
  } catch {
    return AUTHORIZE_STATE("unavailable");
  }
}

// ---------------------------------------------------------------------------
// One receipt
// ---------------------------------------------------------------------------

export type ReceiptView =
  | { readonly status: "ready"; readonly receipt: PaymentReceipt }
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

// Reads one of the client's own payment attempts. It never throws; another
// client's or an unknown attempt is not-found.
export async function resolvePaymentReceipt(
  sources: ClientPaymentSources,
  paymentId: unknown,
): Promise<ReceiptView> {
  try {
    if (!isUuid(paymentId)) {
      return NOT_FOUND;
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return client;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.receipt(paymentId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const receipt = readReceipt(rows[0], paymentId);
    return receipt === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", receipt });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The attorney's ledger-derived earnings
// ---------------------------------------------------------------------------

export type EarningsReads = {
  // attorney_payment_earnings()
  readonly earnings: () => Promise<RowsResult>;
};

export type EarningsSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
  readonly reads: () => Promise<EarningsReads | null>;
};

export type EarningLine = {
  readonly paymentId: string;
  readonly requestId: string;
  readonly capturedAt: string | null;
  readonly currency: string;
  readonly attributedMinor: number;
  readonly reversedMinor: number;
  readonly netMinor: number;
};

export type EarningsTotal = {
  readonly currency: string;
  readonly attributedMinor: number;
  readonly reversedMinor: number;
  readonly netMinor: number;
};

export type EarningsView =
  | {
      readonly status: "ready";
      readonly lines: readonly EarningLine[];
      // One total per currency, never added across currencies.
      readonly totals: readonly EarningsTotal[];
    }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

function readEarning(row: unknown): EarningLine | null {
  const f = readExact(row, EARNINGS_COLUMNS);
  if (f === null) {
    return null;
  }
  const paymentId = f.get("payment_transaction_id");
  const requestId = f.get("consultation_request_id");
  const capturedAt = f.get("captured_at");
  const currency = f.get("currency_code");
  const attributed = f.get("attributed_minor");
  const reversed = f.get("reversed_minor");
  const net = f.get("net_minor");
  if (
    !isUuid(paymentId) ||
    !isUuid(requestId) ||
    !nullableTime(capturedAt) ||
    !isCurrencyCode(currency) ||
    !isAmountMinor(attributed) ||
    !isAmountMinor(reversed) ||
    !Number.isSafeInteger(net) ||
    net !== attributed - reversed
  ) {
    return null;
  }
  return Object.freeze({
    paymentId,
    requestId,
    capturedAt: capturedAt as string | null,
    currency,
    attributedMinor: attributed,
    reversedMinor: reversed,
    netMinor: net as number,
  });
}

// Reads the attorney's own earnings for the current request. It never
// throws; nothing is shown without the attorney principal.
export async function resolveAttorneyEarnings(
  sources: EarningsSources,
): Promise<EarningsView> {
  try {
    const access = await resolveAttorneyWorkspaceAccess({
      session: sources.session,
      attorney: sources.attorney,
    });
    if (access.status !== "granted") {
      return access.status === "sign-in-required" || access.status === "denied"
        ? Object.freeze({ status: access.status })
        : UNAVAILABLE;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.earnings()));
    if (rows === null || rows.length > MAX_EARNINGS) {
      return UNAVAILABLE;
    }
    const lines = readRows(rows, readEarning);
    if (
      lines === null ||
      new Set(lines.map((l) => l.paymentId)).size !== lines.length
    ) {
      return UNAVAILABLE;
    }
    const byCurrency = new Map<string, EarningsTotal>();
    for (const line of lines) {
      const total = byCurrency.get(line.currency) ?? {
        currency: line.currency,
        attributedMinor: 0,
        reversedMinor: 0,
        netMinor: 0,
      };
      byCurrency.set(line.currency, {
        currency: line.currency,
        attributedMinor: total.attributedMinor + line.attributedMinor,
        reversedMinor: total.reversedMinor + line.reversedMinor,
        netMinor: total.netMinor + line.netMinor,
      });
    }
    const totals = [...byCurrency.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map((total) => Object.freeze(total));
    return Object.freeze({
      status: "ready",
      lines,
      totals: Object.freeze(totals),
    });
  } catch {
    return UNAVAILABLE;
  }
}
