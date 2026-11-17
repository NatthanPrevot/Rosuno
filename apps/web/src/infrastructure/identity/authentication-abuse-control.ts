// Server-only authentication-abuse control (MVP-001 S2; PS-A4 sections 3
// and 4; owner decision
// DEC-20261117-S2-AUTHENTICATION-PROTECTION-UNAVAILABLE-BEHAVIOR).
//
// A request-scoped control for one purpose, sign-in or recovery. For one
// validated email address it derives two opaque, domain-separated
// HMAC-SHA-256 digests with the server-only key: the identity (the address
// trimmed and lower-cased, so other casing or outer whitespace is the same
// identity) and the purpose's global label (an empty value). Only those
// digests and the validated operational settings reach the privileged
// decision port, built in the one module that reads the privileged
// credential.
//
// Settings, read through the provider configuration reader (nothing is
// defaulted, and a placeholder is refused):
// - ROSUNO_AUTH_ABUSE_HMAC_SECRET: exactly 32 bytes as canonical padded
//   Base64, shared by both purposes;
// - per purpose, ROSUNO_AUTH_ABUSE_<PURPOSE>_IDENTITY_MAX (1 to 1,000),
//   ..._GLOBAL_MAX (1 to 100,000), and ..._IDENTITY_WINDOW_SECONDS and
//   ..._GLOBAL_WINDOW_SECONDS (900, 3600 or 86400);
// - for sign-in, ROSUNO_AUTH_ABUSE_SIGN_IN_SUSPICIOUS_FAILURES (1 to 1,000,
//   and at most the identity maximum, or it could never be reached).
// A missing or invalid setting, or no verified privileged binding, is a
// configuration failure. A decision that fails, passes its deadline, or
// answers anything but its own outcomes is a runtime failure.
//
// Reports: an unavailable outcome first asks the database to record its
// audit event, then always writes one structured security error line
// (security.protection_unavailable: purpose, failure kind, outcome applied,
// the request's correlation id, and audit persistence, "persisted" only when
// the database answered that the event is recorded). A suspicious sign-in
// writes one security.suspicious_login warning line with how it was handled.
// Neither the email address, a digest, the key, an account id, nor any
// provider payload is logged or returned.

import { createHmac } from "node:crypto";

import {
  areAbuseLimits,
  isProtectionFailureKind,
  isSuspiciousThreshold,
  type AbuseDigests,
  type AbuseLimits,
  type AbusePurpose,
  type AuthenticationAbuseControl,
  type AuthenticationAbusePort,
  type ProtectionFailureKind,
  type ReservationDecision,
  type SignInSignal,
  type SuspiciousLoginHandling,
  type UnavailableOutcome,
} from "../../application/authentication-abuse-control.ts";
import {
  readProviderConfiguration,
  type ProviderSetting,
} from "../environment/provider-configuration.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import { createAuthenticationAbusePort } from "./registration-provisioning.ts";

type Environment = Readonly<Record<string, string | undefined>>;

type SettingNames = {
  readonly identityMax: string;
  readonly identityWindowSeconds: string;
  readonly globalMax: string;
  readonly globalWindowSeconds: string;
  readonly threshold: string | null;
};

export const AUTH_ABUSE_KEY_SETTING = "ROSUNO_AUTH_ABUSE_HMAC_SECRET";

export const AUTH_ABUSE_SETTING_NAMES: Readonly<
  Record<AbusePurpose, SettingNames>
> = Object.freeze({
  sign_in: Object.freeze({
    identityMax: "ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_MAX",
    identityWindowSeconds: "ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_WINDOW_SECONDS",
    globalMax: "ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_MAX",
    globalWindowSeconds: "ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_WINDOW_SECONDS",
    threshold: "ROSUNO_AUTH_ABUSE_SIGN_IN_SUSPICIOUS_FAILURES",
  }),
  recovery: Object.freeze({
    identityMax: "ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_MAX",
    identityWindowSeconds: "ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_WINDOW_SECONDS",
    globalMax: "ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_MAX",
    globalWindowSeconds: "ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_WINDOW_SECONDS",
    threshold: null,
  }),
});

// Exactly 32 bytes as canonical padded Base64.
const KEY_TEXT = /^[A-Za-z0-9+/]{43}=$/;
const KEY_BYTES = 32;
// Canonical base-10 positive integers with no sign, whitespace, or leading
// zero; the numeric envelopes are checked after reading.
const MAXIMUM_TEXT = /^[1-9][0-9]{0,5}$/;
const THRESHOLD_TEXT = /^[1-9][0-9]{0,3}$/;
const WINDOW_TEXT = /^(?:900|3600|86400)$/;

