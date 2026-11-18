"use server";

// The attorney selection's server action (MVP-001 S5; MBS section 10).
//
// It hands the submitted form and this request's trusted ports to the
// discovery use case, which re-establishes the verified client and the
// client's own Intake on the server, checks the environment binding, and
// asks the database to record the selection; only the database's fixed
// outcome comes back. Next.js accepts it only as a POST request and applies
// its Server Action origin checks. The previous state comes back from the
// browser and is never read. Nothing the browser sends chooses an identity
// or authority, and nothing here picks an attorney. An unavailable or unknown
// outcome also writes one log line naming the outcome, with nothing the
// client submitted.

import {
  createReferral,
  type SelectionActionState,
} from "../../../src/application/discovery.ts";
import { DISCOVERY_SOURCES } from "../../../src/infrastructure/discovery/discovery-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";

export async function selectAttorneyAction(
  _previous: SelectionActionState,
  formData: FormData,
): Promise<SelectionActionState> {
  const state = await createReferral(DISCOVERY_SOURCES, formData);
  if (state.status === "unavailable" || state.status === "outcome-unknown") {
    await logRequestEvent("warn", "discovery.action_not_completed", {
      operation: "selectAttorney",
      outcome: state.status,
    });
  }
  return state;
}
