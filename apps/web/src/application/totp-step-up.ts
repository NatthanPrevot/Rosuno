// Authenticator-app (TOTP) enrollment and session step-up (MVP-001 S2).
//
// An attorney or staff principal sets up one authenticator app and then,
// whenever a session is at the ordinary level (aal1), confirms a 6-digit
// code from it; the identity provider then upgrades the request's own
// session to aal2, which the database requires for attorney professional
// writes and every staff operation.
//
// Provider-neutral and injectable: each request hands in its own ports.
// Every operation re-establishes the principal on the server (session
// assurance module) and reads the account's factors afresh; nothing the
// browser sends names a factor, a challenge, an identity, or a destination.
// A submitted code is passed to the provider once and kept nowhere; the
// setup key and setup link are handed only to the principal's own browser
// for manual entry in an authenticator app (no picture of them is made
// here), and no factor id ever leaves the server. Unverified factors left
// by an abandoned setup are removed before a new one is created; a verified
// factor is never removed here. Every result is a fixed status. Success is
// reported only when the provider accepted the code and a fresh read of
// the request's session then shows it stepped up; an outcome that is lost,
// late, or unknown is never reported as success.

import {
  attempt,
  portFrom,
  textField,
  UNAVAILABLE,
  type Refusal,
} from "./professional-identity.ts";
import { isOneOf, readExact } from "./professional-records.ts";
import {
  readSessionAssurance,
  resolvePrincipalStanding,
  servedKindOf,
  STEP_UP_DESTINATIONS,
  type PrincipalKind,
  type StepUpDestination,
  type StepUpSources,
} from "./session-assurance.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// One factor as the provider reported it.
export type FactorRecord = {
  readonly id: unknown;
  readonly factorType: unknown;
  readonly status: unknown;
};

// The account's factors as the provider reported them (all of them,
// verified or not), or "unreadable".
export type FactorsRead =
  | { readonly kind: "factors"; readonly factors: readonly FactorRecord[] }
  | { readonly kind: "unreadable" };

export type EnrollmentAnswer =
  | {
      readonly kind: "enrolled";
      readonly factorId: unknown;
      readonly secret: unknown;
      readonly uri: unknown;
    }
  | { readonly kind: "unavailable" };

export type ChallengeAnswer =
  | { readonly kind: "challenge"; readonly challengeId: unknown }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "unavailable" };

// "verified": the provider accepted the code and issued the upgraded
// session. "wrong-code": it refused the code. "expired": the challenge
// expired. "rate-limited": too many attempts. "refused": any other refusal
// (nothing changed). "unavailable": the provider failed. "unknown": the
// answer was lost, late, or malformed.
export type VerifyAnswer = {
  readonly kind:
    | "verified"
    | "wrong-code"
    | "expired"
    | "rate-limited"
    | "refused"
    | "unavailable"
    | "unknown";
};

export type RemovalAnswer =
  { readonly kind: "removed" } | { readonly kind: "unavailable" };

// Request-scoped: every call works on the request's own session. The ids
// passed in are only those the provider itself reported in this request.
export type AuthenticatorFactors = {
  readonly listFactors: () => Promise<FactorsRead>;
  readonly unenroll: (factorId: string) => Promise<RemovalAnswer>;
  readonly enrollTotp: () => Promise<EnrollmentAnswer>;
  readonly challenge: (factorId: string) => Promise<ChallengeAnswer>;
  readonly verify: (
    factorId: string,
    challengeId: string,
    code: string,
  ) => Promise<VerifyAnswer>;
};

export type AuthenticatorSources = StepUpSources & {
  readonly factors: () => Promise<AuthenticatorFactors | null>;
};

// ---------------------------------------------------------------------------
// Views and states
// ---------------------------------------------------------------------------

// The account security page. "set-up": no verified factor yet, so one can
// be set up. "step-up-required": a factor exists and this session has not
// confirmed a code from it. "protected": this session has.
export type AccountSecurityView =
  | Refusal
  | {
      readonly status: "set-up" | "step-up-required" | "protected";
      readonly kind: PrincipalKind;
    };

// The step-up page. "ready": a code can be confirmed. "set-up-required":
// there is no verified factor to confirm a code from. "stepped-up": this
// session already has.
export type StepUpView =
  | Refusal
  | {
      readonly status: "ready" | "set-up-required" | "stepped-up";
      readonly kind: PrincipalKind;
    };

// Starting a setup. "pending": a new factor awaits its first code; the key
// and link are for manual entry in the principal's own authenticator app.
// "already-set-up": a verified factor exists, so nothing was created.
export type EnrollmentState =
  | { readonly status: "idle" }
  | {
      readonly status: "pending";
      readonly secret: string;
      readonly uri: string;
    }
  | { readonly status: "already-set-up" }
  | Refusal;