const DIGEST_DOMAIN = "authentication-abuse/v1";

// The control gives up on any decision or report after this long; the port's
// own calls are aborted earlier, at 2,000 ms.
const DECISION_DEADLINE_MS = 2500;

function settingsOf(purpose: AbusePurpose): readonly ProviderSetting[] {
  const names = AUTH_ABUSE_SETTING_NAMES[purpose];
  return Object.freeze([
    Object.freeze({ name: AUTH_ABUSE_KEY_SETTING, pattern: KEY_TEXT }),
    Object.freeze({ name: names.identityMax, pattern: MAXIMUM_TEXT }),
    Object.freeze({ name: names.identityWindowSeconds, pattern: WINDOW_TEXT }),
    Object.freeze({ name: names.globalMax, pattern: MAXIMUM_TEXT }),
    Object.freeze({ name: names.globalWindowSeconds, pattern: WINDOW_TEXT }),
    ...(names.threshold === null
      ? []
      : [Object.freeze({ name: names.threshold, pattern: THRESHOLD_TEXT })]),
  ]);
}

type AbuseSettings = {
  readonly key: Buffer;
  readonly limits: AbuseLimits;
  readonly threshold: number | null;
};

function keyOf(value: unknown): Buffer | null {
  if (typeof value !== "string" || !KEY_TEXT.test(value)) {
    return null;
  }
  const key = Buffer.from(value, "base64");
  return key.length === KEY_BYTES && key.toString("base64") === value
    ? key
    : null;
}

// Every setting of the purpose, present and valid, or null. Out of range is
// refused, never clamped.
function readSettings(
  purpose: AbusePurpose,
  environment: Environment | undefined,
): AbuseSettings | null {
  const names = AUTH_ABUSE_SETTING_NAMES[purpose];
  const configuration =
    environment === undefined
      ? readProviderConfiguration(settingsOf(purpose))
      : readProviderConfiguration(settingsOf(purpose), environment);
  if (configuration.kind !== "configured") {
    return null;
  }
  const values = configuration.values;
  const key = keyOf(values[AUTH_ABUSE_KEY_SETTING]);
  const limits: AbuseLimits = Object.freeze({
    identityMax: Number(values[names.identityMax]),
    identityWindowSeconds: Number(values[names.identityWindowSeconds]),
    globalMax: Number(values[names.globalMax]),
    globalWindowSeconds: Number(values[names.globalWindowSeconds]),
  });
  const threshold =
    names.threshold === null ? null : Number(values[names.threshold]);
  if (
    key === null ||
    !areAbuseLimits(limits) ||
    (threshold !== null &&
      (!isSuspiciousThreshold(threshold) || threshold > limits.identityMax))
  ) {
    return null;
  }
  return Object.freeze({ key, limits, threshold });
}

