// Server-only registration provisioning (P2-006), attorney-applicant
// provisioning (P3-002), professional setup and staff verification
// provisioning (P3-003), and quota decision (P2-007).
//
// The only module that reads the privileged project credential. For each
// request it builds a separate, cookie-free Supabase client that is used for
// nothing but Admin creation and rereads of one unconfirmed account and the
// bounded User and Client-profile operations of that account's registration.
// Another such client is used for nothing but the bounded User and Attorney
// Profile reads of an already verified account's attorney application. Two
// more serve only the fixed, exact-key reads of the attorney professional
// setup and the staff verification workspace; neither offers a generic
// query, a write, a removal, or an Admin operation. No privileged client
// writes an attorney profile, professional record, evidence row, evaluation,
// or audit event (P3-904): those changes are made only by the database's own
// operation-specific functions, called through the request's own
// authenticated session, so a privileged credential can never stand in for
// an attorney's or a reviewer's current authority.
// Another makes only the one fixed registration quota decision call, and
// another only the three fixed operational job worker calls (MVP-001 S2:
// claim, complete, and fail; no enqueue, read, or other write). Another makes
// only the four fixed authentication-abuse decision calls (MVP-001 S2,
// PS-A4: reserve, record a failure, record a success, and report an
// unavailable protection; no table read or write). Another (MVP-001 S3)
// only stores new bytes at, and signs, the one opaque path it derives from a
// resource id in the one private bucket. Another (MVP-001 S3 part 2) makes
// only the one fixed AI suggestion recording call for the verified client's
// own Intake (PS section 13), so no browser can forge a suggestion; it reads
// and writes no table. Another (MVP-001 S7) makes only the three fixed
// payment recording calls of the worker and the webhook route (the payment
// job context, a provider call's result, and one authenticated provider
// event); it reads and writes no table. Another (MVP-001 S9) makes only the
// three fixed media recording calls of the worker and the Daily webhook route
// (the media job context, a provider call's result, and one authenticated
// media event); it reads and writes no table. Another (MVP-001 S10) makes
// only the three fixed notification recording calls of the worker and the
// Resend webhook route (the notification job context, which answers the
// recipient's address read at send time, a provider call's result, and one
// authenticated provider event); it reads and writes no table. A further
// client, built from
// the publishable key alone and never given the privileged credential, only
// requests signup confirmation emails. No client receives a request cookie or
// Authorization header, stores or refreshes a session, or reaches
// presentation code, and neither the credential nor a client is exported.
// Each is built only after the environment's project binding is verified;
// anything missing, malformed, or unbound reports null or nothing before any
// client exists, so nothing privileged runs.

import { createClient } from "@supabase/supabase-js";

import {
  isRecordInput,
  recordAnswerOf,
  UNKNOWN_RECORD,
  type SuggestionRecorder,
} from "../../application/ai-suggestion.ts";
import type { AttorneyApplicationRecords } from "../../application/attorney-application.ts";
import type { AttorneyProfessionalProvisioning } from "../../application/attorney-professional.ts";
import {
  areAbuseDigests,
  areAbuseLimits,
  isAbuseDigest,
  isAbusePurpose,
  isAccountId,
  isProtectionFailureKind,
  isSuspiciousThreshold,
  isWindowSeconds,
  reportAnswerOf,
  reserveAnswerOf,
  signalAnswerOf,
  type AuthenticationAbusePort,
} from "../../application/authentication-abuse-control.ts";
import type {
  AccountCreation,
  AccountRead,
  ConfirmationDispatch,
  RegistrationProvisioning,
  RowsResult,
} from "../../application/client-registration.ts";
import {
  claimAnswerOf,
  completeAnswerOf,
  failAnswerOf,
  isClaimLimit,
  isJobErrorCode,
  isJobErrorMessage,
  isLeaseSeconds,
  isWorkerId,
  UNKNOWN_CLAIM,
  type JobWorkerPort,
} from "../../application/job-worker.ts";
import {
  isMediaObservation,
  isProviderCode,
  mediaEventAnswerOf,
  mediaRecordOutcomeOf,
  type MediaEventAnswer,
  type MediaRecorder,
} from "../../application/media-provider.ts";
import {
  isDeliveryAttempt,
  isNotificationEvent,
  isProviderCode as isNotificationProviderCode,
  notificationEventAnswerOf,
  recordOutcomeOf as notificationRecordOutcomeOf,
  type NotificationEventAnswer,
  type NotificationRecorder,
} from "../../application/notifications.ts";
import {
  eventAnswerOf,
  isObservation,
  isProviderReference,
  recordOutcomeOf,
  type EventAnswer,
  type PaymentRecorder,
} from "../../application/payments.ts";
import {
  AUTHORITY_REFERENCE_COLUMNS,
  ELIGIBILITY_POLICY_TYPE,
  POLICY_VERSION_COLUMNS,
} from "../../application/policy-selection.ts";
import {
  DISCIPLINE_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  isUuid,
  JURISDICTION_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS as ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS,
  subjectColumnOf,
  type SubjectKind,
} from "../../application/professional-records.ts";
import {
  isStoredType,
  objectPathOf,
  PROTECTED_BUCKET,
  RESOURCE_BYTE_CEILING,
  SIGNED_URL_SECONDS,
  type ProtectedStorage,
} from "../../application/protected-resources.ts";
import type { StaffProvisioning } from "../../application/staff-verification.ts";

