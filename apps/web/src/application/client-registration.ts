// Client-first registration and email confirmation orchestration (P2-006).
//
// Provider-neutral and injectable: each request hands in its own ports, built
// by the server action or route handler that owns the framework, provider,
// and cookie lifecycle. Registration reads only the email, password, and
// Confirm Password fields and applies the owner-adopted D-01 password rule
// (amended 2026-10-16) in full. Only then, and only when a trusted
// abuse-control decision allows the attempt, does it ask the server-only
// provisioning port to create one unconfirmed account, reread it, record its
// pending User and linked Client profile, and request one signup confirmation
// email. Confirmation and resume activate only that complete pending pair,
// for fresh, verified, and confirmed Auth evidence of the same account, and
// never create a missing User or profile. Every result is a fixed code.
// Nothing here holds a credential beyond the call, keeps module-level mutable
// state, or grants authority: the Client context is decided separately by the
// trusted principal source through the unchanged Security Shell.

import type { FieldErrors, Validation } from "./form-operation.ts";
import { resolveSession, type ServerSessionSource } from "./session.ts";

export type RegistrationCredentials = {
  readonly email: string;
  readonly password: string;
};

// What a trusted abuse-control layer decides for one registration attempt.
// Only "allow" lets an attempt reach account creation.
export type AbuseDecision = "allow" | "deny" | "throttle" | "unavailable";

export type AbuseControl = {
  readonly decide: (attempt: {
    readonly email: string;
  }) => Promise<AbuseDecision>;
};

// No trusted abuse-control enforcement is wired to any deployment yet, so
// every attempt is refused before account creation. There is deliberately no
// allow fallback: a later, separately authorized gate must wire verified
// infrastructure enforcement in its place.
export const NO_TRUSTED_ABUSE_CONTROL: AbuseControl = Object.freeze({
  decide: async (): Promise<AbuseDecision> => "unavailable",
});

// Provider fields of one Auth account, exactly as reported.
export type AccountRecord = {
  readonly id: unknown;
  readonly email: unknown;
  readonly emailConfirmedAt: unknown;
};

// What the provider reports for one Admin account creation. "rejected": it
// refused and created nothing. "unknown": an account may or may not exist.
export type AccountCreation =
  | { readonly kind: "created"; readonly account: AccountRecord }
  | { readonly kind: "rejected" }
  | { readonly kind: "unknown" };

export type AccountRead =
  | { readonly kind: "account"; readonly account: AccountRecord }
  | { readonly kind: "unreadable" };

// Rows one database operation returned, exactly as reported, or
// "unreadable" when it failed or its outcome is unknown.
export type RowsResult =
  | { readonly kind: "rows"; readonly rows: readonly unknown[] }
  | { readonly kind: "unreadable" };

// Server-only, privileged port. Users are found and written only by the exact
// Auth account id, and Client profiles only by the exact User id. The two
// inserts and the activation are separate operations, never one transaction.
export type RegistrationProvisioning = {
  readonly createAccount: (
    submitted: RegistrationCredentials,
  ) => Promise<AccountCreation>;
  readonly readAccount: (accountId: string) => Promise<AccountRead>;
  readonly usersOf: (accountId: string) => Promise<RowsResult>;
  readonly insertPendingUser: (accountId: string) => Promise<RowsResult>;
  readonly clientProfilesOf: (userId: string) => Promise<RowsResult>;
  readonly insertClientProfile: (userId: string) => Promise<RowsResult>;
  readonly activatePendingUser: (
    userId: string,
    accountId: string,
  ) => Promise<RowsResult>;
};

// Unprivileged port. It resolves true only when the provider accepted one
// signup confirmation request for dispatch, which never proves delivery.
export type ConfirmationDispatch = {
  readonly requestSignupConfirmation: (email: string) => Promise<boolean>;
};

// Each port is built for the current request, or reported as null when its
// configuration or project binding is absent or cannot be verified.
export type RegistrationSources = {
  readonly abuseControl: AbuseControl;
  readonly provisioning: () => Promise<RegistrationProvisioning | null>;
  readonly dispatch: () => Promise<ConfirmationDispatch | null>;
};

