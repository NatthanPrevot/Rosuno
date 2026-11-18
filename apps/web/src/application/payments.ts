// The payment engine boundary in the application (MVP-001 S7; MBS section
// 12; IMP sections 3 and 23; TA sections 15, 16.1, 26, 27, 52 and 53; PM
// sections 1, 3, 4, 9 and 10).
//
// Provider-neutral and injectable. Rosuno speaks in domain operations
// (authorize through a hosted checkout, capture, release, refund, reconcile)
// and a provider adapter translates them; no Rosuno state is a provider's
// status. The database owns every decision: the payment state, its FP-1
// provenance, the ledger, the receipts and the Reconciliation Exceptions.
//
// This module holds:
// - the provider port (the adapter's operations, each answering one of a
//   fixed set of neutral results) and the provider observations Rosuno
//   records (the database's own observation vocabulary);
// - the recording port (the server-only privileged worker and webhook calls:
//   the job context, a provider call's result, a provider event);
// - the operational job handlers for the five payment job types. Each reads
//   what to do from canonical state (payment_job_context), makes at most a
//   few provider calls with a deterministic idempotency key derived from the
//   payment, the operation and the refund request (IMP section 23 outbound:
//   a retried job never repeats a provider effect), records the observed
//   result, and resolves JOB_DONE only when the database recorded it. A
//   transient provider answer, an unknown recording answer or missing
//   configuration throws, so the S2 protocol retries with backoff and an
//   exhausted job opens a Reconciliation Exception (TA section 52: never
//   "request sent = success");
// - the recording of one authenticated provider event (the webhook route
//   verifies the signature before anything reaches here).
//
// Nothing here logs a key, card data or a provider payload; the handlers
// carry only identifiers, amounts, currencies and statuses.

import { JOB_DONE, type JobHandler, type JobRun } from "./job-worker.ts";
import { isTimestamp, isUuid, readExact } from "./professional-records.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// The S7 Payment Transaction states (PM section 9 rows 26-30; TA section 52).
export const PAYMENT_STATES = Object.freeze([
  "pending_authorization",
  "authorized",
  "failed",
  "cancelled",
  "release_pending",
  "authorization_released",
  "capture_pending",
  "captured",
  "capture_failed",
  "refund_pending",
  "partially_refunded",
  "fully_refunded",
  "charged_back",
] as const);
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const PAYMENT_JOB_TYPES = Object.freeze([
  "payment.checkout",
  "payment.capture",
  "payment.release",
  "payment.refund",
  "payment.reconcile",
] as const);
export type PaymentJobType = (typeof PAYMENT_JOB_TYPES)[number];

// The observation kinds the database records (its payment_observation_valid
// vocabulary).
export const OBSERVATION_KINDS = Object.freeze([
  "checkout_open",
  "checkout_completed",
  "checkout_expired",
  "authorization_confirmed",
  "authorization_failed",
  "authorization_released",
  "capture_confirmed",
  "capture_refused",
  "refund_confirmed",
  "refund_refused",
  "refund_observed",
  "dispute_opened",
  "dispute_updated",
  "dispute_closed",
  "provider_state",
  "ignored",
] as const);
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

// One provider observation, exactly the members the database accepts.
export type Observation = {
  readonly kind: ObservationKind;
  readonly payment_transaction_id?: string | null;
  readonly checkout_reference?: string | null;
  readonly payment_reference?: string | null;
  readonly refund_reference?: string | null;
  readonly refund_request_id?: string | null;
  readonly dispute_reference?: string | null;
  readonly amount_minor?: number | null;
  readonly amount_capturable_minor?: number | null;
  readonly amount_received_minor?: number | null;
  readonly amount_refunded_minor?: number | null;
  readonly currency_code?: string | null;
  readonly provider_status?: string | null;
};

const REFERENCE = /^[A-Za-z0-9_]{3,255}$/;
const CURRENCY = /^[A-Z]{3}$/;
const STATUS = /^[a-z][a-z0-9_]{1,39}$/;
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

