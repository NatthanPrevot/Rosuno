// Verified Client Reviews (MVP-001 S11; MBS section 16 "Verified Client
// Review"; DM section 9; PS sections 21.1 and P3; TA section 49; MB sections
// 59 to 63).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every action: the
// client through the verified client of the request, the attorney through
// the unchanged Security Shell, staff through the verified staff identity
// holding moderate_reviews. The database decides everything again: the
// Consultation's own client, that it is completed, one review per
// Consultation, the attorney (always derived from the Consultation, never an
// input), every moderation transition and the capability for the
// Consultation's jurisdiction. Nothing is published on submission and nothing
// publishes automatically. Reads are strict: an unexpected column or value
// makes the whole answer unavailable, never partly shown. No aggregate rating
// is stored anywhere: the public count and average are computed by the
// database at read time (PS P3).

import type { AttorneyPrincipalSource } from "./attorney-access.ts";
import type { ClientIntakeSources } from "./client-intake.ts";
import type { EnvironmentConfiguration } from "./environment-binding.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  textField,
  UNAVAILABLE,
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
import type { ServerSessionSource } from "./session.ts";
import {
  verifiedStaffWithAny,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
  admittedAttorney,
  admittedClient,
  environmentBound,
  formFieldsOf,
  IDLE,
  INVALID,
  settle,
  staffOffsetOf,
  staffPageOf,
  staffPageRows,
  type ActionState,
  type CommandAnswer,
  type StaffPager,
} from "./workspace-support.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MODERATION_CAPABILITY = "moderate_reviews";

export const REVIEW_STATES = Object.freeze([
  "submitted",
  "published",
  "rejected",
] as const);
export type ReviewState = (typeof REVIEW_STATES)[number];

// The rating scale the database checks (1 to 5; an owner question).
export const RATINGS = Object.freeze([1, 2, 3, 4, 5] as const);
export type Rating = (typeof RATINGS)[number];
export const MAX_REVIEW_TEXT = 20000;

export const SUBMIT_OUTCOMES = Object.freeze([
  "submitted",
  "invalid",
  "not_eligible",
  "already_reviewed",
]);
export const MODERATE_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "invalid_transition",
]);
export const MODERATION_DECISIONS = Object.freeze([
  "publish",
  "reject",
] as const);
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export const CLIENT_REVIEW_COLUMNS = Object.freeze([
  "consultation_id",
  "consultation_ended_at",
  "review_id",
  "rating",
  "review_text",
  "state",
  "submitted_at",
  "published_at",
  "moderated_at",
]);
export const PUBLISHED_REVIEW_COLUMNS = Object.freeze([
  "rating",
  "review_text",
  "published_at",
]);
export const QUEUE_COLUMNS = Object.freeze([
  "review_id",
  "jurisdiction_id",
  "state",
  "rating",
  "review_text",
  "submitted_at",
  "published_at",
  "moderated_at",
]);
export const PUBLIC_REVIEW_COLUMNS = Object.freeze([
  "rating",
  "review_text",
  "published_at",
  "review_count",
  "average_rating",
]);

