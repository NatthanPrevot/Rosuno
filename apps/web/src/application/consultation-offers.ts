// The attorney's consultation offers (MVP-001 S6; Physical Specification
// amendment PS-A3 section 4).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every change by
// the unchanged Security Shell over the trusted session and the trusted
// attorney principal source (the existing attorney workspace access); a
// request without an admitted attorney principal sees no offer and sends
// nothing. The database decides everything again: the caller's own approved
// Attorney Profile at aal2, which durations and modalities the platform
// permits now (configuration, never enumerated here), which currencies the
// attorney may offer in, and every change, each audited in its own
// transaction. Reads are strict (an unexpected column or value makes the
// whole answer unavailable) and only the database's fixed outcomes are
// reported. Before a change the environment binding is checked (PS-A2
// section 6; Packet rule 7), and an unrecorded or mismatched environment
// refuses.
//
// A price is entered as an amount in the chosen currency, with at most that
// currency's own number of decimal places, and sent in minor units. Nothing
// here supplies a price, a duration, a modality or a currency: the options
// come from the database, and an attorney's price is the attorney's own
// business input (PS-A3 section 2). A price change creates a new offer and
// keeps the earlier one as history; an offer the platform no longer permits
// stays listed, marked as not currently offered.

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
  type AttorneyWorkspaceStage,
} from "./attorney-access.ts";
import type { CallAnswer } from "./attorney-schedule.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import { readFormFields, type FieldErrors } from "./form-operation.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

export type { CallAnswer } from "./attorney-schedule.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export const OFFER_COLUMNS = Object.freeze([
  "offer_id",
  "modality",
  "duration_minutes",
  "listed_price_minor",
  "currency_code",
  "created_at",
  "withdrawn_at",
  "permitted",
]);
export const OFFER_OPTION_COLUMNS = Object.freeze([
  "options_configured",
  "permitted_durations_minutes",
  "permitted_modalities",
  "allowed_currencies",
]);

// The database's own fixed outcomes.
export const SET_OFFER_OUTCOMES = Object.freeze([
  "created",
  "replaced",
  "unchanged",
  "invalid",
  "denied",
  "options_unavailable",
  "not_permitted",
  "currency_not_allowed",
  "rate_limited",
  "conflict",
]);
export const WITHDRAW_OFFER_OUTCOMES = Object.freeze([
  "withdrawn",
  "already_withdrawn",
  "not_found",
  "denied",
]);

// The most offers the database lists (current first, then history).
export const MAX_OFFERS = 500;
// The largest price, in minor units, an offer may carry (the database's own
// sanity bound).
export const MAX_PRICE_MINOR = 1_000_000_000_000;

const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;
const CURRENCY = /^[A-Z]{3}$/;

export type OfferInput = {
  readonly modality: string;
  readonly durationMinutes: number;
  readonly listedPriceMinor: number;
  readonly currency: string;
};

// Request-scoped, unprivileged reads through the database's own functions.
export type OfferReads = {
  // attorney_consultation_offer_options()
  readonly options: () => Promise<RowsResult>;
  // attorney_consultation_offers()
  readonly offers: () => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

// Request-scoped write port: each call is one database function run for the
// request's own authenticated session. None takes an actor, User or profile.
export type OfferWrites = {
  readonly setOffer: (input: OfferInput) => Promise<CallAnswer>;
  readonly withdrawOffer: (offerId: string) => Promise<CallAnswer>;
};

export type OfferSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
  readonly reads: () => Promise<OfferReads | null>;
  readonly writes: () => Promise<OfferWrites | null>;
  // The server-side environment setting compared with the database's own
  // record before a change (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// The number of decimal places a currency uses (its minor unit), as the
// runtime's currency data knows it; two for a code it does not know.
export function currencyMinorDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return Number.isSafeInteger(digits) && (digits as number) >= 0
      ? (digits as number)
      : 2;
  } catch {
    return 2;
  }
}