export function isProviderReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE.test(value);
}

export function isAmountMinor(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_AMOUNT_MINOR
  );
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && CURRENCY.test(value);
}

// Whether an observation has exactly the shape the database accepts (the
// database checks it again).
export function isObservation(value: unknown): value is Observation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, member] of entries) {
    if (key === "kind") {
      if (!(OBSERVATION_KINDS as readonly unknown[]).includes(member)) {
        return false;
      }
      continue;
    }
    if (member === null) {
      continue;
    }
    switch (key) {
      case "checkout_reference":
      case "payment_reference":
      case "refund_reference":
      case "dispute_reference":
        if (!isProviderReference(member)) return false;
        break;
      case "payment_transaction_id":
      case "refund_request_id":
        if (!isUuid(member)) return false;
        break;
      case "amount_minor":
      case "amount_capturable_minor":
      case "amount_received_minor":
      case "amount_refunded_minor":
        if (!isAmountMinor(member)) return false;
        break;
      case "currency_code":
        if (!isCurrencyCode(member)) return false;
        break;
      case "provider_status":
        if (typeof member !== "string" || !STATUS.test(member)) return false;
        break;
      default:
        return false;
    }
  }
  return entries.some(([key]) => key === "kind");
}

// ---------------------------------------------------------------------------
// The provider port (TA section 16.1)
// ---------------------------------------------------------------------------

// A provider call's neutral result:
// - ok: the provider answered with a value of the expected shape;
// - declined: a definitive refusal of the payment method (a card error);
// - invalid_state: the provider object is not in a state for this operation;
// - not_found: the provider object does not exist;
// - rejected: the request itself was refused (authentication, validation);
// - transient: no definitive answer (network, timeout, rate limit, server
//   error, idempotency conflict); retry later with the same key.
export type ProviderResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "declined" }
  | { readonly kind: "invalid_state" }
  | { readonly kind: "not_found" }
  | { readonly kind: "rejected" }
  | { readonly kind: "transient" };

export type CheckoutStatus = "open" | "complete" | "expired";

export type CheckoutView = {
  readonly reference: string;
  readonly status: CheckoutStatus;
  // The provider's payment reference once the client confirmed the checkout.
  readonly paymentReference: string | null;
  // The hosted page, only while it is open.
  readonly url: string | null;
};

export type ProviderPaymentStatus =
  | "requires_payment"
  | "processing"
  | "requires_capture"
  | "succeeded"
  | "canceled";

export type PaymentView = {
  readonly reference: string;
  readonly status: ProviderPaymentStatus;
  readonly amountMinor: number;
  readonly amountCapturableMinor: number;
  readonly amountReceivedMinor: number;
  readonly amountRefundedMinor: number;
  readonly currency: string;
};

export type RefundStatus = "pending" | "succeeded" | "failed" | "canceled";

export type RefundView = {
  readonly reference: string;
  readonly status: RefundStatus;
  readonly amountMinor: number;
};

export type CheckoutInput = {
  readonly paymentId: string;
  readonly requestId: string;
  readonly amountMinor: number;
  readonly currency: string;
  // Unix seconds; within the provider's own bounds.
  readonly expiresAt: number;
};

export type RefundInput = {
  readonly paymentId: string;
  readonly refundRequestId: string;
  readonly paymentReference: string;
  readonly amountMinor: number;
};