export type CodeFieldErrors = Readonly<Record<"code", readonly string[]>>;

// Confirming a code. "verified" (never shown: the action returns to the
// fixed destination) means the provider accepted the code and a fresh read
// shows the session stepped up. "restart": no single pending setup exists,
// so setup starts again. "set-up-required": nothing to confirm a code
// from. "already-set-up": a verified factor already exists. "unconfirmed":
// the outcome is unknown, so nothing is claimed.
export type CodeState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: CodeFieldErrors }
  | { readonly status: "wrong-code" }
  | { readonly status: "expired" }
  | { readonly status: "rate-limited" }
  | { readonly status: "restart" }
  | { readonly status: "set-up-required" }
  | { readonly status: "already-set-up" }
  | { readonly status: "unconfirmed" }
  | { readonly status: "verified"; readonly destination: StepUpDestination }
  | Refusal;

export const INITIAL_ENROLLMENT_STATE: EnrollmentState = Object.freeze({
  status: "idle",
});
export const INITIAL_CODE_STATE: CodeState = Object.freeze({ status: "idle" });

// The one form field an explicit setup request carries, with its one value.
export const ENROLLMENT_INTENT = Object.freeze({
  field: "intent",
  value: "start-authenticator-setup",
} as const);

// The fields a code form carries: the code, and which of the principal's
// own workspaces to return to.
export const CODE_FIELD = "code";
export const DESTINATION_FIELD = "to";

const ALREADY_SET_UP = Object.freeze({ status: "already-set-up" } as const);
const WRONG_CODE = Object.freeze({ status: "wrong-code" } as const);
const EXPIRED = Object.freeze({ status: "expired" } as const);
const RATE_LIMITED = Object.freeze({ status: "rate-limited" } as const);
const RESTART = Object.freeze({ status: "restart" } as const);
const SET_UP_REQUIRED = Object.freeze({ status: "set-up-required" } as const);
const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);
const INVALID_CODE: CodeState = Object.freeze({
  status: "invalid",
  fieldErrors: Object.freeze({
    code: Object.freeze([
      "Enter the 6-digit code shown in your authenticator app.",
    ]),
  }),
});

const VERIFIED: Readonly<Record<PrincipalKind, CodeState>> = Object.freeze({
  attorney: Object.freeze({
    status: "verified",
    destination: STEP_UP_DESTINATIONS.attorney,
  }),
  staff: Object.freeze({
    status: "verified",
    destination: STEP_UP_DESTINATIONS.staff,
  }),
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const FACTOR_STATUSES = Object.freeze(["verified", "unverified"] as const);
type FactorStatus = (typeof FACTOR_STATUSES)[number];

type Factor = {
  readonly id: string;
  readonly totp: boolean;
  readonly status: FactorStatus;
};

const MAX_FACTOR_ID_LENGTH = 128;
const FACTOR_ID = /^[A-Za-z0-9-]{1,128}$/;

function isFactorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_FACTOR_ID_LENGTH &&
    FACTOR_ID.test(value)
  );
}

// The account's factors, or null unless every reported factor is well
// formed with a known status.
function factorsOf(result: unknown): readonly Factor[] | null {
  const fields = readExact(result, ["kind", "factors"]);
  const reported = fields?.get("factors");
  if (fields?.get("kind") !== "factors" || !Array.isArray(reported)) {
    return null;
  }
  const factors: Factor[] = [];
  for (const entry of reported as readonly unknown[]) {
    const factor = readExact(entry, ["id", "factorType", "status"]);
    const id = factor?.get("id");
    const status = factor?.get("status");
    const type = factor?.get("factorType");
    if (
      factor === null ||
      !isFactorId(id) ||
      !isOneOf(FACTOR_STATUSES, status) ||
      typeof type !== "string"
    ) {
      return null;
    }
    factors.push(Object.freeze({ id, totp: type === "totp", status }));
  }
  return factors;
}

// An RFC 4648 base32 setup key as the provider reports it.
const SETUP_KEY_SHAPE = /^[A-Z2-7]{16,128}=*$/;
const MAX_URI_LENGTH = 1024;

