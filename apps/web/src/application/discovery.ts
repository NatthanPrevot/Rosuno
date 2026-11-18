// Discovery, client selection and Referral attempts (MVP-001 S5; MBS
// sections 10, 17, 18.1 and 18.6; TA sections 8, 28, 29, 55 and 58; DM
// section 7).
//
// Provider-neutral and injectable: each request hands in its own ports.
//
// Public discovery reads only the database's three public functions, which
// derive everything on every read and persist nothing; this module never
// ranks, recommends or reorders: it shows the database's own order
// (display_name_then_id) and its own allowlisted fields, and reads each row
// strictly, so an unexpected column or value makes the whole answer
// unavailable rather than partly shown. The filters are objective only:
// jurisdiction (required), practice area and availability. An unknown or
// manipulated value never broadens a search: the page asks for a listed
// choice instead. A profile that is not listed and an unknown id are the
// same not-found answer.
//
// Selection is the client's own choice. The selection page decides, on the
// server, whether the request is anonymous (it then offers the sign-in
// handoff to exactly this selection), a verified client (the client's own
// open Intakes are offered), or anything else (a fixed refusal). The
// Referral itself is one database function called through the request's own
// authenticated session: the database decides the client, the Intake, the
// fresh eligibility and Bookability, the pool and the presented set again,
// on locked rows, and only its fixed outcome is reported. Before that call
// the environment binding is checked (PS-A2 section 6; Packet rule 7), and a
// mismatched or unrecorded environment refuses the selection. Nothing here
// changes an Intake, and nothing chooses an attorney for the client.
// MVP-001 S6: a recorded selection answers its Referral id, so the page can
// offer the request review for exactly that Referral. MVP-001 S6 PS-A3: a
// profile also carries the attorney's current public offers (PS-A3 section
// 6: modality, duration, listed price and currency, only pairs the platform
// permits and, for a chosen jurisdiction, only the offers priced there), read
// from the database's own public offer function as strictly as the profile.

import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  resolveClientWorkspace,
  verifiedClientIntakeOf,
  verifiedClientOf,
  type ClientIntakeSources,
} from "./client-intake.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import { resolveSession, type ServerSessionSource } from "./session.ts";
import {
  AVAILABILITY_FILTERS,
  directoryPageOf,
  selectionFrom,
  selectionPath,
  signInPathFor,
  type AvailabilityFilter,
  type Selection,
} from "./sign-in-continuation.ts";

export {
  AVAILABILITY_FILTERS,
  type AvailabilityFilter,
  type Selection,
} from "./sign-in-continuation.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export const FILTER_COLUMNS = Object.freeze([
  "filter_kind",
  "id",
  "code",
  "name",
]);
export const DIRECTORY_COLUMNS = Object.freeze([
  "display_position",
  "attorney_id",
  "display_name",
  "headline",
  "years_experience",
  "practice_areas",
  "available_now",
  "has_scheduled_availability",
  "more_after",
]);
export const PROFILE_COLUMNS = Object.freeze([
  "attorney_id",
  "display_name",
  "headline",
  "bio",
  "years_experience",
  "jurisdictions",
  "practice_areas",
  "available_now",
  "upcoming_windows",
]);
// MVP-001 S6 PS-A3: public_attorney_offers.
export const PUBLIC_OFFER_COLUMNS = Object.freeze([
  "modality",
  "duration_minutes",
  "listed_price_minor",
  "currency_code",
]);
export const REFERRAL_ATTEMPT_COLUMNS = Object.freeze([
  "attempt_ordinal",
  "created_at",
  "attorney_display_name",
  "request_path",
  "outcome_code",
]);

export const REQUEST_PATHS = Object.freeze(["instant", "scheduled"] as const);
export type RequestPath = (typeof REQUEST_PATHS)[number];

// The database's own fixed outcomes of referral_create.
export const REFERRAL_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "not_found",
  "intake_not_ready",
  "not_available",
  "rate_limited",
] as const);

// The database's page size and the most attempts it lists for one Intake.
export const DIRECTORY_PAGE_SIZE = 20;
export const MAX_REFERRAL_ATTEMPTS = 50;
// The most windows and jurisdictions a public profile carries.
const MAX_PROFILE_WINDOWS = 5;
const MAX_PROFILE_JURISDICTIONS = 20;
// The most public offers the database answers for one profile.
const MAX_PUBLIC_OFFERS = 100;

