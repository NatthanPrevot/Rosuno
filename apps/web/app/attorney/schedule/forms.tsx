"use client";

// Attorney schedule forms (MVP-001 S4).
//
// Each form posts to its server action and shows only the fixed message for
// the state that action returns. The server decides afresh on every
// submission. Hidden fields only name which of the attorney's own rules or
// Blackouts a form concerns; the server checks that ownership itself. Plain
// entries are kept when React resets a form after a refused submission
// (MVP-001 D-2).

import { useActionState } from "react";

import {
  INITIAL_SCHEDULE_STATE,
  type ScheduleActionState,
} from "../../../src/application/attorney-schedule.ts";
import {
  Alert,
  Button,
  Cluster,
  FieldGroup,
  SelectField,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import {
  OUTCOME_MESSAGES,
  WEEKDAY_LABELS,
} from "../../../src/presentation/schedule-labels.ts";
import {
  addAvailabilityRule,
  addBlackout,
  deleteBlackout,
  endAvailabilityRule,
  setInstantMode,
} from "./actions.ts";

type Action = (
  previous: ScheduleActionState,
  formData: FormData,
) => Promise<ScheduleActionState>;

function useForm(action: Action) {
  return useActionState(action, INITIAL_SCHEDULE_STATE);
}

function errorsOf(state: ScheduleActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

function Outcome({ state }: { readonly state: ScheduleActionState }) {
  switch (state.status) {
    case "outcome": {
      const message = OUTCOME_MESSAGES[state.outcome];
      return (
        <Alert tone={message.tone} title={message.title} role="status">
          {message.body}
        </Alert>
      );
    }
    case "invalid":
      return (
        <Alert tone="error" title="Check the form" role="alert">
          {state.fieldErrors.submit?.[0] ??
            "Some details need attention before this can be saved."}
        </Alert>
      );
    case "unconfirmed":
      return (
        <Alert
          tone="error"
          title="The change could not be confirmed"
          role="alert"
        >
          Your change may or may not have been saved. Refresh the page to see
          your current schedule before trying again.
        </Alert>
      );
    case "sign-in-required":
      return (
        <Alert tone="warning" title="Sign in again" role="alert">
          Your session has ended. Sign in again to continue.
        </Alert>
      );
    case "denied":
      return (
        <Alert tone="warning" title="Not available" role="alert">
          This change is not available for this account.
        </Alert>
      );
    case "unavailable":
      return (
        <Alert tone="error" title="Unavailable" role="alert">
          This could not be completed right now. Please try again later.
        </Alert>
      );
    case "step-up-required":
      return (
        <Alert tone="warning" title="Confirm your sign-in" role="alert">
          Nothing was sent. This change needs a sign-in confirmed with a code
          from your authenticator app. Reload this page to confirm it, then try
          again.
        </Alert>
      );
    default:
      return null;
  }
}

function ZoneOptions({ zones }: { readonly zones: readonly string[] }) {
  return (
    <>
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </>
  );
}

type ZoneProps = {
  readonly zones: readonly string[];
  readonly defaultZone: string;
};

export function RuleForm({ zones, defaultZone }: ZoneProps) {
  const [state, formAction, pending] = useForm(addAvailabilityRule);
  return (
    <form
      action={formAction}
      onReset={keepEntries([
        "kind",
        "timezone",
        "weekday",
        "date",
        "start_time",
        "end_time",
        "effective_from",
        "effective_until",
      ])}
    >
      <Stack>
        <Outcome state={state} />
        <SelectField
          id="rule-kind"
          name="kind"
          label="Repeats"
          defaultValue="recurring"
          errors={errorsOf(state, "kind")}
        >
          <option value="recurring">Every week on one day</option>
          <option value="one_time">On one date only</option>
        </SelectField>
        <SelectField
          id="rule-timezone"
          name="timezone"
          label="Time zone"
          defaultValue={defaultZone}
          errors={errorsOf(state, "timezone")}
        >
          <ZoneOptions zones={zones} />
        </SelectField>
        <FieldGroup
          legend="Weekly availability"
          hint="Used when it repeats every week."
        >
          <SelectField
            id="rule-weekday"
            name="weekday"
            label="Day of the week"
            defaultValue="1"
            errors={errorsOf(state, "weekday")}
          >
            {Object.entries(WEEKDAY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <TextField
            id="rule-effective-from"
            name="effective_from"
            type="date"
            label="First date (empty means today)"
            errors={errorsOf(state, "effective_from")}
          />
          <TextField
            id="rule-effective-until"
            name="effective_until"
            type="date"
            label="Last date (optional)"
            errors={errorsOf(state, "effective_until")}
          />
        </FieldGroup>
        <FieldGroup
          legend="Single date"
          hint="Used when it is on one date only."
        >
          <TextField
            id="rule-date"
            name="date"
            type="date"
            label="Date"
            errors={errorsOf(state, "date")}
          />
        </FieldGroup>
        <TextField
          id="rule-start"
          name="start_time"
          type="time"
          label="From (local time)"
          required
          errors={errorsOf(state, "start_time")}
        />
        <TextField
          id="rule-end"
          name="end_time"
          type="time"
          label="Until (local time)"
          required
          errors={errorsOf(state, "end_time")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Add availability
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function EndRuleForm({ ruleId }: { readonly ruleId: string }) {
  const [state, formAction, pending] = useForm(endAvailabilityRule);
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="rule" value={ruleId} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Remove
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function BlackoutForm({ zones, defaultZone }: ZoneProps) {
  const [state, formAction, pending] = useForm(addBlackout);
  return (
    <form
      action={formAction}
      onReset={keepEntries([
        "timezone",
        "start_date",
        "start_time",
        "end_date",
        "end_time",
      ])}
    >
      <Stack>
        <Outcome state={state} />
        <SelectField
          id="blackout-timezone"
          name="timezone"
          label="Time zone"
          defaultValue={defaultZone}
          errors={errorsOf(state, "timezone")}
        >
          <ZoneOptions zones={zones} />
        </SelectField>
        <TextField
          id="blackout-start-date"
          name="start_date"
          type="date"
          label="Starts on"
          required
          errors={errorsOf(state, "start_date")}
        />
        <TextField
          id="blackout-start-time"
          name="start_time"
          type="time"
          label="Starts at (local time)"
          required
          errors={errorsOf(state, "start_time")}
        />
        <TextField
          id="blackout-end-date"
          name="end_date"
          type="date"
          label="Ends on"
          required
          errors={errorsOf(state, "end_date")}
        />
        <TextField
          id="blackout-end-time"
          name="end_time"
          type="time"
          label="Ends at (local time)"
          required
          errors={errorsOf(state, "end_time")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Add blackout
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function RemoveBlackoutForm({
  blackoutId,
}: {
  readonly blackoutId: string;
}) {
  const [state, formAction, pending] = useForm(deleteBlackout);
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="blackout" value={blackoutId} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Remove
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function InstantForm({ on }: { readonly on: boolean }) {
  const [state, formAction, pending] = useForm(setInstantMode);
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="instant" value={on ? "off" : "on"} />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {on ? "Turn Instant mode off" : "Turn Instant mode on"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
