// Authentication-abuse control for sign-in and account recovery (MVP-001
// S2; PS-A4 sections 3 and 4; owner decision
// DEC-20261117-S2-AUTHENTICATION-PROTECTION-UNAVAILABLE-BEHAVIOR).
//
// Provider-neutral and injectable. Each request hands the use case its own
// control, built server-side for one purpose. Before any provider call, a
// validated attempt is reserved: "allow" lets it proceed, "throttle" stops
// it, and an unavailable protection is classified as a configuration failure
// (settings missing or invalid) or a runtime failure (a decision that
// failed, timed out, or answered anything unknown). What an unavailable
// protection means is the owner's recorded decision, held here as two fixed
// policies:
// - sign-in: configuration -> refused; runtime -> permitted temporarily,
//   always reported, never treated as healthy;
// - recovery: configuration -> refused; runtime -> refused.
// Every unavailable outcome is reported through the control, which attempts
// the database audit and always writes one structured server log line.
//
// After a protected sign-in, the attempt's result is recorded: a failure is
// counted, and a success is judged. Either may be reported suspicious.
// Nothing here reads configuration, holds a key, digest, or credential, or
// keeps module-level mutable state, and no answer depends on whether an
// account exists.

import { isUuid } from "./professional-records.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const ABUSE_PURPOSES = Object.freeze(["sign_in", "recovery"] as const);
export type AbusePurpose = (typeof ABUSE_PURPOSES)[number];

export const PROTECTION_FAILURE_KINDS = Object.freeze([
  "configuration",
  "runtime",
] as const);
export type ProtectionFailureKind = (typeof PROTECTION_FAILURE_KINDS)[number];

// The outcome an unavailable protection applied to the attempt.
export type UnavailableOutcome = "refused" | "permitted";

// What a reservation decided for one validated attempt.
export type ReservationDecision =
  "allow" | "throttle" | "unavailable_configuration" | "unavailable_runtime";

// What recording one sign-in result answered.
export type SignInSignal = "recorded" | "suspicious" | "unavailable";

// How a suspicious sign-in was handled, for the security log line: a failed
// attempt needs no handling; after a success the account's other sessions
// were ended, or could not be shown to be ended.
export type SuspiciousLoginHandling =
  "failed_attempt" | "other_sessions_ended" | "other_sessions_not_ended";

// The request-scoped control for one purpose. reserve, recordFailure and
// recordSuccess take the validated email address as submitted (the control
// derives the opaque identity from it) and never throw; recordSuccess also
// takes the signed-in account's opaque Auth id. reportUnavailable and
// reportSuspicious write the reports and never throw.
export type AuthenticationAbuseControl = {
  readonly reserve: (email: string) => Promise<ReservationDecision>;
  readonly recordFailure: (email: string) => Promise<SignInSignal>;
  readonly recordSuccess: (
    email: string,
    accountId: string,
  ) => Promise<SignInSignal>;
  readonly reportUnavailable: (
    failure: ProtectionFailureKind,
    outcome: UnavailableOutcome,
  ) => Promise<void>;
  readonly reportSuspicious: (
    handling: SuspiciousLoginHandling,
  ) => Promise<void>;
};

// The owner's recorded unavailable behaviour, per purpose.
export type UnavailablePolicy = Readonly<
  Record<ProtectionFailureKind, UnavailableOutcome>
>;

export const SIGN_IN_UNAVAILABLE_POLICY: UnavailablePolicy = Object.freeze({
  configuration: "refused",
  runtime: "permitted",
});

export const RECOVERY_UNAVAILABLE_POLICY: UnavailablePolicy = Object.freeze({
  configuration: "refused",
  runtime: "refused",
});

// What protection allows for one attempt: "allow" (protected), "throttle",
// "refused" (unavailable, refused), or "permitted" (unavailable, permitted
// without protection).
export type AttemptProtection = "allow" | "throttle" | "refused" | "permitted";

// ---------------------------------------------------------------------------
// The privileged decision port and its answers (the database checks every
// bound again)
// ---------------------------------------------------------------------------

export type AbuseDigests = {
  readonly identity: string;
  readonly global: string;
};

export type AbuseLimits = {
  readonly identityMax: number;
  readonly identityWindowSeconds: number;
  readonly globalMax: number;
  readonly globalWindowSeconds: number;
};

export type ReserveAnswer = "allow" | "throttle" | "unknown";
export type SignalAnswer = "recorded" | "suspicious" | "unknown";
export type ReportAnswer = "recorded" | "already_recorded" | "unknown";

// The four decision functions, each one fixed database function. A port
// answers "unknown" for anything it cannot read strictly; it never throws.
export type AuthenticationAbusePort = {
  readonly reserve: (
    purpose: AbusePurpose,
    digests: AbuseDigests,
    limits: AbuseLimits,
  ) => Promise<ReserveAnswer>;
  readonly recordFailure: (
    digests: AbuseDigests,
    limits: AbuseLimits,
    threshold: number,
  ) => Promise<SignalAnswer>;
  readonly recordSuccess: (
    identityDigest: string,
    identityWindowSeconds: number,
    threshold: number,
    accountId: string,
  ) => Promise<SignalAnswer>;
  readonly reportUnavailable: (
    purpose: AbusePurpose,
    failure: ProtectionFailureKind,
  ) => Promise<ReportAnswer>;
};

