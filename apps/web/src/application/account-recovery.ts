// Existing-account password recovery orchestration (P2-008).
//
// Provider-neutral and injectable: each request hands in its own provider
// port, built by the server action that owns the framework, provider, and
// cookie lifecycle. A recovery request reads only one email address and asks
// the provider, once, to email a recovery link back to the one fixed recovery
// address. Every attempt that reaches the provider gets the same neutral
// result, so nothing reveals whether an account exists or claims that an
// email was sent. Completion validates the whole submission before the
// one-time code is used, exchanges that code for a session, sets the new
// password only through the session the exchange issued, then ends that
// session and confirms that none remains. Every result is a fixed code.
// Nothing here holds a credential beyond the call, keeps module-level mutable
// state, or grants authority: recovery signs no one in and decides no
// profile, role, capability, or any business question.

import type { FieldErrors, Validation } from "./form-operation.ts";
import { resolveSession, type ServerSessionSource } from "./session.ts";

// Request-scoped provider port. requestRecoveryEmail asks the provider to
// email a recovery link for this address, returning to the fixed recovery
// address. Its answer is never read: acceptance proves neither that an
// account exists nor that an email was delivered, and a refusal can reveal
// that one does.
export type RecoveryRequestProvider = {
  readonly requestRecoveryEmail: (email: string) => Promise<void>;
};

// Builds the provider for the current request, or reports null when the
// provider or the trusted recovery address is not configured.
export type RecoveryRequestProviderSource =
  () => Promise<RecoveryRequestProvider | null>;

// "submitted" is deliberately neutral: it is the result of every attempt
// that reached the provider, whatever the provider answered.
export type RecoveryRequestState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "unavailable" }
  | { readonly status: "submitted" };

// One verified read of a provider session. "none": the read succeeded and
// found no session. "session": it found one, named by the provider's opaque
// session id and subject. "unreadable": the read failed. Any other answer,
// or a thrown read, is taken as unreadable: it proves nothing either way.
export type RecoverySessionRead =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly id: string; readonly subject: string }
  | { readonly kind: "unreadable" };

// The provider's answer to one code exchange. "rejected": it refused the
// code and started no session. On "exchanged", userId and sessionUserId are
// the user and the issued session's user exactly as reported, and
// issuedSession reads the issued session through its own credential, which
// never leaves the port.
export type CodeExchange =
  | { readonly kind: "rejected" }
  | {
      readonly kind: "exchanged";
      readonly userId: unknown;
      readonly sessionUserId: unknown;
      readonly issuedSession: () => Promise<RecoverySessionRead>;
    };

// The provider's answer to one password update. "updated": it reports the
// password of userId changed. "refused": it refused and changed nothing.
// "unknown": the password may or may not have changed.
export type PasswordUpdate =
  | { readonly kind: "updated"; readonly userId: unknown }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

// Request-scoped provider port. exchangeCode is called at most once per
// attempt, only for a fully valid submission, and may store the session it
// issues for this browser. updatePassword changes the password of the
// account whose session the request's own client holds. signOut resolves
// true only when the provider reports that it ended the current browser's
// session; no other session is touched.
//
// heldSession reads what the request's own client holds now: the session an
// update uses. storedSession and session read the request's stored session
// state afresh, through a client that holds nothing of its own, so they see
// only what the request will hand back to the browser, including this
// request's updates; session is the trusted server boundary over that state.
// Neither proves that the response carrying those updates reached the
// browser.
export type RecoveryProvider = {
  readonly exchangeCode: (code: string) => Promise<CodeExchange>;
  readonly updatePassword: (password: string) => Promise<PasswordUpdate>;
  readonly signOut: () => Promise<boolean>;
  readonly heldSession: () => Promise<RecoverySessionRead>;
  readonly storedSession: () => Promise<RecoverySessionRead>;
  readonly session: ServerSessionSource;
};

// Builds the provider for the current request, or reports null when the
// provider is not configured.
export type RecoveryProviderSource = () => Promise<RecoveryProvider | null>;