// The five server runtime inputs this module reads, and nothing else. The URL
// and publishable key are the ones the request-scoped session client already
// uses; the expected project reference, the privileged key, and the
// environment class setting (PS-A2; MVP-001 D-9) are server-only and are
// never read from a request, form, header, or cookie.
export type RegistrationEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL: string | undefined;
  readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string | undefined;
  readonly ROSUNO_SUPABASE_ADMIN_KEY: string | undefined;
  readonly ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: string | undefined;
  readonly ROSUNO_ENVIRONMENT_CLASS?: string | undefined;
};

type ClientFactory = typeof createClient;

type ProjectBinding = {
  readonly url: string;
  readonly publishableKey: string;
  readonly adminKey: string;
};

function runtimeEnvironment(): RegistrationEnvironment {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ROSUNO_SUPABASE_ADMIN_KEY: process.env.ROSUNO_SUPABASE_ADMIN_KEY,
    ROSUNO_SUPABASE_EXPECTED_PROJECT_REF:
      process.env.ROSUNO_SUPABASE_EXPECTED_PROJECT_REF,
    ROSUNO_ENVIRONMENT_CLASS: process.env.ROSUNO_ENVIRONMENT_CLASS,
  };
}

const PROJECT_REF = /^[a-z]{20}$/;
// Visible ASCII only: a key with whitespace or anything else is malformed.
const KEY_TEXT = /^[\x21-\x7e]+$/;

// Neither client keeps, refreshes, or looks for a session anywhere. Each
// client gets its own copy of these options.
function clientOptions() {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
}

// Whether a key can be bound to this project for this purpose: a current key
// carrying the purpose's prefix, or a legacy JWT key whose payload names this
// exact project and role. Any other shape cannot be bound and is refused.
function isKeyFor(
  key: unknown,
  projectRef: string,
  role: string,
  prefix: string,
): key is string {
  if (typeof key !== "string" || !KEY_TEXT.test(key)) {
    return false;
  }
  if (key.startsWith(prefix)) {
    return key.length > prefix.length;
  }
  const parts = key.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return (
      payload !== null &&
      typeof payload === "object" &&
      (payload as { readonly ref?: unknown }).ref === projectRef &&
      (payload as { readonly role?: unknown }).role === role
    );
  } catch {
    return false;
  }
}

// MVP-001 D-9: the local Supabase stack's loopback API origins. A local
// binding exists only when the environment class setting is exactly
// "development" and no hosted project reference is configured.
const LOCAL_ORIGINS = Object.freeze([
  "http://127.0.0.1:54321",
  "http://localhost:54321",
]);

// Whether a key belongs to the local stack for this purpose: a current key
// carrying the purpose's prefix, or a legacy local demo JWT for exactly this
// role that names no project. Any other shape is refused.
function isLocalKeyFor(
  key: unknown,
  role: string,
  prefix: string,
): key is string {
  if (typeof key !== "string" || !KEY_TEXT.test(key)) {
    return false;
  }
  if (key.startsWith(prefix)) {
    return key.length > prefix.length;
  }
  const parts = key.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      !Object.hasOwn(payload, "ref") &&
      (payload as { readonly iss?: unknown }).iss === "supabase-demo" &&
      (payload as { readonly role?: unknown }).role === role
    );
  } catch {
    return false;
  }
}

// The verified binding of the inputs to the local development stack, or
// null: exactly one loopback origin (no other host, scheme, port, path,
// query, or fragment), two distinct keys of the local stack, and no hosted
// project reference.
function readLocalBinding(
  environment: RegistrationEnvironment,
): ProjectBinding | null {
  if (environment.ROSUNO_SUPABASE_EXPECTED_PROJECT_REF !== undefined) {
    return null;
  }
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const origin = LOCAL_ORIGINS.find(
    (candidate) => url === candidate || url === `${candidate}/`,
  );
  if (origin === undefined) {
    return null;
  }
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const adminKey = environment.ROSUNO_SUPABASE_ADMIN_KEY;
  if (
    !isLocalKeyFor(publishableKey, "anon", "sb_publishable_") ||
    !isLocalKeyFor(adminKey, "service_role", "sb_secret_") ||
    adminKey === publishableKey
  ) {
    return null;
  }
  return Object.freeze({ url: origin, publishableKey, adminKey });
}

// The verified binding of all inputs to the one expected project, or null.
// With the environment class setting "development" only the local binding
// above can exist, and a hosted project is never bound. For every other
// setting, including none, the URL must be exactly the expected project's
// managed HTTPS origin: no other host, scheme, port, credentials, path,
// query, or fragment, and no fallback, default project, or inference from
// the request.
function readProjectBinding(
  environment: RegistrationEnvironment,
): ProjectBinding | null {
  if (environment.ROSUNO_ENVIRONMENT_CLASS === "development") {
    return readLocalBinding(environment);
  }
  const projectRef = environment.ROSUNO_SUPABASE_EXPECTED_PROJECT_REF;
  if (typeof projectRef !== "string" || !PROJECT_REF.test(projectRef)) {
    return null;
  }
  const origin = `https://${projectRef}.supabase.co`;
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  if (url !== origin && url !== `${origin}/`) {
    return null;
  }
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const adminKey = environment.ROSUNO_SUPABASE_ADMIN_KEY;
  if (
    !isKeyFor(publishableKey, projectRef, "anon", "sb_publishable_") ||
    !isKeyFor(adminKey, projectRef, "service_role", "sb_secret_") ||
    adminKey === publishableKey
  ) {
    return null;
  }
  return Object.freeze({ url: origin, publishableKey, adminKey });
}