// The setup key and link of a new factor, or null unless both are well
// formed and the link carries exactly that key for a TOTP factor.
function setupOf(
  secret: unknown,
  uri: unknown,
): { readonly secret: string; readonly uri: string } | null {
  if (
    typeof secret !== "string" ||
    !SETUP_KEY_SHAPE.test(secret) ||
    typeof uri !== "string" ||
    uri.length > MAX_URI_LENGTH ||
    /[\s\u0000-\u001f\u007f]/.test(uri)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "otpauth:" ||
    parsed.hostname !== "totp" ||
    parsed.searchParams.getAll("secret").length !== 1 ||
    parsed.searchParams.get("secret") !== secret
  ) {
    return null;
  }
  return { secret, uri };
}

// A submitted code: exactly one string field holding six digits, spaces
// allowed between them; anything else is null.
export function totpCodeOf(formData: unknown): string | null {
  if (!(formData instanceof FormData)) {
    return null;
  }
  const values = formData.getAll(CODE_FIELD);
  if (values.length !== 1 || typeof values[0] !== "string") {
    return null;
  }
  const text = textField(values[0], 16);
  if (text === null) {
    return null;
  }
  const digits = text.replace(/ /g, "");
  return /^[0-9]{6}$/.test(digits) ? digits : null;
}

