"use server";

// Staff configuration server actions (MVP-001 S1).
//
// Each action hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the caller's fresh staff
// identity and exact capability on the server before anything is sent, and
// decides a fixed outcome; the database decides again on every call. Next.js
// accepts these only as POST requests and applies its Server Action origin
// checks. The previous state comes back from the browser and is never read.
// After a change the configuration pages are read afresh. An outcome that is
// unavailable, unconfirmed, or not saved also writes one log line naming the
// action and the outcome, with nothing the caller submitted. MVP-001 S2:
// each action first asks the step-up gate; a session that is not stepped up
// gets one fixed refusal, and nothing is handed to the use case.

import { revalidatePath } from "next/cache";

import {
  addAuthorityReference,
  changeJurisdictionLifecycle,
  createJurisdiction,
  createPolicyVersion,
  createPracticeArea,
  createServiceArea,
  decideAuthorityReference,
  defineLaunchGate,
  endPolicyVersion,
  grantCapability,
  grantLaunchAuthorization,
  publishQuestionSet,
  recordLaunchGateEvaluation,
  revisePolicyDraft,
  revokeCapability,
  revokeLaunchAuthorization,
  setPracticeAreaActive,
  transitionPolicyVersion,
  type ConfigurationActionState,
  type ConfigurationSources,
} from "../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import { stepUpRefusal } from "../account/gate.ts";

type Operation = (
  sources: ConfigurationSources,
  formData: unknown,
) => Promise<ConfigurationActionState>;

const CHANGED = new Set<ConfigurationActionState["status"]>([
  "recorded",
  "unchanged",
]);

const NOT_COMPLETED = new Set<ConfigurationActionState["status"]>([
  "unavailable",
  "unconfirmed",
  "not-saved",
]);

// The configuration pages a change can show up on.
const PAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  policies: ["/staff/policies", "/staff/policies/[version]"],
  jurisdictions: [
    "/staff/jurisdictions",
    "/staff/jurisdictions/[jurisdiction]",
    "/staff/launch",
    "/staff/launch/[jurisdiction]",
  ],
  catalog: ["/staff/catalog"],
  capabilities: ["/staff/capabilities", "/staff/capabilities/[member]"],
  intake: ["/staff/intake-configuration"],
});

async function run(
  name: string,
  operation: Operation,
  area: keyof typeof PAGES,
  formData: FormData,
): Promise<ConfigurationActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation(STAFF_CONFIGURATION_SOURCES, formData);
  if (NOT_COMPLETED.has(state.status)) {
    await logRequestEvent("warn", "staff_configuration.action_not_completed", {
      operation: name,
      outcome: state.status,
    });
  }
  if (CHANGED.has(state.status)) {
    for (const path of PAGES[area]) {
      if (path.includes("[")) {
        revalidatePath(path, "page");
      } else {
        revalidatePath(path);
      }
    }
  }
  return state;
}

export async function createPolicyVersionAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("createPolicyVersion", createPolicyVersion, "policies", formData);
}

export async function revisePolicyDraftAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("revisePolicyDraft", revisePolicyDraft, "policies", formData);
}

export async function transitionPolicyVersionAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "transitionPolicyVersion",
    transitionPolicyVersion,
    "policies",
    formData,
  );
}

export async function endPolicyVersionAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("endPolicyVersion", endPolicyVersion, "policies", formData);
}

export async function addAuthorityReferenceAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "addAuthorityReference",
    addAuthorityReference,
    "policies",
    formData,
  );
}

export async function decideAuthorityReferenceAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "decideAuthorityReference",
    decideAuthorityReference,
    "policies",
    formData,
  );
}

export async function createJurisdictionAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "createJurisdiction",
    createJurisdiction,
    "jurisdictions",
    formData,
  );
}

export async function changeJurisdictionLifecycleAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "changeJurisdictionLifecycle",
    changeJurisdictionLifecycle,
    "jurisdictions",
    formData,
  );
}

export async function createServiceAreaAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("createServiceArea", createServiceArea, "jurisdictions", formData);
}

export async function createPracticeAreaAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("createPracticeArea", createPracticeArea, "catalog", formData);
}

export async function setPracticeAreaActiveAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "setPracticeAreaActive",
    setPracticeAreaActive,
    "catalog",
    formData,
  );
}

export async function defineLaunchGateAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("defineLaunchGate", defineLaunchGate, "jurisdictions", formData);
}

export async function recordLaunchGateEvaluationAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "recordLaunchGateEvaluation",
    recordLaunchGateEvaluation,
    "jurisdictions",
    formData,
  );
}

export async function grantLaunchAuthorizationAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "grantLaunchAuthorization",
    grantLaunchAuthorization,
    "jurisdictions",
    formData,
  );
}

export async function revokeLaunchAuthorizationAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run(
    "revokeLaunchAuthorization",
    revokeLaunchAuthorization,
    "jurisdictions",
    formData,
  );
}

export async function grantCapabilityAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("grantCapability", grantCapability, "capabilities", formData);
}

export async function revokeCapabilityAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("revokeCapability", revokeCapability, "capabilities", formData);
}

export async function publishQuestionSetAction(
  _previous: ConfigurationActionState,
  formData: FormData,
): Promise<ConfigurationActionState> {
  return run("publishQuestionSet", publishQuestionSet, "intake", formData);
}
