"use client";

// The request confirmation form (MVP-001 S6). It posts exactly the Referral,
// the path, the chosen option and, for a scheduled Request, the chosen start
// time, to the request action, and shows only the fixed message for the
// state that action returns. The server decides everything again, the price
// included; a created Request opens its own page.

import { useActionState } from "react";

import {
  INITIAL_REQUEST_STATE,
  type RequestPath,
} from "../../../../src/application/consultation-request.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
} from "../../../../src/presentation/design-system.tsx";
import { requestMessage } from "../../../../src/presentation/request-labels.ts";
import { createRequestAction } from "../actions.ts";

export function ConfirmRequestForm({
  referralId,
  path,
  modality,
  durationMinutes,
  slotStart,
}: {
  readonly referralId: string;
  readonly path: RequestPath;
  readonly modality: string;
  readonly durationMinutes: number;
  readonly slotStart: string | null;
}) {
  const [state, action, pending] = useActionState(
    createRequestAction,
    INITIAL_REQUEST_STATE,
  );
  const message = requestMessage(state);
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
        <input type="hidden" name="referral" value={referralId} />
        <input type="hidden" name="path" value={path} />
        <input type="hidden" name="modality" value={modality} />
        <input type="hidden" name="duration" value={String(durationMinutes)} />
        {slotStart === null ? null : (
          <input type="hidden" name="slot" value={slotStart} />
        )}
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Confirm request
          </Button>
        </Cluster>
      </form>
    </Stack>
  );
}