// "submitted" is deliberately neutral: once account creation has been asked
// for, every outcome (created, already registered, refused, or uncertain)
// reports it, so the result never reveals whether an account exists and never
// claims that one was created or that an email was sent.
export type RegistrationState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "unavailable" }
  | { readonly status: "submitted" };

export const INITIAL_REGISTRATION_STATE: RegistrationState = Object.freeze({
  status: "idle",
});

const UNAVAILABLE: RegistrationState = Object.freeze({ status: "unavailable" });
const SUBMITTED: RegistrationState = Object.freeze({ status: "submitted" });

// One fresh read of a verified Auth user, exactly as the provider reports it.
export type VerifiedUserRead =
  | {
      readonly kind: "user";
      readonly id: unknown;
      readonly emailConfirmedAt: unknown;
    }
  | { readonly kind: "unreadable" };

// The provider's answer to one deliberate token verification. On "verified",
// readUser reads the account afresh with the verified session's own
// credential, which never leaves the port.
export type TokenVerification =
  | { readonly kind: "rejected" }
  | {
      readonly kind: "verified";
      readonly userId: unknown;
      readonly sessionUserId: unknown;
      readonly readUser: () => Promise<VerifiedUserRead>;
    };

// Request-scoped, unprivileged port. verifyEmailToken is called at most once
// per attempt. currentUser reads the request's existing session afresh, and
// session is the trusted claims boundary over the request's cookie state,
// including this request's updates.
export type ConfirmationProvider = {
  readonly verifyEmailToken: (tokenHash: string) => Promise<TokenVerification>;
  readonly currentUser: () => Promise<VerifiedUserRead>;
  readonly session: ServerSessionSource;
};

export type ConfirmationSources = {
  readonly provider: () => Promise<ConfirmationProvider | null>;
  readonly provisioning: () => Promise<RegistrationProvisioning | null>;
};

// "confirmed": the account is active and the request's stored session is
// verified to belong to it. "sign-in-needed": no usable session, or the
// account may be active but its session could not be shown to be stored.
// "failed": nothing was confirmed or activated by this request.
export type ConfirmationResult = "confirmed" | "sign-in-needed" | "failed";

// D-01 bounds. The minimum counts Unicode code points, never UTF-16 units,
// graphemes, or bytes. There is no application maximum: the provider's own
// limit applies, and the password is never truncated or altered.
const PASSWORD_MINIMUM_CODE_POINTS = 15;
const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// D-01 emoji rule, applied with the runtime's own Unicode property data
// (tested on Unicode 16.0). Each pattern rejects one named class. A broad
// \p{Emoji} filter is deliberately absent: it would reject plain digits, "#",
// and "*". Text-default symbols without VS16, such as a bare copyright sign,
// are ordinary symbols and stay allowed.
const EMOJI_PATTERNS = Object.freeze([
  // Every RGI emoji string: single emoji, VS16 forms, flags, keycaps, and
  // skin-tone, ZWJ, and tag sequences.
  new RegExp("\\p{RGI_Emoji}", "v"),
  // Any code point whose default presentation is emoji.
  /\p{Emoji_Presentation}/u,
  // Any emoji character explicitly styled as emoji with VS16.
  /\p{Emoji}\uFE0F/u,
  // Emoji components outside RGI sequences: regional indicators, skin-tone
  // modifiers, the keycap mark, and tag characters.
  /[\p{Regional_Indicator}\p{Emoji_Modifier}\u20E3\u{E0020}-\u{E007F}]/u,
  // A zero-width joiner attached to a pictograph: joined sequences, RGI or
  // not. Joiners between letters, as some scripts use them, are untouched.
  /\p{Extended_Pictographic}[\uFE0E\uFE0F]?\u200D|\u200D\p{Extended_Pictographic}/u,
  // Pictographic code points this Unicode version reserves for future emoji.
  new RegExp("[\\p{Extended_Pictographic}&&\\p{Cn}]", "v"),
]);

