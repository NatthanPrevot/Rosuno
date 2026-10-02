// Generic server-side Security Shell (WI-P2-003).
//
// Fail-closed authorization for later protected routes and mutations. It
// consumes the trusted server-owned session boundary and two trusted
// server-side ports: one reporting the principal contexts a subject holds, and
// one answering whether a subject holds one exact capability in one explicit
// scope. Identity, principal context, and capability are separate layers, and
// none implies another. Nothing the browser sends is read here. It defines no
// capability codes, scope meanings, or product rules, and it implements no
// sign-in, account, or identity-provider lifecycle (P3). Every result is a
// fixed status that carries no identifier, requirement, or thrown detail.

import type { OperationOutcome } from "./form-operation.ts";
import { resolveSession, type ServerSessionSource } from "./session.ts";

// The generic principal contexts. A subject may hold any of them at once, so
// they are facts held together, never one exclusive role.
const CONTEXTS = Object.freeze(["client", "attorney", "staff"] as const);

export type PrincipalContext = (typeof CONTEXTS)[number];

// One exact capability code, required in one explicit scope. Both are opaque
// here: they reach the capability source exactly as written and are never
// compared by pattern, prefix, or fallback.
export type CapabilityRequirement = {
  readonly capability: string;
  readonly scope: string;
};

// What a protected route or mutation requires beyond an authenticated session.
// Every part given must be satisfied; there is nothing else to assert.
export type SecurityRequirement = {
  readonly context?: PrincipalContext;
  readonly capability?: CapabilityRequirement;
};

// Trusted server-side port reporting every principal context the subject
// currently holds.
export type PrincipalContextSource = {
  readonly contextsOf: (
    subject: string,
  ) => Promise<readonly PrincipalContext[]>;
};

// Trusted server-side port answering whether the subject holds exactly this
// capability in exactly this scope. Only true authorizes.
export type CapabilitySource = {
  readonly isGranted: (
    subject: string,
    requirement: CapabilityRequirement,
  ) => Promise<boolean>;
};

export type SecuritySources = {
  readonly session: ServerSessionSource;
  readonly contexts: PrincipalContextSource;
  readonly capabilities: CapabilitySource;
};

export type AuthorizationDenied =
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

export type AuthorizationResult =
  { readonly status: "authorized" } | AuthorizationDenied;

export type ProtectedMutationResult =
  | AuthorizationDenied
  | { readonly status: "operation-failed" }
  | { readonly status: "succeeded" };

const AUTHORIZED: AuthorizationResult = Object.freeze({ status: "authorized" });
const UNAUTHENTICATED: AuthorizationDenied = Object.freeze({
  status: "unauthenticated",
});
const FORBIDDEN: AuthorizationDenied = Object.freeze({ status: "forbidden" });
// A source, requirement, or answer that cannot be used safely.
const UNAVAILABLE: AuthorizationDenied = Object.freeze({
  status: "unavailable",
});
const OPERATION_FAILED: ProtectedMutationResult = Object.freeze({
  status: "operation-failed",
});
const SUCCEEDED: ProtectedMutationResult = Object.freeze({
  status: "succeeded",
});

function isPrincipalContext(value: unknown): value is PrincipalContext {
  return CONTEXTS.some((context) => context === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

// The own data fields of a plain record, each read once, or null when it holds
// any other field, an accessor, or a symbol key. Inherited fields are ignored.
function readRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      descriptor === undefined ||
      !("value" in descriptor)
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

type CheckedRequirement = {
  readonly context: PrincipalContext | null;
  readonly capability: CapabilityRequirement | null;
};

// The requirement is written by server code, yet it is still taken only in
// its exact documented shape, so no added field can carry authority.
function checkRequirement(requirement: unknown): CheckedRequirement | null {
  const fields = readRecord(requirement, ["context", "capability"]);
  if (fields === null) {
    return null;
  }
  const context = fields.get("context");
  if (context !== undefined && !isPrincipalContext(context)) {
    return null;
  }
  const required = fields.get("capability");
  if (required === undefined) {
    return Object.freeze({ context: context ?? null, capability: null });
  }
  const parts = readRecord(required, ["capability", "scope"]);
  const capability = parts?.get("capability");
  const scope = parts?.get("scope");
  if (!isNonEmptyString(capability) || !isNonEmptyString(scope)) {
    return null;
  }
  return Object.freeze({
    context: context ?? null,
    capability: Object.freeze({ capability, scope }),
  });
}

// The contexts a source reported, or null unless it reported an array made
// only of known contexts.
function readContexts(reported: unknown): readonly PrincipalContext[] | null {
  if (!Array.isArray(reported)) {
    return null;
  }
  const contexts: PrincipalContext[] = [];
  const count: number = reported.length;
  for (let index = 0; index < count; index += 1) {
    const context: unknown = reported[index];
    if (!isPrincipalContext(context)) {
      return null;
    }
    contexts.push(context);
  }
  return contexts;
}

// Decides whether the current request meets the requirement. It never throws:
// anything that fails or cannot be read denies.
export async function authorize(
  sources: SecuritySources,
  requirement: SecurityRequirement,
): Promise<AuthorizationResult> {
  try {
    const required = checkRequirement(requirement);
    if (required === null) {
      return UNAVAILABLE;
    }
    const session = await resolveSession(sources.session);
    if (session.status !== "authenticated") {
      return UNAUTHENTICATED;
    }
    if (required.context !== null) {
      const contexts = readContexts(
        await sources.contexts.contextsOf(session.subject),
      );
      if (contexts === null) {
        return UNAVAILABLE;
      }
      if (!contexts.includes(required.context)) {
        return FORBIDDEN;
      }
    }
    if (required.capability !== null) {
      const granted: unknown = await sources.capabilities.isGranted(
        session.subject,
        required.capability,
      );
      if (typeof granted !== "boolean") {
        return UNAVAILABLE;
      }
      if (!granted) {
        return FORBIDDEN;
      }
    }
    return AUTHORIZED;
  } catch {
    return UNAVAILABLE;
  }
}

// Runs the mutation only after authorize succeeds for this request, and at
// most once. The mutation receives nothing; only an explicit ok: true from it
// is success, and nothing else it returns or throws reaches the result.
export async function runProtectedMutation(
  sources: SecuritySources,
  requirement: SecurityRequirement,
  mutation: () => Promise<OperationOutcome>,
): Promise<ProtectedMutationResult> {
  const authorization = await authorize(sources, requirement);
  if (authorization.status !== "authorized") {
    return authorization;
  }
  try {
    const outcome = await mutation();
    return outcome?.ok === true ? SUCCEEDED : OPERATION_FAILED;
  } catch {
    return OPERATION_FAILED;
  }
}
