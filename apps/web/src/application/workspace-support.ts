// Shared, provider-neutral pieces of the completion workspaces (MVP-001 S11):
// admitting the verified client or the attorney of a request, reading a
// submitted form strictly, paging a staff list, binding the environment
// before a change and settling one database answer into a fixed action
// state.
//
// Nothing here decides anything the database decides: every helper only
// refuses early (a missing sign-in, a refused principal, a malformed form, an
// unrecorded or mismatched environment) or passes the database's own fixed
// outcome on. An answer outside the command's own table is never guessed: it
// is reported as unconfirmed.

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
} from "./attorney-access.ts";
import { verifiedClientOf, type ClientIntakeSources } from "./client-intake.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  attempt,
  DENIED,
  rowsOf,
  SIGN_IN_REQUIRED,
  UNAVAILABLE,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import { readExact, readRows } from "./professional-records.ts";
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

export type Admission = "granted" | Refusal;

// The verified client of the request (the client intake sources), or the
// fixed refusal.
export async function admittedClient(
  clientIntake: ClientIntakeSources,
): Promise<Admission> {
  const client = await verifiedClientOf(clientIntake);
  if ("clientId" in client) {
    return "granted";
  }
  return client.status === "sign-in-required"
    ? SIGN_IN_REQUIRED
    : client.status === "denied"
      ? DENIED
      : UNAVAILABLE;
}

// The attorney of the request through the unchanged Security Shell (the
// trusted session and the trusted attorney principal source), or the fixed
// refusal.
export async function admittedAttorney(
  session: ServerSessionSource,
  attorney: AttorneyPrincipalSource,
): Promise<Admission> {
  const access = await resolveAttorneyWorkspaceAccess({ session, attorney });
  if (access.status === "sign-in-required") {
    return SIGN_IN_REQUIRED;
  }
  if (access.status === "denied") {
    return DENIED;
  }
  return access.status === "granted" ? "granted" : UNAVAILABLE;
}

// One answer of a database command, as its adapter read it.
export type CommandAnswer =
  | { readonly kind: "answer"; readonly outcome: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

// What a server action answers: the database's own fixed outcome, or why
// nothing was sent or confirmed.
export type ActionState<Outcome extends string> =
  | { readonly status: "idle" }
  | { readonly status: "outcome"; readonly outcome: Outcome }
  | { readonly status: "invalid" }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const IDLE = Object.freeze({ status: "idle" } as const);
export const INVALID = Object.freeze({ status: "invalid" } as const);
export const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

export function outcomeState<Outcome extends string>(
  outcome: Outcome,
): ActionState<Outcome> {
  return Object.freeze({ status: "outcome", outcome });
}

// Maps one answer through the command's own table. "denied" is always a
// refusal and "invalid" always the invalid form; a database rejection inside
// the call committed nothing; anything unknown is unconfirmed.
export function settle<Outcome extends string>(
  answer: unknown,
  table: Readonly<Record<string, Outcome>>,
): ActionState<Outcome> {
  const fields = readExact(answer, ["kind", "outcome"]);
  if (fields?.get("kind") === "answer") {
    const outcome = fields.get("outcome");
    if (outcome === "denied") {
      return DENIED;
    }
    if (outcome === "invalid") {
      return INVALID;
    }
    if (typeof outcome === "string" && Object.hasOwn(table, outcome)) {
      return outcomeState(table[outcome]);
    }
    return UNCONFIRMED;
  }
  return readExact(answer, ["kind"])?.get("kind") === "rejected"
    ? UNAVAILABLE
    : UNCONFIRMED;
}

// Each named field exactly once and as text (an optional one at most once);
// null when one is missing, repeated or not text. Other fields are ignored.
export function formFieldsOf(
  formData: unknown,
  names: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, string> | null {
  if (!(formData instanceof FormData)) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const name of [...names, ...optional]) {
    const values = formData.getAll(name);
    if (values.length === 0 && optional.includes(name)) {
      continue;
    }
    const [value] = values;
    if (values.length !== 1 || typeof value !== "string") {
      return null;
    }
    fields.set(name, value);
  }
  return fields;
}

// Whether the database's own environment record matches the server-side
// setting (PS-A2 section 6; Packet rule 7). An unrecorded or mismatched
// environment, or an unreadable record, refuses.
export async function environmentBound(
  identity: () => Promise<RowsResult>,
  environment: () => EnvironmentConfiguration,
): Promise<boolean> {
  const binding = bindEnvironment(
    rowsOf(await attempt(identity)),
    environment(),
  );
  return !(binding === "unrecorded" || binding === "mismatch");
}

// One bounded worker run after a change (a room's closing, a provider
// release, an email): nothing depends on it, and the worker route drains the
// backlog later.
export async function drainAfter(drain: () => Promise<void>): Promise<void> {
  try {
    await drain();
  } catch {
    // The jobs stay pending until the next worker run.
  }
}

// The page size of the staff lists; the database answers one more row to
// tell whether another page follows.
export const STAFF_PAGE_SIZE = 25;
const MAX_PAGE = 4000;

export type StaffPager = {
  readonly page: number;
  readonly hasNext: boolean;
};

// The page a query value names: 1 for anything that is not a plain page
// number.
export function staffPageOf(value: unknown): number {
  const text = Array.isArray(value) ? undefined : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,3}$/.test(text)) {
    return 1;
  }
  return Math.min(Number(text), MAX_PAGE);
}

export function staffOffsetOf(page: number): number {
  return (page - 1) * STAFF_PAGE_SIZE;
}

// One page of a staff list read strictly: every row or none, at most one row
// more than the page holds.
export function staffPageRows<T>(
  rows: readonly unknown[] | null,
  reader: (row: unknown) => T | null,
  page: number,
): { readonly rows: readonly T[]; readonly pager: StaffPager } | null {
  if (rows === null || rows.length > STAFF_PAGE_SIZE + 1) {
    return null;
  }
  const read = readRows(rows, reader);
  if (read === null) {
    return null;
  }
  return {
    rows: Object.freeze(read.slice(0, STAFF_PAGE_SIZE)),
    pager: Object.freeze({ page, hasNext: read.length > STAFF_PAGE_SIZE }),
  };
}

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

// A lower-snake code, as the database's own vocabularies are written.
export function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}

// Whether text read from the database is within a bound the database states in
// characters (char_length counts Unicode code points). A string within the
// bound in UTF-16 units is within it in code points; only a longer one (an
// astral character takes two units) is counted.
export function withinCharacters(value: string, maximum: number): boolean {
  return value.length <= maximum || [...value].length <= maximum;
}
