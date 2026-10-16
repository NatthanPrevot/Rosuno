// Existing-account sign-in and sign-out orchestration (P2-005).
//
// Provider-neutral and injectable: each request hands in its own provider
// port, built by the server action that owns the framework, provider, and
// cookie lifecycle. This module checks the submitted input, asks the provider,
// verifies the outcome through the trusted server session boundary, and
// reports a fixed result code. It keeps no credential beyond the call, holds
// no module-level mutable state, and never decides a profile, role,
// capability, or any business question: an authenticated session is only
// that.

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

// Request-scoped provider port. signOut resolves true only when the provider
// reports that it ended the current session. session reads the request's
// verified identity through the trusted server boundary, which reports a
// failed read as no identity: enough to deny, never enough to prove that a
// session ended. confirmNoSession resolves true only when a successful read
// of the request's provider session finds none; a failed or unreadable read
// is never a confirmation.
export type AuthenticationProvider = {
  readonly signInWithPassword: (
    submitted: SignInCredentials,
  ) => Promise<PasswordSignInOutcome>;
  readonly signOut: () => Promise<boolean>;
  readonly session: ServerSessionSource;
  readonly confirmNoSession: () => Promise<boolean>;
};

// Builds the provider for the current request, or reports null when the
// provider is not configured.
export type AuthenticationProviderSource =
  () => Promise<AuthenticationProvider | null>;

export type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "rejected" }
  | { readonly status: "unavailable" }
  | { readonly status: "uncertain" }
  | { readonly status: "signed-in" };

export type SignOutState =
  { readonly status: "signed-out" } | { readonly status: "failed" };

export const INITIAL_SIGN_IN_STATE: SignInState = Object.freeze({
  status: "idle",
});

const REJECTED: SignInState = Object.freeze({ status: "rejected" });
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

// Whether the request is confirmed to hold no session: a successful provider
// read finds none and the trusted boundary agrees. A read that fails, throws,
// or reports anything other than true is not a confirmation.
async function isConfirmedAnonymous(
  provider: AuthenticationProvider,
): Promise<boolean> {
  let confirmed: unknown;
  try {
    confirmed = await provider.confirmNoSession();
  } catch {
    return false;
  }
  return confirmed === true && (await isAuthenticated(provider)) === false;
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
  let outcome: unknown;
  try {
    outcome = await provider.signInWithPassword(validation.value);
  } catch {
    // The provider's state is unknown, so any session it started is ended.
    return failAfterPossibleSession(provider);
  }
  if (outcome === "rejected") {
    return REJECTED;
  }
  if (outcome === "unavailable") {
    return UNAVAILABLE;
  }
  // Acceptance is reported only once the trusted boundary verifies it.
  if (outcome === "accepted" && (await isAuthenticated(provider)) === true) {
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
  // Success is reported only when the session is confirmed gone; a read that
  // fails is not proof of sign-out.
  return (await isConfirmedAnonymous(provider)) ? SIGNED_OUT : SIGN_OUT_FAILED;
}