const REJECTED: AccountCreation = Object.freeze({ kind: "rejected" });
const UNKNOWN: AccountCreation = Object.freeze({ kind: "unknown" });
const UNREADABLE_ACCOUNT: AccountRead = Object.freeze({ kind: "unreadable" });
const UNREADABLE_ROWS: RowsResult = Object.freeze({ kind: "unreadable" });

const USER_COLUMNS = "id, auth_user_id, account_state";
const PROFILE_COLUMNS = "id, user_id";

type ProviderUser = {
  readonly id?: unknown;
  readonly email?: unknown;
  readonly email_confirmed_at?: unknown;
} | null;

function accountRecordOf(user: ProviderUser) {
  return Object.freeze({
    id: user?.id,
    email: user?.email,
    emailConfirmedAt: user?.email_confirmed_at,
  });
}

function rowsResultOf(result: {
  readonly data: unknown;
  readonly error: unknown;
}): RowsResult {
  return result.error === null && Array.isArray(result.data)
    ? Object.freeze({ kind: "rows", rows: Object.freeze([...result.data]) })
    : UNREADABLE_ROWS;
}

export async function createRegistrationProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<RegistrationProvisioning | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    // email_confirm stays false: the account is unconfirmed, no email is sent
    // by creation, and no session is started. Only a definite client error
    // means nothing was created; anything else leaves the outcome unknown.
    createAccount: async ({ email, password }) => {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: false,
      });
      if (error !== null) {
        return typeof error.status === "number" &&
          error.status >= 400 &&
          error.status < 500
          ? REJECTED
          : UNKNOWN;
      }
      return data.user === null
        ? UNKNOWN
        : Object.freeze({
            kind: "created",
            account: accountRecordOf(data.user),
          });
    },
    readAccount: async (accountId) => {
      const { data, error } = await admin.auth.admin.getUserById(accountId);
      return error !== null || data.user === null
        ? UNREADABLE_ACCOUNT
        : Object.freeze({
            kind: "account",
            account: accountRecordOf(data.user),
          });
    },
    usersOf: async (accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .select(USER_COLUMNS)
          .eq("auth_user_id", accountId)
          .limit(2),
      ),
    insertPendingUser: async (accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .insert({
            auth_user_id: accountId,
            account_state: "pending_verification",
          })
          .select(USER_COLUMNS),
      ),
    clientProfilesOf: async (userId) =>
      rowsResultOf(
        await admin
          .from("client_profiles")
          .select(PROFILE_COLUMNS)
          .eq("user_id", userId)
          .limit(2),
      ),
    insertClientProfile: async (userId) =>
      rowsResultOf(
        await admin
          .from("client_profiles")
          .insert({ user_id: userId })
          .select(PROFILE_COLUMNS),
      ),
    activatePendingUser: async (userId, accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .update({ account_state: "active" })
          .eq("id", userId)
          .eq("auth_user_id", accountId)
          .eq("account_state", "pending_verification")
          .select(USER_COLUMNS),
      ),
  } satisfies RegistrationProvisioning);
}

export async function createConfirmationDispatch(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<ConfirmationDispatch | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const publicClient = create(
    binding.url,
    binding.publishableKey,
    clientOptions(),
  );
  return Object.freeze({
    // The provider's normal signup confirmation for an existing unconfirmed
    // address, with no caller-chosen redirect.
    requestSignupConfirmation: async (email) => {
      const { error } = await publicClient.auth.resend({
        type: "signup",
        email,
      });
      return error === null;
    },
  } satisfies ConfirmationDispatch);
}

// Whether the environment holds a verified project binding, answered without
// building any client and without returning the binding or a credential. It
// lets a page refrain from offering an action that the privileged boundary
// would certainly refuse (P3-003 correction of the P3-002 entry limitation).
export function hasPrivilegedProjectBinding(
  environment: RegistrationEnvironment = runtimeEnvironment(),
): boolean {
  return readProjectBinding(environment) !== null;
}