export type DirectoryQueryInput = {
  readonly jurisdictionId: string;
  readonly practiceAreaId: string | null;
  readonly availability: AvailabilityFilter;
  readonly page: number;
};

export type ReferralInput = {
  readonly intakeId: string;
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly practiceAreaId: string | null;
  readonly path: RequestPath;
  readonly availability: AvailabilityFilter;
  readonly page: number;
};

export type DiscoveryReads = {
  // public_discovery_filters()
  readonly filters: () => Promise<RowsResult>;
  // public_attorney_directory(...)
  readonly directory: (query: DirectoryQueryInput) => Promise<RowsResult>;
  // public_attorney_profile(...)
  readonly profile: (
    attorneyId: string,
    jurisdictionId: string | null,
  ) => Promise<RowsResult>;
  // public_attorney_offers(...) (MVP-001 S6 PS-A3)
  readonly offers: (
    attorneyId: string,
    jurisdictionId: string | null,
  ) => Promise<RowsResult>;
  // client_referrals(intake), the caller's own Intake only.
  readonly clientReferrals: (intakeId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type CallAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly value: string | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type DiscoveryWrites = {
  readonly createReferral: (input: ReferralInput) => Promise<CallAnswer>;
};

export type DiscoverySources = {
  readonly session: ServerSessionSource;
  // The client intake sources decide the verified client and its Intakes.
  readonly clientIntake: ClientIntakeSources;
  readonly reads: () => Promise<DiscoveryReads | null>;
  readonly writes: () => Promise<DiscoveryWrites | null>;
  // The server-side environment setting compared with the database's own
  // record before a selection (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type FilterOption = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
};

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isLongText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function isYears(value: unknown): value is number | null {
  return (
    value === null ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 200)
  );
}

function isNameList(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((name) => isText(name, 200))
  );
}

function readOption(value: unknown): FilterOption | null {
  const fields = readExact(value, ["id", "code", "name"]);
  const id = fields?.get("id");
  const code = fields?.get("code");
  const name = fields?.get("name");
  return isUuid(id) && isText(code, 64) && isText(name, 200)
    ? Object.freeze({ id, code, name })
    : null;
}

type FilterRow = FilterOption & {
  readonly kind: "jurisdiction" | "practice_area";
};

function readFilterRow(row: unknown): FilterRow | null {
  const fields = readExact(row, FILTER_COLUMNS);
  const kind = fields?.get("filter_kind");
  if (kind !== "jurisdiction" && kind !== "practice_area") {
    return null;
  }
  const option = readOption({
    id: fields?.get("id"),
    code: fields?.get("code"),
    name: fields?.get("name"),
  });
  return option === null ? null : Object.freeze({ kind, ...option });
}

export type DirectoryEntry = {
  readonly position: number;
  readonly attorneyId: string;
  readonly displayName: string;
  readonly headline: string | null;
  readonly yearsExperience: number | null;
  readonly practiceAreas: readonly string[];
  readonly availableNow: boolean;
  readonly scheduledAvailability: boolean;
  readonly moreAfter: boolean;
};

function readDirectoryRow(row: unknown): DirectoryEntry | null {
  const fields = readExact(row, DIRECTORY_COLUMNS);
  if (fields === null) {
    return null;
  }
  const position = fields.get("display_position");
  const attorneyId = fields.get("attorney_id");
  const displayName = fields.get("display_name");
  const headline = fields.get("headline");
  const years = fields.get("years_experience");
  const areas = fields.get("practice_areas");
  const now = fields.get("available_now");
  const scheduled = fields.get("has_scheduled_availability");
  const more = fields.get("more_after");
  if (
    !Number.isSafeInteger(position) ||
    (position as number) < 1 ||
    !isUuid(attorneyId) ||
    !isText(displayName, 200) ||
    !(headline === null || isText(headline, 300)) ||
    !isYears(years) ||
    !isNameList(areas, 50) ||
    typeof now !== "boolean" ||
    typeof scheduled !== "boolean" ||
    typeof more !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    position: position as number,
    attorneyId,
    displayName,
    headline,
    yearsExperience: years,
    practiceAreas: Object.freeze([...areas]),
    availableNow: now,
    scheduledAvailability: scheduled,
    moreAfter: more,
  });
}

export type OfferedWindow = {
  readonly startsAt: string;
  readonly endsAt: string;
};

