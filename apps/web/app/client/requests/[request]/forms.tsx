"use client";

// The request withdrawal form (MVP-001 S6). It posts exactly the Request id
// to the withdrawal action and shows only the fixed message for the state
// that action returns. The server decides everything again, including
// whether the Request has already expired.

import { useActionState } from "react";

import { INITIAL_WITHDRAW_STATE } from "../../../../src/application/consultation-request.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
} from "../../../../src/presentation/design-system.tsx";
import { withdrawMessage } from "../../../../src/presentation/request-labels.ts";
import { withdrawRequestAction } from "../actions.ts";

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