// MVP-001 S7: the payment recording port (Packet S7 outbound reliability and
// webhooks; IMP section 23), through its own cookie-free privileged client.
// It makes only the three fixed service_role calls, each a literal call of
// one database function with exactly its named arguments, after checking
// every argument against the database's own bounds, under a deadline:
// payment_job_context (what a running payment job is to do), and
// payment_record_operation and payment_record_provider_event (a provider
// call's result, and one provider event whose signature the webhook route
// verified first). Each answer is read strictly; anything else, including a
// failed, refused, aborted, or thrown call, is unknown, so nothing is taken
// as recorded that the database did not answer. It decides nothing: the
// database owns every payment transition, ledger posting, receipt and
// exception.
const PAYMENT_CALL_DEADLINE_MS = 10_000;
const UNKNOWN_EVENT: EventAnswer = Object.freeze({ kind: "unknown" });
const EVENT_TYPE = /^[a-z][a-z0-9_.]{2,99}$/;
const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const PAYLOAD_DIGEST = /^sha256:[0-9a-f]{64}$/;
const EVENT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export async function createPaymentRecorder(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<PaymentRecorder | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jobContext: async (jobId) => {
      if (!isUuid(jobId)) {
        return null;
      }
      try {
        const { data, error } = await admin
          .rpc("payment_job_context", { p_job_id: jobId })
          .abortSignal(AbortSignal.timeout(PAYMENT_CALL_DEADLINE_MS));
        return error === null && Array.isArray(data)
          ? Object.freeze(data.slice())
          : null;
      } catch {
        return null;
      }
    },
    recordOperation: async (jobId, observation) => {
      if (!isUuid(jobId) || !isObservation(observation)) {
        return "unknown";
      }
      try {
        const { data, error } = await admin
          .rpc("payment_record_operation", {
            p_job_id: jobId,
            p_observation: observation,
          })
          .abortSignal(AbortSignal.timeout(PAYMENT_CALL_DEADLINE_MS));
        return error === null ? recordOutcomeOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    recordEvent: async (event) => {
      if (
        !PROVIDER_CODE.test(event.providerCode) ||
        !isProviderReference(event.eventReference) ||
        !EVENT_TYPE.test(event.eventType) ||
        !EVENT_TIME.test(event.occurredAt) ||
        !PAYLOAD_DIGEST.test(event.payloadDigest) ||
        !isObservation(event.observation)
      ) {
        return UNKNOWN_EVENT;
      }
      try {
        const { data, error } = await admin
          .rpc("payment_record_provider_event", {
            p_provider_code: event.providerCode,
            p_event_reference: event.eventReference,
            p_event_type: event.eventType,
            p_occurred_at: event.occurredAt,
            p_payload_digest: event.payloadDigest,
            p_observation: event.observation,
          })
          .abortSignal(AbortSignal.timeout(PAYMENT_CALL_DEADLINE_MS));
        return error === null ? eventAnswerOf(data) : UNKNOWN_EVENT;
      } catch {
        return UNKNOWN_EVENT;
      }
    },
  } satisfies PaymentRecorder);
}

// MVP-001 S9: the media recording port (Packet S9 Daily adapter, provider
// sessions and participation evidence; IMP section 23; TA section 53), through
// its own cookie-free privileged client. It makes only the three fixed
// service_role calls, each a literal call of one database function with
// exactly its named arguments, after checking every argument against the
// database's own bounds, under a deadline: media_job_context (what a running
// media job is to do), and media_record_operation and
// media_record_provider_event (a provider call's result, and one provider
// event whose signature the webhook route verified first). Each answer is
// read strictly; anything else, including a failed, refused, aborted, or
// thrown call, is unknown, so nothing is taken as recorded that the database
// did not answer. It decides nothing: the database owns every Media Room
// transition, provider session, participation record, receipt and exception,
// and never a Consultation state.
const MEDIA_CALL_DEADLINE_MS = 10_000;
const UNKNOWN_MEDIA_EVENT: MediaEventAnswer = Object.freeze({
  kind: "unknown",
});

export async function createMediaRecorder(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<MediaRecorder | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jobContext: async (jobId) => {
      if (!isUuid(jobId)) {
        return null;
      }
      try {
        const { data, error } = await admin
          .rpc("media_job_context", { p_job_id: jobId })
          .abortSignal(AbortSignal.timeout(MEDIA_CALL_DEADLINE_MS));
        return error === null && Array.isArray(data)
          ? Object.freeze(data.slice())
          : null;
      } catch {
        return null;
      }
    },
    recordOperation: async (jobId, providerCode, observation) => {
      if (
        !isUuid(jobId) ||
        !isProviderCode(providerCode) ||
        !isMediaObservation(observation)
      ) {
        return "unknown";
      }
      try {
        const { data, error } = await admin
          .rpc("media_record_operation", {
            p_job_id: jobId,
            p_provider_code: providerCode,
            p_observation: observation,
          })
          .abortSignal(AbortSignal.timeout(MEDIA_CALL_DEADLINE_MS));
        return error === null ? mediaRecordOutcomeOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    recordEvent: async (event) => {
      if (
        !isProviderCode(event.providerCode) ||
        !isProviderReference(event.eventReference) ||
        !EVENT_TYPE.test(event.eventType) ||
        !EVENT_TIME.test(event.occurredAt) ||
        !PAYLOAD_DIGEST.test(event.payloadDigest) ||
        !isMediaObservation(event.observation)
      ) {
        return UNKNOWN_MEDIA_EVENT;
      }
      try {
        const { data, error } = await admin
          .rpc("media_record_provider_event", {
            p_provider_code: event.providerCode,
            p_event_reference: event.eventReference,
            p_event_type: event.eventType,
            p_occurred_at: event.occurredAt,
            p_payload_digest: event.payloadDigest,
            p_observation: event.observation,
          })
          .abortSignal(AbortSignal.timeout(MEDIA_CALL_DEADLINE_MS));
        return error === null ? mediaEventAnswerOf(data) : UNKNOWN_MEDIA_EVENT;
      } catch {
        return UNKNOWN_MEDIA_EVENT;
      }
    },
  } satisfies MediaRecorder);
}