// An amount typed in a currency's major unit ("50", "50.5", "50.00") as minor
// units, or null when it is not a plain positive amount with at most the
// currency's decimal places, or is above the sanity bound.
export function amountToMinor(text: string, currency: string): number | null {
  const digits = currencyMinorDigits(currency);
  const pattern =
    digits === 0
      ? /^(\d{1,13})$/
      : new RegExp(`^(\\d{1,13})(?:\\.(\\d{1,${digits}}))?$`);
  const match = pattern.exec(text.trim());
  if (match === null) {
    return null;
  }
  const minor =
    Number(match[1]) * 10 ** digits +
    (digits === 0 ? 0 : Number((match[2] ?? "").padEnd(digits, "0")));
  return Number.isSafeInteger(minor) && minor >= 1 && minor <= MAX_PRICE_MINOR
    ? minor
    : null;
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type OfferView = {
  readonly id: string;
  readonly modality: string;
  readonly durationMinutes: number;
  readonly listedPriceMinor: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly withdrawnAt: string | null;
  // Whether the platform permits this modality and duration now.
  readonly permitted: boolean;
};

export type OfferOptions = {
  readonly configured: boolean;
  readonly durations: readonly number[];
  readonly modalities: readonly string[];
  readonly currencies: readonly string[];
};

export type OffersView =
  | {
      readonly status: "ready";
      readonly stage: AttorneyWorkspaceStage;
      // Null when the database offers this attorney nothing (an attorney
      // profile that is not approved).
      readonly options: OfferOptions | null;
      readonly current: readonly OfferView[];
      readonly history: readonly OfferView[];
    }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);

function isDuration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 1440
  );
}

function isPrice(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_PRICE_MINOR
  );
}

const isModality = (value: unknown): value is string =>
  typeof value === "string" && MODALITY.test(value);
const isCurrency = (value: unknown): value is string =>
  typeof value === "string" && CURRENCY.test(value);

function distinctList<T>(
  value: unknown,
  check: (entry: unknown) => entry is T,
): readonly T[] | null {
  if (!Array.isArray(value) || !value.every(check)) {
    return null;
  }
  return new Set(value).size === value.length
    ? Object.freeze([...value])
    : null;
}

function readOffer(row: unknown): OfferView | null {
  const fields = readExact(row, OFFER_COLUMNS);
  if (fields === null) {
    return null;
  }
  const id = fields.get("offer_id");
  const modality = fields.get("modality");
  const duration = fields.get("duration_minutes");
  const price = fields.get("listed_price_minor");
  const currency = fields.get("currency_code");
  const createdAt = fields.get("created_at");
  const withdrawnAt = fields.get("withdrawn_at");
  const permitted = fields.get("permitted");
  if (
    !isUuid(id) ||
    !isModality(modality) ||
    !isDuration(duration) ||
    !isPrice(price) ||
    !isCurrency(currency) ||
    !isTimestamp(createdAt) ||
    !(withdrawnAt === null || isTimestamp(withdrawnAt)) ||
    typeof permitted !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    id,
    modality,
    durationMinutes: duration,
    listedPriceMinor: price,
    currency,
    createdAt,
    withdrawnAt,
    permitted,
  });
}

function readOptions(row: unknown): OfferOptions | null {
  const fields = readExact(row, OFFER_OPTION_COLUMNS);
  if (fields === null) {
    return null;
  }
  const configured = fields.get("options_configured");
  const durations = distinctList(
    fields.get("permitted_durations_minutes"),
    isDuration,
  );
  const modalities = distinctList(
    fields.get("permitted_modalities"),
    isModality,
  );
  const currencies = distinctList(fields.get("allowed_currencies"), isCurrency);
  if (
    typeof configured !== "boolean" ||
    durations === null ||
    modalities === null ||
    currencies === null ||
    (configured
      ? durations.length === 0 || modalities.length === 0
      : durations.length > 0 || modalities.length > 0)
  ) {
    return null;
  }
  return Object.freeze({ configured, durations, modalities, currencies });
}

