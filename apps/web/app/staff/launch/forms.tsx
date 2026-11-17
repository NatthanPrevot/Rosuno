"use client";

// Launch gate and launch authorization forms (MVP-001 S1).
//
// Gate evaluations are append-only history; a launch authorization is a
// human decision that changes only by recording its revocation once. A
// passed gate never makes a jurisdiction live by itself.

import {
  Alert,
  Button,
  Choice,
  Cluster,
  FieldGroup,
  Stack,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import {
  defineLaunchGateAction,
  grantLaunchAuthorizationAction,
  recordLaunchGateEvaluationAction,
  revokeLaunchAuthorizationAction,
} from "../actions.ts";
import { errorsOf, Outcome, useConfigurationAction } from "../outcome.tsx";

export function DefineGateForm({
  jurisdiction,
}: {
  readonly jurisdiction: string;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    defineLaunchGateAction,
  );
  const prefix = `gate-${jurisdiction}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries(["gate_code", "required", "description"])}
    >
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="jurisdiction" value={jurisdiction} />
        <TextField
          id={`${prefix}-code`}
          name="gate_code"
          label="Gate code"
          hint="3 to 64 lowercase letters, digits, or underscores, starting with a letter."
          maxLength={64}
          required
          errors={errorsOf(state, "gate_code")}
        />
        <FieldGroup id={`${prefix}-required`} legend="Required for launch?">
          <Choice
            type="radio"
            name="required"
            value="yes"
            label="Required"
            required
          />
          <Choice
            type="radio"
            name="required"
            value="no"
            label="Not required"
          />
        </FieldGroup>
        {errorsOf(state, "required") === undefined ? null : (
          <Alert tone="error">{errorsOf(state, "required")?.[0]}</Alert>
        )}
        <TextAreaField
          id={`${prefix}-description`}
          name="description"
          label="Description (optional)"
          maxLength={500}
          rows={3}
          errors={errorsOf(state, "description")}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Define launch gate
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function EvaluationForm({ gate }: { readonly gate: string }) {
  const [state, formAction, pending] = useConfigurationAction(
    recordLaunchGateEvaluationAction,
  );
  const prefix = `evaluation-${gate}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries([
        "evaluation_status",
        "evidence_reference",
        "reason",
      ])}
    >
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="gate" value={gate} />
        <FieldGroup id={`${prefix}-status`} legend="Evaluation">
          <Choice
            type="radio"
            name="evaluation_status"
            value="passed"
            label="Passed"
            required
          />
          <Choice
            type="radio"
            name="evaluation_status"
            value="failed"
            label="Failed"
          />
        </FieldGroup>
        {errorsOf(state, "evaluation_status") === undefined ? null : (
          <Alert tone="error">
            {errorsOf(state, "evaluation_status")?.[0]}
          </Alert>
        )}
        <TextAreaField
          id={`${prefix}-reason`}
          name="reason"
          label="Reason"
          maxLength={500}
          rows={3}
          required
          errors={errorsOf(state, "reason")}
        />
        <TextAreaField
          id={`${prefix}-evidence`}
          name="evidence_reference"
          label="Evidence reference (optional JSON object)"
          hint='For example {"document": "..."}; up to 8192 bytes.'
          rows={4}
          errors={errorsOf(state, "evidence_reference")}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Record evaluation
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function GrantLaunchForm({
  jurisdiction,
}: {
  readonly jurisdiction: string;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    grantLaunchAuthorizationAction,
  );
  return (
    <form action={formAction} onReset={keepEntries(["reason"])}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="jurisdiction" value={jurisdiction} />
        <TextAreaField
          id={`launch-grant-${jurisdiction}`}
          name="reason"
          label="Reason for this launch authorization"
          hint="Recorded with your name in the audit history. It does not make the jurisdiction live by itself."
          maxLength={500}
          rows={3}
          required
          errors={errorsOf(state, "reason")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Grant launch authorization
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function RevokeLaunchForm({
  authorization,
}: {
  readonly authorization: string;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    revokeLaunchAuthorizationAction,
  );
  return (
    <form action={formAction} onReset={keepEntries(["reason"])}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="authorization" value={authorization} />
        <TextAreaField
          id={`launch-revoke-${authorization}`}
          name="reason"
          label="Reason for revoking"
          maxLength={500}
          rows={3}
          required
          errors={errorsOf(state, "reason")}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Revoke launch authorization
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
