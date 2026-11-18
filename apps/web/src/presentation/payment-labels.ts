// Payment wording (MVP-001 S7). Presentation only.
//
// Fixed, neutral wording: no legal, disclosure, entitlement or settlement
// statement (those are gated), no claim about when funds are taken or when a
// fee is earned (G-1 to G-4 stay unresolved), and no provider status shown
// as Rosuno's own. Amounts are formatted from minor units in their own
// currency and never added across currencies.

import type { AuthorizeActionState } from "../application/client-payments.ts";
import type { PaymentStep } from "../application/client-payments.ts";
import type {
  ExceptionStatus,
  FinanceActionState,
  LedgerEntryType,
  PaymentGroup,
} from "../application/finance-workspace.ts";
import type { PaymentState } from "../application/payments.ts";
import type { Tone } from "./design-system.tsx";

export { moneyText, utcText } from "./request-labels.ts";

export const PAYMENT_STATE_LABELS: Readonly<
  Record<PaymentState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  pending_authorization: {
    label: "Awaiting authorization",
    tone: "information",
  },
  authorized: { label: "Authorized", tone: "success" },
  failed: { label: "Authorization failed", tone: "error" },
  cancelled: { label: "Ended before authorization", tone: "neutral" },
  release_pending: { label: "Being released", tone: "information" },
  authorization_released: { label: "Authorization released", tone: "neutral" },
  capture_pending: { label: "Being collected", tone: "information" },
  captured: { label: "Collected", tone: "success" },
  capture_failed: { label: "Collection failed; under review", tone: "warning" },
  refund_pending: { label: "Refund in progress", tone: "information" },
  partially_refunded: { label: "Partly refunded", tone: "neutral" },
  fully_refunded: { label: "Refunded", tone: "neutral" },
  charged_back: { label: "Disputed; under review", tone: "warning" },
});

export const PAYMENT_STEP_TEXT: Readonly<Record<PaymentStep, string>> =
  Object.freeze({
    authorization_required:
      "This request waits for a payment authorization before it goes to the attorney. You complete the authorization on the payment provider's secure page; your card details are not shared with Rosuno.",
    not_required_now: "No payment step is needed at this stage of the request.",
    unavailable: "Payment is not available for this request right now.",
    not_applicable: "There is no payment step to take on this request now.",
  });

export const PAYMENT_STATUS_NOTE =
  "The payment status shown is the one Rosuno has recorded. If you have just returned from the payment page, it can take a moment to update.";

export const AUTHORIZE_LABEL = "Authorize payment";
export const CONTINUE_LABEL = "Continue to payment";

type Message = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

export function authorizeMessage(state: AuthorizeActionState): Message | null {
  switch (state.status) {
    case "idle":
    case "redirect":
      return null;
    case "preparing":
      return {
        tone: "information",
        title: "Payment page being prepared",
        body: "The secure payment page is being prepared. Please try again in a moment.",
      };
    case "payments-unavailable":
      return {
        tone: "warning",
        title: "Payment not available",
        body: "Payments are not available right now, so this request cannot be authorized. Nothing was charged.",
      };
    case "configuration-unavailable":
      return {
        tone: "warning",
        title: "Payment not available",
        body: "Payment is not available for this request right now. Nothing was charged.",
      };
    case "not-required":
      return {
        tone: "information",
        title: "No payment step now",
        body: "No payment authorization is needed at this stage of the request.",
      };
    case "not-payable":
      return {
        tone: "information",
        title: "No payment step now",
        body: "This request has no payment step to take now.",
      };
    case "expired":
      return {
        tone: "warning",
        title: "Request expired",
        body: "This request has expired, so it can no longer be paid.",
      };
    case "not-found":
      return {
        tone: "error",
        title: "Request not found",
        body: "This request could not be found for your account.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "The payment could not be started. Please reload the page and try again.",
      };
    case "outcome-unknown":
      return {
        tone: "warning",
        title: "Not confirmed",
        body: "We could not confirm whether the payment was started. Reload the page to see its current status.",
      };
    case "sign-in-required":
      return {
        tone: "warning",
        title: "Sign in to continue",
        body: "Sign in to your client account to authorize the payment.",
      };
    case "denied":
      return {
        tone: "error",
        title: "Not available for this account",
        body: "Payments are available to signed-in client accounts.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "The payment could not be started right now. Please try again later.",
      };
  }
}