// MVP-001 S10: the notification recording port (Packet S10 "durable delivery
// attempts, retries, observations"; ROS section 15; IMP section 23), through
// its own cookie-free privileged client. It makes only the three fixed
// service_role calls, each a literal call of one database function with
// exactly its named arguments, after checking every argument against the
// database's own bounds, under a deadline: notification_job_context (what a
// running notification job is to do, with the recipient's address read at
// send time; the rows are handed only to the job handler, never logged),
// and notification_record_attempt and notification_record_provider_event (a
// provider call's result, and one provider event whose signature the webhook
// route verified first). Each answer is read strictly; anything else,
// including a failed, refused, aborted, or thrown call, is unknown, so
// nothing is taken as recorded that the database did not answer. It decides
// nothing: the database owns every Notification transition, attempt,
// receipt and exception, and never a business record.
const NOTIFICATION_CALL_DEADLINE_MS = 10_000;
const UNKNOWN_NOTIFICATION_EVENT: NotificationEventAnswer = Object.freeze({
  kind: "unknown",
});

export async function createNotificationRecorder(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<NotificationRecorder | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jobContext: async (jobId) => {
      if (!isUuid(jobId)) {
        return null;
      }
      try {
        const { data, error } = await admin
          .rpc("notification_job_context", { p_job_id: jobId })
          .abortSignal(AbortSignal.timeout(NOTIFICATION_CALL_DEADLINE_MS));
        return error === null && Array.isArray(data)
          ? Object.freeze(data.slice())
          : null;
      } catch {
        return null;
      }
    },
    recordAttempt: async (jobId, providerCode, attempt) => {
      if (
        !isUuid(jobId) ||
        !isNotificationProviderCode(providerCode) ||
        !isDeliveryAttempt(attempt)
      ) {
        return "unknown";
      }
      try {
        const { data, error } = await admin
          .rpc("notification_record_attempt", {
            p_job_id: jobId,
            p_provider_code: providerCode,
            p_result: attempt.result,
            p_provider_reference:
              attempt.result === "accepted" ? attempt.reference : null,
            p_failure_code:
              attempt.result === "accepted" ? null : attempt.failureCode,
          })
          .abortSignal(AbortSignal.timeout(NOTIFICATION_CALL_DEADLINE_MS));
        return error === null ? notificationRecordOutcomeOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    recordEvent: async (event) => {
      if (!isNotificationEvent(event)) {
        return UNKNOWN_NOTIFICATION_EVENT;
      }
      try {
        const { data, error } = await admin
          .rpc("notification_record_provider_event", {
            p_provider_code: event.providerCode,
            p_event_reference: event.eventReference,
            p_event_type: event.eventType,
            p_occurred_at: event.occurredAt,
            p_payload_digest: event.payloadDigest,
            p_observation: event.observation,
          })
          .abortSignal(AbortSignal.timeout(NOTIFICATION_CALL_DEADLINE_MS));
        return error === null
          ? notificationEventAnswerOf(data)
          : UNKNOWN_NOTIFICATION_EVENT;
      } catch {
        return UNKNOWN_NOTIFICATION_EVENT;
      }
    },
  } satisfies NotificationRecorder);
}

// MVP-001 S3 part 2 (PS section 13; TA section 30): the AI suggestion
// recording port, through its own cookie-free privileged client. It makes
// only the one fixed call of ai_record_intake_suggestion (service_role
// only), a literal call with exactly its named arguments, after checking
// every argument against the database's own bounds, under a deadline. The
// caller passes the verified client's User id and Intake, the revision the
// suggestion was generated from, one permitted suggestion, the model
// reference and the server's time of the provider answer; the database
// decides again and stores the suggestion as presented, with its audit
// event. Its answer is read strictly; anything else, including a failed,
// refused, aborted, or thrown call, is unknown, so nothing is presented that
// the database did not record.
const AI_RECORD_DEADLINE_MS = 5000;

export async function createAiSuggestionRecorder(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<SuggestionRecorder | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    record: async (input) => {
      try {
        if (!isRecordInput(input)) {
          return UNKNOWN_RECORD;
        }
        const { data, error } = await admin
          .rpc("ai_record_intake_suggestion", {
            p_user_id: input.userId,
            p_intake_id: input.intakeId,
            p_revision_number: input.revisionNumber,
            p_suggestion_type: input.type,
            p_suggestion_value: input.value,
            p_model_reference: input.modelReference,
            p_generated_at: input.generatedAt,
          })
          .abortSignal(AbortSignal.timeout(AI_RECORD_DEADLINE_MS));
        return error === null ? recordAnswerOf(data) : UNKNOWN_RECORD;
      } catch {
        return UNKNOWN_RECORD;
      }
    },
  } satisfies SuggestionRecorder);
}

// MVP-001 S3 (IMP section 13; PS section 29): the protected storage port,
// through its own cookie-free privileged client. It works only in the one
// private bucket and only at the one path it derives itself from a canonical
// resource id; it never receives a path, a bucket, or a file name:
// - store: new bytes of an allowed content type within the byte ceiling,
//   never replacing an existing object (no upsert);
// - signedUrl: one URL for that path, valid for SIGNED_URL_SECONDS, served
//   inline or as an attachment, returned only when it is exactly this
//   project's signed-object URL for that path.
// It offers no listing, reading, moving, copying, replacing, public URL, or
// removal. Authorization is never decided here: the database starts the
// resource first, and authorizes the caller before anything is signed
// (resource_authorize_access). The caller bounds each call in time.
const SIGNED_SUFFIX = /^[A-Za-z0-9._-]+(?:&download=)?$/;