export type PaymentProvider = {
  readonly createCheckout: (
    input: CheckoutInput,
    idempotencyKey: string,
  ) => Promise<ProviderResult<CheckoutView>>;
  readonly retrieveCheckout: (
    reference: string,
  ) => Promise<ProviderResult<CheckoutView>>;
  readonly expireCheckout: (
    reference: string,
    idempotencyKey: string,
  ) => Promise<ProviderResult<CheckoutView>>;
  readonly retrievePayment: (
    reference: string,
  ) => Promise<ProviderResult<PaymentView>>;
  readonly capturePayment: (
    reference: string,
    amountMinor: number,
    idempotencyKey: string,
  ) => Promise<ProviderResult<PaymentView>>;
  readonly cancelPayment: (
    reference: string,
    idempotencyKey: string,
  ) => Promise<ProviderResult<PaymentView>>;
  readonly createRefund: (
    input: RefundInput,
    idempotencyKey: string,
  ) => Promise<ProviderResult<RefundView>>;
  readonly retrieveRefund: (
    reference: string,
  ) => Promise<ProviderResult<RefundView>>;
};

// The provider's own bounds for a hosted checkout's expiry, in seconds after
// its creation, with a minute of margin on each side: it cannot close sooner
// than this, so a Request deadline that comes first ends the attempt through
// the release (the Request's expiry enqueues it, and an authorization after
// the Request ended is released, never captured).
export const CHECKOUT_MIN_SECONDS = 31 * 60;
export const CHECKOUT_MAX_SECONDS = 23 * 60 * 60 + 59 * 60;

// The checkout expiry for a canonical bound (the earliest of the quote
// validity, the response deadline and the Hold expiry), kept within the
// provider's bounds.
export function checkoutExpiryOf(bound: string | null, nowMs: number): number {
  const now = Math.floor(nowMs / 1000);
  const wanted =
    bound !== null && isTimestamp(bound)
      ? Math.floor(Date.parse(bound) / 1000)
      : now;
  return Math.min(
    Math.max(wanted, now + CHECKOUT_MIN_SECONDS),
    now + CHECKOUT_MAX_SECONDS,
  );
}

// The deterministic idempotency key of one provider operation: the same on
// every attempt and every delivery of the job that asks for it, different
// for every other payment, operation or refund request.
export function idempotencyKeyFor(
  paymentId: string,
  operation: "checkout" | "capture" | "cancel" | "expire" | "refund",
  refundRequestId: string | null = null,
): string {
  return refundRequestId === null
    ? `rosuno-payment-${paymentId}-${operation}`
    : `rosuno-payment-${paymentId}-${operation}-${refundRequestId}`;
}

// ---------------------------------------------------------------------------
// The recording port (server-only privileged calls)
// ---------------------------------------------------------------------------

export const JOB_CONTEXT_COLUMNS = Object.freeze([
  "outcome",
  "operation",
  "payment_transaction_id",
  "consultation_request_id",
  "state",
  "provider_reference",
  "reference_kind",
  "currency_code",
  "amount_minor",
  "refund_request_id",
  "checkout_expires_at",
]);

export const RECORD_OUTCOMES = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "contradiction",
  "invalid",
  "not_running",
  "unmatched",
] as const);
export type RecordOutcome = (typeof RECORD_OUTCOMES)[number];

export const EVENT_OUTCOMES = Object.freeze([
  "recorded",
  "duplicate",
  "invalid",
] as const);
export const PROCESSING_STATES = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "contradiction",
  "unmatched",
  "ignored",
] as const);

export type JobContext = {
  readonly outcome: "act" | "nothing_to_do" | "wait" | "not_running";
  readonly operation: string | null;
  readonly paymentId: string | null;
  readonly requestId: string | null;
  readonly state: PaymentState | null;
  readonly providerReference: string | null;
  readonly referenceKind: "none" | "checkout" | "payment" | null;
  readonly currency: string | null;
  readonly amountMinor: number | null;
  readonly refundRequestId: string | null;
  readonly checkoutExpiresAt: string | null;
};

// One authenticated provider event, as the webhook adapter translated it.
export type ProviderEvent = {
  readonly providerCode: string;
  readonly eventReference: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadDigest: string;
  readonly observation: Observation;
};

export type EventAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: (typeof EVENT_OUTCOMES)[number];
      readonly processing: (typeof PROCESSING_STATES)[number] | null;
    }
  | { readonly kind: "unknown" };

