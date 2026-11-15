"use client";

// Client intake forms (P5-001).
//
// The questions, choices and limits shown here come from the published
// question-set version the server rendered; this module writes none of its
// own. Each form posts to its server action and shows only the fixed message
// for the state that action returns. Hidden fields name only which of the
// client's own Intakes a form concerns, the revision the page showed (so a
// stale page cannot displace newer content), and which of the two allowed
// versions the client is answering; the server checks all of them itself.

import { useActionState } from "react";

import {
  INITIAL_CLIENT_INTAKE_STATE,
  type ClientIntakeActionState,
  type QuestionView,
} from "../../../../src/application/client-intake.ts";
import { NOT_SURE } from "../../../../src/application/intake-question-set.ts";
import {
  Alert,
  Button,
  Choice,
  FieldGroup,
  SelectField,
  Stack,
  TextAreaField,
} from "../../../../src/presentation/design-system.tsx";
import { outcomeMessage } from "../../../../src/presentation/client-intake-labels.ts";
import {
  closeIntakeAction,
  saveIntakeAction,
  submitIntakeAction,
} from "../../actions.ts";

function Outcome({ state }: { readonly state: ClientIntakeActionState }) {
  const message = outcomeMessage(state);
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

function errorsOf(state: ClientIntakeActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

function FieldErrors({ messages }: { readonly messages?: readonly string[] }) {
  if (messages === undefined || messages.length === 0) {
    return null;
  }
  return (
    <Alert tone="error" role="alert">
      {messages.join(" ")}
    </Alert>
  );
}

function QuestionField({
  question,
  state,
}: {
  readonly question: QuestionView;
  readonly state: ClientIntakeActionState;
}) {
  const label = question.required
    ? question.prompt
    : `${question.prompt} (optional)`;
  if (question.kind === "practice_area") {
    return (
      <SelectField
        id={question.field}
        name={question.field}
        label={label}
        hint={question.help ?? undefined}
        errors={errorsOf(state, question.field)}
        defaultValue={question.value}
      >
        <option value="">Choose an answer</option>
        {question.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={NOT_SURE}>{question.notSureLabel}</option>
      </SelectField>
    );
  }
  if (question.kind === "jurisdictions") {
    return (
      <FieldGroup legend={label} hint={question.help ?? undefined}>
        {question.options.map((option) => (
          <Choice
            key={option.value}
            type="checkbox"
            name={question.field}
            value={option.value}
            label={option.label}
            defaultChecked={question.values.includes(option.value)}
          />
        ))}
        <Choice
          type="checkbox"
          name={question.field}
          value={NOT_SURE}
          label={question.notSureLabel}
          defaultChecked={question.values.includes(NOT_SURE)}
        />
        <FieldErrors messages={errorsOf(state, question.field)} />
      </FieldGroup>
    );
  }
  return (
    <FieldGroup legend={label} hint={question.help ?? undefined}>
      {question.choices.map((choice) => (
        <Choice
          key={choice.value}
          type="radio"
          name={question.field}
          value={choice.value}
          label={choice.label}
          defaultChecked={question.value === choice.value}
        />
      ))}
      <FieldErrors messages={errorsOf(state, question.field)} />
    </FieldGroup>
  );
}

type IntakeFormProps = {
  readonly intakeId: string;
  readonly latestRevision: number | null;
  readonly version: "governing" | "current";
  readonly questions: readonly QuestionView[];
  readonly description: {
    readonly prompt: string;
    readonly help: string | null;
    readonly required: boolean;
    readonly maxCharacters: number;
    readonly value: string;
  };
};

export function IntakeForm({
  intakeId,
  latestRevision,
  version,
  questions,
  description,
}: IntakeFormProps) {
  const [state, action, pending] = useActionState(
    saveIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <input
          type="hidden"
          name="expected_revision"
          value={latestRevision === null ? "" : String(latestRevision)}
        />
        <input type="hidden" name="version" value={version} />
        {questions.map((question) => (
          <QuestionField key={question.id} question={question} state={state} />
        ))}
        <TextAreaField
          id="description"
          name="description"
          label={
            description.required
              ? description.prompt
              : `${description.prompt} (optional)`
          }
          hint={description.help ?? undefined}
          errors={errorsOf(state, "description")}
          defaultValue={description.value}
          maxLength={description.maxCharacters}
          rows={6}
        />
        <Button variant="primary" type="submit" disabled={pending}>
          Save answers
        </Button>
      </Stack>
    </form>
  );
}

export function SubmitIntakeForm({
  intakeId,
  latestRevision,
}: {
  readonly intakeId: string;
  readonly latestRevision: number | null;
}) {
  const [state, action, pending] = useActionState(
    submitIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <input
          type="hidden"
          name="expected_revision"
          value={latestRevision === null ? "" : String(latestRevision)}
        />
        <Button variant="secondary" type="submit" disabled={pending}>
          Submit saved answers
        </Button>
      </Stack>
    </form>
  );
}

export function CloseIntakeForm({ intakeId }: { readonly intakeId: string }) {
  const [state, action, pending] = useActionState(
    closeIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <Button variant="tertiary" type="submit" disabled={pending}>
          Close this Intake
        </Button>
      </Stack>
    </form>
  );
}
