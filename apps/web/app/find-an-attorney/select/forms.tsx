"use client";

// The attorney selection form (MVP-001 S5). It posts the client's choice of
// one of their own open Intakes and of how soon they need help, with the
// directory selection the page was opened for, to the selection action, and
// shows only the fixed message for the state that action returns. The server
// decides everything again. MVP-001 S6: once the selection is recorded, the
// form offers the request review for exactly the Referral the database
// created.

import { useActionState } from "react";

import { requestReviewPathFor } from "../../../src/application/consultation-request.ts";
import {
  INITIAL_SELECTION_STATE,
  type Selection,
  type SelectableIntake,
} from "../../../src/application/discovery.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Choice,
  Cluster,
  FieldGroup,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import {
  PATH_LABELS,
  REQUEST_REVIEW_LINK,
  selectionMessage,
  utcText,
} from "../../../src/presentation/discovery-labels.ts";
import { INTAKE_STATE_LABELS } from "../../../src/presentation/client-intake-labels.ts";
import { selectAttorneyAction } from "./actions.ts";

export function SelectionForm({
  selection,
  intakes,
}: {
  readonly selection: Selection;
  readonly intakes: readonly SelectableIntake[];
}) {
  const [state, action, pending] = useActionState(
    selectAttorneyAction,
    INITIAL_SELECTION_STATE,
  );
  const message = selectionMessage(state);
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
      {state.status === "created" ? (
        <Cluster>
          <ButtonLink
            variant="primary"
            href={requestReviewPathFor(state.referralId)}
          >
            {REQUEST_REVIEW_LINK}
          </ButtonLink>
        </Cluster>
      ) : (
        <form action={action}>
          <input type="hidden" name="attorney" value={selection.attorneyId} />
          <input
            type="hidden"
            name="jurisdiction"
            value={selection.jurisdictionId}
          />
          {selection.practiceAreaId === null ? null : (
            <input
              type="hidden"
              name="practice_area"
              value={selection.practiceAreaId}
            />
          )}
          <input
            type="hidden"
            name="availability"
            value={selection.availability}
          />
          <input type="hidden" name="page" value={String(selection.page)} />
          <Stack>
            <FieldGroup legend="Which Intake is this for?">
              {intakes.map((intake) => (
                <Choice
                  key={intake.id}
                  type="radio"
                  name="intake"
                  value={intake.id}
                  required
                  label={`Intake started ${utcText(intake.createdAt)}`}
                  hint={INTAKE_STATE_LABELS[intake.state].label}
                />
              ))}
            </FieldGroup>
            <FieldGroup legend="How soon do you need help?">
              <Choice
                type="radio"
                name="path"
                value="instant"
                required
                label={PATH_LABELS.instant}
              />
              <Choice
                type="radio"
                name="path"
                value="scheduled"
                required
                label={PATH_LABELS.scheduled}
              />
            </FieldGroup>
            <Cluster>
              <Button variant="primary" type="submit" disabled={pending}>
                Confirm selection
              </Button>
            </Cluster>
          </Stack>
        </form>
      )}
    </Stack>
  );
}
