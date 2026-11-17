// Server-only Supabase Auth adapter for session assurance and authenticator
// app (TOTP) factors (MVP-001 S2).
//
// Every port works through the request's own, unprivileged server client
// (cookie session, publishable key); no privileged credential or client is
// seen here and nothing is cached between requests. The assurance read takes
// the access token of the request's stored session and asks Auth for its
// assurance level with that token, which Auth verifies, and lists the
// account's factors, which Auth reads afresh; a new client is built for each
// read, so a read made after a code is verified sees the upgraded session.
// The factor port works on one client per request, so a verified code's
// upgraded session is stored through the request's own cookies. The
// principal reads are own-row reads under the database's row policies.
//
// Every call answers within its deadline, and anything that fails, throws,
// or is too slow is reported as unreadable or unavailable, never as success.
// A failed call writes one log line naming only the operation, a fixed
// outcome, and the error's class, code, and HTTP status: never a code, a
// setup key or link, a token, or a factor or challenge id. The provider's
// picture of the setup link is dropped and never handed on.

import type {
  AssuranceRead,
  PrincipalReads,
  SessionAssuranceSource,
  StepUpSources,
} from "../../application/session-assurance.ts";
import {
  STEP_UP_ATTORNEY_COLUMNS,
  STEP_UP_STAFF_COLUMNS,
} from "../../application/session-assurance.ts";
import {
  rowsResultOf,
  USER_COLUMNS,
  withinDeadline,
} from "../../application/professional-identity.ts";
import type {
  AuthenticatorFactors,
  AuthenticatorSources,
  ChallengeAnswer,
  EnrollmentAnswer,
  FactorsRead,
  RemovalAnswer,
  VerifyAnswer,
} from "../../application/totp-step-up.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "./server-session-source.ts";

const CALL_FAILED = "auth_mfa.call_failed";

// The issuer name an authenticator app shows beside the account.
const TOTP_ISSUER = "Rosuno";

const UNREADABLE_ASSURANCE: AssuranceRead = Object.freeze({
  kind: "unreadable",
});
const UNREADABLE_FACTORS: FactorsRead = Object.freeze({ kind: "unreadable" });
const ENROLLMENT_UNAVAILABLE: EnrollmentAnswer = Object.freeze({
  kind: "unavailable",
});
const CHALLENGE_UNAVAILABLE: ChallengeAnswer = Object.freeze({
  kind: "unavailable",
});
const CHALLENGE_RATE_LIMITED: ChallengeAnswer = Object.freeze({
  kind: "rate-limited",
});
const REMOVED: RemovalAnswer = Object.freeze({ kind: "removed" });
const REMOVAL_UNAVAILABLE: RemovalAnswer = Object.freeze({
  kind: "unavailable",
});

const VERIFY_ANSWERS: Readonly<Record<VerifyAnswer["kind"], VerifyAnswer>> =
  Object.freeze({
    verified: Object.freeze({ kind: "verified" }),
    "wrong-code": Object.freeze({ kind: "wrong-code" }),
    expired: Object.freeze({ kind: "expired" }),
    "rate-limited": Object.freeze({ kind: "rate-limited" }),
    refused: Object.freeze({ kind: "refused" }),
    unavailable: Object.freeze({ kind: "unavailable" }),
    unknown: Object.freeze({ kind: "unknown" }),
  });

const EXPIRED = Symbol("expired");

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// What a log line may say about a provider answer's error.
function failureOf(result: unknown): LogFields {
  return { outcome: "error", ...errorFieldsOf(ownField(result, "error")) };
}

// Runs one provider call within the deadline. A call that throws or is too
// slow writes one log line and answers undefined.
async function settle<T>(
  operation: string,
  work: () => Promise<T>,
  deadlineMs: number,
): Promise<T | undefined> {
  const settled = await withinDeadline<
    { readonly answer: T } | { readonly failure: LogFields } | typeof EXPIRED
  >(
    async () => {
      try {
        return { answer: await work() };
      } catch (error) {
        return { failure: { outcome: "threw", ...errorFieldsOf(error) } };
      }
    },
    EXPIRED,
    deadlineMs,
  );
  if (settled === EXPIRED) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      outcome: "deadline",
    });
    return undefined;
  }
  if ("failure" in settled) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...settled.failure,
    });
    return undefined;
  }
  return settled.answer;
}

