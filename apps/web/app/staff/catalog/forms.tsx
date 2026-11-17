"use client";

// Practice-area catalog forms (MVP-001 S1).
//
// A new practice area starts active. Making one inactive keeps it and its
// history; it can be made active again.

import {
  Button,
  Cluster,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import {
  createPracticeAreaAction,
  setPracticeAreaActiveAction,
} from "../actions.ts";
import { errorsOf, Outcome, useConfigurationAction } from "../outcome.tsx";

export function CreatePracticeAreaForm() {
  const [state, formAction, pending] = useConfigurationAction(
    createPracticeAreaAction,
  );
  return (
    <form action={formAction} onReset={keepEntries(["code", "name"])}>
      <Stack>
        <Outcome state={state} />
        <TextField
          id="practice-area-code"
          name="code"
          label="Code"
          hint="2 to 64 lowercase letters, digits, or underscores, starting with a letter."
          maxLength={64}
          required
          errors={errorsOf(state, "code")}
        />
        <TextField
          id="practice-area-name"
          name="name"
          label="Name"
          maxLength={120}
          required
          errors={errorsOf(state, "name")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Add practice area
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function PracticeAreaActivityForm({
  area,
  active,
}: {
  readonly area: string;
  readonly active: boolean;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    setPracticeAreaActiveAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="practice_area" value={area} />
        <input type="hidden" name="active" value={active ? "false" : "true"} />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            {active ? "Make inactive" : "Make active"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
