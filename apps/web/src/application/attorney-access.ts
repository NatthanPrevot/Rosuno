// Existing-attorney workspace access (P3-001).
//
// A small presentation-facing adapter over the unchanged Security Shell. For
// one request it asks authorize for the attorney principal context and maps
// the fixed result to a fixed workspace-access state that carries no
// identifier, record, or provider detail. The trusted attorney principal
// source is read exactly once per request, and the lifecycle stage handed to
// presentation is the one from that same read, so what is shown never comes
// from a second, later read. Nothing the browser sends is read here, nothing
// is kept between requests, and no capability is granted. An admitted
// lifecycle stage, approved included, is a record stage only: this adapter
// decides no professional verification, current eligibility, bookability, or
// any other business question.

import {
  authorize,
  type CapabilitySource,
  type PrincipalContext,
  type PrincipalContextSource,
  type SecurityRequirement,
} from "./security.ts";
import type { ServerSessionSource } from "./session.ts";

// The Attorney Profile lifecycle stages admitted to the restricted workspace.
const WORKSPACE_STAGES = Object.freeze([
  "applicant",
  "under_review",
  "approved",
] as const);

export type AttorneyWorkspaceStage = (typeof WORKSPACE_STAGES)[number];

// What the trusted attorney principal source resolved for one subject in one
// read: the attorney context with its admitted stage, or no context at all.
export type AttorneyPrincipal = {
  readonly contexts: readonly PrincipalContext[];
  readonly stage: AttorneyWorkspaceStage | null;
};

// The existing PrincipalContextSource port, plus the one read that also
// reports the admitted stage.
export type AttorneyPrincipalSource = PrincipalContextSource & {
  readonly principalOf: (subject: string) => Promise<AttorneyPrincipal>;
};

export type AttorneyWorkspaceSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

export type AttorneyWorkspaceAccess =
  | { readonly status: "granted"; readonly stage: AttorneyWorkspaceStage }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

const ATTORNEY_REQUIREMENT: SecurityRequirement = Object.freeze({
  context: "attorney",
});

// The workspace requires no capability, so this port is never asked; were it
// asked, it would grant nothing.
const NO_CAPABILITIES: CapabilitySource = Object.freeze({
  isGranted: async () => false,
});

const NO_CONTEXT: readonly PrincipalContext[] = Object.freeze([]);
const ATTORNEY_CONTEXT: readonly PrincipalContext[] = Object.freeze([
  "attorney",
]);

const SIGN_IN_REQUIRED: AttorneyWorkspaceAccess = Object.freeze({
  status: "sign-in-required",
});
const DENIED: AttorneyWorkspaceAccess = Object.freeze({ status: "denied" });
const UNAVAILABLE: AttorneyWorkspaceAccess = Object.freeze({
  status: "unavailable",
});
const GRANTED: Readonly<
  Record<AttorneyWorkspaceStage, AttorneyWorkspaceAccess>
> = Object.freeze({
  applicant: Object.freeze({ status: "granted", stage: "applicant" }),
  under_review: Object.freeze({ status: "granted", stage: "under_review" }),
  approved: Object.freeze({ status: "granted", stage: "approved" }),
});

export function isAttorneyWorkspaceStage(
  value: unknown,
): value is AttorneyWorkspaceStage {
  return WORKSPACE_STAGES.some((stage) => stage === value);
}

// Thrown for a principal answer that cannot be used. The message is fixed,
// and the Security Shell never passes it on.
function unusable(): Error {
  return new Error("The attorney workspace principal could not be read.");
}

// The own data field of a record, or null when it is missing or an accessor,
// so no getter can compute an answer later.
function dataField(record: object, key: string): { value: unknown } | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    return null;
  }
  return { value: descriptor.value };
}

// The stage an answer admits, null when it admits none, or undefined unless
// the answer is exactly one of the two consistent shapes: the attorney
// context alone with an admitted stage, or no context with no stage.
function stageOf(answer: unknown): AttorneyWorkspaceStage | null | undefined {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return undefined;
  }
  const keys = Reflect.ownKeys(answer);
  const contexts = dataField(answer, "contexts");
  const stage = dataField(answer, "stage");
  if (
    keys.length !== 2 ||
    contexts === null ||
    stage === null ||
    !Array.isArray(contexts.value)
  ) {
    return undefined;
  }
  const reported: readonly unknown[] = contexts.value;
  if (stage.value === null) {
    return reported.length === 0 ? null : undefined;
  }
  if (
    !isAttorneyWorkspaceStage(stage.value) ||
    reported.length !== 1 ||
    reported[0] !== "attorney"
  ) {
    return undefined;
  }
  return stage.value;
}

// Decides workspace access for the current request. It never throws:
// anything that fails, cannot be read, or does not add up is unavailable.
export async function resolveAttorneyWorkspaceAccess(
  sources: AttorneyWorkspaceSources,
): Promise<AttorneyWorkspaceAccess> {
  try {
    const { session, attorney } = sources;
    // The one principal read of this request, kept only for this call.
    const observed: { read: boolean; stage: AttorneyWorkspaceStage | null } = {
      read: false,
      stage: null,
    };
    const contexts: PrincipalContextSource = Object.freeze({
      contextsOf: async (subject: string) => {
        if (observed.read) {
          throw unusable();
        }
        observed.read = true;
        const stage = stageOf(await attorney.principalOf(subject));
        if (stage === undefined) {
          throw unusable();
        }
        observed.stage = stage;
        return stage === null ? NO_CONTEXT : ATTORNEY_CONTEXT;
      },
    });
    const result = await authorize(
      { session, contexts, capabilities: NO_CAPABILITIES },
      ATTORNEY_REQUIREMENT,
    );
    switch (result.status) {
      case "authorized":
        return observed.stage === null ? UNAVAILABLE : GRANTED[observed.stage];
      case "unauthenticated":
        return SIGN_IN_REQUIRED;
      case "forbidden":
        return DENIED;
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}