export type PaymentRecorder = {
  // payment_job_context(job): the rows exactly as answered, or null.
  readonly jobContext: (jobId: string) => Promise<readonly unknown[] | null>;
  // payment_record_operation(job, observation): its outcome, or "unknown".
  readonly recordOperation: (
    jobId: string,
    observation: Observation,
  ) => Promise<RecordOutcome | "unknown">;
  // payment_record_provider_event(...): its answer.
  readonly recordEvent: (event: ProviderEvent) => Promise<EventAnswer>;
};

const CONTEXT_OUTCOMES = Object.freeze([
  "act",
  "nothing_to_do",
  "wait",
  "not_running",
] as const);
const REFERENCE_KINDS = Object.freeze(["none", "checkout", "payment"] as const);

function oneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

// payment_job_context's one row read strictly, or null.
export function jobContextOf(
  rows: readonly unknown[] | null,
): JobContext | null {
  if (rows === null || rows.length !== 1) {
    return null;
  }
  const fields = readExact(rows[0], JOB_CONTEXT_COLUMNS);
  if (fields === null) {
    return null;
  }
  const outcome = fields.get("outcome");
  const operation = fields.get("operation");
  const paymentId = fields.get("payment_transaction_id");
  const requestId = fields.get("consultation_request_id");
  const state = fields.get("state");
  const reference = fields.get("provider_reference");
  const kind = fields.get("reference_kind");
  const currency = fields.get("currency_code");
  const amount = fields.get("amount_minor");
  const refundRequestId = fields.get("refund_request_id");
  const expires = fields.get("checkout_expires_at");
  if (
    !oneOf(CONTEXT_OUTCOMES, outcome) ||
    !(operation === null || typeof operation === "string") ||
    !(paymentId === null || isUuid(paymentId)) ||
    !(requestId === null || isUuid(requestId)) ||
    !(state === null || oneOf(PAYMENT_STATES, state)) ||
    !(reference === null || isProviderReference(reference)) ||
    !(kind === null || oneOf(REFERENCE_KINDS, kind)) ||
    !(currency === null || isCurrencyCode(currency)) ||
    !(amount === null || isAmountMinor(amount)) ||
    !(refundRequestId === null || isUuid(refundRequestId)) ||
    !(expires === null || isTimestamp(expires))
  ) {
    return null;
  }
  if (
    outcome === "act" &&
    (paymentId === null ||
      requestId === null ||
      kind === null ||
      currency === null ||
      amount === null ||
      (kind === "none") !== (reference === null))
  ) {
    return null;
  }
  return Object.freeze({
    outcome,
    operation: operation as string | null,
    paymentId: paymentId as string | null,
    requestId: requestId as string | null,
    state: state as PaymentState | null,
    providerReference: reference as string | null,
    referenceKind: kind as JobContext["referenceKind"],
    currency: currency as string | null,
    amountMinor: amount as number | null,
    refundRequestId: refundRequestId as string | null,
    checkoutExpiresAt: expires as string | null,
  });
}

export function recordOutcomeOf(data: unknown): RecordOutcome | "unknown" {
  return oneOf(RECORD_OUTCOMES, data) ? data : "unknown";
}

// payment_record_provider_event's one row read strictly.
export function eventAnswerOf(rows: unknown): EventAnswer {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return Object.freeze({ kind: "unknown" });
  }
  const fields = readExact(rows[0], ["outcome", "processing_state"]);
  const outcome = fields?.get("outcome");
  const processing = fields?.get("processing_state");
  if (
    fields === null ||
    !oneOf(EVENT_OUTCOMES, outcome) ||
    !(processing === null || oneOf(PROCESSING_STATES, processing)) ||
    (outcome === "invalid") !== (processing === null)
  ) {
    return Object.freeze({ kind: "unknown" });
  }
  return Object.freeze({
    kind: "answer",
    outcome,
    processing: processing as (typeof PROCESSING_STATES)[number] | null,
  });
}

