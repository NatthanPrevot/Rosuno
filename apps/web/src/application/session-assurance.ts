// Session assurance and the step-up gate (MVP-001 S2).
//
// Attorney and staff sessions need the stronger, two-step sign-in (MBS
// section 5): the database refuses attorney professional writes and every
// staff operation unless the request's own Auth token carries the higher
// Authenticator Assurance Level, aal2. This module reads, for the current
// request, whether the session is at aal1 or aal2 and whether the account
// has a verified authenticator-app (TOTP) factor, and decides whether an
// attorney or staff principal may go on, must first confirm a code from
// that app (step-up), or must first set one up (enrollment).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Identity is established afresh on the server exactly as the professional
// surfaces do it: the trusted session subject, a fresh read of that same
// Auth account with a confirmed email, its one active Rosuno User, and that
// User's own Staff Profile and Attorney Profile, read under the database's
// own-row policies. Nothing the browser sends chooses an identity, a
// principal kind, an assurance level, or a destination. It fails closed:
// anything that cannot be read, or does not add up, counts as not stepped
// up, and the gate then never lets a principal through. Every result is a
// fixed status that carries no identifier, factor, or provider detail.
//
// The gate decides nothing else. A request that is not signed in, or whose
// account holds no principal of the kind a route serves, passes through
// unchanged, so the route's own sign-in and refusal behaviour stays exactly
// as it was; a stepped-up principal also passes, and the route then decides
// access for itself as before.

import {
  activeUserOf,
  attempt,
  confirmedAccountOf,
  DENIED,
  portFrom,
  rowsOf,
  UNAVAILABLE,
  type AccountSource,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isUuid,
  PROFILE_STATES,
  readExact,
  STAFF_STATES,
} from "./professional-records.ts";
import type { ServerSessionSource } from "./session.ts";

// ---------------------------------------------------------------------------
// Assurance
// ---------------------------------------------------------------------------

// One read of the request's own session assurance, exactly as reported: the
// level its verified Auth token carries and how many verified authenticator
// app (TOTP) factors the account holds; or "unreadable" when any part of
// the read failed, was refused, or timed out.
export type AssuranceRead =
  | {
      readonly kind: "assurance";
      readonly currentLevel: unknown;
      readonly verifiedTotpFactors: unknown;
    }
  | { readonly kind: "unreadable" };

// Request-scoped: reads the request's own session afresh on every call, so a
// read made after a code is verified sees the upgraded session.
export type SessionAssuranceSource = {
  readonly currentAssurance: () => Promise<AssuranceRead>;
};

// "stepped-up": aal2 and at least one verified TOTP factor.
// "step-up-required": aal1 and at least one verified TOTP factor.
// "enrollment-required": no verified TOTP factor (at either level).
// "unavailable": the read failed or does not add up; never stepped up.
export type SessionAssurance =
  | { readonly status: "stepped-up" }
  | { readonly status: "step-up-required" }
  | { readonly status: "enrollment-required" }
  | { readonly status: "unavailable" };

const ASSURANCE_LEVELS = Object.freeze(["aal1", "aal2"] as const);

const STEPPED_UP: SessionAssurance = Object.freeze({ status: "stepped-up" });
const ASSURANCE_STEP_UP: SessionAssurance = Object.freeze({
  status: "step-up-required",
});
const ASSURANCE_ENROLLMENT: SessionAssurance = Object.freeze({
  status: "enrollment-required",
});
const ASSURANCE_UNAVAILABLE: SessionAssurance = Object.freeze({
  status: "unavailable",
});

