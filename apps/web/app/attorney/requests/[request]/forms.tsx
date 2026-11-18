"use client";

// Attorney request decision forms (MVP-001 S8).
//
// Each form posts to its server action and the panel shows only the fixed
// message for the state that action returns. The server decides afresh on
// every submission: whether the Request is the attorney's own and still
// awaits a decision, every expiry and every consequence. A hidden field only names
// which Request the decision concerns; the server checks that ownership
// itself. No timer in the browser decides anything.

import { useActionState } from "react";

import {
  INITIAL_DECISION_STATE,
  type DecisionActionState,
} from "../../../../src/application/attorney-requests.ts";
import {
  ACCEPT_LABEL,
  DECLINE_LABEL,
  decisionMessage,
} from "../../../../src/presentation/attorney-request-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
} from "../../../../src/presentation/design-system.tsx";
import { acceptRequestAction, declineRequestAction } from "../actions.ts";

function Outcome({ state }: { readonly state: DecisionActionState }) {
  const message = decisionMessage(state);
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

// The decision panel: both forms while the Request can be decided. It stays
// mounted when the page refreshes after a decision, so the fixed outcome
// message stays in view while the forms go away (the server no longer offers
// a decision).
export function DecisionPanel({
  requestId,
  decidable,
}: {
  readonly requestId: string;
  readonly decidable: boolean;
}) {
  const [acceptState, acceptAction, accepting] = useActionState(
    acceptRequestAction,
    INITIAL_DECISION_STATE,
  );
  const [declineState, declineAction, declining] = useActionState(
    declineRequestAction,
    INITIAL_DECISION_STATE,
  );
  const pending = accepting || declining;
  return (
    <Stack gap="tight">
      <Outcome state={acceptState} />
      <Outcome state={declineState} />
      {decidable ? (
        <Cluster>
          <form action={acceptAction}>
            <input type="hidden" name="request" value={requestId} />
            <Button variant="primary" type="submit" disabled={pending}>
              {ACCEPT_LABEL}
            </Button>
          </form>
          <form action={declineAction}>
            <input type="hidden" name="request" value={requestId} />
            <Button variant="secondary" type="submit" disabled={pending}>
              {DECLINE_LABEL}
            </Button>
          </form>
        </Cluster>
      ) : null}
    </Stack>
  );
}