// ---------------------------------------------------------------------------
// The job handlers (the S2 protocol runs them; MBS section 21)
// ---------------------------------------------------------------------------

export type PaymentJobWiring = {
  readonly provider: () => Promise<PaymentProvider | null>;
  readonly recorder: () => Promise<PaymentRecorder | null>;
  readonly clock: () => number;
};

// Thrown so the S2 protocol retries the job with backoff (and escalates it,
// opening a Reconciliation Exception, once its attempts are used up). It
// carries no payload, key, or provider message.
export class PaymentJobRetry extends Error {
  constructor() {
    super("payment job attempt did not finish");
    this.name = "PaymentJobRetry";
  }
}

const retry = (): never => {
  throw new PaymentJobRetry();
};

// The recorded outcomes that mean the database holds the result (or no
// longer needs it).
const SETTLED = Object.freeze([
  "applied",
  "no_effect",
  "stale",
  "contradiction",
  "not_running",
]);

async function recorded(
  recorder: PaymentRecorder,
  job: JobRun,
  observation: Observation,
): Promise<typeof JOB_DONE> {
  if (!isObservation(observation)) {
    return retry();
  }
  const outcome = await recorder.recordOperation(job.jobId, observation);
  return SETTLED.includes(outcome) ? JOB_DONE : retry();
}

// A provider payment as a reconciliation snapshot.
function paymentState(
  view: PaymentView,
  checkoutReference: string | null,
): Observation {
  return {
    kind: "provider_state",
    checkout_reference: checkoutReference,
    payment_reference: view.reference,
    provider_status: view.status,
    amount_capturable_minor: view.amountCapturableMinor,
    amount_received_minor: view.amountReceivedMinor,
    amount_refunded_minor: view.amountRefundedMinor,
    currency_code: view.currency,
  };
}

type Context = JobContext & {
  readonly paymentId: string;
  readonly requestId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly referenceKind: "none" | "checkout" | "payment";
};

type Step = (
  context: Context,
  provider: PaymentProvider,
  recorder: PaymentRecorder,
  job: JobRun,
  wiring: PaymentJobWiring,
) => Promise<typeof JOB_DONE>;

const checkoutStep: Step = async (context, provider, recorder, job, wiring) => {
  const created = await provider.createCheckout(
    {
      paymentId: context.paymentId,
      requestId: context.requestId,
      amountMinor: context.amountMinor,
      currency: context.currency,
      expiresAt: checkoutExpiryOf(context.checkoutExpiresAt, wiring.clock()),
    },
    idempotencyKeyFor(context.paymentId, "checkout"),
  );
  if (created.kind !== "ok") {
    return retry();
  }
  return recorded(recorder, job, {
    kind: "checkout_open",
    checkout_reference: created.value.reference,
  });
};

const captureStep: Step = async (context, provider, recorder, job) => {
  const reference = context.providerReference;
  if (context.referenceKind !== "payment" || reference === null) {
    return retry();
  }
  const captured = await provider.capturePayment(
    reference,
    context.amountMinor,
    idempotencyKeyFor(context.paymentId, "capture"),
  );
  let view: PaymentView | null = captured.kind === "ok" ? captured.value : null;
  if (captured.kind === "declined" || captured.kind === "not_found") {
    return recorded(recorder, job, {
      kind: "capture_refused",
      payment_reference: reference,
    });
  }
  if (
    captured.kind === "invalid_state" ||
    (view !== null && view.status !== "succeeded")
  ) {
    const current = await provider.retrievePayment(reference);
    view = current.kind === "ok" ? current.value : null;
    if (view === null) {
      return retry();
    }
  }
  if (view === null) {
    return retry();
  }
  if (view.status === "succeeded") {
    return recorded(recorder, job, {
      kind: "capture_confirmed",
      payment_reference: reference,
      amount_minor: view.amountReceivedMinor,
      currency_code: view.currency,
    });
  }
  if (view.status === "canceled" || view.status === "requires_payment") {
    return recorded(recorder, job, {
      kind: "capture_refused",
      payment_reference: reference,
    });
  }
  return retry();
};

