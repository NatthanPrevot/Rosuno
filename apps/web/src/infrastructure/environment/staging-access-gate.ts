// Server-only Staging access gate (the reviewed P2-925 design, implemented
// under DEV-001).
//
// Every human-facing and data-bearing route of a non-production deployment
// answers only to one Staging access credential: HTTP Basic with the fixed
// user name "rosuno-staging" and, as password, the server-only setting
// ROSUNO_STAGING_ACCESS_GATE. The proxy calls the gate after it sets the
// correlation id and before the Supabase session refresh.
//
// Inputs (design section 2.1). The database record is authoritative:
// - C_db, R_db: the recorded environment class and project reference, read
//   only through the PS-A2 API accessor deployment_environment_identity()
//   with the server's existing privileged binding (the privileged module's
//   one identity port). A recorded identity is immutable, so the first
//   successful read of one is kept for the process lifetime. Until then, or
//   when it cannot be read (no binding, more than two seconds, an error, a
//   malformed answer), the identity is unknown. An "unrecorded" answer is
//   not a record and is never kept, so a database recorded later is read
//   again.
// - C_app, R_app: the existing binding settings, read through the existing
//   environment configuration: the ROSUNO_ENVIRONMENT_CLASS setting and the
//   project reference of the configured Supabase URL. A recorded identity is
//   readable only through a verified privileged binding, and that binding
//   exists only when the URL is exactly the expected project's origin (or,
//   for development, the local stack's origin with no expected project), so
//   whenever the identity is known this R_app equals the expected project
//   reference setting, and is absent for the local stack.
// - H: hosted, meaning REPLIT_DEPLOYMENT is exactly "1".
// - S: ROSUNO_STAGING_ACCESS_GATE, valid only as 32 to 128 characters of
//   [A-Za-z0-9_-]. An absent setting is missing; any other value, the empty
//   string included, is invalid.
//
// Activation (design section 2.2). The gate is off in exactly two cases:
// production fully bound (C_db and C_app production, R_app equal to R_db),
// and local development (C_db and C_app development, not hosted, S missing).
// It is required in every other case, an unknown or unrecorded identity
// included. When required, a missing or invalid S answers 503 to every gated
// request and nothing passes; a valid S requires the credential.
//
// Credential and responses (design section 2.3). The presented user-pass is
// compared with the expected one as SHA-256 digests with
// crypto.timingSafeEqual, and the comparison always runs. A missing, wrong,
// malformed or non-Basic credential answers 401 with the Basic challenge.
// Every gated response, 401, 503 and every pass, carries Cache-Control
// "private, no-store, max-age=0" and X-Robots-Tag "noindex, nofollow". After
// the check, pass or fail, the Authorization header is deleted from the
// forwarded request headers, so no page, action, route handler or log
// receives it. The gate logs nothing.
//
// Coverage (design section 2.4). The four machine routes, matched by exact
// equality of the normalized pathname with any method, keep their own
// authentication: the gate neither reads nor alters their headers, and a
// gate credential grants nothing there.

import { createHash, timingSafeEqual } from "node:crypto";

