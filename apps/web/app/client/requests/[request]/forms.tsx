"use client";

// The request withdrawal form (MVP-001 S6). It posts exactly the Request id
// to the withdrawal action and shows only the fixed message for the state
// that action returns. The server decides everything again, including
// whether the Request has already expired.
//
// MVP-001 S7: the payment authorization form posts exactly the Request id;
// the server sends the client to the payment provider's hosted page, or
// answers one fixed message.

import { useActionState } from "react";

import { INITIAL_AUTHORIZE_STATE } from "../../../../src/application/client-payments.ts";
import { INITIAL_WITHDRAW_STATE } from "../../../../src/application/consultation-request.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
} from "../../../../src/presentation/design-system.tsx";
import { authorizeMessage } from "../../../../src/presentation/payment-labels.ts";
import { withdrawMessage } from "../../../../src/presentation/request-labels.ts";
import { authorizePaymentAction, withdrawRequestAction } from "../actions.ts";

export function WithdrawRequestForm({
  requestId,
}: {
  readonly requestId: string;
}) {
  const [state, action, pending] = useActionState(
    withdrawRequestAction,
    INITIAL_WITHDRAW_STATE,
  );
  const message = withdrawMessage(state);
  return (
    <Stack>
      {message === null ? null : (
        <Alert
          tone={message.tone}
          title={message.title}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.body}
        </Alert>
      )}
      {state.status === "withdrawn" || state.status === "expired" ? null : (
        <form action={action}>
          <input type="hidden" name="request" value={requestId} />
          <Cluster>
            <Button variant="secondary" type="submit" disabled={pending}>
              Withdraw request
            </Button>
          </Cluster>
        </form>
      )}
    </Stack>
  );
}

export function AuthorizePaymentForm({
  requestId,
  label,
}: {
  readonly requestId: string;
  readonly label: string;
}) {
  const [state, action, pending] = useActionState(
    authorizePaymentAction,
    INITIAL_AUTHORIZE_STATE,
  );
  const message = authorizeMessage(state);
  return (
    <Stack>
      {message === null ? null : (
        <Alert
          tone={message.tone}
          title={message.title}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.body}
        </Alert>
      )}
      <form action={action}>
        <input type="hidden" name="request" value={requestId} />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {label}
          </Button>
        </Cluster>
      </form>
    </Stack>
  );
}