function readWindow(value: unknown): OfferedWindow | null {
  const fields = readExact(value, ["starts_at", "ends_at"]);
  const startsAt = fields?.get("starts_at");
  const endsAt = fields?.get("ends_at");
  return isTimestamp(startsAt) &&
    isTimestamp(endsAt) &&
    Date.parse(startsAt) < Date.parse(endsAt)
    ? Object.freeze({ startsAt, endsAt })
    : null;
}

export type AttorneyProfile = {
  readonly attorneyId: string;
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly yearsExperience: number | null;
  readonly jurisdictions: readonly FilterOption[];
  readonly practiceAreas: readonly string[];
  readonly availableNow: boolean;
  readonly windows: readonly OfferedWindow[];
};

function readProfileRow(row: unknown): AttorneyProfile | null {
  const fields = readExact(row, PROFILE_COLUMNS);
  if (fields === null) {
    return null;
  }
  const attorneyId = fields.get("attorney_id");
  const displayName = fields.get("display_name");
  const headline = fields.get("headline");
  const bio = fields.get("bio");
  const years = fields.get("years_experience");
  const jurisdictions = fields.get("jurisdictions");
  const areas = fields.get("practice_areas");
  const now = fields.get("available_now");
  const windows = fields.get("upcoming_windows");
  if (
    !isUuid(attorneyId) ||
    !isText(displayName, 200) ||
    !(headline === null || isText(headline, 300)) ||
    !(bio === null || isLongText(bio, 4000)) ||
    !isYears(years) ||
    !Array.isArray(jurisdictions) ||
    jurisdictions.length < 1 ||
    jurisdictions.length > MAX_PROFILE_JURISDICTIONS ||
    !isNameList(areas, 200) ||
    typeof now !== "boolean" ||
    !Array.isArray(windows) ||
    windows.length > MAX_PROFILE_WINDOWS
  ) {
    return null;
  }
  const listed = readRows(jurisdictions, readOption);
  const offered = readRows(windows, readWindow);
  if (listed === null || offered === null) {
    return null;
  }
  return Object.freeze({
    attorneyId,
    displayName,
    headline,
    bio,
    yearsExperience: years,
    jurisdictions: listed,
    practiceAreas: Object.freeze([...areas]),
    availableNow: now,
    windows: offered,
  });
}

// ---------------------------------------------------------------------------
// The query a request asks for
// ---------------------------------------------------------------------------

export type DiscoveryQuery = {
  readonly jurisdictionId: string | null;
  readonly practiceAreaId: string | null;
  readonly availability: AvailabilityFilter;
  readonly page: number;
  // Whether a value was present but not one the server accepts.
  readonly malformed: boolean;
};

type QueryValue = string | readonly string[] | undefined;

function single(value: QueryValue): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

// The directory query from the request's own query values: a jurisdiction
// and practice-area id, an availability filter and a page. A missing value
// takes its neutral form (no jurisdiction, any practice area, any
// availability, the first page); a present but malformed value is reported so
// the page shows no result for it rather than a broader one.
export function discoveryQueryOf(values: {
  readonly jurisdiction?: QueryValue;
  readonly practice_area?: QueryValue;
  readonly availability?: QueryValue;
  readonly page?: QueryValue;
}): DiscoveryQuery {
  const jurisdiction = single(values.jurisdiction);
  const practiceArea = single(values.practice_area);
  const availability = single(values.availability);
  const page = single(values.page);
  let malformed = false;
  const jurisdictionId =
    jurisdiction === undefined || jurisdiction === ""
      ? null
      : isUuid(jurisdiction)
        ? jurisdiction
        : ((malformed = true), null);
  const practiceAreaId =
    practiceArea === undefined || practiceArea === ""
      ? null
      : isUuid(practiceArea)
        ? practiceArea
        : ((malformed = true), null);
  const filter =
    availability === undefined
      ? "any"
      : isOneOf(AVAILABILITY_FILTERS, availability)
        ? availability
        : ((malformed = true), "any");
  const pageNumber =
    page === undefined ? 1 : (directoryPageOf(page) ?? ((malformed = true), 1));
  return Object.freeze({
    jurisdictionId,
    practiceAreaId,
    availability: filter,
    page: pageNumber,
    malformed,
  });
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

export type DirectoryView =
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly jurisdictions: readonly FilterOption[];
      readonly practiceAreas: readonly FilterOption[];
      readonly query: DiscoveryQuery;
      // Why no result is shown: no jurisdiction chosen yet, or a value that
      // is not one of the listed choices.
      readonly prompt: "choose" | "invalid" | null;
      readonly results: {
        readonly entries: readonly DirectoryEntry[];
        readonly page: number;
        readonly previousPage: number | null;
        readonly nextPage: number | null;
      } | null;
    };