function requestedOf(formData: FormData): unknown {
  return formData.getAll(DESTINATION_FIELD);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// Resolves the account security page for the current request. It never
// throws and never changes anything.
export async function resolveAccountSecurity(
  sources: StepUpSources,
  requested?: unknown,
): Promise<AccountSecurityView> {
  try {
    const standing = await resolvePrincipalStanding(sources);
    if (standing.status !== "principal") {
      return standing;
    }
    const kind = servedKindOf(requested, standing.kinds);
    const assurance = await readSessionAssurance(sources.assurance);
    switch (assurance.status) {
      case "enrollment-required":
        return Object.freeze({ status: "set-up", kind });
      case "step-up-required":
        return Object.freeze({ status: "step-up-required", kind });
      case "stepped-up":
        return Object.freeze({ status: "protected", kind });
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

// Resolves the step-up page for the current request. It never throws and
// never changes anything.
export async function resolveStepUp(
  sources: StepUpSources,
  requested?: unknown,
): Promise<StepUpView> {
  try {
    const standing = await resolvePrincipalStanding(sources);
    if (standing.status !== "principal") {
      return standing;
    }
    const kind = servedKindOf(requested, standing.kinds);
    const assurance = await readSessionAssurance(sources.assurance);
    switch (assurance.status) {
      case "step-up-required":
        return Object.freeze({ status: "ready", kind });
      case "enrollment-required":
        return Object.freeze({ status: "set-up-required", kind });
      case "stepped-up":
        return Object.freeze({ status: "stepped-up", kind });
      default:
        return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

// Starts an authenticator setup for the principal's own account: removes
// any unverified factor an abandoned setup left behind, then creates one
// new TOTP factor and returns its setup key and link. Nothing is created
// while a verified factor exists. It never throws.
export async function startTotpEnrollment(
  sources: AuthenticatorSources,
  formData: unknown,
): Promise<EnrollmentState> {
  try {
    if (
      !(formData instanceof FormData) ||
      formData.getAll(ENROLLMENT_INTENT.field).length !== 1 ||
      formData.get(ENROLLMENT_INTENT.field) !== ENROLLMENT_INTENT.value
    ) {
      return UNAVAILABLE;
    }
    const standing = await resolvePrincipalStanding(sources);
    if (standing.status !== "principal") {
      return standing;
    }
    const assurance = await readSessionAssurance(sources.assurance);
    if (assurance.status === "unavailable") {
      return UNAVAILABLE;
    }
    if (assurance.status !== "enrollment-required") {
      return ALREADY_SET_UP;
    }
    const factors = await portFrom(sources.factors);
    if (factors === null) {
      return UNAVAILABLE;
    }
    const listed = factorsOf(await attempt(() => factors.listFactors()));
    if (listed === null) {
      return UNAVAILABLE;
    }
    if (listed.some((f) => f.totp && f.status === "verified")) {
      return ALREADY_SET_UP;
    }
    for (const stale of listed.filter(
      (f) => f.totp && f.status === "unverified",
    )) {
      const removed = readExact(
        await attempt(() => factors.unenroll(stale.id)),
        ["kind"],
      );
      if (removed?.get("kind") !== "removed") {
        return UNAVAILABLE;
      }
    }
    const answer = await attempt(() => factors.enrollTotp());
    const enrolled = readExact(answer, ["kind", "factorId", "secret", "uri"]);
    if (
      enrolled?.get("kind") !== "enrolled" ||
      !isFactorId(enrolled.get("factorId"))
    ) {
      return UNAVAILABLE;
    }
    const setup = setupOf(enrolled.get("secret"), enrolled.get("uri"));
    if (setup === null) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "pending", ...setup });
  } catch {
    return UNAVAILABLE;
  }
}

// Asks the provider for one challenge of the factor and verifies the code
// against it, then maps the answer to a fixed state. Success needs both the
// provider's acceptance and a fresh read showing the session stepped up.
async function challengeAndVerify(
  sources: AuthenticatorSources,
  factors: AuthenticatorFactors,
  factorId: string,
  code: string,
  kind: PrincipalKind,
  refused: CodeState,
): Promise<CodeState> {
  const challenged = await attempt(() => factors.challenge(factorId));
  const challenge = readExact(challenged, ["kind", "challengeId"]);
  if (challenge === null) {
    const other = readExact(challenged, ["kind"])?.get("kind");
    return other === "rate-limited" ? RATE_LIMITED : UNAVAILABLE;
  }
  const challengeId = challenge.get("challengeId");
  if (challenge.get("kind") !== "challenge" || !isFactorId(challengeId)) {
    return UNAVAILABLE;
  }
  const verified = readExact(
    await attempt(() => factors.verify(factorId, challengeId, code)),
    ["kind"],
  );
  switch (verified?.get("kind")) {
    case "verified": {
      const after = await readSessionAssurance(sources.assurance);
      return after.status === "stepped-up" ? VERIFIED[kind] : UNCONFIRMED;
    }
    case "wrong-code":
      return WRONG_CODE;
    case "expired":
      return EXPIRED;
    case "rate-limited":
      return RATE_LIMITED;
    case "refused":
      return refused;
    case "unavailable":
      return UNAVAILABLE;
    default:
      return UNCONFIRMED;
  }
}

// Confirms the first code of the one pending setup, which verifies the new
// factor and steps the session up. It never throws.
export async function confirmTotpEnrollment(
  sources: AuthenticatorSources,
  formData: unknown,
): Promise<CodeState> {
  try {
    const code = totpCodeOf(formData);
    if (code === null || !(formData instanceof FormData)) {
      return INVALID_CODE;
    }
    const standing = await resolvePrincipalStanding(sources);
    if (standing.status !== "principal") {
      return standing;
    }
    const kind = servedKindOf(requestedOf(formData), standing.kinds);
    const assurance = await readSessionAssurance(sources.assurance);
    switch (assurance.status) {
      case "stepped-up":
        return VERIFIED[kind];
      case "step-up-required":
        return ALREADY_SET_UP;
      case "enrollment-required":
        break;
      default:
        return UNAVAILABLE;
    }
    const factors = await portFrom(sources.factors);
    if (factors === null) {
      return UNAVAILABLE;
    }
    const listed = factorsOf(await attempt(() => factors.listFactors()));
    if (listed === null) {
      return UNAVAILABLE;
    }
    if (listed.some((f) => f.totp && f.status === "verified")) {
      return ALREADY_SET_UP;
    }
    const pending = listed.filter((f) => f.totp && f.status === "unverified");
    if (pending.length !== 1) {
      return RESTART;
    }
    return challengeAndVerify(
      sources,
      factors,
      pending[0].id,
      code,
      kind,
      RESTART,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Confirms a code from the account's one verified factor, which steps an
// ordinary session up. It never throws.
export async function stepUpSession(
  sources: AuthenticatorSources,
  formData: unknown,
): Promise<CodeState> {
  try {
    const code = totpCodeOf(formData);
    if (code === null || !(formData instanceof FormData)) {
      return INVALID_CODE;
    }
    const standing = await resolvePrincipalStanding(sources);
    if (standing.status !== "principal") {
      return standing;
    }
    const kind = servedKindOf(requestedOf(formData), standing.kinds);
    const assurance = await readSessionAssurance(sources.assurance);
    switch (assurance.status) {
      case "stepped-up":
        return VERIFIED[kind];
      case "enrollment-required":
        return SET_UP_REQUIRED;
      case "step-up-required":
        break;
      default:
        return UNAVAILABLE;
    }
    const factors = await portFrom(sources.factors);
    if (factors === null) {
      return UNAVAILABLE;
    }
    const listed = factorsOf(await attempt(() => factors.listFactors()));
    if (listed === null) {
      return UNAVAILABLE;
    }
    // Exactly one verified authenticator app: setup never creates a second,
    // and a code is never tried against a factor chosen by guesswork.
    const verified = listed.filter((f) => f.totp && f.status === "verified");
    if (verified.length !== 1) {
      return UNAVAILABLE;
    }
    return challengeAndVerify(
      sources,
      factors,
      verified[0].id,
      code,
      kind,
      UNAVAILABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}