// A provider answer whose error is null, or undefined after writing one log
// line for its error.
async function succeeded(
  operation: string,
  result: unknown,
): Promise<unknown | undefined> {
  if (result === undefined) {
    return undefined;
  }
  if (ownField(result, "error") !== null) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...failureOf(result),
    });
    return undefined;
  }
  return ownField(result, "data");
}

// The account's verified TOTP factors as listFactors reported them.
function verifiedTotpCountOf(data: unknown): number | null {
  const totp = ownField(data, "totp");
  if (!Array.isArray(totp)) {
    return null;
  }
  let count = 0;
  for (const factor of totp as readonly unknown[]) {
    if (
      ownField(factor, "factor_type") !== "totp" ||
      ownField(factor, "status") !== "verified"
    ) {
      return null;
    }
    count += 1;
  }
  return count;
}

export function createSessionAssuranceSource(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): SessionAssuranceSource {
  checkDeadline(deadlineMs);
  const read = async (): Promise<AssuranceRead> => {
    const client = await settle("requestClient", clientSource, deadlineMs);
    if (client === undefined || client === null) {
      return UNREADABLE_ASSURANCE;
    }
    const stored = await succeeded(
      "getSession",
      await settle("getSession", () => client.auth.getSession(), deadlineMs),
    );
    const accessJwt = ownField(ownField(stored, "session"), "access_token");
    if (typeof accessJwt !== "string" || accessJwt === "") {
      return UNREADABLE_ASSURANCE;
    }
    const level = await succeeded(
      "getAuthenticatorAssuranceLevel",
      await settle(
        "getAuthenticatorAssuranceLevel",
        () => client.auth.mfa.getAuthenticatorAssuranceLevel(accessJwt),
        deadlineMs,
      ),
    );
    const factors = await succeeded(
      "listFactors",
      await settle(
        "listFactors",
        () => client.auth.mfa.listFactors(),
        deadlineMs,
      ),
    );
    const verified = verifiedTotpCountOf(factors);
    if (!isRecord(level) || verified === null) {
      return UNREADABLE_ASSURANCE;
    }
    return Object.freeze({
      kind: "assurance",
      currentLevel: ownField(level, "currentLevel"),
      verifiedTotpFactors: verified,
    });
  };
  return Object.freeze({ currentAssurance: read });
}

// One verify answer as the provider reported it.
export function verifyAnswerOf(result: unknown): VerifyAnswer {
  if (result === undefined) {
    return VERIFY_ANSWERS.unknown;
  }
  const error = ownField(result, "error");
  if (error === null) {
    const data = ownField(result, "data");
    return typeof ownField(data, "access_token") === "string"
      ? VERIFY_ANSWERS.verified
      : VERIFY_ANSWERS.unknown;
  }
  const code = ownField(error, "code");
  const status = ownField(error, "status");
  if (
    code === "mfa_verification_failed" ||
    code === "mfa_verification_rejected"
  ) {
    return VERIFY_ANSWERS["wrong-code"];
  }
  if (code === "mfa_challenge_expired") {
    return VERIFY_ANSWERS.expired;
  }
  if (code === "over_request_rate_limit" || status === 429) {
    return VERIFY_ANSWERS["rate-limited"];
  }
  if (typeof status === "number" && status >= 400 && status <= 499) {
    return VERIFY_ANSWERS.refused;
  }
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return VERIFY_ANSWERS.unavailable;
  }
  return VERIFY_ANSWERS.unknown;
}

