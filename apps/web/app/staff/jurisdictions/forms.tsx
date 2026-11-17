"use client";

// Jurisdiction configuration forms (MVP-001 S1).
//
// A new jurisdiction starts unsupported. A lifecycle change carries back the
// record version the page showed; LIVE is decided by the database from the
// launch gates and the human launch authorization, never by this form.

import type { LifecycleState } from "../../../src/application/staff-configuration.ts";
import {
  Button,
  Cluster,
  SelectField,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import { LIFECYCLE_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import {
  changeJurisdictionLifecycleAction,
  createJurisdictionAction,
  createServiceAreaAction,
} from "../actions.ts";
import { errorsOf, Outcome, useConfigurationAction } from "../outcome.tsx";

export function CreateJurisdictionForm() {
  const [state, formAction, pending] = useConfigurationAction(
    createJurisdictionAction,
  );
  return (
    <form
      action={formAction}
      onReset={keepEntries(["code", "name", "region_type"])}
    >
      <Stack>
        <Outcome state={state} />
        <TextField
          id="jurisdiction-code"
          name="code"
          label="Code"
          hint="2 to 32 capital letters, digits, or underscores, starting with a letter."
          maxLength={32}
          required
          errors={errorsOf(state, "code")}
        />
        <TextField
          id="jurisdiction-name"
          name="name"
          label="Name"
          maxLength={120}
          required
          errors={errorsOf(state, "name")}
        />
        <TextField
          id="jurisdiction-region-type"
          name="region_type"
          label="Region type"
          hint="For example, state or territory."
          maxLength={40}
          required
          errors={errorsOf(state, "region_type")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Create jurisdiction (unsupported)
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function LifecycleForm({
  jurisdiction,
  expectedUpdatedAt,
  targets,
}: {
  readonly jurisdiction: string;
  readonly expectedUpdatedAt: string;
  readonly targets: readonly LifecycleState[];
}) {
  const [state, formAction, pending] = useConfigurationAction(
    changeJurisdictionLifecycleAction,
  );
  return (
    <form action={formAction} onReset={keepEntries(["target_state"])}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="jurisdiction" value={jurisdiction} />
        <input
          type="hidden"
          name="expected_updated_at"
          value={expectedUpdatedAt}
        />
        <SelectField
          id={`lifecycle-${jurisdiction}`}
          name="target_state"
          label="New lifecycle state"
          hint="Live needs every required launch gate passed and an active launch authorization."
          defaultValue=""
          required
          errors={errorsOf(state, "target_state")}
        >
          <option value="">Choose a state</option>
          {targets.map((target) => (
            <option key={target} value={target}>
              {LIFECYCLE_LABELS[target].label}
            </option>
          ))}
        </SelectField>
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Change lifecycle state
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function ServiceAreaForm({
  jurisdiction,
}: {
  readonly jurisdiction: string;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    createServiceAreaAction,
  );
  const prefix = `service-area-${jurisdiction}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries(["code", "name", "active_from", "active_until"])}
    >
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="jurisdiction" value={jurisdiction} />
        <TextField
          id={`${prefix}-code`}
          name="code"
          label="Code"
          hint="2 to 64 capital letters, digits, or underscores, starting with a letter."
          maxLength={64}
          required
          errors={errorsOf(state, "code")}
        />
        <TextField
          id={`${prefix}-name`}
          name="name"
          label="Name"
          maxLength={120}
          required
          errors={errorsOf(state, "name")}
        />
        <TextField
          id={`${prefix}-from`}
          name="active_from"
          type="datetime-local"
          step={1}
          label="Active from (UTC)"
          required
          errors={errorsOf(state, "active_from")}
        />
        <TextField
          id={`${prefix}-until`}
          name="active_until"
          type="datetime-local"
          step={1}
          label="Active until (UTC, optional)"
          errors={errorsOf(state, "active_until")}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Add service area
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