const DIGEST = /^[0-9a-f]{64}$/;
// The window lengths the database accepts, in seconds.
export const WINDOW_SECONDS = Object.freeze([900, 3600, 86400] as const);
// The envelopes the database enforces again.
export const IDENTITY_MAX_CEILING = 1000;
export const GLOBAL_MAX_CEILING = 100_000;
export const SUSPICIOUS_THRESHOLD_CEILING = 1000;

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

export function isAbusePurpose(value: unknown): value is AbusePurpose {
  return ABUSE_PURPOSES.some((purpose) => purpose === value);
}

export function isProtectionFailureKind(
  value: unknown,
): value is ProtectionFailureKind {
  return PROTECTION_FAILURE_KINDS.some((kind) => kind === value);
}

export function isAbuseDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

export function isWindowSeconds(value: unknown): value is number {
  return WINDOW_SECONDS.some((seconds) => seconds === value);
}

export function isIdentityMaximum(value: unknown): value is number {
  return isIntegerIn(value, 1, IDENTITY_MAX_CEILING);
}

export function isGlobalMaximum(value: unknown): value is number {
  return isIntegerIn(value, 1, GLOBAL_MAX_CEILING);
}

export function isSuspiciousThreshold(value: unknown): value is number {
  return isIntegerIn(value, 1, SUSPICIOUS_THRESHOLD_CEILING);
}

// Two distinct, well-formed digests.
export function areAbuseDigests(value: AbuseDigests): boolean {
  return (
    isAbuseDigest(value.identity) &&
    isAbuseDigest(value.global) &&
    value.identity !== value.global
  );
}

export function areAbuseLimits(value: AbuseLimits): boolean {
  return (
    isIdentityMaximum(value.identityMax) &&
    isWindowSeconds(value.identityWindowSeconds) &&
    isGlobalMaximum(value.globalMax) &&
    isWindowSeconds(value.globalWindowSeconds)
  );
}

// An account id the database can resolve: an Auth user id is a UUID.
export function isAccountId(value: unknown): value is string {
  return isUuid(value);
}

export function reserveAnswerOf(data: unknown): ReserveAnswer {
  return data === "allow" || data === "throttle" ? data : "unknown";
}

export function signalAnswerOf(data: unknown): SignalAnswer {
  return data === "recorded" || data === "suspicious" ? data : "unknown";
}

export function reportAnswerOf(data: unknown): ReportAnswer {
  return data === "recorded" || data === "already_recorded" ? data : "unknown";
}

// ---------------------------------------------------------------------------
// Use-case helpers
// ---------------------------------------------------------------------------

const CONTROL_MEMBERS = Object.freeze([
  "reserve",
  "recordFailure",
  "recordSuccess",
  "reportUnavailable",
  "reportSuspicious",
]);

// The control a request handed in, or null when it is not a control.
export function abuseControlOf(
  value: unknown,
): AuthenticationAbuseControl | null {
  try {
    if (value === null || typeof value !== "object") {
      return null;
    }
    return CONTROL_MEMBERS.every(
      (member) =>
        typeof (value as Record<string, unknown>)[member] === "function",
    )
      ? (value as AuthenticationAbuseControl)
      : null;
  } catch {
    return null;
  }
}

// Reports one unavailable outcome. It never throws.
export async function reportProtectionUnavailable(
  control: AuthenticationAbuseControl,
  failure: ProtectionFailureKind,
  outcome: UnavailableOutcome,
): Promise<void> {
  try {
    await control.reportUnavailable(failure, outcome);
  } catch {
    // Reporting never changes an outcome.
  }
}

// Reports how one suspicious sign-in was handled. It never throws.
export async function reportSuspiciousLogin(
  control: AuthenticationAbuseControl,
  handling: SuspiciousLoginHandling,
): Promise<void> {
  try {
    await control.reportSuspicious(handling);
  } catch {
    // Reporting never changes an outcome.
  }
}

// Reserves one validated attempt before any provider call and applies the
// purpose's unavailable policy, reporting every unavailable outcome. Only an
// exact "allow" or "throttle" is a decision; any other answer, or a throw,
// is a runtime failure. A missing control is a wiring defect: the attempt is
// refused, and nothing can be reported.
export async function protectAttempt(
  value: unknown,
  email: string,
  policy: UnavailablePolicy,
): Promise<AttemptProtection> {
  const control = abuseControlOf(value);
  if (control === null) {
    return "refused";
  }
  let decision: unknown;
  try {
    decision = await control.reserve(email);
  } catch {
    decision = undefined;
  }
  if (decision === "allow" || decision === "throttle") {
    return decision;
  }
  const failure: ProtectionFailureKind =
    decision === "unavailable_configuration" ? "configuration" : "runtime";
  const outcome = policy[failure] === "permitted" ? "permitted" : "refused";
  await reportProtectionUnavailable(control, failure, outcome);
  return outcome;
}