import {
  ENVIRONMENT_CLASSES,
  type EnvironmentClass,
} from "../../application/policy-selection.ts";
import {
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { isOneOf, readExact } from "../../application/professional-records.ts";
import { createDeploymentIdentityPort } from "../identity/registration-provisioning.ts";
import { readEnvironmentConfiguration } from "./environment-configuration.ts";

export const STAGING_ACCESS_USER = "rosuno-staging";
export const GATED_CACHE_CONTROL = "private, no-store, max-age=0";
export const GATED_ROBOTS = "noindex, nofollow";
export const BASIC_CHALLENGE = 'Basic realm="Rosuno Staging", charset="UTF-8"';

// The four machine routes, each with its own authentication (the Stripe,
// Daily and Resend signatures; the worker's bearer value).
export const MACHINE_ROUTES: readonly string[] = Object.freeze([
  "/api/payments/stripe",
  "/api/media/daily",
  "/api/notifications/resend",
  "/api/jobs/run",
]);

export const IDENTITY_DEADLINE_MS = 2000;

// The recorded class and project reference, or "unrecorded" with none.
export type DeploymentIdentity = {
  readonly environmentClass: EnvironmentClass | "unrecorded";
  readonly projectRef: string | null;
};

export type GateSettings = {
  // C_app: the environment class setting, unvalidated.
  readonly configuredClass: unknown;
  // R_app: the configured project reference, or null.
  readonly expectedProjectRef: string | null;
  // H.
  readonly hosted: boolean;
  // S, unvalidated; undefined when the setting is absent.
  readonly gateValue: string | undefined;
};

export type AccessDecision = "off" | "unavailable" | "challenge" | "pass";

const PROJECT_REF = /^[a-z]{20}$/;
const GATE_VALUE = /^[A-Za-z0-9_-]{32,128}$/;

export function isValidGateValue(value: unknown): value is string {
  return typeof value === "string" && GATE_VALUE.test(value);
}

// The activation matrix: false (off) in exactly its two cases.
export function isGateRequired(
  identity: DeploymentIdentity | null,
  settings: GateSettings,
): boolean {
  if (identity === null) {
    return true;
  }
  if (
    identity.environmentClass === "production" &&
    settings.configuredClass === "production" &&
    identity.projectRef !== null &&
    identity.projectRef === settings.expectedProjectRef
  ) {
    return false;
  }
  if (
    identity.environmentClass === "development" &&
    settings.configuredClass === "development" &&
    !settings.hosted &&
    settings.gateValue === undefined
  ) {
    return false;
  }
  return true;
}

// One Basic credential in strict, canonical base64. A header longer than
// any credential the gate accepts is refused before it is decoded.
const BASIC =
  /^Basic ((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==))$/;
const MAX_HEADER_LENGTH = 512;
const COLON = 0x3a;

// The decoded user-pass bytes of a well-formed Basic header, or null.
function presentedCredential(authorization: string | null): Buffer | null {
  if (
    typeof authorization !== "string" ||
    authorization.length > MAX_HEADER_LENGTH
  ) {
    return null;
  }
  const encoded = BASIC.exec(authorization)?.[1];
  if (encoded === undefined) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded && decoded.includes(COLON)
    ? decoded
    : null;
}

function digestOf(value: Buffer | string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Whether the header presents exactly "rosuno-staging" and the gate value as
// password. Neither the user name nor a valid gate value holds a colon, so
// equal user-pass bytes mean an equal user name and an equal password.
export function presentsStagingCredential(
  authorization: string | null,
  gateValue: string,
): boolean {
  const presented = presentedCredential(authorization);
  const equal = timingSafeEqual(
    digestOf(presented ?? ""),
    digestOf(`${STAGING_ACCESS_USER}:${gateValue}`),
  );
  return presented !== null && isValidGateValue(gateValue) && equal;
}

// The pure decision for one gated request.
export function decideStagingAccess(
  identity: DeploymentIdentity | null,
  settings: GateSettings,
  authorization: string | null,
): AccessDecision {
  if (!isGateRequired(identity, settings)) {
    return "off";
  }
  if (!isValidGateValue(settings.gateValue)) {
    return "unavailable";
  }
  return presentsStagingCredential(authorization, settings.gateValue)
    ? "pass"
    : "challenge";
}

export function isMachineRoute(pathname: string): boolean {
  return MACHINE_ROUTES.includes(pathname);
}

// The settings, read from the server environment on every request; nothing
// is defaulted.
export function readGateSettings(
  environment: {
    readonly ROSUNO_ENVIRONMENT_CLASS?: string | undefined;
    readonly NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
    readonly REPLIT_DEPLOYMENT?: string | undefined;
    readonly ROSUNO_STAGING_ACCESS_GATE?: string | undefined;
  } = {
    ROSUNO_ENVIRONMENT_CLASS: process.env.ROSUNO_ENVIRONMENT_CLASS,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    REPLIT_DEPLOYMENT: process.env.REPLIT_DEPLOYMENT,
    ROSUNO_STAGING_ACCESS_GATE: process.env.ROSUNO_STAGING_ACCESS_GATE,
  },
): GateSettings {
  const configuration = readEnvironmentConfiguration({
    ROSUNO_ENVIRONMENT_CLASS: environment.ROSUNO_ENVIRONMENT_CLASS,
    NEXT_PUBLIC_SUPABASE_URL: environment.NEXT_PUBLIC_SUPABASE_URL,
  });
  return Object.freeze({
    configuredClass: configuration.configuredClass,
    expectedProjectRef: configuration.expectedProjectRef,
    hosted: environment.REPLIT_DEPLOYMENT === "1",
    gateValue: environment.ROSUNO_STAGING_ACCESS_GATE,
  });
}

const UNRECORDED: DeploymentIdentity = Object.freeze({
  environmentClass: "unrecorded",
  projectRef: null,
});
const UNREADABLE: RowsResult = Object.freeze({ kind: "unreadable" });

// The rows deployment_environment_identity() answered, read strictly:
// exactly one row with exactly its two columns, a known class (or
// "unrecorded" with no reference) and a well-formed reference or none.
// Anything else is unknown (null).
export function identityOf(result: RowsResult): DeploymentIdentity | null {
  if (result.kind !== "rows" || result.rows.length !== 1) {
    return null;
  }
  const row = readExact(result.rows[0], ["environment_class", "project_ref"]);
  if (row === null) {
    return null;
  }
  const environmentClass = row.get("environment_class");
  const projectRef = row.get("project_ref");
  if (environmentClass === "unrecorded" && projectRef === null) {
    return UNRECORDED;
  }
  if (
    !isOneOf(ENVIRONMENT_CLASSES, environmentClass) ||
    !(
      projectRef === null ||
      (typeof projectRef === "string" && PROJECT_REF.test(projectRef))
    )
  ) {
    return null;
  }
  return Object.freeze({ environmentClass, projectRef });
}

export type IdentityPort = { readonly read: () => Promise<RowsResult> };

// The identity reader: one bounded read at a time, shared by the requests
// that arrive meanwhile. A recorded identity is kept for the process lifetime
// only once it was read successfully, and nothing else is ever kept.
export function createIdentityReader(
  source: () => Promise<IdentityPort | null> = createDeploymentIdentityPort,
  deadlineMs: number = IDENTITY_DEADLINE_MS,
): () => Promise<DeploymentIdentity | null> {
  let recorded: DeploymentIdentity | null = null;
  let pending: Promise<DeploymentIdentity | null> | null = null;
  const readOnce = async (): Promise<DeploymentIdentity | null> => {
    const result = await withinDeadline(
      async () => {
        const port = await source();
        return port === null ? UNREADABLE : port.read();
      },
      UNREADABLE,
      deadlineMs,
    );
    const identity = identityOf(result);
    if (identity !== null && identity.environmentClass !== "unrecorded") {
      recorded = identity;
    }
    return identity;
  };
  return () => {
    if (recorded !== null) {
      return Promise.resolve(recorded);
    }
    pending ??= readOnce().finally(() => {
      pending = null;
    });
    return pending;
  };
}

export type GateDependencies = {
  readonly settings: () => GateSettings;
  readonly identity: () => Promise<DeploymentIdentity | null>;
};

const DEFAULT_DEPENDENCIES: GateDependencies = Object.freeze({
  settings: () => readGateSettings(),
  identity: createIdentityReader(),
});

// What the gate sees of a request: its mutable forwarded headers and its
// normalized pathname.
export type GatedRequest = {
  readonly headers: Headers;
  readonly nextUrl: { readonly pathname: string };
};

export type GateOutcome =
  // A machine route, or the gate is off: nothing was read or changed.
  | { readonly kind: "ungated" }
  // The credential was accepted; the response is still to be marked.
  | { readonly kind: "passed" }
  // 401 or 503, already marked.
  | { readonly kind: "refused"; readonly response: Response };

const UNGATED: GateOutcome = Object.freeze({ kind: "ungated" });
const PASSED: GateOutcome = Object.freeze({ kind: "passed" });

// Marks a gated response: never kept by a shared cache, never indexed.
export function markGatedResponse(response: {
  readonly headers: Headers;
}): void {
  response.headers.set("Cache-Control", GATED_CACHE_CONTROL);
  response.headers.set("X-Robots-Tag", GATED_ROBOTS);
}

function refusalOf(decision: "unavailable" | "challenge"): Response {
  const response = new Response(null, {
    status: decision === "challenge" ? 401 : 503,
  });
  markGatedResponse(response);
  if (decision === "challenge") {
    response.headers.set("WWW-Authenticate", BASIC_CHALLENGE);
  }
  return response;
}

// The gate for one request. It never throws: anything unexpected while
// deciding is a refusal (503), never a pass.
export async function stagingAccessGate(
  request: GatedRequest,
  dependencies: GateDependencies = DEFAULT_DEPENDENCIES,
): Promise<GateOutcome> {
  if (isMachineRoute(request.nextUrl.pathname)) {
    return UNGATED;
  }
  let decision: AccessDecision;
  try {
    decision = decideStagingAccess(
      await dependencies.identity(),
      dependencies.settings(),
      request.headers.get("authorization"),
    );
  } catch {
    decision = "unavailable";
  }
  if (decision === "off") {
    return UNGATED;
  }
  request.headers.delete("authorization");
  return decision === "pass"
    ? PASSED
    : Object.freeze({ kind: "refused", response: refusalOf(decision) });
}
