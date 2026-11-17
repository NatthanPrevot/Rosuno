"use client";

// Shared pieces of the staff configuration forms (MVP-001 S1).
//
// Each form posts to its server action and shows only the fixed message for
// the state that action returns. Hidden fields only name the record a form
// concerns, or carry back the record version the page showed; the server
// re-checks the caller's identity and capability before sending anything,
// and the database decides again.

import { useActionState } from "react";

import {
  INITIAL_CONFIGURATION_STATE,
  type ConfigurationActionState,
} from "../../src/application/staff-configuration.ts";
import { Alert } from "../../src/presentation/design-system.tsx";
import { outcomeMessage } from "../../src/presentation/staff-configuration-labels.ts";

export type ConfigurationAction = (
  previous: ConfigurationActionState,
  formData: FormData,
) => Promise<ConfigurationActionState>;

export function useConfigurationAction(action: ConfigurationAction) {
  return useActionState(action, INITIAL_CONFIGURATION_STATE);
}

export function errorsOf(state: ConfigurationActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

export function Outcome({
  state,
}: {
  readonly state: ConfigurationActionState;
}) {
  const message = outcomeMessage(state);
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={
        message.tone === "success" || message.tone === "information"
          ? "status"
          : "alert"
      }
    >
      {message.body}
    </Alert>
  );
}

// A stored timestamp as the value of a UTC date-and-time field.
export function fieldDateTime(timestamp: string | null): string {
  return timestamp === null
    ? ""
    : new Date(timestamp).toISOString().slice(0, 19);
}
