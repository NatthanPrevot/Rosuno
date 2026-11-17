// Existing-account sign-in and sign-out orchestration (P2-005).
//
// Provider-neutral and injectable: each request hands in its own provider
// port, built by the server action that owns the framework, provider, and
// cookie lifecycle. This module checks the submitted input, asks the provider,
// verifies the outcome against a fresh read of the request's stored session
// state and the trusted server session boundary over it, and reports a fixed
// result code. It keeps no credential beyond the call, holds no module-level
// mutable state, and never decides a profile, role, capability, or any
// business question: an authenticated session is only that.
//
// MVP-001 S2 (PS-A4 sections 3 and 4): every submission that passes
// validation is reserved through the request's authentication-abuse control
// before the provider is asked, whether or not the account exists. A
// throttled attempt gets one fixed result and reaches no provider. An
// unavailable protection follows the owner's recorded sign-in policy
// (configuration: refused; runtime: permitted, and reported). After a
// protected attempt, a rejection is counted, and a confirmed sign-in is
// judged; a suspicious sign-in ends the account's other sessions, keeping
// only the new one, and is reported. Neither changes the result.

import {
  abuseControlOf,
  protectAttempt,
  reportProtectionUnavailable,
  reportSuspiciousLogin,
  SIGN_IN_UNAVAILABLE_POLICY,
  type AuthenticationAbuseControl,
} from "./authentication-abuse-control.ts";
import {
  readFormFields,
  type FieldErrors,
  type FormFields,
  type Validation,
} from "./form-operation.ts";
import { resolveSession, type ServerSessionSource } from "./session.ts";

export type SignInCredentials = {
  readonly email: string;
  readonly password: string;
};

// What the provider reports for a password sign-in attempt. "rejected" means
// it refused the credentials and started no session; "unavailable" means it
// could not answer and started no session.
export type PasswordSignInOutcome = "accepted" | "rejected" | "unavailable";

// One verified read of a provider session. "none": the read succeeded and
// found no session. "session": it found one, named by the provider's opaque
// session id. "unreadable": the read failed. Any other answer, or a thrown
// read, is taken as unreadable: it proves nothing either way.
export type SessionRead =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "unreadable" };

// Request-scoped provider port. signOut resolves true only when the provider
// reports that it ended the current session.
//
// issuedSession reads what the request's own provider holds after its calls.
// That provider keeps its own changes in memory, so this shows which session
// it issued, never that the session was stored for the browser.
//
// storedSession and session read the request's stored session state afresh,
// through a provider that holds nothing of its own, so they see only what the
// request will hand back to the browser, including this request's updates.
// session is the trusted server boundary over that state, the one the next
// request reads; it reports a failed read as no identity, which is enough to
// deny and never enough to prove that a session ended. Neither proves that
// the response carrying those updates reached the browser: the next request
// shows what it did receive.
//
// abuseControl is the request's authentication-abuse control for sign-in.
// signOutOtherSessions resolves true only when the provider reports that it
// ended every other session of the signed-in account, keeping the current
// one; it is asked only after a confirmed sign-in judged suspicious.
export type AuthenticationProvider = {
  readonly signInWithPassword: (
    submitted: SignInCredentials,
  ) => Promise<PasswordSignInOutcome>;
  readonly signOut: () => Promise<boolean>;
  readonly signOutOtherSessions: () => Promise<boolean>;
  readonly issuedSession: () => Promise<SessionRead>;
  readonly storedSession: () => Promise<SessionRead>;
  readonly session: ServerSessionSource;
  readonly abuseControl: AuthenticationAbuseControl;
};

// Builds the provider for the current request, or reports null when the
// provider is not configured.
export type AuthenticationProviderSource =
  () => Promise<AuthenticationProvider | null>;

// "signed-in" and "signed-out" mean the request's stored session state was
// verified, read afresh, to hold exactly the issued session or none at all.
// They do not mean the browser received the response; the next request reads
// whatever it did receive through the trusted boundary. "throttled" means too
// many attempts were made for this address or in total; nothing was asked of
// the provider, and the result is the same whether or not an account exists.
export type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "rejected" }
  | { readonly status: "throttled" }
  | { readonly status: "unavailable" }
  | { readonly status: "uncertain" }
  | { readonly status: "signed-in" };

export type SignOutState =
  { readonly status: "signed-out" } | { readonly status: "failed" };

export const INITIAL_SIGN_IN_STATE: SignInState = Object.freeze({
  status: "idle",
});

const REJECTED: SignInState = Object.freeze({ status: "rejected" });
const THROTTLED: SignInState = Object.freeze({ status: "throttled" });
const UNAVAILABLE: SignInState = Object.freeze({ status: "unavailable" });
// Sign-in failed, and a session it may have started could not be shown to be
// gone: this browser may still be signed in.
const UNCERTAIN: SignInState = Object.freeze({ status: "uncertain" });
const SIGNED_IN: SignInState = Object.freeze({ status: "signed-in" });
const SIGNED_OUT: SignOutState = Object.freeze({ status: "signed-out" });
const SIGN_OUT_FAILED: SignOutState = Object.freeze({ status: "failed" });