// Finance workspace wording.

export const PAYMENT_GROUP_LINKS: Readonly<
  Record<PaymentGroup, { readonly href: string; readonly title: string }>
> = Object.freeze({
  open: { href: "/staff/finance?group=open", title: "In flight" },
  collected: { href: "/staff/finance?group=collected", title: "Collected" },
  ended: { href: "/staff/finance?group=ended", title: "Ended" },
  all: { href: "/staff/finance?group=all", title: "All" },
});

export const EXCEPTION_STATUS_LINKS: Readonly<
  Record<ExceptionStatus, { readonly href: string; readonly title: string }>
> = Object.freeze({
  open: { href: "/staff/finance/exceptions?status=open", title: "Open" },
  resolved: {
    href: "/staff/finance/exceptions?status=resolved",
    title: "Resolved",
  },
});

export const STAFF_PAYMENT_STATE_LABELS: Readonly<
  Record<PaymentState, string>
> = Object.freeze({
  pending_authorization: "Pending authorization",
  authorized: "Authorized",
  failed: "Failed",
  cancelled: "Cancelled",
  release_pending: "Release pending",
  authorization_released: "Authorization released",
  capture_pending: "Capture pending",
  captured: "Captured",
  capture_failed: "Capture failed",
  refund_pending: "Refund pending",
  partially_refunded: "Partially refunded",
  fully_refunded: "Fully refunded",
  charged_back: "Charged back",
});

export const ENTRY_TYPE_LABELS: Readonly<Record<LedgerEntryType, string>> =
  Object.freeze({
    client_payment: "Client payment",
    attorney_share: "Attorney share",
    platform_fee: "Platform fee",
    client_fee: "Client fee",
    other_required_fee: "Other required fee",
  });

export const SEVERITY_TONES: Readonly<Record<string, Tone>> = Object.freeze({
  low: "neutral",
  medium: "information",
  high: "warning",
  critical: "error",
});

export const FINANCE_INTRO =
  "Payments as Rosuno records them. Provider events are observations; a disagreement opens a reconciliation exception for review and is never corrected silently.";

export const REFUND_NOTE =
  "Choose how much of each component to refund (at most what remains of it) and give a reason. Whether a refund is owed is decided by the applicable refund policy, not by this form; the payment's refund policy version is recorded with the request.";

export function financeMessage(state: FinanceActionState): Message | null {
  switch (state.status) {
    case "idle":
      return null;
    case "recorded":
      return {
        tone: "success",
        title: "Recorded",
        body: "The change was recorded.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Check the entries",
        body: "One or more entries are missing or not valid.",
      };
    case "refused":
      return {
        tone: "warning",
        title: "Not recorded",
        body: `The database refused the change (${state.reason.replaceAll("_", " ")}).`,
      };
    case "outcome-unknown":
      return {
        tone: "warning",
        title: "Not confirmed",
        body: "The change could not be confirmed. Reload the page to see the current state.",
      };
    case "sign-in-required":
      return {
        tone: "warning",
        title: "Sign in to continue",
        body: "Sign in again to make this change.",
      };
    case "step-up-required":
      return {
        tone: "warning",
        title: "Confirm your sign-in",
        body: "Confirm your sign-in with your authenticator before making this change.",
      };
    case "denied":
      return {
        tone: "error",
        title: "No access",
        body: "This account does not hold a current capability for this change.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "The change could not be made right now. Please try again later.",
      };
  }
}

export const EARNINGS_INTRO =
  "Amounts the ledger attributes to you from collected payments of your own requests, less what refunds reversed, in each payment's currency. This view shows ledger entries only; it is not a balance or a payout.";