// Releases an attempt whose payment exists at the provider: cancels an
// authorization, or reports what the provider holds.
async function releasePayment(
  context: Context,
  provider: PaymentProvider,
  recorder: PaymentRecorder,
  job: JobRun,
  reference: string,
  checkoutReference: string | null,
): Promise<typeof JOB_DONE> {
  let current = await provider.retrievePayment(reference);
  if (current.kind !== "ok") {
    return retry();
  }
  if (
    current.value.status === "requires_capture" ||
    current.value.status === "requires_payment"
  ) {
    const authorized = current.value.status === "requires_capture";
    const cancelled = await provider.cancelPayment(
      reference,
      idempotencyKeyFor(context.paymentId, "cancel"),
    );
    if (cancelled.kind === "ok" && cancelled.value.status === "canceled") {
      return recorded(recorder, job, {
        kind: "authorization_released",
        payment_reference: reference,
        amount_minor: authorized ? cancelled.value.amountMinor : null,
        currency_code: authorized ? cancelled.value.currency : null,
      });
    }
    current = await provider.retrievePayment(reference);
    if (current.kind !== "ok") {
      return retry();
    }
  }
  if (current.value.status === "canceled") {
    return recorded(recorder, job, {
      kind: "authorization_released",
      payment_reference: reference,
    });
  }
  if (current.value.status === "succeeded") {
    // Captured at the provider although Rosuno asked for a release: recorded
    // as a snapshot, which opens a Reconciliation Exception.
    return recorded(
      recorder,
      job,
      paymentState(current.value, checkoutReference),
    );
  }
  return retry();
}

const releaseStep: Step = async (context, provider, recorder, job) => {
  const reference = context.providerReference;
  if (context.referenceKind === "none" || reference === null) {
    // No checkout was ever created: nothing exists at the provider.
    return recorded(recorder, job, { kind: "checkout_expired" });
  }
  if (context.referenceKind === "payment") {
    return releasePayment(context, provider, recorder, job, reference, null);
  }
  const expired = await provider.expireCheckout(
    reference,
    idempotencyKeyFor(context.paymentId, "expire"),
  );
  if (expired.kind === "ok" && expired.value.status === "expired") {
    return recorded(recorder, job, {
      kind: "checkout_expired",
      checkout_reference: reference,
    });
  }
  const checkout = await provider.retrieveCheckout(reference);
  if (checkout.kind !== "ok") {
    return retry();
  }
  if (checkout.value.status === "expired") {
    return recorded(recorder, job, {
      kind: "checkout_expired",
      checkout_reference: reference,
    });
  }
  if (
    checkout.value.status === "complete" &&
    checkout.value.paymentReference !== null
  ) {
    return releasePayment(
      context,
      provider,
      recorder,
      job,
      checkout.value.paymentReference,
      reference,
    );
  }
  return retry();
};

const refundStep: Step = async (context, provider, recorder, job) => {
  const reference = context.providerReference;
  const request = context.refundRequestId;
  if (
    context.referenceKind !== "payment" ||
    reference === null ||
    request === null
  ) {
    return retry();
  }
  const created = await provider.createRefund(
    {
      paymentId: context.paymentId,
      refundRequestId: request,
      paymentReference: reference,
      amountMinor: context.amountMinor,
    },
    idempotencyKeyFor(context.paymentId, "refund", request),
  );
  if (
    created.kind === "declined" ||
    created.kind === "invalid_state" ||
    created.kind === "not_found"
  ) {
    return recorded(recorder, job, {
      kind: "refund_refused",
      payment_reference: reference,
      refund_request_id: request,
    });
  }
  if (created.kind !== "ok") {
    return retry();
  }
  let view = created.value;
  if (view.status === "pending") {
    // An idempotent replay answers the first response; read the refund now.
    const current = await provider.retrieveRefund(view.reference);
    if (current.kind !== "ok") {
      return retry();
    }
    view = current.value;
  }
  if (view.status === "succeeded") {
    return recorded(recorder, job, {
      kind: "refund_confirmed",
      payment_reference: reference,
      refund_reference: view.reference,
      refund_request_id: request,
      amount_minor: view.amountMinor,
      currency_code: context.currency,
    });
  }
  if (view.status === "failed" || view.status === "canceled") {
    return recorded(recorder, job, {
      kind: "refund_refused",
      payment_reference: reference,
      refund_reference: view.reference,
      refund_request_id: request,
    });
  }
  return retry();
};