// Reports the current request's session assurance. It never throws.
export async function readSessionAssurance(
  source: SessionAssuranceSource,
): Promise<SessionAssurance> {
  const read = readExact(await attempt(() => source.currentAssurance()), [
    "kind",
    "currentLevel",
    "verifiedTotpFactors",
  ]);
  if (read?.get("kind") !== "assurance") {
    return ASSURANCE_UNAVAILABLE;
  }
  const level = read.get("currentLevel");
  const verified = read.get("verifiedTotpFactors");
  if (
    !isOneOf(ASSURANCE_LEVELS, level) ||
    typeof verified !== "number" ||
    !Number.isSafeInteger(verified) ||
    verified < 0
  ) {
    return ASSURANCE_UNAVAILABLE;
  }
  if (verified === 0) {
    return ASSURANCE_ENROLLMENT;
  }
  return level === "aal2" ? STEPPED_UP : ASSURANCE_STEP_UP;
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

// The principals that need a stepped-up session. A client principal never
// does, and nothing here touches client flows.
export const PRINCIPAL_KINDS = Object.freeze(["attorney", "staff"] as const);
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const STEP_UP_STAFF_COLUMNS = "id, user_id, staff_state";
export const STEP_UP_ATTORNEY_COLUMNS = "id, user_id, profile_state";

// Request-scoped, unprivileged own-row reads, keyed only by the verified
// account and User ids this module derives.
export type PrincipalReads = {
  readonly usersOf: (accountId: string) => Promise<RowsResult>;
  readonly staffProfilesOf: (userId: string) => Promise<RowsResult>;
  readonly attorneyProfilesOf: (userId: string) => Promise<RowsResult>;
};

export type StepUpSources = {
  readonly session: ServerSessionSource;
  readonly account: AccountSource;
  readonly principals: () => Promise<PrincipalReads | null>;
  readonly assurance: SessionAssuranceSource;
};

// "principal": the account's active User holds these kinds, in the fixed
// order of PRINCIPAL_KINDS. "denied": it is signed in but holds none (or the
// account is unconfirmed or inactive).
export type PrincipalStanding =
  | {
      readonly status: "principal";
      readonly kinds: readonly PrincipalKind[];
    }
  | Refusal;

// The state of the User's own one profile, null when there is none, or
// undefined when the read failed, repeated, or does not add up.
function ownStateOf(
  result: unknown,
  columns: string,
  stateColumn: string,
  states: readonly string[],
  userId: string,
): string | null | undefined {
  const rows = rowsOf(result);
  if (rows === null || rows.length > 1) {
    return undefined;
  }
  if (rows.length === 0) {
    return null;
  }
  const row = readExact(rows[0], columns.split(", "));
  const state = row?.get(stateColumn);
  if (
    row === null ||
    !isUuid(row.get("id")) ||
    row.get("user_id") !== userId ||
    !isOneOf(states, state)
  ) {
    return undefined;
  }
  return state;
}

// Which of the principal kinds the current request's own account holds. An
// Attorney Profile in any stage counts (its stage limits what the attorney
// routes then show); a Staff Profile counts only while active. It never
// throws.
export async function resolvePrincipalStanding(
  sources: StepUpSources,
): Promise<PrincipalStanding> {
  try {
    const account = await confirmedAccountOf(sources.session, sources.account);
    if (!("accountId" in account)) {
      return account;
    }
    const reads = await portFrom(sources.principals);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const user = await activeUserOf(reads.usersOf, account.accountId);
    if (!("userId" in user)) {
      return user;
    }
    const [staffRows, attorneyRows] = await Promise.all([
      attempt(() => reads.staffProfilesOf(user.userId)),
      attempt(() => reads.attorneyProfilesOf(user.userId)),
    ]);
    const staff = ownStateOf(
      staffRows,
      STEP_UP_STAFF_COLUMNS,
      "staff_state",
      STAFF_STATES,
      user.userId,
    );
    const attorney = ownStateOf(
      attorneyRows,
      STEP_UP_ATTORNEY_COLUMNS,
      "profile_state",
      PROFILE_STATES,
      user.userId,
    );
    if (staff === undefined || attorney === undefined) {
      return UNAVAILABLE;
    }
    const kinds: PrincipalKind[] = [];
    if (attorney !== null) {
      kinds.push("attorney");
    }
    if (staff === "active") {
      kinds.push("staff");
    }
    return kinds.length === 0
      ? DENIED
      : Object.freeze({ status: "principal", kinds: Object.freeze(kinds) });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

// "pass": the route decides as before (not signed in, not a principal of
// this kind, or a stepped-up principal). Anything else stops the route.
export type StepUpGate =
  | { readonly status: "pass" }
  | { readonly status: "step-up-required" }
  | { readonly status: "enrollment-required" }
  | { readonly status: "unavailable" };

const PASS: StepUpGate = Object.freeze({ status: "pass" });
const GATE_STEP_UP: StepUpGate = Object.freeze({ status: "step-up-required" });
const GATE_ENROLLMENT: StepUpGate = Object.freeze({
  status: "enrollment-required",
});
const GATE_UNAVAILABLE: StepUpGate = Object.freeze({ status: "unavailable" });

// Decides, for a route serving one principal kind, whether the current
// request may go on to the route's own access decision. It never throws.
export async function resolveStepUpGate(
  sources: StepUpSources,
  kind: PrincipalKind,
): Promise<StepUpGate> {
  try {
    if (!isOneOf(PRINCIPAL_KINDS, kind)) {
      return GATE_UNAVAILABLE;
    }
    const standing = await resolvePrincipalStanding(sources);
    if (
      standing.status === "sign-in-required" ||
      standing.status === "denied"
    ) {
      return PASS;
    }
    if (standing.status !== "principal") {
      return GATE_UNAVAILABLE;
    }
    if (!standing.kinds.includes(kind)) {
      return PASS;
    }
    const assurance = await readSessionAssurance(sources.assurance);
    switch (assurance.status) {
      case "stepped-up":
        return PASS;
      case "step-up-required":
        return GATE_STEP_UP;
      case "enrollment-required":
        return GATE_ENROLLMENT;
      default:
        return GATE_UNAVAILABLE;
    }
  } catch {
    return GATE_UNAVAILABLE;
  }
}

// The fixed refusal a gated change returns before anything is sent.
export const STEP_UP_REQUIRED = Object.freeze({
  status: "step-up-required",
} as const);
export type StepUpRequired = typeof STEP_UP_REQUIRED;

// The refusal for a gated change, or null when the gate lets it through. A
// principal without a stepped-up session is told to step up; a gate that
// could not decide is unavailable.
export function stepUpRefusalOf(
  gate: StepUpGate,
): StepUpRequired | typeof UNAVAILABLE | null {
  switch (gate?.status) {
    case "pass":
      return null;
    case "step-up-required":
    case "enrollment-required":
      return STEP_UP_REQUIRED;
    default:
      return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Fixed destinations
// ---------------------------------------------------------------------------

// The only places a step-up or enrollment ever returns to.
export const STEP_UP_DESTINATIONS = Object.freeze({
  attorney: "/attorney",
  staff: "/staff",
} as const);
export type StepUpDestination =
  (typeof STEP_UP_DESTINATIONS)[keyof typeof STEP_UP_DESTINATIONS];

// The fixed account pages, one address per principal kind.
export const ACCOUNT_PAGES = Object.freeze({
  attorney: Object.freeze({
    security: "/account/security?to=attorney",
    stepUp: "/account/step-up?to=attorney",
  }),
  staff: Object.freeze({
    security: "/account/security?to=staff",
    stepUp: "/account/step-up?to=staff",
  }),
} as const);
export type AccountPage =
  | (typeof ACCOUNT_PAGES)[PrincipalKind]["security"]
  | (typeof ACCOUNT_PAGES)[PrincipalKind]["stepUp"];

// Where a stopped page request is sent: the code confirmation, or the
// authenticator setup when there is no factor yet. An undecidable gate goes
// to the code confirmation page, which reads afresh and shows its own fixed
// state. Null when the gate lets the request through.
export function stepUpPathOf(
  gate: StepUpGate,
  kind: PrincipalKind,
): AccountPage | null {
  if (gate?.status === "pass") {
    return null;
  }
  const pages = isOneOf(PRINCIPAL_KINDS, kind)
    ? ACCOUNT_PAGES[kind]
    : ACCOUNT_PAGES.staff;
  return gate?.status === "enrollment-required" ? pages.security : pages.stepUp;
}

// The principal kind a request names: exactly one of the fixed words given
// once, or null for anything else (absent, repeated, or any other value).
export function requestedKindOf(value: unknown): PrincipalKind | null {
  const single = Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : null
    : value;
  return isOneOf(PRINCIPAL_KINDS, single) ? single : null;
}

// The kind a step-up serves: the requested one when the principal holds it,
// otherwise the first kind the principal holds. Never anything the request
// wrote beyond choosing between the principal's own kinds.
export function servedKindOf(
  requested: unknown,
  kinds: readonly PrincipalKind[],
): PrincipalKind {
  const asked = requestedKindOf(requested);
  if (asked !== null && kinds.includes(asked)) {
    return asked;
  }
  return PRINCIPAL_KINDS.find((kind) => kinds.includes(kind)) ?? "staff";
}
