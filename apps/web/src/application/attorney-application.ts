// Attorney application entry and initial applicant creation (P3-002).
//
// Provider-neutral and injectable: each request hands in its own ports, built
// by the page or server action that owns the framework and provider. For the
// current request it establishes, on the server and from nothing the browser
// sends, the trusted session subject, a fresh Auth read of that same account
// with a confirmed email, that account's one Rosuno User in the active state,
// and whether that User already holds an Attorney Profile. Entry only reads.
// Creation runs only on an explicit start request, asks the database to
// create one Attorney Profile in the applicant state for the verified User,
// and claims creation only when a fresh read afterwards shows exactly the row
// that insert reported. A duplicate or a concurrent start leaves the one
// existing profile as it is, and an uncertain write is never reported as
// created. No existing profile is reset, promoted, or revived, and no Client
// profile or User is touched. Every result is a fixed status that carries no
// identifier, record, or provider detail. Starting an application is a record
// stage only: nothing here decides professional verification, approval,
// eligibility, bookability, or any other business question.

import { resolveSession, type ServerSessionSource } from "./session.ts";

// One fresh read of the request's own Auth user, exactly as the provider
// reports it, or "unreadable" when the read failed.
export type AttorneyApplicationAccountRead =
  | {
      readonly kind: "user";
      readonly id: unknown;
      readonly emailConfirmedAt: unknown;
    }
  | { readonly kind: "unreadable" };

// Request-scoped, unprivileged port: reads the request's own Auth user afresh
// from its own session; no identifier is passed in.
export type AttorneyApplicationAccountSource = {
  readonly currentAccount: () => Promise<AttorneyApplicationAccountRead>;
};

// Rows one database operation returned, exactly as reported, or "unreadable"
// when it failed, was refused, or its outcome is unknown.
export type AttorneyApplicationRows =
  | { readonly kind: "rows"; readonly rows: readonly unknown[] }
  | { readonly kind: "unreadable" };

// Read-only port. The User is found only by the exact verified Auth account
// id, and the Attorney Profile only by the exact User id that read named.
export type AttorneyApplicationRecords = {
  readonly usersOf: (accountId: string) => Promise<AttorneyApplicationRows>;
  readonly attorneyProfilesOf: (
    userId: string,
  ) => Promise<AttorneyApplicationRows>;
};

// Server-only port: the same two exact-key reads and one creation of an
// applicant-state Attorney Profile. The creation is made by the database for
// the request's own authenticated session and its own User only (P3-904); the
// verified User id is passed so the reported row can be checked against it.
export type AttorneyApplicantProvisioning = AttorneyApplicationRecords & {
  readonly insertApplicantProfile: (
    userId: string,
  ) => Promise<AttorneyApplicationRows>;
};

// Each port source builds its port for the current request, or reports null
// when its configuration or project binding is absent or cannot be verified.
export type AttorneyApplicationEntrySources = {
  readonly session: ServerSessionSource;
  readonly account: AttorneyApplicationAccountSource;
  readonly records: () => Promise<AttorneyApplicationRecords | null>;
  // Whether the privileged start boundary is configured, answered without
  // building it. When given, the entry offers a start only if it answers
  // exactly true, so no form is shown that would certainly fail (P3-003).
  readonly startConfigured?: () => Promise<boolean>;
};

export type AttorneyApplicationStartSources = {
  readonly session: ServerSessionSource;
  readonly account: AttorneyApplicationAccountSource;
  readonly provisioning: () => Promise<AttorneyApplicantProvisioning | null>;
};

