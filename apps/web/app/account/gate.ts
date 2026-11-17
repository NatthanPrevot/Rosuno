// Step-up gate for the attorney and staff routes (MVP-001 S2).
//
// Server-only. Every attorney page and staff page calls requireSteppedUp
// right after opting out of prerendering, before it reads anything else, and
// every attorney or staff server action asks stepUpRefusal before it hands
// anything to its use case. An attorney or staff principal whose session is
// not stepped up is sent to one fixed account page (the code confirmation,
// or the authenticator setup when there is none yet), and a change returns
// one fixed refusal without anything being sent. Anyone else passes through
// unchanged to the route's own access decision. Nothing the request carries
// is read here, and the only destinations are the fixed account pages.

import { redirect } from "next/navigation";

import {
  resolveStepUpGate,
  stepUpPathOf,
  stepUpRefusalOf,
  type PrincipalKind,
} from "../../src/application/session-assurance.ts";
import { STEP_UP_SOURCES } from "../../src/infrastructure/identity/authenticator-provider.ts";

// For a page: returns only when the request may go on to the page's own
// access decision.
export async function requireSteppedUp(kind: PrincipalKind): Promise<void> {
  const path = stepUpPathOf(
    await resolveStepUpGate(STEP_UP_SOURCES, kind),
    kind,
  );
  if (path !== null) {
    redirect(path);
  }
}

// For a server action: the fixed refusal to return before anything is sent,
// or null when the change may go on to its use case.
export async function stepUpRefusal(kind: PrincipalKind) {
  return stepUpRefusalOf(await resolveStepUpGate(STEP_UP_SOURCES, kind));
}