// The database's own bounds on the lists.
export const MAX_OWN_REVIEWS = 200;
export const MAX_PUBLIC_REVIEWS = 50;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// Request-scoped, unprivileged calls through the database's own functions.
export type ReviewReads = {
  // client_reviews()
  readonly clientReviews: () => Promise<RowsResult>;
  // attorney_reviews()
  readonly attorneyReviews: () => Promise<RowsResult>;
  // staff_review_queue(p_state, p_offset)
  readonly queue: (state: ReviewState, offset: number) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type ReviewWrites = {
  // review_submit(p_consultation_id, p_rating, p_review_text)
  readonly submit: (
    consultationId: string,
    rating: Rating,
    text: string | null,
  ) => Promise<CommandAnswer>;
  // staff_moderate_review(p_review_id, p_decision)
  readonly moderate: (
    reviewId: string,
    decision: ModerationDecision,
  ) => Promise<CommandAnswer>;
};

// public_attorney_reviews(p_attorney_id): anyone, signed in or not.
export type PublicReviewReads = {
  readonly attorneyReviews: (attorneyId: string) => Promise<RowsResult>;
};

type Shared = {
  readonly reads: () => Promise<ReviewReads | null>;
  readonly writes: () => Promise<ReviewWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

export type ClientReviewSources = Shared & {
  readonly clientIntake: ClientIntakeSources;
};

export type AttorneyReviewSources = Shared & {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

export type ModerationSources = Shared & {
  readonly staff: ConfigurationSources;
};

export type PublicReviewSources = {
  readonly reads: () => Promise<PublicReviewReads | null>;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const isRating = (value: unknown): value is Rating =>
  RATINGS.some((rating) => rating === value);
const isReviewText = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_REVIEW_TEXT);

export type OwnReview = {
  readonly id: string;
  readonly rating: Rating;
  readonly text: string | null;
  readonly state: ReviewState;
  readonly submittedAt: string;
  readonly publishedAt: string | null;
  readonly moderatedAt: string | null;
};

export type ReviewableConsultation = {
  readonly consultationId: string;
  readonly endedAt: string;
  // The client's review of it, or null while none was submitted.
  readonly review: OwnReview | null;
};

function readClientReview(row: unknown): ReviewableConsultation | null {
  const f = readExact(row, CLIENT_REVIEW_COLUMNS);
  if (f === null) {
    return null;
  }
  const consultationId = f.get("consultation_id");
  const endedAt = f.get("consultation_ended_at");
  const reviewId = f.get("review_id");
  const rating = f.get("rating");
  const text = f.get("review_text");
  const state = f.get("state");
  const submittedAt = f.get("submitted_at");
  const publishedAt = f.get("published_at");
  const moderatedAt = f.get("moderated_at");
  if (!isUuid(consultationId) || !isTimestamp(endedAt)) {
    return null;
  }
  if (reviewId === null) {
    return [rating, text, state, submittedAt, publishedAt, moderatedAt].every(
      (value) => value === null,
    )
      ? Object.freeze({ consultationId, endedAt, review: null })
      : null;
  }
  if (
    !isUuid(reviewId) ||
    !isRating(rating) ||
    !isReviewText(text) ||
    !isOneOf(REVIEW_STATES, state) ||
    !isTimestamp(submittedAt) ||
    !nullableTime(publishedAt) ||
    !nullableTime(moderatedAt) ||
    (state === "published" && publishedAt === null) ||
    (state === "submitted" && (publishedAt !== null || moderatedAt !== null))
  ) {
    return null;
  }
  return Object.freeze({
    consultationId,
    endedAt,
    review: Object.freeze({
      id: reviewId,
      rating,
      text,
      state,
      submittedAt,
      publishedAt,
      moderatedAt,
    }),
  });
}

export type PublishedReview = {
  readonly rating: Rating;
  readonly text: string | null;
  readonly publishedAt: string;
};

function readPublished(row: unknown): PublishedReview | null {
  const f = readExact(row, PUBLISHED_REVIEW_COLUMNS);
  if (f === null) {
    return null;
  }
  const rating = f.get("rating");
  const text = f.get("review_text");
  const publishedAt = f.get("published_at");
  if (!isRating(rating) || !isReviewText(text) || !isTimestamp(publishedAt)) {
    return null;
  }
  return Object.freeze({ rating, text, publishedAt });
}

export type QueuedReview = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly state: ReviewState;
  readonly rating: Rating;
  readonly text: string | null;
  readonly submittedAt: string;
  readonly publishedAt: string | null;
  readonly moderatedAt: string | null;
};

function readQueued(row: unknown): QueuedReview | null {
  const f = readExact(row, QUEUE_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("review_id"),
    jurisdictionId: f.get("jurisdiction_id"),
    state: f.get("state"),
    rating: f.get("rating"),
    text: f.get("review_text"),
    submittedAt: f.get("submitted_at"),
    publishedAt: f.get("published_at"),
    moderatedAt: f.get("moderated_at"),
  };
  if (
    !isUuid(value.id) ||
    !isUuid(value.jurisdictionId) ||
    !isOneOf(REVIEW_STATES, value.state) ||
    !isRating(value.rating) ||
    !isReviewText(value.text) ||
    !isTimestamp(value.submittedAt) ||
    !nullableTime(value.publishedAt) ||
    !nullableTime(value.moderatedAt) ||
    (value.state === "published" && value.publishedAt === null)
  ) {
    return null;
  }
  return Object.freeze(value) as QueuedReview;
}

// ---------------------------------------------------------------------------
// The client's reviews
// ---------------------------------------------------------------------------

export type ClientReviewsView =
  | {
      readonly status: "ready";
      readonly consultations: readonly ReviewableConsultation[];
    }
  | Refusal;

// The client's completed Consultations, each with its review or none: the
// ones without a review are the ones the client may still review.
export async function resolveClientReviews(
  sources: Pick<ClientReviewSources, "clientIntake" | "reads">,
): Promise<ClientReviewsView> {
  try {
    const access = await admittedClient(sources.clientIntake);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.clientReviews()));
    if (rows === null || rows.length > MAX_OWN_REVIEWS) {
      return UNAVAILABLE;
    }
    const consultations = readRows(rows, readClientReview);
    if (
      consultations === null ||
      new Set(consultations.map((entry) => entry.consultationId)).size !==
        consultations.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", consultations });
  } catch {
    return UNAVAILABLE;
  }
}

export const SUBMIT_ACTION_OUTCOMES = Object.freeze([
  "review_submitted",
  "not_eligible",
  "already_reviewed",
] as const);
export type SubmitActionOutcome = (typeof SUBMIT_ACTION_OUTCOMES)[number];
export type SubmitActionState = ActionState<SubmitActionOutcome>;
export const INITIAL_SUBMIT_STATE: SubmitActionState = IDLE;

const SUBMIT_TABLE: Readonly<Record<string, SubmitActionOutcome>> =
  Object.freeze({
    submitted: "review_submitted",
    not_eligible: "not_eligible",
    already_reviewed: "already_reviewed",
  });

// The client submits the one review of one of their own completed
// Consultations: a rating from the scale and optional text. The form never
// names an attorney; the database derives it from the Consultation.
export async function submitClientReview(
  sources: ClientReviewSources,
  formData: unknown,
): Promise<SubmitActionState> {
  try {
    const fields = formFieldsOf(formData, ["consultation", "rating"], ["text"]);
    const consultationId = fields?.get("consultation");
    const ratingText = fields?.get("rating");
    const text = textField(fields?.get("text"), MAX_REVIEW_TEXT);
    const rating =
      typeof ratingText === "string" && /^[1-5]$/.test(ratingText)
        ? Number(ratingText)
        : null;
    if (
      fields === null ||
      !isUuid(consultationId) ||
      !isRating(rating) ||
      text === null
    ) {
      return INVALID;
    }
    const access = await admittedClient(sources.clientIntake);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (
      reads === null ||
      writes === null ||
      !(await environmentBound(
        () => reads.environmentIdentity(),
        sources.environment,
      ))
    ) {
      return UNAVAILABLE;
    }
    return settle(
      await attempt(() =>
        writes.submit(consultationId, rating, text === "" ? null : text),
      ),
      SUBMIT_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The attorney's published reviews
// ---------------------------------------------------------------------------

export type AttorneyReviewsView =
  | { readonly status: "ready"; readonly reviews: readonly PublishedReview[] }
  | Refusal;

export async function resolveAttorneyReviews(
  sources: Pick<AttorneyReviewSources, "session" | "attorney" | "reads">,
): Promise<AttorneyReviewsView> {
  try {
    const access = await admittedAttorney(sources.session, sources.attorney);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.attorneyReviews()));
    if (rows === null || rows.length > MAX_OWN_REVIEWS) {
      return UNAVAILABLE;
    }
    const reviews = readRows(rows, readPublished);
    return reviews === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", reviews });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Staff moderation
// ---------------------------------------------------------------------------

export function reviewStateOf(value: unknown): ReviewState {
  return isOneOf(REVIEW_STATES, value) ? value : "submitted";
}

export type ModerationQueueView =
  | {
      readonly status: "ready";
      readonly reviewState: ReviewState;
      readonly reviews: readonly QueuedReview[];
      readonly pager: StaffPager;
    }
  | Refusal;

// One page of the reviews in one state, in the jurisdictions the caller holds
// moderate_reviews for.
export async function resolveModerationQueue(
  sources: ModerationSources,
  stateValue: unknown,
  pageValue: unknown,
): Promise<ModerationQueueView> {
  try {
    const reviewState = reviewStateOf(stateValue);
    const page = staffPageOf(pageValue);
    const staff = await verifiedStaffWithAny(
      sources.staff,
      MODERATION_CAPABILITY,
    );
    if (!("userId" in staff)) {
      return staff;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() => reads.queue(reviewState, staffOffsetOf(page))),
      ),
      readQueued,
      page,
    );
    if (read === null || read.rows.some((row) => row.state !== reviewState)) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      reviewState,
      reviews: read.rows,
      pager: read.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export const MODERATE_ACTION_OUTCOMES = Object.freeze([
  "applied",
  "not_found",
  "invalid_transition",
] as const);
export type ModerateActionOutcome = (typeof MODERATE_ACTION_OUTCOMES)[number];
export type ModerateActionState = ActionState<ModerateActionOutcome>;
export const INITIAL_MODERATE_STATE: ModerateActionState = IDLE;

const MODERATE_TABLE: Readonly<Record<string, ModerateActionOutcome>> =
  Object.freeze({
    applied: "applied",
    not_found: "not_found",
    invalid_transition: "invalid_transition",
  });

// Staff publish or reject a submitted review, or take a published one down
// (reject). The database decides the transition and audits it without the
// text.
export async function moderateReview(
  sources: ModerationSources,
  formData: unknown,
): Promise<ModerateActionState> {
  try {
    const fields = formFieldsOf(formData, ["review", "decision"]);
    const reviewId = fields?.get("review");
    const decision = fields?.get("decision");
    if (!isUuid(reviewId) || !isOneOf(MODERATION_DECISIONS, decision)) {
      return INVALID;
    }
    const staff = await verifiedStaffWithAny(
      sources.staff,
      MODERATION_CAPABILITY,
    );
    if (!("userId" in staff)) {
      return staff;
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (
      reads === null ||
      writes === null ||
      !(await environmentBound(
        () => reads.environmentIdentity(),
        sources.environment,
      ))
    ) {
      return UNAVAILABLE;
    }
    return settle(
      await attempt(() => writes.moderate(reviewId, decision)),
      MODERATE_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The public read
// ---------------------------------------------------------------------------

export type PublicReviews = {
  readonly reviews: readonly PublishedReview[];
  // Computed by the database at read time over every published review.
  readonly count: number;
  readonly average: number | null;
};

const EMPTY_PUBLIC = Object.freeze({
  reviews: Object.freeze([]),
  count: 0,
  average: null,
});

// The published reviews of an attorney the public profile lists, with their
// count and average; none for an unlisted or unknown attorney, and null when
// they cannot be read (the profile still shows without them).
export async function resolvePublicReviews(
  sources: PublicReviewSources,
  attorneyId: unknown,
): Promise<PublicReviews | null> {
  try {
    if (!isUuid(attorneyId)) {
      return EMPTY_PUBLIC;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return null;
    }
    const rows = rowsOf(await attempt(() => reads.attorneyReviews(attorneyId)));
    if (rows === null || rows.length > MAX_PUBLIC_REVIEWS) {
      return null;
    }
    if (rows.length === 0) {
      return EMPTY_PUBLIC;
    }
    const reviews: PublishedReview[] = [];
    let count: number | null = null;
    let average: number | null = null;
    for (const row of rows) {
      const f = readExact(row, PUBLIC_REVIEW_COLUMNS);
      const review =
        f === null
          ? null
          : readPublished({
              rating: f.get("rating"),
              review_text: f.get("review_text"),
              published_at: f.get("published_at"),
            });
      const rowCount = f?.get("review_count");
      const rowAverage = averageOf(f?.get("average_rating"));
      if (
        review === null ||
        !Number.isSafeInteger(rowCount) ||
        (rowCount as number) < rows.length ||
        rowAverage === null ||
        (count !== null && (rowCount !== count || rowAverage !== average))
      ) {
        return null;
      }
      count = rowCount as number;
      average = rowAverage;
      reviews.push(review);
    }
    return Object.freeze({
      reviews: Object.freeze(reviews),
      count: count as number,
      average,
    });
  } catch {
    return null;
  }
}

// A numeric average as the database answers it (a number or its text form),
// between 1 and 5.
function averageOf(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number >= 1 && number <= 5 ? number : null;
}

export function clientReviewsPath(): string {
  return "/client/reviews";
}