function containsEmoji(text: string): boolean {
  return EMOJI_PATTERNS.some((pattern) => pattern.test(text));
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

// Only the email, password, and confirm_password fields are read. Any other
// field, such as an identifier, role, profile, metadata, destination, or
// confirmation state, is ignored and grants nothing. The email loses only
// its outer whitespace; both passwords are kept exactly as submitted.
export function validateRegistration(
  payload: unknown,
): Validation<RegistrationCredentials> {
  const read = (name: string): string | null => fieldOf(payload, name);
  const submittedEmail = read("email");
  const email = submittedEmail === null ? null : submittedEmail.trim();
  const password = read("password");
  const confirmation = read("confirm_password");
  const emailErrors: string[] = [];
  const passwordErrors: string[] = [];
  const confirmationErrors: string[] = [];
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
  if (password === "") {
    passwordErrors.push("Enter a password.");
  } else if (password === null || !password.isWellFormed()) {
    passwordErrors.push("Enter a valid password.");
  } else {
    if (Array.from(password).length < PASSWORD_MINIMUM_CODE_POINTS) {
      passwordErrors.push("Use at least 15 characters.");
    }
    if (containsEmoji(password)) {
      passwordErrors.push("Emojis aren't allowed.");
    }
  }
  if (confirmation === "" || confirmation === null) {
    confirmationErrors.push("Confirm your password.");
  } else if (confirmation !== password) {
    // Exact code-unit equality: nothing is normalized or transformed.
    confirmationErrors.push("The passwords don't match.");
  }
  const failed: Array<[string, readonly string[]]> = [];
  if (emailErrors.length > 0) {
    failed.push(["email", Object.freeze(emailErrors)]);
  }
  if (passwordErrors.length > 0) {
    failed.push(["password", Object.freeze(passwordErrors)]);
  }
  if (confirmationErrors.length > 0) {
    failed.push(["confirm_password", Object.freeze(confirmationErrors)]);
  }
  if (failed.length > 0 || email === null || password === null) {
    return {
      ok: false,
      fieldErrors: Object.freeze(Object.fromEntries(failed)),
    };
  }
  // The Confirm Password value goes no further than the comparison above.
  return { ok: true, value: Object.freeze({ email, password }) };
}

// The own data fields of a plain record, each read once, or null when it is
// anything else or holds a field outside keys, an accessor, or a symbol key.
function readRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | null {
  try {
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
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

// A record of one of the declared kinds, or null.
function kindOf(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | null {
  const fields = readRecord(value, ["kind", ...keys]);
  return fields !== null && typeof fields.get("kind") === "string"
    ? fields
    : null;
}

type Account = {
  readonly id: string;
  readonly email: string;
  readonly confirmed: boolean;
};

// A reported account with a canonical id and an email, and whether that
// email is confirmed. Only an absent confirmation time is unconfirmed.
function accountOf(value: unknown): Account | null {
  const fields = readRecord(value, ["id", "email", "emailConfirmedAt"]);
  const id = fields?.get("id");
  const email = fields?.get("email");
  if (fields === null || typeof id !== "string" || !UUID.test(id)) {
    return null;
  }
  if (!isNonEmptyString(email)) {
    return null;
  }
  const confirmedAt = fields.get("emailConfirmedAt");
  if (confirmedAt !== undefined && confirmedAt !== null) {
    return isNonEmptyString(confirmedAt)
      ? { id, email, confirmed: true }
      : null;
  }
  return { id, email, confirmed: false };
}

// The provider stores email addresses in lower case. Nothing else about its
// handling is assumed, so any other difference is a mismatch.
function isProviderEmailFor(providerEmail: string, submitted: string): boolean {
  return (
    providerEmail === submitted || providerEmail === submitted.toLowerCase()
  );
}

type UserRow = {
  readonly id: string;
  readonly accountId: string;
  readonly state: unknown;
};

type ProfileRow = { readonly id: string; readonly userId: string };

// The rows of a result, or null when it is unreadable or malformed.
function rowsOf(result: unknown): readonly unknown[] | null {
  const fields = kindOf(result, ["rows"]);
  const rows = fields?.get("rows");
  if (fields?.get("kind") !== "rows" || !Array.isArray(rows)) {
    return null;
  }
  return [...rows];
}

function userRowOf(row: unknown): UserRow | null {
  const fields = readRecord(row, ["id", "auth_user_id", "account_state"]);
  const id = fields?.get("id");
  const accountId = fields?.get("auth_user_id");
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    typeof accountId !== "string"
  ) {
    return null;
  }
  return { id, accountId, state: fields?.get("account_state") };
}

function profileRowOf(row: unknown): ProfileRow | null {
  const fields = readRecord(row, ["id", "user_id"]);
  const id = fields?.get("id");
  const userId = fields?.get("user_id");
  if (typeof id !== "string" || !UUID.test(id) || typeof userId !== "string") {
    return null;
  }
  return { id, userId };
}

// Runs one port call. A thrown call is an unknown outcome, never an answer.
async function attempt(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

// The single User an operation reports for exactly this account in exactly
// this state, or null.
async function exactUser(
  call: () => Promise<unknown>,
  accountId: string,
  state: string,
): Promise<UserRow | null> {
  const rows = rowsOf(await attempt(call));
  const user = rows?.length === 1 ? userRowOf(rows[0]) : null;
  return user !== null && user.accountId === accountId && user.state === state
    ? user
    : null;
}

// The single Client profile an operation reports for exactly this User, or
// null.
async function exactProfile(
  call: () => Promise<unknown>,
  userId: string,
): Promise<ProfileRow | null> {
  const rows = rowsOf(await attempt(call));
  const profile = rows?.length === 1 ? profileRowOf(rows[0]) : null;
  return profile !== null && profile.userId === userId ? profile : null;
}

const PENDING = "pending_verification";
const ACTIVE = "active";

// Pre-verification association for an account this very request just created
// through Admin creation. Each step continues only on proof; anything else
// stops the attempt with existing rows untouched and nothing deleted, rolled
// back, retried, or repaired. An account left without its User or profile is
// for controlled manual reconciliation only. The email request is the last
// step and is made at most once.
async function provisionPendingRegistration(
  provisioning: RegistrationProvisioning,
  dispatch: ConfirmationDispatch,
  submitted: RegistrationCredentials,
): Promise<void> {
  // Only the original email and password reach the provider.
  const creation = kindOf(
    await attempt(() => provisioning.createAccount(submitted)),
    ["account"],
  );
  if (creation?.get("kind") !== "created") {
    // A refusal, a duplicate, or an unknown outcome. No existing account is
    // looked up, adopted, updated, or sent an email.
    return;
  }
  const created = accountOf(creation.get("account"));
  if (created === null || created.confirmed) {
    return;
  }
  // The exact created id, reread through the Admin API, must still be the
  // same unconfirmed account for the submitted email.
  const reread = kindOf(
    await attempt(() => provisioning.readAccount(created.id)),
    ["account"],
  );
  const account =
    reread?.get("kind") === "account" ? accountOf(reread.get("account")) : null;
  if (
    account === null ||
    account.id !== created.id ||
    account.email !== created.email ||
    account.confirmed ||
    !isProviderEmailFor(account.email, submitted.email)
  ) {
    return;
  }
  // A User already linked to the new account is a conflict, never claimed.
  const existing = rowsOf(
    await attempt(() => provisioning.usersOf(account.id)),
  );
  if (existing === null || existing.length !== 0) {
    return;
  }
  // An insert that fails or answers anything unexpected cannot be proven to
  // be this request's own, so the attempt stops there.
  const inserted = await exactUser(
    () => provisioning.insertPendingUser(account.id),
    account.id,
    PENDING,
  );
  if (inserted === null) {
    return;
  }
  const user = await exactUser(
    () => provisioning.usersOf(account.id),
    account.id,
    PENDING,
  );
  if (user === null || user.id !== inserted.id) {
    return;
  }
  const insertedProfile = await exactProfile(
    () => provisioning.insertClientProfile(user.id),
    user.id,
  );
  if (insertedProfile === null) {
    return;
  }
  const profile = await exactProfile(
    () => provisioning.clientProfilesOf(user.id),
    user.id,
  );
  const stillPending = await exactUser(
    () => provisioning.usersOf(account.id),
    account.id,
    PENDING,
  );
  if (
    profile === null ||
    profile.id !== insertedProfile.id ||
    stillPending === null ||
    stillPending.id !== user.id
  ) {
    return;
  }
  // The pair is durably complete, so exactly one confirmation email is
  // requested for the provider's own record of the address. Acceptance is
  // not delivery, and nothing is retried.
  await attempt(() => dispatch.requestSignupConfirmation(account.email));
}

async function portFrom<Port>(
  source: () => Promise<Port | null>,
): Promise<Port | null> {
  try {
    const port = await source();
    return port !== null && typeof port === "object" ? port : null;
  } catch {
    return null;
  }
}

async function decisionOf(
  control: AbuseControl,
  email: string,
): Promise<unknown> {
  try {
    return await control.decide(Object.freeze({ email }));
  } catch {
    return "unavailable";
  }
}

export async function registerClientAccount(
  sources: RegistrationSources,
  payload: unknown,
): Promise<RegistrationState> {
  const validation = validateRegistration(payload);
  if (!validation.ok) {
    return Object.freeze({
      status: "invalid",
      fieldErrors: validation.fieldErrors,
    });
  }
  // A missing, unavailable, throttling, or denying decision refuses the
  // attempt before any account creation, database write, or email request.
  if (
    (await decisionOf(sources.abuseControl, validation.value.email)) !== "allow"
  ) {
    return UNAVAILABLE;
  }
  // Both ports must be bound to the verified project before anything runs.
  const provisioning = await portFrom(sources.provisioning);
  const dispatch = await portFrom(sources.dispatch);
  if (provisioning === null || dispatch === null) {
    return UNAVAILABLE;
  }
  await provisionPendingRegistration(provisioning, dispatch, validation.value);
  return SUBMITTED;
}

type Pair = { readonly user: UserRow; readonly profile: ProfileRow };

// The account's one User and that User's one Client profile, read afresh by
// their exact keys, or null when either is missing, repeated, unreadable, or
// linked to anything else.
async function completePairOf(
  provisioning: RegistrationProvisioning,
  accountId: string,
): Promise<Pair | null> {
  const rows = rowsOf(await attempt(() => provisioning.usersOf(accountId)));
  const user = rows?.length === 1 ? userRowOf(rows[0]) : null;
  if (user === null || user.accountId !== accountId) {
    return null;
  }
  const profile = await exactProfile(
    () => provisioning.clientProfilesOf(user.id),
    user.id,
  );
  return profile === null ? null : { user, profile };
}

// Activates the account's complete pending pair, or confirms an already
// active one read-only. Only a pending User with its Client profile is ever
// changed, by one conditional update keyed to the User, the account, and the
// pending state; a suspension or closure in the meantime always wins. The
// answer comes from a fresh read afterwards, never from the write itself.
async function activateRegistration(
  provisioning: RegistrationProvisioning,
  accountId: string,
): Promise<boolean> {
  const pair = await completePairOf(provisioning, accountId);
  if (pair === null) {
    return false;
  }
  if (pair.user.state === PENDING) {
    const updated = rowsOf(
      await attempt(() =>
        provisioning.activatePendingUser(pair.user.id, accountId),
      ),
    );
    if (updated === null || updated.length > 1) {
      return false;
    }
    if (updated.length === 1) {
      const row = userRowOf(updated[0]);
      if (
        row === null ||
        row.id !== pair.user.id ||
        row.accountId !== accountId ||
        row.state !== ACTIVE
      ) {
        return false;
      }
    }
    // No row changed: the reread below decides, and only an exact, complete,
    // already active pair counts.
  } else if (pair.user.state !== ACTIVE) {
    return false;
  }
  const fresh = await completePairOf(provisioning, accountId);
  return (
    fresh !== null &&
    fresh.user.id === pair.user.id &&
    fresh.profile.id === pair.profile.id &&
    fresh.user.state === ACTIVE
  );
}

// Whether a fresh user read names exactly this account with a confirmed email.
async function isConfirmedUser(
  read: () => Promise<VerifiedUserRead>,
  accountId: string,
): Promise<boolean> {
  const fields = kindOf(await attempt(read), ["id", "emailConfirmedAt"]);
  return (
    fields?.get("kind") === "user" &&
    fields.get("id") === accountId &&
    isNonEmptyString(fields.get("emailConfirmedAt"))
  );
}

// The subject the trusted boundary reports for the request's stored session
// state, null when it is anonymous, or undefined when the read fails.
async function storedSubjectOf(
  provider: ConfirmationProvider,
): Promise<string | null | undefined> {
  try {
    const session = await resolveSession(provider.session);
    return session.status === "authenticated" ? session.subject : null;
  } catch {
    return undefined;
  }
}

// After activation, success is claimed only when the stored session is
// verified to belong to the activated account; otherwise sign-in is needed.
async function activatedResult(
  provider: ConfirmationProvider,
  accountId: string,
): Promise<ConfirmationResult> {
  return (await storedSubjectOf(provider)) === accountId
    ? "confirmed"
    : "sign-in-needed";
}

async function confirmationPorts(sources: ConfirmationSources): Promise<{
  readonly provider: ConfirmationProvider;
  readonly provisioning: RegistrationProvisioning;
} | null> {
  const provider = await portFrom(sources.provider);
  const provisioning = await portFrom(sources.provisioning);
  return provider === null || provisioning === null
    ? null
    : { provider, provisioning };
}

// A deliberate confirmation: verifies the token once, requires the verified
// session, the verified user, and a fresh read with that session's own
// credential to name the same account with a confirmed email, and only then
// activates that account's complete pending pair. Both ports are checked
// before the token is used, so an unconfigured server never consumes it.
export async function confirmRegistrationEmail(
  sources: ConfirmationSources,
  tokenHash: string,
): Promise<ConfirmationResult> {
  const ports = await confirmationPorts(sources);
  if (ports === null) {
    return "failed";
  }
  const verification = kindOf(
    await attempt(() => ports.provider.verifyEmailToken(tokenHash)),
    ["userId", "sessionUserId", "readUser"],
  );
  const accountId = verification?.get("userId");
  const readUser = verification?.get("readUser");
  if (
    verification?.get("kind") !== "verified" ||
    !isNonEmptyString(accountId) ||
    verification.get("sessionUserId") !== accountId ||
    typeof readUser !== "function"
  ) {
    return "failed";
  }
  if (
    !(await isConfirmedUser(
      () => (readUser as () => Promise<VerifiedUserRead>)(),
      accountId,
    ))
  ) {
    return "failed";
  }
  if (!(await activateRegistration(ports.provisioning, accountId))) {
    return "failed";
  }
  return activatedResult(ports.provider, accountId);
}

// An explicit, token-free resume for a signed-in account whose email is
// already confirmed: it finishes or confirms activation of that account's
// existing complete pair, and never creates, reconstructs, or adopts one.
export async function resumeRegistration(
  sources: ConfirmationSources,
): Promise<ConfirmationResult> {
  const ports = await confirmationPorts(sources);
  if (ports === null) {
    return "failed";
  }
  const subject = await storedSubjectOf(ports.provider);
  if (subject === null) {
    return "sign-in-needed";
  }
  if (
    subject === undefined ||
    !(await isConfirmedUser(() => ports.provider.currentUser(), subject))
  ) {
    return "failed";
  }
  if (!(await activateRegistration(ports.provisioning, subject))) {
    return "failed";
  }
  return activatedResult(ports.provider, subject);
}