// Completion results. Only "completed" says the password changed: the
// provider confirmed the update for the recovered account and the request's
// stored state is confirmed to hold no session. "invalid": the form needs
// attention and the code was not used. "unusable": the link is malformed, or
// the code was refused or could not be shown to recover one account; no
// password was changed and no session remains. "unavailable": nothing was
// attempted. "not-changed": the provider refused the new password and no
// session remains. "session-uncertain": no password was changed, but a
// session may remain. "uncertain": the password may have changed, and the
// outcome or the session's end could not be confirmed.
export type RecoveryCompletionState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "unusable" }
  | { readonly status: "unavailable" }
  | { readonly status: "not-changed" }
  | { readonly status: "session-uncertain" }
  | { readonly status: "uncertain" }
  | { readonly status: "completed" };

// The query of one request for the recovery address, as the framework
// reports it: a repeated key is an array.
export type RecoverySearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export const INITIAL_RECOVERY_REQUEST_STATE: RecoveryRequestState =
  Object.freeze({ status: "idle" });

export const INITIAL_RECOVERY_COMPLETION_STATE: RecoveryCompletionState =
  Object.freeze({ status: "idle" });

const REQUEST_UNAVAILABLE: RecoveryRequestState = Object.freeze({
  status: "unavailable",
});
const SUBMITTED: RecoveryRequestState = Object.freeze({ status: "submitted" });
const UNUSABLE: RecoveryCompletionState = Object.freeze({ status: "unusable" });
const COMPLETION_UNAVAILABLE: RecoveryCompletionState = Object.freeze({
  status: "unavailable",
});
const NOT_CHANGED: RecoveryCompletionState = Object.freeze({
  status: "not-changed",
});
const SESSION_UNCERTAIN: RecoveryCompletionState = Object.freeze({
  status: "session-uncertain",
});
const UNCERTAIN: RecoveryCompletionState = Object.freeze({
  status: "uncertain",
});
const COMPLETED: RecoveryCompletionState = Object.freeze({
  status: "completed",
});

// The one fixed path the provider's recovery link returns to.
const RECOVERY_PATH = "/reset-password";

// Bounds that only reject malformed submissions. They are not a password
// rule: no recovery password policy is decided here, so the provider alone
// decides whether a new password is accepted, and a password is never
// trimmed, normalized, or truncated. The code is opaque: only the provider
// decides whether it is valid.
const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const PASSWORD_MAX_LENGTH = 1024;
const CODE_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

// The fixed recovery address under the one server-trusted application
// origin, or null when the configured value is absent or not an exact
// http(s) origin. Nothing from the request ever takes part.
export function recoveryRedirectFor(configured: unknown): string | null {
  if (typeof configured !== "string") {
    return null;
  }
  try {
    const parsed = new URL(configured);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin === configured
      ? `${configured}${RECOVERY_PATH}`
      : null;
  } catch {
    return null;
  }
}