// One lowercase hexadecimal HMAC-SHA-256 digest of a value labelled with its
// purpose and dimension.
function digestOf(
  key: Buffer,
  purpose: AbusePurpose,
  dimension: "identity" | "global",
  value: string,
): string {
  return createHmac("sha256", key)
    .update(`${DIGEST_DOMAIN}\u0000${purpose}\u0000${dimension}\u0000`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

// The identity and global digests of one validated address, or null when
// the address is not usable text.
function digestsOf(
  key: Buffer,
  purpose: AbusePurpose,
  email: unknown,
): AbuseDigests | null {
  if (typeof email !== "string" || !email.isWellFormed()) {
    return null;
  }
  const identity = email.trim().toLowerCase();
  if (identity === "") {
    return null;
  }
  return Object.freeze({
    identity: digestOf(key, purpose, "identity", identity),
    global: digestOf(key, purpose, "global", ""),
  });
}

// The call's answer, or the fallback once the deadline passes or the call
// throws.
async function withinDeadline<T>(
  call: () => Promise<T>,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), DECISION_DEADLINE_MS);
  });
  try {
    return await Promise.race([call(), expired]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export type AuthenticationAbuseControlOptions = {
  // The server environment to read; the process environment when omitted.
  readonly environment?: Environment;
  // The privileged decision port; the verified project binding's when
  // omitted.
  readonly port?: () => Promise<AuthenticationAbusePort | null>;
};

export function createAuthenticationAbuseControl(
  purpose: AbusePurpose,
  options: AuthenticationAbuseControlOptions = {},
): AuthenticationAbuseControl {
  const portSource = options.port ?? (() => createAuthenticationAbusePort());
  // The request's one port, built when first needed.
  let portPromise: Promise<AuthenticationAbusePort | null> | undefined;
  const portOf = async (): Promise<AuthenticationAbusePort | null> => {
    portPromise ??= withinDeadline(portSource, null);
    const port = await portPromise;
    return port !== null && typeof port === "object" ? port : null;
  };

  const reserve = async (email: string): Promise<ReservationDecision> => {
    const settings = readSettings(purpose, options.environment);
    if (settings === null) {
      return "unavailable_configuration";
    }
    const port = await portOf();
    if (port === null) {
      return "unavailable_configuration";
    }
    const digests = digestsOf(settings.key, purpose, email);
    if (digests === null) {
      return "unavailable_runtime";
    }
    const answer = await withinDeadline<unknown>(
      () => port.reserve(purpose, digests, settings.limits),
      undefined,
    );
    return answer === "allow" || answer === "throttle"
      ? answer
      : "unavailable_runtime";
  };

  const recordFailure = async (email: string): Promise<SignInSignal> => {
    const settings = readSettings(purpose, options.environment);
    const port = settings === null ? null : await portOf();
    const digests =
      settings === null ? null : digestsOf(settings.key, purpose, email);
    if (
      purpose !== "sign_in" ||
      settings === null ||
      settings.threshold === null ||
      port === null ||
      digests === null
    ) {
      return "unavailable";
    }
    const threshold = settings.threshold;
    const answer = await withinDeadline<unknown>(
      () => port.recordFailure(digests, settings.limits, threshold),
      undefined,
    );
    return answer === "recorded" || answer === "suspicious"
      ? answer
      : "unavailable";
  };

  const recordSuccess = async (
    email: string,
    accountId: string,
  ): Promise<SignInSignal> => {
    const settings = readSettings(purpose, options.environment);
    const port = settings === null ? null : await portOf();
    const digests =
      settings === null ? null : digestsOf(settings.key, purpose, email);
    if (
      purpose !== "sign_in" ||
      settings === null ||
      settings.threshold === null ||
      port === null ||
      digests === null
    ) {
      return "unavailable";
    }
    const threshold = settings.threshold;
    const answer = await withinDeadline<unknown>(
      () =>
        port.recordSuccess(
          digests.identity,
          settings.limits.identityWindowSeconds,
          threshold,
          accountId,
        ),
      undefined,
    );
    return answer === "recorded" || answer === "suspicious"
      ? answer
      : "unavailable";
  };

  const reportUnavailable = async (
    failure: ProtectionFailureKind,
    outcome: UnavailableOutcome,
  ): Promise<void> => {
    let persisted = false;
    try {
      const port = isProtectionFailureKind(failure) ? await portOf() : null;
      if (port !== null) {
        const answer = await withinDeadline<unknown>(
          () => port.reportUnavailable(purpose, failure),
          undefined,
        );
        persisted = answer === "recorded" || answer === "already_recorded";
      }
    } catch {
      persisted = false;
    }
    await logRequestEvent("error", "security.protection_unavailable", {
      purpose,
      failureKind: failure,
      outcome,
      auditPersistence: persisted ? "persisted" : "not_persisted",
    });
  };

  const reportSuspicious = async (
    handling: SuspiciousLoginHandling,
  ): Promise<void> => {
    await logRequestEvent("warn", "security.suspicious_login", {
      purpose,
      outcome: handling,
    });
  };

  // No member ever throws: anything unexpected is a runtime failure.
  return Object.freeze({
    reserve: async (email: string) => {
      try {
        return await reserve(email);
      } catch {
        return "unavailable_runtime";
      }
    },
    recordFailure: async (email: string) => {
      try {
        return await recordFailure(email);
      } catch {
        return "unavailable";
      }
    },
    recordSuccess: async (email: string, accountId: string) => {
      try {
        return await recordSuccess(email, accountId);
      } catch {
        return "unavailable";
      }
    },
    reportUnavailable: async (
      failure: ProtectionFailureKind,
      outcome: UnavailableOutcome,
    ) => {
      try {
        await reportUnavailable(failure, outcome);
      } catch {
        // Reporting never changes an outcome.
      }
    },
    reportSuspicious: async (handling: SuspiciousLoginHandling) => {
      try {
        await reportSuspicious(handling);
      } catch {
        // Reporting never changes an outcome.
      }
    },
  } satisfies AuthenticationAbuseControl);
}