// "can-start": the signed-in account may start an application. "on-record":
// it already holds one, in a stage the attorney workspace admits. "denied":
// no application can be started for it, whatever the reason.
export type AttorneyApplicationEntry =
  | { readonly status: "sign-in-required" }
  | { readonly status: "can-start" }
  | { readonly status: "on-record" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

// "created": this request's insert is proven by a fresh read. "on-record": an
// application exists, but this request did not prove it created it.
// "unavailable": nothing was written. "unconfirmed": a write was attempted
// and its outcome could not be shown, so nothing is claimed.
export type AttorneyApplicationOutcome =
  | { readonly status: "sign-in-required" }
  | { readonly status: "created" }
  | { readonly status: "on-record" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | { readonly status: "unconfirmed" };

// The one form field an explicit start request carries, with its one value.
export const ATTORNEY_APPLICATION_INTENT = Object.freeze({
  field: "intent",
  value: "start-attorney-application",
} as const);

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const CAN_START = Object.freeze({ status: "can-start" } as const);
const ON_RECORD = Object.freeze({ status: "on-record" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);
const CREATED = Object.freeze({ status: "created" } as const);
const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ACTIVE = "active";
const APPLICANT = "applicant";

// User account states other than active. Each one definitely cannot start an
// application; any other value is unreadable.
const INACTIVE_ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "suspended",
  "closed",
] as const);

// Attorney Profile stages the attorney workspace admits: an application on
// record. Each is a record stage only.
const ON_RECORD_PROFILE_STATES = Object.freeze([
  "applicant",
  "under_review",
  "approved",
] as const);

// Attorney Profile states that are never reset, revived, or restarted here.
const REFUSED_PROFILE_STATES = Object.freeze(["suspended", "removed"] as const);

function isOneOf(list: readonly string[], value: unknown): boolean {
  return list.some((entry) => entry === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
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

// The rows of a result, or null when it is unreadable or malformed.
function rowsOf(result: unknown): readonly unknown[] | null {
  const fields = kindOf(result, ["rows"]);
  const rows = fields?.get("rows");
  if (fields?.get("kind") !== "rows" || !Array.isArray(rows)) {
    return null;
  }
  return [...rows];
}

type UserRow = {
  readonly id: string;
  readonly accountId: unknown;
  readonly state: unknown;
};

type ProfileRow = {
  readonly id: string;
  readonly userId: unknown;
  readonly state: unknown;
};

function userRowOf(row: unknown): UserRow | null {
  const fields = readRecord(row, ["id", "auth_user_id", "account_state"]);
  const id = fields?.get("id");
  if (fields === null || typeof id !== "string" || !UUID.test(id)) {
    return null;
  }
  return {
    id,
    accountId: fields.get("auth_user_id"),
    state: fields.get("account_state"),
  };
}

function profileRowOf(row: unknown): ProfileRow | null {
  const fields = readRecord(row, ["id", "user_id", "profile_state"]);
  const id = fields?.get("id");
  if (fields === null || typeof id !== "string" || !UUID.test(id)) {
    return null;
  }
  return {
    id,
    userId: fields.get("user_id"),
    state: fields.get("profile_state"),
  };
}

// Runs one port call. A thrown call is an unknown outcome, never an answer.
async function attempt(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch {
    return undefined;
  }
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

type Refusal = typeof SIGN_IN_REQUIRED | typeof DENIED | typeof UNAVAILABLE;

// The subject the trusted boundary reports for the request's session, null
// when it is anonymous, or undefined when the read fails.
async function sessionSubjectOf(
  session: ServerSessionSource,
): Promise<string | null | undefined> {
  try {
    const resolved = await resolveSession(session);
    return resolved.status === "authenticated" ? resolved.subject : null;
  } catch {
    return undefined;
  }
}

// The confirmed Auth account id of the request, or the fixed refusal. The
// subject comes from the trusted session boundary; a fresh read of the
// request's own Auth user must name exactly that subject, in canonical form,
// with a confirmed email. Role, identity, and confirmation never come from
// metadata, email text, or request input.
async function confirmedAccountOf(
  session: ServerSessionSource,
  account: AttorneyApplicationAccountSource,
): Promise<{ readonly accountId: string } | Refusal> {
  const subject = await sessionSubjectOf(session);
  if (subject === null) {
    return SIGN_IN_REQUIRED;
  }
  if (subject === undefined) {
    return UNAVAILABLE;
  }
  const read = kindOf(await attempt(() => account.currentAccount()), [
    "id",
    "emailConfirmedAt",
  ]);
  if (read?.get("kind") !== "user") {
    return UNAVAILABLE;
  }
  if (
    read.get("id") !== subject ||
    !isNonEmptyString(read.get("emailConfirmedAt"))
  ) {
    return DENIED;
  }
  return UUID.test(subject) ? { accountId: subject } : UNAVAILABLE;
}

type Standing =
  | Refusal
  | typeof ON_RECORD
  | { readonly status: "none"; readonly userId: string };

// What the account's records say about starting an application. The User is
// read only by the verified account id and the profile only by the User id
// that read named. Anything missing, repeated, unreadable, inconsistent, or
// of an unknown state never lets an application start.
async function standingOf(
  records: AttorneyApplicationRecords,
  accountId: string,
): Promise<Standing> {
  const users = rowsOf(await attempt(() => records.usersOf(accountId)));
  if (users === null || users.length > 1) {
    return UNAVAILABLE;
  }
  if (users.length === 0) {
    // No Rosuno User: nothing is provisioned for the account here.
    return DENIED;
  }
  const user = userRowOf(users[0]);
  if (user === null || user.accountId !== accountId) {
    return UNAVAILABLE;
  }
  if (user.state !== ACTIVE) {
    return isOneOf(INACTIVE_ACCOUNT_STATES, user.state) ? DENIED : UNAVAILABLE;
  }
  const profiles = rowsOf(
    await attempt(() => records.attorneyProfilesOf(user.id)),
  );
  if (profiles === null || profiles.length > 1) {
    return UNAVAILABLE;
  }
  if (profiles.length === 0) {
    return Object.freeze({ status: "none", userId: user.id });
  }
  return existingStanding(profileRowOf(profiles[0]), user.id) ?? UNAVAILABLE;
}

// The standing an existing profile of exactly this User holds, or null when
// it is malformed, linked to anyone else, or of an unknown state.
function existingStanding(
  profile: ProfileRow | null,
  userId: string,
): typeof ON_RECORD | typeof DENIED | null {
  if (profile === null || profile.userId !== userId) {
    return null;
  }
  if (isOneOf(ON_RECORD_PROFILE_STATES, profile.state)) {
    return ON_RECORD;
  }
  return isOneOf(REFUSED_PROFILE_STATES, profile.state) ? DENIED : null;
}

// Decides what the attorney application entry shows for the current request.
// It only reads, and it never throws.
export async function resolveAttorneyApplicationEntry(
  sources: AttorneyApplicationEntrySources,
): Promise<AttorneyApplicationEntry> {
  try {
    const identity = await confirmedAccountOf(sources.session, sources.account);
    if (!("accountId" in identity)) {
      return identity;
    }
    const records = await portFrom(sources.records);
    if (records === null) {
      return UNAVAILABLE;
    }
    const standing = await standingOf(records, identity.accountId);
    if (standing.status !== "none") {
      return standing;
    }
    if (sources.startConfigured === undefined) {
      return CAN_START;
    }
    const configured = await attempt(() => sources.startConfigured!());
    return configured === true ? CAN_START : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

// Whether the submitted form is one explicit start request: exactly one
// intent field with exactly the fixed value. Any other field, such as an
// identifier, role, profile, state, or destination, is never read.
function isExplicitStart(payload: unknown): boolean {
  if (!(payload instanceof FormData)) {
    return false;
  }
  const values = payload.getAll(ATTORNEY_APPLICATION_INTENT.field);
  return values.length === 1 && values[0] === ATTORNEY_APPLICATION_INTENT.value;
}

// After the one insert, a fresh read decides, never the write's own answer.
// Creation is claimed only for exactly the row the insert reported, still in
// the applicant state; an existing profile is only ever reported as on record.
async function outcomeAfterWrite(
  provisioning: AttorneyApplicantProvisioning,
  userId: string,
  insertedId: string | null,
): Promise<AttorneyApplicationOutcome> {
  const rows = rowsOf(
    await attempt(() => provisioning.attorneyProfilesOf(userId)),
  );
  if (rows === null || rows.length !== 1) {
    return UNCONFIRMED;
  }
  const profile = profileRowOf(rows[0]);
  if (insertedId !== null) {
    if (profile === null || profile.id !== insertedId) {
      return UNCONFIRMED;
    }
    if (profile.userId === userId && profile.state === APPLICANT) {
      return CREATED;
    }
  }
  return existingStanding(profile, userId) ?? UNCONFIRMED;
}

// Starts an attorney application for the current request, at most once. It
// never throws. Nothing is read before the request is an explicit start, the
// privileged port is built only after the account is verified, and the one
// insert runs only after a fresh read shows no Attorney Profile for the
// verified, active User. The database's unique User link keeps every repeated
// or concurrent start to that one profile.
export async function startAttorneyApplication(
  sources: AttorneyApplicationStartSources,
  payload: unknown,
): Promise<AttorneyApplicationOutcome> {
  try {
    if (!isExplicitStart(payload)) {
      return UNAVAILABLE;
    }
    const identity = await confirmedAccountOf(sources.session, sources.account);
    if (!("accountId" in identity)) {
      return identity;
    }
    const provisioning = await portFrom(sources.provisioning);
    if (provisioning === null) {
      return UNAVAILABLE;
    }
    const standing = await standingOf(provisioning, identity.accountId);
    if (standing.status !== "none") {
      return standing;
    }
    const userId = standing.userId;
    // The one write. Whatever it answers, only the fresh read below decides.
    const inserted = rowsOf(
      await attempt(() => provisioning.insertApplicantProfile(userId)),
    );
    const row = inserted?.length === 1 ? profileRowOf(inserted[0]) : null;
    const insertedId =
      row !== null && row.userId === userId && row.state === APPLICANT
        ? row.id
        : null;
    return await outcomeAfterWrite(provisioning, userId, insertedId);
  } catch {
    return UNAVAILABLE;
  }
}
