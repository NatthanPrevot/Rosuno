"use client";

// The acknowledgement form of one notification (MVP-001 S10).
//
// The form posts to its server action and shows only the fixed message for
// the state that action returns. A hidden field only names which of the
// account's own Notifications the request concerns; the server decides afresh
// whether it is the account's own and needs an acknowledgement.

import { useActionState } from "react";

import { INITIAL_ACKNOWLEDGE_STATE } from "../../../src/application/notification-center.ts";
import {
  ACKNOWLEDGE_LABEL,
  acknowledgeMessage,
} from "../../../src/presentation/communication-labels.ts";
import {
  Alert,
  Button,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import { acknowledgeNotificationAction } from "./actions.ts";

export function AcknowledgeForm({
  notificationId,
}: {
  readonly notificationId: string;
}) {
  const [state, action, pending] = useActionState(
    acknowledgeNotificationAction,
    INITIAL_ACKNOWLEDGE_STATE,
  );
  const message = acknowledgeMessage(state);
  return (
    <form action={action}>
      <Stack gap="tight">
        {message === null ? null : (
          <Alert
            tone={message.tone}
            title={message.title}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.body}
          </Alert>
        )}
        <input type="hidden" name="notification" value={notificationId} />
        <Button variant="secondary" type="submit" disabled={pending}>
          {ACKNOWLEDGE_LABEL}
        </Button>
      </Stack>
    </form>
  );
}