// The one-time code of a recovery link: exactly one well-formed code and
// nothing else. A missing, repeated, or malformed code, or any other value
// (a token, a type, an error report, or a destination), is null: such a
// link is never used, repaired, or forwarded.
export function recoveryCodeOf(query: unknown): string | null {
  try {
    if (query === null || typeof query !== "object") {
      return null;
    }
    const keys = Object.keys(query);
    const code: unknown = (query as RecoverySearchParams).code;
    return keys.length === 1 &&
      keys[0] === "code" &&
      typeof code === "string" &&
      CODE_SHAPE.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

// The one string value submitted for a field: "" when it is absent, or null
// when it is repeated or not text, which is never guessed at.
function fieldOf(payload: unknown, name: string): string | null {
  if (!(payload instanceof FormData)) {
    return "";
  }
  const values = payload.getAll(name);
  if (values.length === 0) {
    return "";
  }
  return values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : null;
}

function failedFields(
  entries: ReadonlyArray<readonly [string, readonly string[]]>,
): FieldErrors {
  return Object.freeze(
    Object.fromEntries(
      entries
        .filter(([, messages]) => messages.length > 0)
        .map(([name, messages]) => [name, Object.freeze([...messages])]),
    ),
  );
}

// Only the email field is read. Any other field, such as a destination,
// password, code, identifier, or role, is ignored and grants nothing. The
// email loses only its outer whitespace.
export function validateRecoveryRequest(
  payload: unknown,
): Validation<{ readonly email: string }> {
  const submitted = fieldOf(payload, "email");
  const email = submitted === null ? null : submitted.trim();
  const emailErrors: string[] = [];
  if (email === "") {
    emailErrors.push("Enter your email address.");
  } else if (
    email === null ||
    !email.isWellFormed() ||
    email.length > EMAIL_MAX_LENGTH ||
    !EMAIL_SHAPE.test(email)
  ) {
    emailErrors.push("Enter a valid email address.");
  }
  if (email === null || emailErrors.length > 0) {
    return { ok: false, fieldErrors: failedFields([["email", emailErrors]]) };
  }
  return { ok: true, value: Object.freeze({ email }) };
}

// Only the password and confirm_password fields are read. Both are kept
// exactly as submitted and compared code unit for code unit; the
// confirmation goes no further than that comparison.
export function validateNewPassword(
  payload: unknown,
): Validation<{ readonly password: string }> {
  const read = (name: string): string | null => fieldOf(payload, name);
  const password = read("password");
  const confirmation = read("confirm_password");
  const passwordErrors: string[] = [];
  const confirmationErrors: string[] = [];
  if (password === "") {
    passwordErrors.push("Enter a new password.");
  } else if (
    password === null ||
    !password.isWellFormed() ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    passwordErrors.push("Enter a valid password.");
  }
  if (confirmation === "" || confirmation === null) {
    confirmationErrors.push("Confirm your new password.");
  } else if (confirmation !== password) {
    confirmationErrors.push("The passwords don't match.");
  }
  if (
    password === null ||
    passwordErrors.length > 0 ||
    confirmationErrors.length > 0
  ) {
    return {
      ok: false,
      fieldErrors: failedFields([
        ["password", passwordErrors],
        ["confirm_password", confirmationErrors],
      ]),
    };
  }
  return { ok: true, value: Object.freeze({ password }) };
}

async function providerFrom<Provider>(
  source: () => Promise<Provider | null>,
): Promise<Provider | null> {
  try {
    const provider = await source();
    return provider !== null && typeof provider === "object" ? provider : null;
  } catch {
    return null;
  }
}

export async function requestAccountRecovery(
  source: RecoveryRequestProviderSource,
  payload: unknown,
): Promise<RecoveryRequestState> {
  const validation = validateRecoveryRequest(payload);
  if (!validation.ok) {
    return Object.freeze({
      status: "invalid",
      fieldErrors: validation.fieldErrors,
    });
  }
  const provider = await providerFrom(source);
  if (provider === null) {
    return REQUEST_UNAVAILABLE;
  }
  try {
    await provider.requestRecoveryEmail(validation.value.email);
  } catch {
    // The same neutral result, and never a retry: a provider failure can be
    // specific to an existing account.
  }
  return SUBMITTED;
}

type SessionIdentity = { readonly id: string; readonly subject: string };

function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// What one session read proves: the session it found, null when it found
// none, or undefined when it failed, threw, or answered anything other than
// a well-formed read, so it is never taken as either answer.
async function sessionIn(
  read: () => Promise<RecoverySessionRead>,
): Promise<SessionIdentity | null | undefined> {
  let kind: unknown;
  let id: unknown;
  let subject: unknown;
  try {
    const result: unknown = await read();
    if (result === null || typeof result !== "object") {
      return undefined;
    }
    ({ kind, id, subject } = result as {
      readonly kind?: unknown;
      readonly id?: unknown;
      readonly subject?: unknown;
    });
  } catch {
    return undefined;
  }
  if (kind === "none" && id === undefined && subject === undefined) {
    return null;
  }
  if (kind === "session" && isPresent(id) && isPresent(subject)) {
    return { id, subject };
  }
  return undefined;
}

// Whether the provider refused the code outright, which starts no session.
function isRejection(exchange: unknown): boolean {
  try {
    return (
      exchange !== null &&
      typeof exchange === "object" &&
      Object.keys(exchange).length === 1 &&
      (exchange as { readonly kind?: unknown }).kind === "rejected"
    );
  } catch {
    return false;
  }
}

// The account a code exchange recovered, or null. The exchange must name one
// user for itself and its session; a read of the issued session through its
// own credential must find a session of that user; and the request's own
// client must hold that very session, the one an update uses. A session
// stored before the exchange, of this account or another, is a different
// session and never stands in for it.
async function recoveredAccount(
  provider: RecoveryProvider,
  exchange: unknown,
): Promise<string | null> {
  let kind: unknown;
  let userId: unknown;
  let sessionUserId: unknown;
  let issuedSession: unknown;
  try {
    if (exchange === null || typeof exchange !== "object") {
      return null;
    }
    ({ kind, userId, sessionUserId, issuedSession } = exchange as {
      readonly kind?: unknown;
      readonly userId?: unknown;
      readonly sessionUserId?: unknown;
      readonly issuedSession?: unknown;
    });
  } catch {
    return null;
  }
  if (
    kind !== "exchanged" ||
    !isPresent(userId) ||
    sessionUserId !== userId ||
    typeof issuedSession !== "function"
  ) {
    return null;
  }
  const issued = await sessionIn(
    issuedSession as () => Promise<RecoverySessionRead>,
  );
  if (issued === null || issued === undefined || issued.subject !== userId) {
    return null;
  }
  const held = await sessionIn(() => provider.heldSession());
  return held !== null &&
    held !== undefined &&
    held.id === issued.id &&
    held.subject === userId
    ? userId
    : null;
}

// What one update answer proves: "updated" only for the recovered account,
// "refused" only for a plain refusal, and "unknown" for anything else.
function updateOutcomeOf(
  update: unknown,
  account: string,
): "updated" | "refused" | "unknown" {
  try {
    if (update === null || typeof update !== "object") {
      return "unknown";
    }
    const { kind, userId } = update as {
      readonly kind?: unknown;
      readonly userId?: unknown;
    };
    if (kind === "updated" && userId === account) {
      return "updated";
    }
    return kind === "refused" && Object.keys(update).length === 1
      ? "refused"
      : "unknown";
  } catch {
    return "unknown";
  }
}

// Whether the trusted server boundary reports an authenticated request, or
// null when the read fails, so a failed read is never taken as either answer.
async function isAuthenticated(
  provider: RecoveryProvider,
): Promise<boolean | null> {
  try {
    const session = await resolveSession(provider.session);
    return session.status === "authenticated";
  } catch {
    return null;
  }
}

// Ends the session this attempt may have stored and reports whether the
// request's stored state is confirmed to hold none: the provider ended the
// session, a fresh read finds none, and the trusted boundary over that state
// agrees. What the request's own client now holds is never consulted: it may
// have dropped a session that is still stored.
async function isSessionDiscarded(
  provider: RecoveryProvider,
): Promise<boolean> {
  let ended: unknown;
  try {
    ended = await provider.signOut();
  } catch {
    return false;
  }
  return (
    ended === true &&
    (await sessionIn(() => provider.storedSession())) === null &&
    (await isAuthenticated(provider)) === false
  );
}

// The result after an attempt that may have stored a session but changed no
// password: plainly unusable only when that session is confirmed gone.
async function failBeforeUpdate(
  provider: RecoveryProvider,
): Promise<RecoveryCompletionState> {
  return (await isSessionDiscarded(provider)) ? UNUSABLE : SESSION_UNCERTAIN;
}

export async function completeAccountRecovery(
  source: RecoveryProviderSource,
  payload: unknown,
): Promise<RecoveryCompletionState> {
  const code = fieldOf(payload, "code");
  if (code === null || !CODE_SHAPE.test(code)) {
    return UNUSABLE;
  }
  const validation = validateNewPassword(payload);
  if (!validation.ok) {
    return Object.freeze({
      status: "invalid",
      fieldErrors: validation.fieldErrors,
    });
  }
  const provider = await providerFrom(source);
  if (provider === null) {
    return COMPLETION_UNAVAILABLE;
  }
  let exchange: unknown;
  try {
    exchange = await provider.exchangeCode(code);
  } catch {
    // The provider's state is unknown, so any session it stored is ended.
    return failBeforeUpdate(provider);
  }
  if (isRejection(exchange)) {
    return UNUSABLE;
  }
  const account = await recoveredAccount(provider, exchange);
  if (account === null) {
    return failBeforeUpdate(provider);
  }
  let update: unknown;
  try {
    update = await provider.updatePassword(validation.value.password);
  } catch {
    update = undefined;
  }
  const outcome = updateOutcomeOf(update, account);
  // Whatever the update did, the recovery session is ended before any result.
  const discarded = await isSessionDiscarded(provider);
  if (outcome === "updated") {
    return discarded ? COMPLETED : UNCERTAIN;
  }
  if (outcome === "refused") {
    return discarded ? NOT_CHANGED : SESSION_UNCERTAIN;
  }
  return UNCERTAIN;
}
