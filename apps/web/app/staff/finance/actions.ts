"use server";

// Finance workspace server actions (MVP-001 S7).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the finance use cases, which re-establish the caller's fresh staff identity
// and the manage_financial_operations capability before anything is sent;
// the database decides again on every call and audits every change. Next.js
// accepts these only as POST requests and applies its Server Action origin
// checks. The previous state comes back from the browser and is never read.
// Submitted ids only name the payment or exception a change concerns; the
// amounts and the reason are the staff member's entries, which the database
// checks. An outcome that is unavailable or unconfirmed also writes one log
// line naming the action and the outcome, with nothing the caller submitted.

import { revalidatePath } from "next/cache";

import {
  assignFinanceException,
  requestFinanceReconciliation,
  requestFinanceRefund,
  resolveFinanceException,
  type FinanceActionState,
  type FinanceSources,
} from "../../../src/application/finance-workspace.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { FINANCE_SOURCES } from "../../../src/infrastructure/payments/payment-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

type Operation = (
  sources: FinanceSources,
  formData: unknown,
) => Promise<FinanceActionState>;

async function gated(
  name: string,
  operation: Operation,
  formData: FormData,
): Promise<FinanceActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation(FINANCE_SOURCES, formData);
  if (state.status === "unavailable" || state.status === "outcome-unknown") {
    await logRequestEvent("warn", "payments.action_not_completed", {
      operation: name,
      outcome: state.status,
    });
  }
  if (state.status === "recorded") {
    revalidatePath("/staff/finance", "layout");
  }
  return state;
}

export async function requestRefundAction(
  _previous: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  return gated("requestRefund", requestFinanceRefund, formData);
}

export async function assignExceptionAction(
  _previous: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  return gated("assignException", assignFinanceException, formData);
}

export async function resolveExceptionAction(
  _previous: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  return gated("resolveException", resolveFinanceException, formData);
}

export async function requestReconciliationAction(
  _previous: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  return gated("requestReconciliation", requestFinanceReconciliation, formData);
}