const reconcileStep: Step = async (context, provider, recorder, job) => {
  const reference = context.providerReference;
  if (reference === null || context.referenceKind === "none") {
    return JOB_DONE;
  }
  if (context.referenceKind === "payment") {
    const current = await provider.retrievePayment(reference);
    return current.kind === "ok"
      ? recorded(recorder, job, paymentState(current.value, null))
      : retry();
  }
  const checkout = await provider.retrieveCheckout(reference);
  if (checkout.kind !== "ok") {
    return retry();
  }
  if (
    checkout.value.status !== "complete" ||
    checkout.value.paymentReference === null
  ) {
    return recorded(recorder, job, {
      kind: "provider_state",
      checkout_reference: reference,
      provider_status:
        checkout.value.status === "expired"
          ? "checkout_expired"
          : "checkout_open",
    });
  }
  const current = await provider.retrievePayment(
    checkout.value.paymentReference,
  );
  return current.kind === "ok"
    ? recorded(recorder, job, paymentState(current.value, reference))
    : retry();
};

const STEPS: Readonly<Record<PaymentJobType, Step>> = Object.freeze({
  "payment.checkout": checkoutStep,
  "payment.capture": captureStep,
  "payment.release": releaseStep,
  "payment.refund": refundStep,
  "payment.reconcile": reconcileStep,
});

function handlerFor(
  type: PaymentJobType,
  wiring: PaymentJobWiring,
): JobHandler {
  return async (job: JobRun) => {
    const recorder = await wiring.recorder();
    if (recorder === null) {
      return retry();
    }
    const context = jobContextOf(await recorder.jobContext(job.jobId));
    if (context === null || context.outcome === "wait") {
      return retry();
    }
    if (context.outcome !== "act") {
      // The payment no longer needs this operation (or the job is no longer
      // running): nothing is sent.
      return JOB_DONE;
    }
    if (context.operation !== type.slice("payment.".length)) {
      return retry();
    }
    const provider = await wiring.provider();
    if (provider === null) {
      return retry();
    }
    return STEPS[type](context as Context, provider, recorder, job, wiring);
  };
}

// The five payment job handlers, keyed by job type.
export function createPaymentJobHandlers(
  wiring: PaymentJobWiring,
): ReadonlyMap<string, JobHandler> {
  return new Map<string, JobHandler>(
    PAYMENT_JOB_TYPES.map((type) => [type, handlerFor(type, wiring)]),
  );
}

// ---------------------------------------------------------------------------
// Provider events (after the webhook adapter verified authenticity)
// ---------------------------------------------------------------------------

export type EventHandling = "accepted" | "rejected" | "unavailable";

// Records one authenticated provider event: accepted when the database
// recorded it or already had it (a replay), rejected when it refused the
// event as malformed, unavailable when the answer is unknown (the provider
// delivers again; the receipt key keeps that idempotent).
export async function recordProviderEvent(
  recorder: PaymentRecorder,
  event: ProviderEvent,
): Promise<EventHandling> {
  try {
    if (!isObservation(event.observation)) {
      return "rejected";
    }
    const answer = await recorder.recordEvent(event);
    if (answer.kind !== "answer") {
      return "unavailable";
    }
    return answer.outcome === "invalid" ? "rejected" : "accepted";
  } catch {
    return "unavailable";
  }
}
