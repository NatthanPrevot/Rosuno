"use client";

// Finance workspace forms (MVP-001 S7).
//
// Each form names only the payment or exception it concerns and posts the
// staff member's own entries. The server re-checks the caller's step-up,
// identity and capability before anything is sent, and the database decides
// again and audits every change. Each form shows only the fixed message for
// the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_FINANCE_STATE,
  REFUND_COMPONENTS,
  type FinanceActionState,
  type RefundComponent,
} from "../../../src/application/finance-workspace.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import {
  ENTRY_TYPE_LABELS,
  financeMessage,
} from "../../../src/presentation/payment-labels.ts";
import {
  assignExceptionAction,
  requestReconciliationAction,
  requestRefundAction,
  resolveExceptionAction,
} from "./actions.ts";

function Outcome({ state }: { readonly state: FinanceActionState }) {
  const message = financeMessage(state);
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "success" ? "status" : "alert"}
    >
      {message.body}
    </Alert>
  );
}

export function ReconcileForm({
  payment,
  label,
}: {
  readonly payment: string | null;
  readonly label: string;
}) {
  const [state, action, pending] = useActionState(
    requestReconciliationAction,
    INITIAL_FINANCE_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        {payment === null ? null : (
          <input type="hidden" name="payment" value={payment} />
        )}
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            {label}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function RefundForm({
  payment,
  remaining,
}: {
  readonly payment: string;
  // What remains of each component, already formatted in its currency.
  readonly remaining: Readonly<Record<RefundComponent, string>>;
}) {
  const [state, action, pending] = useActionState(
    requestRefundAction,
    INITIAL_FINANCE_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="payment" value={payment} />
        {REFUND_COMPONENTS.map((component) => (
          <TextField
            key={component}
            id={`refund-${component}`}
            name={component}
            label={ENTRY_TYPE_LABELS[component]}
            hint={`At most ${remaining[component]}. Enter 0 to refund none of it.`}
            inputMode="decimal"
            autoComplete="off"
            required
          />
        ))}
        <TextAreaField
          id="refund-reason"
          name="reason"
          label="Reason"
          hint="Required, at most 500 characters."
          maxLength={500}
          required
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Request refund
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function AssignExceptionForm({
  exception,
  assign,
}: {
  readonly exception: string;
  readonly assign: "me" | "nobody";
}) {
  const [state, action, pending] = useActionState(
    assignExceptionAction,
    INITIAL_FINANCE_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="exception" value={exception} />
        <input type="hidden" name="assign" value={assign} />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            {assign === "me" ? "Assign to me" : "Clear assignment"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function ResolveExceptionForm({
  exception,
}: {
  readonly exception: string;
}) {
  const [state, action, pending] = useActionState(
    resolveExceptionAction,
    INITIAL_FINANCE_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="exception" value={exception} />
        <TextAreaField
          id={`resolve-${exception}`}
          name="notes"
          label="Resolution notes"
          hint="Required, at most 2,000 characters."
          maxLength={2000}
          required
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Resolve
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