export async function createProtectedStoragePort(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<ProtectedStorage | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    store: async (resourceId, bytes, type) => {
      try {
        const path = objectPathOf(resourceId);
        if (
          path === null ||
          !isStoredType(type) ||
          !(bytes instanceof Uint8Array) ||
          bytes.length < 1 ||
          bytes.length > RESOURCE_BYTE_CEILING
        ) {
          return false;
        }
        const { data, error } = await admin.storage
          .from(PROTECTED_BUCKET)
          .upload(path, bytes, {
            contentType: type,
            upsert: false,
            cacheControl: "0",
          });
        return error === null && data?.path === path;
      } catch {
        return false;
      }
    },
    signedUrl: async (resourceId, disposition) => {
      try {
        const path = objectPathOf(resourceId);
        if (
          path === null ||
          (disposition !== "inline" && disposition !== "attachment")
        ) {
          return null;
        }
        const { data, error } = await admin.storage
          .from(PROTECTED_BUCKET)
          .createSignedUrl(
            path,
            SIGNED_URL_SECONDS,
            disposition === "attachment" ? { download: true } : undefined,
          );
        const url = data?.signedUrl;
        const prefix = `${binding.url}/storage/v1/object/sign/${PROTECTED_BUCKET}/${path}?token=`;
        return error === null &&
          typeof url === "string" &&
          url.startsWith(prefix) &&
          SIGNED_SUFFIX.test(url.slice(prefix.length)) &&
          (disposition === "attachment") === url.endsWith("&download=")
          ? url
          : null;
      } catch {
        return null;
      }
    },
  } satisfies ProtectedStorage);
}

// MVP-001 S2 (PS-A4 section 3): the authentication-abuse decision port,
// through its own cookie-free privileged client. It makes only the four
// fixed decision calls, each a literal call of one database function with
// exactly its named arguments, after checking every argument against the
// database's own bounds, under a deadline. Each answer is read strictly
// against that function's own outcomes; anything else, including a failed,
// refused, aborted, or thrown call, is "unknown", so nothing is ever taken
// as decided or persisted that the database did not answer. Only opaque
// digests, validated operational settings, a purpose, a failure kind, and a
// signed-in account's Auth id are sent; the database owns the clock, the
// windows, the counts, and the audit events.
const ABUSE_CALL_DEADLINE_MS = 2000;

