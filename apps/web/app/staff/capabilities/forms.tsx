"use client";

// Staff capability forms (MVP-001 S1).
//
// A grant names the staff member it is for; the grantor is always the
// caller, as the database records it, and nobody grants themselves a
// capability. A grant changes only by recording its revocation once.

import {
  GLOBAL_SCOPE,
  type Option,
} from "../../../src/application/staff-configuration.ts";
import {
  Button,
  Cluster,
  SelectField,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import { grantCapabilityAction, revokeCapabilityAction } from "../actions.ts";
import { errorsOf, Outcome, useConfigurationAction } from "../outcome.tsx";

export function GrantCapabilityForm({
  member,
  capabilities,
  jurisdictions,
}: {
  readonly member: string;
  readonly capabilities: readonly Option[];
  readonly jurisdictions: readonly Option[];
}) {
  const [state, formAction, pending] = useConfigurationAction(
    grantCapabilityAction,
  );
  const prefix = `grant-${member}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries(["capability_code", "scope", "expires_at"])}
    >
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="member" value={member} />
        <SelectField
          id={`${prefix}-capability`}
          name="capability_code"
          label="Capability"
          defaultValue=""
          required
          errors={errorsOf(state, "capability_code")}
        >
          <option value="">Choose a capability</option>
          {capabilities.map((capability) => (
            <option key={capability.value} value={capability.value}>
              {capability.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          id={`${prefix}-scope`}
          name="scope"
          label="Scope"
          defaultValue=""
          required
          errors={errorsOf(state, "scope")}
        >
          <option value="">Choose a scope</option>
          <option value={GLOBAL_SCOPE}>All jurisdictions</option>
          {jurisdictions.map((jurisdiction) => (
            <option key={jurisdiction.value} value={jurisdiction.value}>
              {jurisdiction.label}
            </option>
          ))}
        </SelectField>
        <TextField
          id={`${prefix}-expires`}
          name="expires_at"
          type="datetime-local"
          step={1}
          label="Expires at (UTC, optional)"
          errors={errorsOf(state, "expires_at")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Grant capability
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function RevokeCapabilityForm({ grant }: { readonly grant: string }) {
  const [state, formAction, pending] = useConfigurationAction(
    revokeCapabilityAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="grant" value={grant} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Revoke
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
