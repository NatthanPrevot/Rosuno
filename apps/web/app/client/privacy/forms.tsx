"use client";

// The client's data request forms (MVP-001 S11; PS-A6 section 3).
//
// The request form posts one request type and an optional description; the
// withdrawal form names only the request. The client is always the
// requester and the server decides afresh. Each form shows only the fixed
// message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_CLIENT_STATE,
  MAX_DETAILS,
  REQUEST_TYPES,
  type ClientActionState,
} from "../../../src/application/data-requests.ts";
import { messageOf } from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
  TextAreaField,
} from "../../../src/presentation/design-system.tsx";
import {
  CLIENT_REQUEST_MESSAGES,
  REQUEST_TYPE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
import {
  submitDataRequestAction,
  withdrawDataRequestAction,
} from "./actions.ts";

function Outcome({ state }: { readonly state: ClientActionState }) {
  const message = messageOf(state, CLIENT_REQUEST_MESSAGES);
  return message === null ? null : (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

export function DataRequestForm() {
  const [state, action, pending] = useActionState<ClientActionState, FormData>(
    submitDataRequestAction,
    INITIAL_CLIENT_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <SelectField
          id="data-request-type"
          name="type"
          label="What is your request about?"
          required
          defaultValue=""
        >
          <option value="" disabled>
            Choose
          </option>
          {REQUEST_TYPES.map((type) => (
            <option key={type} value={type}>
              {REQUEST_TYPE_LABELS[type]}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          id="data-request-details"
          name="details"
          label="Details (optional)"
          hint={`For example, what should be corrected. At most ${MAX_DETAILS.toLocaleString("en-US")} characters.`}
          maxLength={MAX_DETAILS}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Submit the request
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function WithdrawRequestForm({ request }: { readonly request: string }) {
  const [state, action, pending] = useActionState<ClientActionState, FormData>(
    withdrawDataRequestAction,
    INITIAL_CLIENT_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="request" value={request} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Withdraw the request
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