const UNAVAILABLE_VIEW = Object.freeze({ status: "unavailable" } as const);

async function filtersOf(reads: DiscoveryReads): Promise<{
  readonly jurisdictions: readonly FilterOption[];
  readonly practiceAreas: readonly FilterOption[];
} | null> {
  const rows = rowsOf(await attempt(() => reads.filters()));
  if (rows === null || rows.length > 300) {
    return null;
  }
  const read = readRows(rows, readFilterRow);
  if (read === null) {
    return null;
  }
  const strip = ({ id, code, name }: FilterRow): FilterOption =>
    Object.freeze({ id, code, name });
  return {
    jurisdictions: Object.freeze(
      read.filter((r) => r.kind === "jurisdiction").map(strip),
    ),
    practiceAreas: Object.freeze(
      read.filter((r) => r.kind === "practice_area").map(strip),
    ),
  };
}

export async function resolveDirectory(
  sources: Pick<DiscoverySources, "reads">,
  query: DiscoveryQuery,
): Promise<DirectoryView> {
  try {
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const catalog = await filtersOf(reads);
    if (catalog === null) {
      return UNAVAILABLE_VIEW;
    }
    const known = (list: readonly FilterOption[], id: string | null) =>
      id === null || list.some((option) => option.id === id);
    const base = {
      status: "ready" as const,
      jurisdictions: catalog.jurisdictions,
      practiceAreas: catalog.practiceAreas,
      query,
    };
    if (
      query.malformed ||
      !known(catalog.jurisdictions, query.jurisdictionId) ||
      !known(catalog.practiceAreas, query.practiceAreaId)
    ) {
      return Object.freeze({ ...base, prompt: "invalid", results: null });
    }
    if (query.jurisdictionId === null) {
      return Object.freeze({ ...base, prompt: "choose", results: null });
    }
    const rows = rowsOf(
      await attempt(() =>
        reads.directory({
          jurisdictionId: query.jurisdictionId as string,
          practiceAreaId: query.practiceAreaId,
          availability: query.availability,
          page: query.page,
        }),
      ),
    );
    if (rows === null || rows.length > DIRECTORY_PAGE_SIZE) {
      return UNAVAILABLE_VIEW;
    }
    const entries = readRows(rows, readDirectoryRow);
    const first = (query.page - 1) * DIRECTORY_PAGE_SIZE + 1;
    if (
      entries === null ||
      entries.some((entry, index) => entry.position !== first + index) ||
      new Set(entries.map((entry) => entry.attorneyId)).size !== entries.length
    ) {
      return UNAVAILABLE_VIEW;
    }
    const more =
      entries.length > 0 && entries.every((entry) => entry.moreAfter);
    return Object.freeze({
      ...base,
      prompt: null,
      results: Object.freeze({
        entries,
        page: query.page,
        previousPage: query.page > 1 ? query.page - 1 : null,
        nextPage: more ? query.page + 1 : null,
      }),
    });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

// ---------------------------------------------------------------------------
// A public profile
// ---------------------------------------------------------------------------

// One public offer (MVP-001 S6 PS-A3).
export type PublicOffer = {
  readonly modality: string;
  readonly durationMinutes: number;
  readonly listedPriceMinor: number;
  readonly currency: string;
};

function readPublicOffer(row: unknown): PublicOffer | null {
  const fields = readExact(row, PUBLIC_OFFER_COLUMNS);
  const modality = fields?.get("modality");
  const duration = fields?.get("duration_minutes");
  const price = fields?.get("listed_price_minor");
  const currency = fields?.get("currency_code");
  if (
    typeof modality !== "string" ||
    !/^[a-z][a-z0-9_]{1,31}$/.test(modality) ||
    !Number.isSafeInteger(duration) ||
    (duration as number) < 1 ||
    (duration as number) > 1440 ||
    !Number.isSafeInteger(price) ||
    (price as number) < 1 ||
    (price as number) > 1_000_000_000_000 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return null;
  }
  return Object.freeze({
    modality,
    durationMinutes: duration as number,
    listedPriceMinor: price as number,
    currency,
  });
}

export type ProfileView =
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly profile: AttorneyProfile;
      readonly jurisdictionId: string | null;
      readonly offers: readonly PublicOffer[];
    };

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

// One listed attorney's profile. A malformed id or jurisdiction, an unknown
// id and an attorney who is not listed are all the same not-found answer.
export async function resolveAttorneyProfile(
  sources: Pick<DiscoverySources, "reads">,
  attorneyId: unknown,
  jurisdiction: QueryValue,
): Promise<ProfileView> {
  try {
    const value = single(jurisdiction);
    const jurisdictionId =
      value === undefined || value === "" ? null : isUuid(value) ? value : "";
    if (!isUuid(attorneyId) || jurisdictionId === "") {
      return NOT_FOUND;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const rows = rowsOf(
      await attempt(() => reads.profile(attorneyId, jurisdictionId)),
    );
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE_VIEW;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const profile = readProfileRow(rows[0]);
    if (
      profile === null ||
      profile.attorneyId !== attorneyId ||
      (jurisdictionId !== null &&
        !profile.jurisdictions.some((j) => j.id === jurisdictionId)) ||
      (jurisdictionId === null && profile.windows.length > 0)
    ) {
      return UNAVAILABLE_VIEW;
    }
    const offerRows = rowsOf(
      await attempt(() => reads.offers(attorneyId, jurisdictionId)),
    );
    if (offerRows === null || offerRows.length > MAX_PUBLIC_OFFERS) {
      return UNAVAILABLE_VIEW;
    }
    const offers = readRows(offerRows, readPublicOffer);
    if (
      offers === null ||
      new Set(
        offers.map((o) => `${o.modality}|${o.durationMinutes}|${o.currency}`),
      ).size !== offers.length ||
      (jurisdictionId !== null &&
        new Set(offers.map((o) => o.currency)).size > 1)
    ) {
      return UNAVAILABLE_VIEW;
    }
    return Object.freeze({
      status: "ready",
      profile,
      jurisdictionId,
      offers,
    });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectionOf(values: {
  readonly attorney?: QueryValue;
  readonly jurisdiction?: QueryValue;
  readonly practice_area?: QueryValue;
  readonly availability?: QueryValue;
  readonly page?: QueryValue;
}): Selection | null {
  return selectionFrom({
    attorney: single(values.attorney),
    jurisdiction: single(values.jurisdiction),
    practice_area: single(values.practice_area),
    availability: single(values.availability),
    page: single(values.page),
  });
}

export type SelectableIntake = {
  readonly id: string;
  readonly state: "submitted" | "active";
  readonly createdAt: string;
};

export type SelectionView =
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" }
  | { readonly status: "denied" }
  | { readonly status: "not-available" }
  | { readonly status: "sign-in-required"; readonly signInHref: string }
  | {
      readonly status: "ready";
      readonly selection: Selection;
      readonly attorneyName: string;
      readonly intakes: readonly SelectableIntake[];
      // Whether the client has more Intakes than the newest page shown.
      readonly moreIntakes: boolean;
      // The directory page the selection came from.
      readonly backHref: string;
    };

// The directory address a selection came from.
export function directoryPathFor(selection: Selection): string {
  return `/find-an-attorney?${[
    `jurisdiction=${selection.jurisdictionId}`,
    ...(selection.practiceAreaId === null
      ? []
      : [`practice_area=${selection.practiceAreaId}`]),
    `availability=${selection.availability}`,
    `page=${selection.page}`,
  ].join("&")}`;
}

const OPEN_STATES = Object.freeze(["submitted", "active"] as const);

export async function resolveSelection(
  sources: DiscoverySources,
  selection: Selection | null,
): Promise<SelectionView> {
  try {
    if (selection === null) {
      return Object.freeze({ status: "invalid" });
    }
    const session = await resolveSession(sources.session);
    if (session.status !== "authenticated") {
      return Object.freeze({
        status: "sign-in-required",
        signInHref: signInPathFor(selection),
      });
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return refusalView(client, selection);
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const rows = rowsOf(
      await attempt(() =>
        reads.profile(selection.attorneyId, selection.jurisdictionId),
      ),
    );
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE_VIEW;
    }
    const profile = rows.length === 1 ? readProfileRow(rows[0]) : null;
    if (rows.length === 1 && profile === null) {
      return UNAVAILABLE_VIEW;
    }
    if (profile === null || profile.attorneyId !== selection.attorneyId) {
      return Object.freeze({ status: "not-available" });
    }
    const workspace = await resolveClientWorkspace(sources.clientIntake, "1");
    if (workspace.status !== "ready") {
      return refusalView(workspace, selection);
    }
    const intakes = workspace.intakes
      .filter(
        (intake): intake is typeof intake & { state: "submitted" | "active" } =>
          isOneOf(OPEN_STATES, intake.state),
      )
      .map((intake) =>
        Object.freeze({
          id: intake.id,
          state: intake.state,
          createdAt: intake.createdAt,
        }),
      );
    return Object.freeze({
      status: "ready",
      selection,
      attorneyName: profile.displayName,
      intakes: Object.freeze(intakes),
      moreIntakes: workspace.olderPage !== null,
      backHref: directoryPathFor(selection),
    });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

function refusalView(refusal: Refusal, selection: Selection): SelectionView {
  if (refusal.status === "sign-in-required") {
    return Object.freeze({
      status: "sign-in-required",
      signInHref: signInPathFor(selection),
    });
  }
  return refusal.status === "denied"
    ? Object.freeze({ status: "denied" })
    : UNAVAILABLE_VIEW;
}

// ---------------------------------------------------------------------------
// The selection's server action
// ---------------------------------------------------------------------------

export type SelectionActionState =
  | { readonly status: "idle" }
  | { readonly status: "created"; readonly referralId: string }
  | { readonly status: "invalid" }
  | { readonly status: "not-found" }
  | { readonly status: "intake-not-ready" }
  | { readonly status: "not-available" }
  | { readonly status: "rate-limited" }
  | { readonly status: "outcome-unknown" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

export const INITIAL_SELECTION_STATE: SelectionActionState = Object.freeze({
  status: "idle",
});

const STATE = (status: Exclude<SelectionActionState["status"], "created">) =>
  Object.freeze({ status }) as SelectionActionState;

const SELECTION_FIELDS = Object.freeze([
  "intake",
  "path",
  "attorney",
  "jurisdiction",
  "practice_area",
  "availability",
  "page",
]);

// Each selection field at most once and as text (practice_area may be
// absent); a repeated or non-text field is null. Other names are not read.
function strictFields(formData: FormData): ReadonlyMap<string, string> | null {
  const fields = new Map<string, string>();
  for (const name of SELECTION_FIELDS) {
    const values = formData.getAll(name);
    if (values.length === 0 && name === "practice_area") {
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

function answerOf(answer: unknown): CallAnswer {
  const kind = readExact(answer, ["kind"])?.get("kind");
  if (kind === "rejected" || kind === "unreadable") {
    return Object.freeze({ kind });
  }
  const fields = readExact(answer, ["kind", "outcome", "value"]);
  const outcome = fields?.get("outcome");
  const value = fields?.get("value");
  if (
    fields?.get("kind") !== "answer" ||
    !isOneOf(REFERRAL_OUTCOMES, outcome) ||
    !(value === null || typeof value === "string")
  ) {
    return Object.freeze({ kind: "unreadable" });
  }
  return Object.freeze({ kind: "answer", outcome, value });
}

// Records the client's selection as a Referral of one of the client's own
// Intakes, through the database's own function, and reports only its fixed
// outcome. The submitted values are checked first (each once, of its own
// form); the database decides everything again.
export async function createReferral(
  sources: DiscoverySources,
  formData: unknown,
): Promise<SelectionActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return STATE("unavailable");
    }
    const fields = strictFields(formData);
    if (fields === null) {
      return STATE("invalid");
    }
    const selection = selectionFrom({
      attorney: fields.get("attorney"),
      jurisdiction: fields.get("jurisdiction"),
      practice_area: fields.get("practice_area") ?? "",
      availability: fields.get("availability"),
      page: fields.get("page"),
    });
    const intakeId = fields.get("intake");
    const path = fields.get("path");
    if (
      selection === null ||
      !isUuid(intakeId) ||
      !isOneOf(REQUEST_PATHS, path)
    ) {
      return STATE("invalid");
    }
    const client = await verifiedClientIntakeOf(sources.clientIntake, intakeId);
    if (!("client" in client)) {
      if (client.status === "not-found") {
        return STATE("not-found");
      }
      return STATE(client.status);
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (reads === null || writes === null) {
      return STATE("unavailable");
    }
    const environment = bindEnvironment(
      rowsOf(await attempt(() => reads.environmentIdentity())),
      sources.environment(),
    );
    if (environment === "unrecorded" || environment === "mismatch") {
      return STATE("unavailable");
    }
    const answer = answerOf(
      await attempt(() =>
        writes.createReferral({
          intakeId,
          attorneyId: selection.attorneyId,
          jurisdictionId: selection.jurisdictionId,
          practiceAreaId: selection.practiceAreaId,
          path,
          availability: selection.availability,
          page: selection.page,
        }),
      ),
    );
    if (answer.kind === "rejected") {
      return STATE("unavailable");
    }
    if (answer.kind === "unreadable") {
      return STATE("outcome-unknown");
    }
    switch (answer.outcome) {
      case "created":
        return isUuid(answer.value)
          ? Object.freeze({ status: "created", referralId: answer.value })
          : STATE("outcome-unknown");
      case "invalid":
        return STATE("invalid");
      case "not_found":
        return STATE("not-found");
      case "intake_not_ready":
        return STATE("intake-not-ready");
      case "not_available":
        return STATE("not-available");
      case "rate_limited":
        return STATE("rate-limited");
      default:
        return STATE("outcome-unknown");
    }
  } catch {
    return STATE("unavailable");
  }
}

// ---------------------------------------------------------------------------
// The client's attempts on one Intake
// ---------------------------------------------------------------------------

export type ReferralAttempt = {
  readonly ordinal: number;
  readonly createdAt: string;
  readonly attorneyName: string | null;
  readonly path: RequestPath | null;
  // Whether an outcome has been recorded. The outcome taxonomy is gated
  // configuration, so its codes are never shown as wording.
  readonly outcomeRecorded: boolean;
};

export type IntakeReferralsView =
  | { readonly status: "unavailable" }
  | { readonly status: "not-found" }
  | {
      readonly status: "ready";
      readonly attempts: readonly ReferralAttempt[];
      readonly canSelect: boolean;
    };

function readAttempt(row: unknown): ReferralAttempt | null {
  const fields = readExact(row, REFERRAL_ATTEMPT_COLUMNS);
  if (fields === null) {
    return null;
  }
  const ordinal = fields.get("attempt_ordinal");
  const createdAt = fields.get("created_at");
  const name = fields.get("attorney_display_name");
  const path = fields.get("request_path");
  const outcome = fields.get("outcome_code");
  if (
    !Number.isSafeInteger(ordinal) ||
    (ordinal as number) < 1 ||
    !isTimestamp(createdAt) ||
    !(name === null || isText(name, 200)) ||
    !(path === null || isOneOf(REQUEST_PATHS, path)) ||
    !(
      outcome === null ||
      (typeof outcome === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(outcome))
    )
  ) {
    return null;
  }
  return Object.freeze({
    ordinal: ordinal as number,
    createdAt,
    attorneyName: name,
    path,
    outcomeRecorded: outcome !== null,
  });
}

// The Referral attempts of one of the verified client's own Intakes, in
// order, and whether the client may make another selection for it.
export async function resolveIntakeReferrals(
  sources: Pick<DiscoverySources, "clientIntake" | "reads">,
  intakeId: unknown,
): Promise<IntakeReferralsView> {
  try {
    const intake = await verifiedClientIntakeOf(sources.clientIntake, intakeId);
    if (!("client" in intake)) {
      return intake.status === "not-found" ? NOT_FOUND : UNAVAILABLE_VIEW;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const rows = rowsOf(
      await attempt(() => reads.clientReferrals(intake.intakeId)),
    );
    if (rows === null || rows.length > MAX_REFERRAL_ATTEMPTS) {
      return UNAVAILABLE_VIEW;
    }
    const attempts = readRows(rows, readAttempt);
    if (
      attempts === null ||
      attempts.some((entry, index) => entry.ordinal !== index + 1)
    ) {
      return UNAVAILABLE_VIEW;
    }
    return Object.freeze({
      status: "ready",
      attempts,
      canSelect: isOneOf(OPEN_STATES, intake.state),
    });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

export { selectionPath };