// Reads the attorney's own offers and options for the current request. It
// never throws: anything that fails, cannot be read, or does not add up is
// unavailable, and nothing is shown without the attorney principal.
export async function resolveAttorneyOffers(
  sources: OfferSources,
): Promise<OffersView> {
  try {
    const access = await resolveAttorneyWorkspaceAccess({
      session: sources.session,
      attorney: sources.attorney,
    });
    if (access.status === "sign-in-required") {
      return SIGN_IN_REQUIRED;
    }
    if (access.status === "denied") {
      return DENIED;
    }
    if (access.status !== "granted") {
      return UNAVAILABLE;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const [optionRows, offerRows] = (
      await Promise.all([
        attempt(() => reads.options()),
        attempt(() => reads.offers()),
      ])
    ).map(rowsOf);
    if (
      optionRows === null ||
      offerRows === null ||
      optionRows.length > 1 ||
      offerRows.length > MAX_OFFERS
    ) {
      return UNAVAILABLE;
    }
    const offers = readRows(offerRows, readOffer);
    if (offers === null) {
      return UNAVAILABLE;
    }
    let options: OfferOptions | null = null;
    if (optionRows.length === 1) {
      options = readOptions(optionRows[0]);
      if (options === null) {
        return UNAVAILABLE;
      }
    } else if (access.stage === "approved" || offers.length > 0) {
      // An approved attorney (at aal2) always has an options row.
      return UNAVAILABLE;
    }
    const current = offers.filter((offer) => offer.withdrawnAt === null);
    const history = offers.filter((offer) => offer.withdrawnAt !== null);
    return Object.freeze({
      status: "ready",
      stage: access.stage,
      options,
      current: Object.freeze(current),
      history: Object.freeze(history),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export const OFFER_OUTCOMES = Object.freeze([
  "offer_created",
  "offer_replaced",
  "offer_unchanged",
  "offer_withdrawn",
  "offer_already_withdrawn",
  "not_found",
  "not_permitted",
  "currency_not_allowed",
  "options_unavailable",
  "rate_limited",
  "conflict",
] as const);
export type OfferOutcome = (typeof OFFER_OUTCOMES)[number];

export type OfferActionState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "outcome"; readonly outcome: OfferOutcome }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_OFFER_STATE: OfferActionState = Object.freeze({
  status: "idle",
});

const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

function invalid(fieldErrors: Record<string, readonly string[]>) {
  return Object.freeze({
    status: "invalid",
    fieldErrors: Object.freeze(fieldErrors),
  } as const);
}

function outcomeState(outcome: OfferOutcome): OfferActionState {
  return Object.freeze({ status: "outcome", outcome });
}

const REJECTED_BY_DATABASE = invalid({
  submit: ["The offer could not be saved. Check it and try again."],
});

// Admits the request's attorney principal, checks the environment binding,
// then hands the write port to the change. Nothing is sent without both.
async function withWrites(
  sources: OfferSources,
  change: (writes: OfferWrites) => Promise<OfferActionState>,
): Promise<OfferActionState> {
  try {
    const access = await resolveAttorneyWorkspaceAccess({
      session: sources.session,
      attorney: sources.attorney,
    });
    if (access.status === "sign-in-required") {
      return SIGN_IN_REQUIRED;
    }
    if (access.status === "denied") {
      return DENIED;
    }
    if (access.status !== "granted") {
      return UNAVAILABLE;
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (reads === null || writes === null) {
      return UNAVAILABLE;
    }
    const binding = bindEnvironment(
      rowsOf(await attempt(() => reads.environmentIdentity())),
      sources.environment(),
    );
    if (binding === "unrecorded" || binding === "mismatch") {
      return UNAVAILABLE;
    }
    return await change(writes);
  } catch {
    return UNAVAILABLE;
  }
}

// Maps one answer through the change's own table of outcomes. "denied" is
// always a refusal; a database rejection inside the call committed nothing;
// anything unknown is unconfirmed.
function settle(
  answer: unknown,
  table: Readonly<Record<string, OfferActionState>>,
): OfferActionState {
  const fields = readExact(answer, ["kind", "outcome", "value"]);
  if (fields?.get("kind") === "answer") {
    const outcome = fields.get("outcome");
    if (outcome === "denied") {
      return DENIED;
    }
    if (typeof outcome === "string" && Object.hasOwn(table, outcome)) {
      return table[outcome];
    }
    return UNCONFIRMED;
  }
  return readExact(answer, ["kind"])?.get("kind") === "rejected"
    ? REJECTED_BY_DATABASE
    : UNCONFIRMED;
}

// Each named field at most once and as text.
function singleFields(
  formData: FormData,
  names: readonly string[],
): ReadonlyMap<string, string> | null {
  const fields = new Map<string, string>();
  for (const name of names) {
    const values = formData.getAll(name);
    const [value] = values;
    if (values.length !== 1 || typeof value !== "string") {
      return null;
    }
    fields.set(name, value);
  }
  return fields;
}

// The offer to set from the submitted form: one modality, duration and
// currency in their own forms, and the price as an amount in that currency.
export function readOfferForm(
  formData: FormData,
):
  | { readonly ok: true; readonly input: OfferInput }
  | ReturnType<typeof invalid> {
  const fields = singleFields(formData, [
    "modality",
    "duration",
    "currency",
    "price",
  ]);
  if (fields === null) {
    return invalid({ submit: ["Reload the page and try again."] });
  }
  const errors: Record<string, string[]> = {};
  const modality = fields.get("modality") ?? "";
  const duration = fields.get("duration") ?? "";
  const currency = fields.get("currency") ?? "";
  const price = fields.get("price") ?? "";
  if (!isModality(modality)) {
    errors.modality = ["Choose a consultation type from the list."];
  }
  const durationMinutes = /^[1-9][0-9]{0,3}$/.test(duration)
    ? Number(duration)
    : null;
  if (durationMinutes === null || !isDuration(durationMinutes)) {
    errors.duration = ["Choose a length from the list."];
  }
  if (!isCurrency(currency)) {
    errors.currency = ["Choose a currency from the list."];
  }
  const listedPriceMinor = isCurrency(currency)
    ? amountToMinor(price, currency)
    : null;
  if (isCurrency(currency) && listedPriceMinor === null) {
    const digits = currencyMinorDigits(currency);
    errors.price = [
      digits === 0
        ? "Enter a whole amount above zero, without decimals."
        : `Enter an amount above zero with at most ${digits} decimal places.`,
    ];
  }
  if (Object.keys(errors).length > 0 || listedPriceMinor === null) {
    return invalid(errors);
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      modality,
      durationMinutes: durationMinutes as number,
      listedPriceMinor,
      currency,
    }),
  });
}

export async function setConsultationOffer(
  sources: OfferSources,
  formData: FormData,
): Promise<OfferActionState> {
  try {
    const read = readOfferForm(formData);
    if (!("ok" in read)) {
      return read;
    }
    return await withWrites(sources, async (writes) =>
      settle(await attempt(() => writes.setOffer(read.input)), {
        created: outcomeState("offer_created"),
        replaced: outcomeState("offer_replaced"),
        unchanged: outcomeState("offer_unchanged"),
        not_permitted: outcomeState("not_permitted"),
        currency_not_allowed: outcomeState("currency_not_allowed"),
        options_unavailable: outcomeState("options_unavailable"),
        rate_limited: outcomeState("rate_limited"),
        conflict: outcomeState("conflict"),
        invalid: REJECTED_BY_DATABASE,
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}

export async function withdrawConsultationOffer(
  sources: OfferSources,
  formData: FormData,
): Promise<OfferActionState> {
  try {
    const value = readFormFields(formData).get("offer");
    if (!isUuid(value) || formData.getAll("offer").length !== 1) {
      return outcomeState("not_found");
    }
    return await withWrites(sources, async (writes) =>
      settle(await attempt(() => writes.withdrawOffer(value)), {
        withdrawn: outcomeState("offer_withdrawn"),
        already_withdrawn: outcomeState("offer_already_withdrawn"),
        not_found: outcomeState("not_found"),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}
