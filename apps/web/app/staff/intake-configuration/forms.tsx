"use client";

// Intake configuration form (MVP-001 S1).
//
// A published question-set version is immutable. The definition is checked
// on the server against the format-1 rules before anything is sent, and the
// database checks it again.

import {
  Button,
  Cluster,
  Stack,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import { publishQuestionSetAction } from "../actions.ts";
import { errorsOf, Outcome, useConfigurationAction } from "../outcome.tsx";

export function PublishQuestionSetForm({
  definitionText,
}: {
  readonly definitionText: string;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    publishQuestionSetAction,
  );
  return (
    <form
      action={formAction}
      onReset={keepEntries(["version_key", "definition"])}
    >
      <Stack>
        <Outcome state={state} />
        <TextField
          id="question-set-version-key"
          name="version_key"
          label="Version key"
          hint="3 to 64 lowercase letters, digits, or hyphens, starting with a letter. It cannot be reused."
          maxLength={64}
          required
          errors={errorsOf(state, "version_key")}
        />
        <TextAreaField
          id="question-set-definition"
          name="definition"
          label="Definition (JSON object, format 1)"
          hint="Questions, the description field, and the intake limits. Once published, a version is never changed."
          rows={16}
          defaultValue={definitionText}
          required
          errors={errorsOf(state, "definition")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Publish new version
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