// Bounds that only reject malformed submissions. They are not a password
// rule: the provider alone decides whether credentials are accepted.
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 1024;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

// Reads the submitted string fields. Anything other than form data is an
// empty submission.
function fieldsOf(payload: unknown): FormFields {
  return payload instanceof FormData ? readFormFields(payload) : new Map();
}

// Only the email and password fields are read. Any other field, such as a
// destination, role, or identifier, is ignored.
export function validateSignIn(
  fields: FormFields,
): Validation<SignInCredentials> {
  const read = (name: string): string => fields.get(name) ?? "";
  const email = read("email").trim();
  const password = read("password");
  const emailErrors: string[] = [];
  const passwordErrors: string[] = [];
  if (email === "") {
    emailErrors.push("Enter your email address.");
  } else if (email.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(email)) {
    emailErrors.push("Enter a valid email address.");
  }
  if (password === "") {
    passwordErrors.push("Enter your password.");
  } else if (password.length > PASSWORD_MAX_LENGTH) {
    passwordErrors.push("Enter a valid password.");
  }
  const failed: Array<[string, readonly string[]]> = [];
  if (emailErrors.length > 0) {
    failed.push(["email", Object.freeze(emailErrors)]);
  }
  if (passwordErrors.length > 0) {
    failed.push(["password", Object.freeze(passwordErrors)]);
  }
  if (failed.length > 0) {
    return {
      ok: false,
      fieldErrors: Object.freeze(Object.fromEntries(failed)),
    };
  }
  return { ok: true, value: Object.freeze({ email, password }) };
}

async function providerFrom(
  source: AuthenticationProviderSource,
): Promise<AuthenticationProvider | null> {
  try {
    const provider = await source();
    return provider !== null && typeof provider === "object" ? provider : null;
  } catch {
    return null;
  }
}

// Whether the trusted server boundary reports an authenticated request, or
// null when the read fails, so a failed read is never taken as either answer.
async function isAuthenticated(
  provider: AuthenticationProvider,
): Promise<boolean | null> {
  try {
    const session = await resolveSession(provider.session);
    return session.status === "authenticated";
  } catch {
    return null;
  }
}

// What one session read proves: the id of the session it found, null when it
// found none, or undefined when it failed, threw, or answered anything other
// than a well-formed read, so it is never taken as either answer.
async function sessionIdOf(
  read: () => Promise<SessionRead>,
): Promise<string | null | undefined> {
  let kind: unknown;
  let id: unknown;
  try {
    const result: unknown = await read();
    if (result === null || typeof result !== "object") {
      return undefined;
    }
    ({ kind, id } = result as {
      readonly kind?: unknown;
      readonly id?: unknown;
    });
  } catch {
    return undefined;
  }
  if (kind === "none" && id === undefined) {
    return null;
  }
  if (kind === "session" && typeof id === "string" && id.trim() !== "") {
    return id;
  }
  return undefined;
}

// Whether the request's stored state is confirmed to hold no session: a
// fresh read succeeds and finds none, and the trusted boundary over that
// state agrees. A read that fails, throws, or finds any session is not a
// confirmation, so a session left behind always shows. What the request's
// own provider now holds is never consulted: it may have dropped a session
// that is still stored.
async function isConfirmedAnonymous(
  provider: AuthenticationProvider,
): Promise<boolean> {
  return (
    (await sessionIdOf(() => provider.storedSession())) === null &&
    (await isAuthenticated(provider)) === false
  );
}

// Whether the request's stored state is confirmed to hold the very session
// this sign-in issued: the provider names the session it issued, a fresh
// read of the stored state finds that same session, and the trusted boundary
// over that state reports an authenticated request. A session that was
// stored before, or any other session, is a different session and never
// confirms a new sign-in. The provider's own copy of its session is never
// taken as proof that it was stored.
async function isConfirmedSignIn(
  provider: AuthenticationProvider,
): Promise<boolean> {
  const issued = await sessionIdOf(() => provider.issuedSession());
  if (typeof issued !== "string") {
    return false;
  }
  return (
    (await sessionIdOf(() => provider.storedSession())) === issued &&
    (await isAuthenticated(provider)) === true
  );
}

// "cleared": the provider ended the session and its absence is confirmed.
// "failed": the provider did not confirm that it ended the session.
// "unverified": the provider reported success, but absence is not confirmed.
type CleanupOutcome = "cleared" | "failed" | "unverified";

// Ends whatever session the provider may have started and reports whether
// it is confirmed gone.
async function discardSession(
  provider: AuthenticationProvider,
): Promise<CleanupOutcome> {
  let ended: unknown;
  try {
    ended = await provider.signOut();
  } catch {
    return "failed";
  }
  if (ended !== true) {
    return "failed";
  }
  return (await isConfirmedAnonymous(provider)) ? "cleared" : "unverified";
}