// The factor port over one request-scoped client: each call is one fixed
// Auth MFA call with exactly its named arguments.
export function createAuthenticatorFactors(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AuthenticatorFactors | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await settle("requestClient", clientSource, deadlineMs);
    if (client === undefined || client === null) {
      return null;
    }
    return Object.freeze({
      listFactors: async () => {
        const data = await succeeded(
          "listFactors",
          await settle(
            "listFactors",
            () => client.auth.mfa.listFactors(),
            deadlineMs,
          ),
        );
        const all = ownField(data, "all");
        if (!Array.isArray(all)) {
          return UNREADABLE_FACTORS;
        }
        return Object.freeze({
          kind: "factors",
          factors: Object.freeze(
            (all as readonly unknown[]).map((factor) =>
              Object.freeze({
                id: ownField(factor, "id"),
                factorType: ownField(factor, "factor_type"),
                status: ownField(factor, "status"),
              }),
            ),
          ),
        });
      },
      unenroll: async (factorId: string) => {
        const data = await succeeded(
          "unenroll",
          await settle(
            "unenroll",
            () => client.auth.mfa.unenroll({ factorId }),
            deadlineMs,
          ),
        );
        return isRecord(data) ? REMOVED : REMOVAL_UNAVAILABLE;
      },
      enrollTotp: async () => {
        const data = await succeeded(
          "enroll",
          await settle(
            "enroll",
            () =>
              client.auth.mfa.enroll({
                factorType: "totp",
                issuer: TOTP_ISSUER,
              }),
            deadlineMs,
          ),
        );
        const totp = ownField(data, "totp");
        if (ownField(data, "type") !== "totp" || !isRecord(totp)) {
          return ENROLLMENT_UNAVAILABLE;
        }
        const key = ownField(totp, "secret");
        return Object.freeze({
          kind: "enrolled",
          factorId: ownField(data, "id"),
          secret: key,
          uri: ownField(totp, "uri"),
        });
      },
      challenge: async (factorId: string) => {
        const result = await settle(
          "challenge",
          () => client.auth.mfa.challenge({ factorId }),
          deadlineMs,
        );
        if (result === undefined) {
          return CHALLENGE_UNAVAILABLE;
        }
        const error = ownField(result, "error");
        if (error !== null) {
          await logRequestEvent("warn", CALL_FAILED, {
            operation: "challenge",
            ...failureOf(result),
          });
          return ownField(error, "status") === 429 ||
            ownField(error, "code") === "over_request_rate_limit"
            ? CHALLENGE_RATE_LIMITED
            : CHALLENGE_UNAVAILABLE;
        }
        const data = ownField(result, "data");
        const type = ownField(data, "type");
        return isRecord(data) && (type === "totp" || type === undefined)
          ? Object.freeze({
              kind: "challenge",
              challengeId: ownField(data, "id"),
            })
          : CHALLENGE_UNAVAILABLE;
      },
      verify: async (factorId: string, challengeId: string, code: string) => {
        const result = await settle(
          "verify",
          () => client.auth.mfa.verify({ factorId, challengeId, code }),
          deadlineMs,
        );
        const answer = verifyAnswerOf(result);
        if (result !== undefined && answer.kind !== "verified") {
          await logRequestEvent("warn", CALL_FAILED, {
            operation: "verify",
            ...errorFieldsOf(ownField(result, "error")),
            outcome: answer.kind,
          });
        }
        return answer;
      },
    } satisfies AuthenticatorFactors);
  };
}

// The principal's own-row reads over one request-scoped client.
export function createStepUpPrincipalReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<PrincipalReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        usersOf: async (accountId: string) =>
          rowsResultOf(
            await client
              .from("users")
              .select(USER_COLUMNS)
              .eq("auth_user_id", accountId)
              .limit(2),
          ),
        staffProfilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("staff_profiles")
              .select(STEP_UP_STAFF_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        attorneyProfilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("attorney_profiles")
              .select(STEP_UP_ATTORNEY_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
      } satisfies PrincipalReads,
      deadlineMs,
    );
  };
}

// The trusted wiring of the step-up gate for one request.
export const STEP_UP_SOURCES: StepUpSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  account: createRequestAccountSource(),
  principals: createStepUpPrincipalReads(),
  assurance: createSessionAssuranceSource(),
});

// The trusted wiring of the authenticator setup and step-up for one request.
export const AUTHENTICATOR_SOURCES: AuthenticatorSources = Object.freeze({
  ...STEP_UP_SOURCES,
  factors: createAuthenticatorFactors(),
});
