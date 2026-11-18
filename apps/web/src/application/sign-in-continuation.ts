// Discovery to sign-in handoff (MVP-001 S5; MBS section 18.1: discovery moves
// into the authenticated workflow without operator intervention; MBS section
// 18.6: manipulated state is refused).
//
// Pure and dependency-light, so the sign-in page can use it as well as the
// server. A continuation is never a free destination: the only one that
// exists is the attorney selection page, and only with its own parameters
// (an attorney id, a jurisdiction id, an optional practice-area id, one of
// three availability filters and a page number). Every value is checked and
// the path is rebuilt from the checked values, so nothing the browser sends
// is ever echoed into a redirect. Anything else answers null, and sign-in
// then returns to the fixed home page.

import { isOneOf, isUuid } from "./professional-records.ts";

export const SELECTION_PATH = "/find-an-attorney/select";

// The sign-in query value and form field that carry a continuation.
export const CONTINUATION_FIELD = "continuation";

export const AVAILABILITY_FILTERS = Object.freeze([
  "any",
  "instant",
  "scheduled",
] as const);
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number];

// Directory pages run from 1 to 25 (the database's own bound).
export const MAX_DIRECTORY_PAGE = 25;

export type Selection = {
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly practiceAreaId: string | null;
  readonly availability: AvailabilityFilter;
  readonly page: number;
};

const SELECTION_KEYS = Object.freeze([
  "attorney",
  "jurisdiction",
  "practice_area",
  "availability",
  "page",
]);

// A page number written plainly: 1 to 25, no sign, no leading zero.
export function directoryPageOf(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]?$/.test(value)) {
    return null;
  }
  const page = Number(value);
  return page <= MAX_DIRECTORY_PAGE ? page : null;
}

// One selection from already-separated values, or null unless every value is
// valid: practice_area may be absent or empty, everything else is required.
export function selectionFrom(values: {
  readonly attorney?: unknown;
  readonly jurisdiction?: unknown;
  readonly practice_area?: unknown;
  readonly availability?: unknown;
  readonly page?: unknown;
}): Selection | null {
  const practiceArea =
    values.practice_area === undefined || values.practice_area === ""
      ? null
      : values.practice_area;
  const page = directoryPageOf(values.page);
  if (
    !isUuid(values.attorney) ||
    !isUuid(values.jurisdiction) ||
    !(practiceArea === null || isUuid(practiceArea)) ||
    !isOneOf(AVAILABILITY_FILTERS, values.availability) ||
    page === null
  ) {
    return null;
  }
  return Object.freeze({
    attorneyId: values.attorney,
    jurisdictionId: values.jurisdiction,
    practiceAreaId: practiceArea,
    availability: values.availability,
    page,
  });
}

// The canonical selection path, rebuilt from checked values only.
export function selectionPath(selection: Selection): string {
  const query = [
    `attorney=${selection.attorneyId}`,
    `jurisdiction=${selection.jurisdictionId}`,
    ...(selection.practiceAreaId === null
      ? []
      : [`practice_area=${selection.practiceAreaId}`]),
    `availability=${selection.availability}`,
    `page=${selection.page}`,
  ];
  return `${SELECTION_PATH}?${query.join("&")}`;
}

// The canonical selection path a continuation names, or null. The value must
// be one string: the selection path, "?", and only the selection keys, each
// at most once, with no fragment, encoding trick or other character.
export function continuationOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) {
    return null;
  }
  const prefix = `${SELECTION_PATH}?`;
  if (!value.startsWith(prefix)) {
    return null;
  }
  const query = value.slice(prefix.length);
  if (!/^[a-z0-9_=&-]+$/.test(query)) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const parts = pair.split("=");
    const [key, entry] = parts;
    if (
      parts.length !== 2 ||
      key === undefined ||
      entry === undefined ||
      !SELECTION_KEYS.includes(key) ||
      Object.hasOwn(values, key)
    ) {
      return null;
    }
    values[key] = entry;
  }
  const selection = selectionFrom(values);
  return selection === null ? null : selectionPath(selection);
}

// Where a successful sign-in goes: the canonical selection path the submitted
// form names in exactly one continuation field, or the fixed home page.
export function signInDestinationOf(formData: unknown): string {
  if (!(formData instanceof FormData)) {
    return "/";
  }
  const values = formData.getAll(CONTINUATION_FIELD);
  if (values.length !== 1) {
    return "/";
  }
  return continuationOf(values[0]) ?? "/";
}

// The sign-in address that continues to a selection afterwards.
export function signInPathFor(selection: Selection): string {
  return `/sign-in?${CONTINUATION_FIELD}=${encodeURIComponent(selectionPath(selection))}`;
}