// The request's abuse control as handed in; a read that throws gives nothing.
function abuseControlIn(provider: AuthenticationProvider): unknown {
  try {
    return provider.abuseControl;
  } catch {
    return null;
  }
}

// The opaque account id the trusted server boundary reports for the stored
// state, or null when the read fails or finds no authenticated request.
async function signedInAccountOf(
  provider: AuthenticationProvider,
): Promise<string | null> {
  try {
    const session = await resolveSession(provider.session);
    return session.status === "authenticated" ? session.subject : null;
  } catch {
    return null;
  }
}

// Whether the provider reports that it ended the account's other sessions.
async function endOtherSessions(
  provider: AuthenticationProvider,
): Promise<boolean> {
  try {
    return (await provider.signOutOtherSessions()) === true;
  } catch {
    return false;
  }
}

// Counts a protected attempt the provider rejected. A count that fails is a
// runtime protection failure: the attempt stays rejected, and it is reported.
async function recordRejection(
  provider: AuthenticationProvider,
  email: string,
): Promise<void> {
  const control = abuseControlOf(abuseControlIn(provider));
  if (control === null) {
    return;
  }
  let signal: unknown;
  try {
    signal = await control.recordFailure(email);
  } catch {
    signal = undefined;
  }
  if (signal === "suspicious") {
    await reportSuspiciousLogin(control, "failed_attempt");
  } else if (signal !== "recorded") {
    await reportProtectionUnavailable(control, "runtime", "permitted");
  }
}

// Judges a protected, confirmed sign-in. A suspicious one ends the account's
// other sessions, keeping the one just issued, and is reported. A judgement
// that cannot be made is a runtime protection failure, and it is reported.
// The sign-in stands either way.
async function judgeSignIn(
  provider: AuthenticationProvider,
  email: string,
): Promise<void> {
  const control = abuseControlOf(abuseControlIn(provider));
  if (control === null) {
    return;
  }
  const account = await signedInAccountOf(provider);
  let signal: unknown;
  if (account !== null) {
    try {
      signal = await control.recordSuccess(email, account);
    } catch {
      signal = undefined;
    }
  }
  if (signal === "suspicious") {
    await reportSuspiciousLogin(
      control,
      (await endOtherSessions(provider))
        ? "other_sessions_ended"
        : "other_sessions_not_ended",
    );
  } else if (signal !== "recorded") {
    await reportProtectionUnavailable(control, "runtime", "permitted");
  }
}

// The failure result after an attempt that may have started a session: plain
// unavailability only when that session is confirmed gone.
async function failAfterPossibleSession(
  provider: AuthenticationProvider,
): Promise<SignInState> {
  return (await discardSession(provider)) === "cleared"
    ? UNAVAILABLE
    : UNCERTAIN;
}

export async function signInExistingAccount(
  source: AuthenticationProviderSource,
  payload: unknown,
): Promise<SignInState> {
  const validation = validateSignIn(fieldsOf(payload));
  if (!validation.ok) {
    return Object.freeze({
      status: "invalid",
      fieldErrors: validation.fieldErrors,
    });
  }
  const provider = await providerFrom(source);
  if (provider === null) {
    return UNAVAILABLE;
  }
  const { email } = validation.value;
  const protection = await protectAttempt(
    abuseControlIn(provider),
    email,
    SIGN_IN_UNAVAILABLE_POLICY,
  );
  if (protection === "throttle") {
    return THROTTLED;
  }
  if (protection === "refused") {
    return UNAVAILABLE;
  }
  let outcome: unknown;
  try {
    outcome = await provider.signInWithPassword(validation.value);
  } catch {
    // The provider's state is unknown, so any session it started is ended.
    return failAfterPossibleSession(provider);
  }
  if (outcome === "rejected") {
    if (protection === "allow") {
      await recordRejection(provider, email);
    }
    return REJECTED;
  }
  if (outcome === "unavailable") {
    return UNAVAILABLE;
  }
  // Acceptance is reported only once the stored state is verified to hold
  // the session the provider issued.
  if (outcome === "accepted" && (await isConfirmedSignIn(provider))) {
    if (protection === "allow") {
      await judgeSignIn(provider, email);
    }
    return SIGNED_IN;
  }
  return failAfterPossibleSession(provider);
}

export async function signOutCurrentSession(
  source: AuthenticationProviderSource,
): Promise<SignOutState> {
  const provider = await providerFrom(source);
  if (provider === null) {
    return SIGN_OUT_FAILED;
  }
  let ended: unknown;
  try {
    ended = await provider.signOut();
  } catch {
    return SIGN_OUT_FAILED;
  }
  if (ended !== true) {
    return SIGN_OUT_FAILED;
  }
  // Success is reported only when the stored state is confirmed to hold no
  // session; the provider's word, its own emptied copy, or a read that fails
  // is not proof of sign-out.
  return (await isConfirmedAnonymous(provider)) ? SIGNED_OUT : SIGN_OUT_FAILED;
}