export async function createAuthenticationAbusePort(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<AuthenticationAbusePort | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    reserve: async (purpose, digests, limits) => {
      try {
        if (
          !isAbusePurpose(purpose) ||
          !areAbuseDigests(digests) ||
          !areAbuseLimits(limits)
        ) {
          return "unknown";
        }
        const { data, error } = await admin
          .rpc("authentication_abuse_reserve", {
            p_purpose: purpose,
            p_identity_digest: digests.identity,
            p_identity_max: limits.identityMax,
            p_identity_window_seconds: limits.identityWindowSeconds,
            p_global_digest: digests.global,
            p_global_max: limits.globalMax,
            p_global_window_seconds: limits.globalWindowSeconds,
          })
          .abortSignal(AbortSignal.timeout(ABUSE_CALL_DEADLINE_MS));
        return error === null ? reserveAnswerOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    recordFailure: async (digests, limits, threshold) => {
      try {
        if (
          !areAbuseDigests(digests) ||
          !areAbuseLimits(limits) ||
          !isSuspiciousThreshold(threshold)
        ) {
          return "unknown";
        }
        const { data, error } = await admin
          .rpc("authentication_abuse_record_failure", {
            p_identity_digest: digests.identity,
            p_identity_window_seconds: limits.identityWindowSeconds,
            p_global_digest: digests.global,
            p_global_window_seconds: limits.globalWindowSeconds,
            p_suspicious_threshold: threshold,
          })
          .abortSignal(AbortSignal.timeout(ABUSE_CALL_DEADLINE_MS));
        return error === null ? signalAnswerOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    recordSuccess: async (
      identityDigest,
      identityWindowSeconds,
      threshold,
      accountId,
    ) => {
      try {
        if (
          !isAbuseDigest(identityDigest) ||
          !isWindowSeconds(identityWindowSeconds) ||
          !isSuspiciousThreshold(threshold) ||
          !isAccountId(accountId)
        ) {
          return "unknown";
        }
        const { data, error } = await admin
          .rpc("authentication_abuse_record_success", {
            p_identity_digest: identityDigest,
            p_identity_window_seconds: identityWindowSeconds,
            p_suspicious_threshold: threshold,
            p_auth_user_id: accountId,
          })
          .abortSignal(AbortSignal.timeout(ABUSE_CALL_DEADLINE_MS));
        return error === null ? signalAnswerOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    reportUnavailable: async (purpose, failure) => {
      try {
        if (!isAbusePurpose(purpose) || !isProtectionFailureKind(failure)) {
          return "unknown";
        }
        const { data, error } = await admin
          .rpc("authentication_abuse_report_unavailable", {
            p_purpose: purpose,
            p_failure_kind: failure,
          })
          .abortSignal(AbortSignal.timeout(ABUSE_CALL_DEADLINE_MS));
        return error === null ? reportAnswerOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
  } satisfies AuthenticationAbusePort);
}

// MVP-001 S2: the operational job worker port (Packet S2 job architecture
// item 4), through its own cookie-free privileged client. It makes only the
// three fixed worker calls, each a literal call of one database function
// with exactly its named arguments, after checking every argument against
// the database's own bounds, under a deadline. Each answer is read strictly
// against that function's own outcomes; anything else, including a failed,
// refused, aborted, or thrown call, is "unknown", so nothing is ever
// reported as done that the database did not answer. The database derives
// every other value (lease, attempts, backoff, escalation, audit) itself.
const JOB_CALL_DEADLINE_MS = 10_000;

export async function createJobWorkerPort(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<JobWorkerPort | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    claim: async (workerId, leaseSeconds, limit) => {
      if (
        !isWorkerId(workerId) ||
        !isLeaseSeconds(leaseSeconds) ||
        !isClaimLimit(limit)
      ) {
        return UNKNOWN_CLAIM;
      }
      try {
        const { data, error } = await admin
          .rpc("job_claim", {
            p_worker: workerId,
            p_lease_seconds: leaseSeconds,
            p_limit: limit,
          })
          .abortSignal(AbortSignal.timeout(JOB_CALL_DEADLINE_MS));
        return error === null ? claimAnswerOf(data, limit) : UNKNOWN_CLAIM;
      } catch {
        return UNKNOWN_CLAIM;
      }
    },
    complete: async (jobId, workerId) => {
      if (!isUuid(jobId) || !isWorkerId(workerId)) {
        return "unknown";
      }
      try {
        const { data, error } = await admin
          .rpc("job_complete", {
            p_job_id: jobId,
            p_worker: workerId,
          })
          .abortSignal(AbortSignal.timeout(JOB_CALL_DEADLINE_MS));
        return error === null ? completeAnswerOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
    fail: async (jobId, workerId, errorCode, errorMessage) => {
      if (
        !isUuid(jobId) ||
        !isWorkerId(workerId) ||
        !isJobErrorCode(errorCode) ||
        !isJobErrorMessage(errorMessage)
      ) {
        return "unknown";
      }
      try {
        const { data, error } = await admin
          .rpc("job_fail", {
            p_job_id: jobId,
            p_worker: workerId,
            p_error_code: errorCode,
            p_error_message: errorMessage,
          })
          .abortSignal(AbortSignal.timeout(JOB_CALL_DEADLINE_MS));
        return error === null ? failAnswerOf(data) : "unknown";
      } catch {
        return "unknown";
      }
    },
  } satisfies JobWorkerPort);
}

// P3-003 professional read ports. Every list read is bounded and every id
// list is checked to hold only canonical ids before it reaches a filter. The
// caller derives each id from a verified server-side read; nothing here takes
// request input, decides authorization, or writes anything.
const MAX_IDS = 500;

function idListOf(ids: readonly string[]): readonly string[] | null {
  return ids.length > 0 && ids.length <= MAX_IDS && ids.every(isUuid)
    ? [...new Set(ids)]
    : null;
}

const EVIDENCE_FLAG_COLUMNS = "id, discrepancy_flag, retrieved_at";
const ATTORNEY_EVALUATION_COLUMNS =
  "id, jurisdiction_id, context_type, context_id, result, evaluated_at";

export async function createAttorneyProfessionalProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<AttorneyProfessionalProvisioning | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jurisdictions: async () =>
      rowsResultOf(
        await admin
          .from("jurisdictions")
          .select(JURISDICTION_COLUMNS)
          .order("code")
          .limit(MAX_IDS),
      ),
    evidenceSubjectsOf: async (kind: SubjectKind, recordIds) => {
      const ids = idListOf(recordIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      const column = subjectColumnOf(kind);
      return rowsResultOf(
        await admin
          .from("verification_evidence_subjects")
          .select(`verification_evidence_id, ${column}`)
          .in(column, ids)
          .limit(MAX_IDS),
      );
    },
    evidenceFlagsOf: async (evidenceIds) => {
      const ids = idListOf(evidenceIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("verification_evidence")
          .select(EVIDENCE_FLAG_COLUMNS)
          .in("id", ids)
          .limit(MAX_IDS),
      );
    },
    evaluationsOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("eligibility_evaluations")
          .select(ATTORNEY_EVALUATION_COLUMNS)
          .eq("attorney_id", attorneyId)
          .order("evaluated_at", { ascending: false })
          .limit(MAX_IDS),
      ),
    // The staff requests for more information about this applicant's own
    // profile, each recorded together with its return to the applicant stage.
    informationRequestsOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("audit_events")
          .select("id, occurred_at, action_code, after_snapshot")
          .eq("resource_type", "attorney_profile")
          .eq("resource_id", attorneyId)
          .eq("action_code", "attorney_information_requested")
          .order("occurred_at", { ascending: false })
          .limit(100),
      ),
  } satisfies AttorneyProfessionalProvisioning);
}

export async function createStaffVerificationProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<StaffProvisioning | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    jurisdictions: async () =>
      rowsResultOf(
        await admin
          .from("jurisdictions")
          .select(JURISDICTION_COLUMNS)
          .order("code")
          .limit(MAX_IDS),
      ),
    attorneyProfileOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .select(ATTORNEY_PROFESSIONAL_PROFILE_COLUMNS)
          .eq("id", attorneyId)
          .limit(2),
      ),
    accountStateOf: async (userId) =>
      rowsResultOf(
        await admin
          .from("users")
          .select("id, account_state")
          .eq("id", userId)
          .limit(2),
      ),
    // Each professional table is named literally; the privileged client
    // never receives a table chosen at run time.
    licensesIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("licenses")
          .select(LICENSE_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    insuranceIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("insurance_records")
          .select(INSURANCE_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    disciplineIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("discipline_records")
          .select(DISCIPLINE_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    authorisationsIn: async (attorneyId, jurisdictionId) =>
      rowsResultOf(
        await admin
          .from("practice_area_authorisations")
          .select(PRACTICE_AUTHORISATION_COLUMNS)
          .eq("attorney_id", attorneyId)
          .eq("jurisdiction_id", jurisdictionId)
          .limit(MAX_IDS),
      ),
    evidenceSubjectsOf: async (kind: SubjectKind, recordIds) => {
      const ids = idListOf(recordIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("verification_evidence_subjects")
          .select(EVIDENCE_SUBJECT_COLUMNS)
          .in(subjectColumnOf(kind), ids)
          .limit(MAX_IDS),
      );
    },
    evidenceOf: async (evidenceIds) => {
      const ids = idListOf(evidenceIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("verification_evidence")
          .select(EVIDENCE_COLUMNS)
          .in("id", ids)
          .limit(MAX_IDS),
      );
    },
    // Only the one eligibility policy type, for exactly one jurisdiction.
    policyVersionsFor: async (policyTypeCode, jurisdictionId) =>
      policyTypeCode !== ELIGIBILITY_POLICY_TYPE
        ? UNREADABLE_ROWS
        : rowsResultOf(
            await admin
              .from("policy_versions")
              .select(POLICY_VERSION_COLUMNS)
              .eq("policy_type_code", ELIGIBILITY_POLICY_TYPE)
              .eq("jurisdiction_id", jurisdictionId)
              .limit(50),
          ),
    authorityReferencesFor: async (versionIds) => {
      const ids = idListOf(versionIds);
      if (ids === null) {
        return UNREADABLE_ROWS;
      }
      return rowsResultOf(
        await admin
          .from("policy_authority_references")
          .select(AUTHORITY_REFERENCE_COLUMNS)
          .in("policy_version_id", ids)
          .limit(MAX_IDS),
      );
    },
    profileHistoryOf: async (attorneyId) =>
      rowsResultOf(
        await admin
          .from("audit_events")
          .select("occurred_at, action_code, after_snapshot")
          .eq("resource_type", "attorney_profile")
          .eq("resource_id", attorneyId)
          .order("occurred_at", { ascending: false })
          .limit(100),
      ),
  } satisfies StaffProvisioning);
}

const ATTORNEY_PROFILE_COLUMNS = "id, user_id, profile_state";

// Attorney-applicant reads (P3-002), through their own cookie-free privileged
// client: the User of exactly one Auth account id and the Attorney Profile of
// exactly one User id. No insert, update, removal, or Admin operation is
// offered; the one applicant-state creation is the database's own
// attorney_start_application function, called through the request's own
// session (P3-904). The caller derives every id from a verified server-side
// read; nothing here takes request input.
export async function createAttorneyApplicantProvisioning(
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<AttorneyApplicationRecords | null> {
  const binding = readProjectBinding(environment);
  if (binding === null) {
    return null;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  return Object.freeze({
    usersOf: async (accountId) =>
      rowsResultOf(
        await admin
          .from("users")
          .select(USER_COLUMNS)
          .eq("auth_user_id", accountId)
          .limit(2),
      ),
    attorneyProfilesOf: async (userId) =>
      rowsResultOf(
        await admin
          .from("attorney_profiles")
          .select(ATTORNEY_PROFILE_COLUMNS)
          .eq("user_id", userId)
          .limit(2),
      ),
  } satisfies AttorneyApplicationRecords);
}

// The opaque digests and validated deployment maxima of one quota decision.
type QuotaDigests = {
  readonly ip: string;
  readonly identity: string;
  readonly global: string;
};

type QuotaMaxima = {
  readonly ipPerHour: number;
  readonly identityPerDay: number;
  readonly globalPerHour: number;
};

const DIGEST = /^[0-9a-f]{64}$/;

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function isMaximum(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

// One registration quota decision (P2-007), made by the fixed
// registration_quota_decide database function through its own cookie-free
// privileged client. Only the three opaque digests and three validated
// maxima are sent, under the caller's abort signal; nothing else from the
// request reaches the call. It resolves the function's answer exactly as
// returned, or undefined when the binding or an argument is invalid or the
// call fails, is refused, or is aborted. The database bounds the maxima
// again and owns the clock and windows.
export async function decideQuotaRpc(
  digests: QuotaDigests,
  maxima: QuotaMaxima,
  signal: AbortSignal,
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<unknown> {
  const binding = readProjectBinding(environment);
  if (
    binding === null ||
    !isDigest(digests.ip) ||
    !isDigest(digests.identity) ||
    !isDigest(digests.global) ||
    !isMaximum(maxima.ipPerHour) ||
    !isMaximum(maxima.identityPerDay) ||
    !isMaximum(maxima.globalPerHour)
  ) {
    return undefined;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  const { data, error } = await admin
    .rpc("registration_quota_decide", {
      ip_digest: digests.ip,
      identity_digest: digests.identity,
      global_digest: digests.global,
      ip_max: maxima.ipPerHour,
      identity_max: maxima.identityPerDay,
      global_max: maxima.globalPerHour,
    })
    .abortSignal(signal);
  return error === null ? data : undefined;
}
