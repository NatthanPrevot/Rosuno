// Website and appearance studio: ports, sources and use cases (DEV-001;
// studio specification section 5.2).
//
// Provider-neutral and injectable: each request hands in its own ports. The
// published appearance is read by anyone (the public read answers only the
// published version of the active theme); everything else needs the staff
// capability manage_site_appearance as a global grant at aal2, which the
// database decides again on every call. The application validates every
// configuration it reads or sends with the caller's validator (built from
// the presentation registry, so this module stays registry-agnostic): a
// stored published version is used only when it passes publish mode, a draft
// is sent only when it passes draft mode, and a publication re-reads and
// re-validates the stored draft in publish mode first. Every change is bound
// to the database's own environment record first. Reads are strict: one
// malformed or contradictory row makes the whole answer unavailable. Nothing
// here decides a rule the database decides: commands pass the database's own
// fixed outcomes on, and an answer outside a command's table is unconfirmed.

import {
  isSha256,
  type Issue,
  type ValidAppearance,
  type ValidationMode,
  type ValidationResult,
} from "./appearance-schema.ts";
import {
  ASSET_MEDIA_TYPES,
  base64Of,
  bytesOfBase64,
  inspectImage,
  MAX_ASSET_BYTES,
  type AssetMediaType,
  type ImageProblem,
} from "./appearance-image.ts";
import type { EnvironmentConfiguration } from "./environment-binding.ts";
import {
  attempt,
  DENIED,
  portFrom,
  rowsOf,
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
import {
  verifiedStaffWith,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
  environmentBound,
  UNCONFIRMED,
  type CommandAnswer,
} from "./workspace-support.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const SITE_THEME_KEY = "rosuno";
export const APPEARANCE_CAPABILITY = "manage_site_appearance";

export const THEME_KEY = /^[a-z][a-z0-9-]{1,31}$/;
export const MAX_REVISION = 1_000_000;
export const MAX_LABEL = 80;
export const VERSION_PAGE_SIZE = 25;
export const ASSET_PAGE_SIZE = 50;
export const MAX_LIST_OFFSET = 100_000;
export const MAX_ASSETS = 100;

export const VERSION_STATES = Object.freeze([
  "draft",
  "published",
  "superseded",
  "discarded",
] as const);
export type VersionState = (typeof VERSION_STATES)[number];

// Each command's own fixed outcomes, as the database answers them.
export const SAVE_OUTCOMES = Object.freeze([
  "created",
  "saved",
  "conflict",
  "invalid",
  "denied",
] as const);
export const PUBLISH_OUTCOMES = Object.freeze([
  "published",
  "conflict",
  "not_found",
  "invalid",
  "denied",
] as const);
export const RESTORE_OUTCOMES = Object.freeze([
  "restored",
  "conflict",
  "not_found",
  "invalid",
  "denied",
] as const);
export const RESET_OUTCOMES = Object.freeze([
  "reset",
  "conflict",
  "invalid",
  "denied",
] as const);
export const DISCARD_OUTCOMES = Object.freeze([
  "discarded",
  "conflict",
  "not_found",
  "invalid",
  "denied",
] as const);
export const UPLOAD_OUTCOMES = Object.freeze([
  "stored",
  "exists",
  "limit_reached",
  "invalid",
  "denied",
] as const);

// The result columns of each function, as the migration declares them.
export const PUBLISHED_COLUMNS = Object.freeze([
  "version_id",
  "version_number",
  "theme_key",
  "configuration",
  "configuration_sha256",
  "published_at",
]);
export const ASSET_CONTENT_COLUMNS = Object.freeze([
  "media_type",
  "content_base64",
  "byte_size",
]);
export const OVERVIEW_COLUMNS = Object.freeze([
  "draft_id",
  "draft_revision",
  "draft_configuration",
  "draft_based_on_version_id",
  "draft_updated_at",
  "published_id",
  "published_version_number",
  "published_configuration",
  "published_at",
  "active_theme_key",
]);
export const VERSION_LIST_COLUMNS = Object.freeze([
  "version_id",
  "version_number",
  "state",
  "label",
  "configuration_sha256",
  "based_on_version_id",
  "created_at",
  "updated_at",
  "published_at",
  "published_by_user_id",
  "superseded_at",
  "discarded_at",
]);
export const VERSION_COLUMNS = Object.freeze([
  "version_id",
  "theme_key",
  "state",
  "version_number",
  "configuration",
  "configuration_sha256",
  "label",
  "published_at",
]);
export const PREVIEW_COLUMNS = Object.freeze([
  "version_id",
  "revision",
  "configuration",
]);
export const ASSET_LIST_COLUMNS = Object.freeze([
  "asset_id",
  "sha256",
  "media_type",
  "byte_size",
  "width",
  "height",
  "created_at",
]);
export const SAVE_COLUMNS = Object.freeze([
  "outcome",
  "version_id",
  "revision",
]);
export const PUBLISH_COLUMNS = Object.freeze([
  "outcome",
  "version_id",
  "version_number",
]);
export const UPLOAD_COLUMNS = Object.freeze(["outcome", "asset_id", "sha256"]);

// ---------------------------------------------------------------------------
// Ports and sources
// ---------------------------------------------------------------------------

export type AppearanceReads = {
  // public_site_appearance()
  readonly published: () => Promise<RowsResult>;
  // public_site_appearance_asset(p_sha256)
  readonly publishedAsset: (sha: string) => Promise<RowsResult>;
  // staff_site_appearance_overview(p_theme_key)
  readonly overview: (theme: string) => Promise<RowsResult>;
  // staff_site_appearance_versions(p_theme_key, p_offset)
  readonly versions: (theme: string, offset: number) => Promise<RowsResult>;
  // staff_site_appearance_version(p_version_id)
  readonly version: (id: string) => Promise<RowsResult>;
  // staff_site_appearance_preview(p_theme_key)
  readonly preview: (theme: string) => Promise<RowsResult>;
  // staff_site_appearance_assets(p_offset)
  readonly assets: (offset: number) => Promise<RowsResult>;
  // staff_site_appearance_asset(p_sha256)
  readonly asset: (sha: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type AppearanceWrites = {
  // staff_save_site_appearance_draft(p_theme_key, p_expected_revision,
  // p_configuration); json is the canonical configuration
  readonly saveDraft: (
    theme: string,
    expected: number | null,
    json: string,
  ) => Promise<RowsResult>;
  // staff_publish_site_appearance(p_theme_key, p_draft_id,
  // p_expected_revision, p_label)
  readonly publish: (
    theme: string,
    draftId: string,
    expected: number,
    label: string | null,
  ) => Promise<RowsResult>;
  // staff_restore_site_appearance(p_version_id, p_expected_revision)
  readonly restore: (
    versionId: string,
    expected: number | null,
  ) => Promise<RowsResult>;
  // staff_reset_site_appearance(p_theme_key, p_expected_revision)
  readonly reset: (
    theme: string,
    expected: number | null,
  ) => Promise<RowsResult>;
  // staff_discard_site_appearance_draft(p_draft_id, p_expected_revision)
  readonly discard: (
    draftId: string,
    expected: number,
  ) => Promise<CommandAnswer>;
  // staff_upload_site_appearance_asset(p_media_type, p_width, p_height,
  // p_content_base64)
  readonly uploadAsset: (
    mediaType: string,
    width: number,
    height: number,
    base64: string,
  ) => Promise<RowsResult>;
};

export type AppearanceSources = {
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<AppearanceReads | null>;
  readonly writes: () => Promise<AppearanceWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

// The caller's validator, built from the presentation registry.
export type AppearanceValidator = (
  raw: unknown,
  mode: ValidationMode,
) => ValidationResult;

// ---------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------

export function isThemeKey(value: unknown): value is string {
  return typeof value === "string" && THEME_KEY.test(value);
}

const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= MAX_REVISION;
const isExpected = (value: unknown): value is number | null =>
  value === null || isRevision(value);
const isVersionNumber = isRevision;
const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const nullableId = (value: unknown): value is string | null =>
  value === null || isUuid(value);
const isPlainObject = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isMediaType = (value: unknown): value is AssetMediaType =>
  isOneOf(Object.values(ASSET_MEDIA_TYPES), value);
const isLabel = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" &&
    [...value].length >= 1 &&
    [...value].length <= MAX_LABEL &&
    !/[\u0000-\u001f\u007f]/.test(value));

// A version label from a form: trimmed; empty is none; null when unusable.
export function labelOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  return isLabel(trimmed) ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// The published appearance (anyone)
// ---------------------------------------------------------------------------

export type PublishedAppearance =
  | {
      readonly status: "ready";
      // "none": nothing published; "valid": the stored version passed
      // publish-mode validation; "invalid": it did not, so the defaults
      // apply (the caller logs it).
      readonly stored: "none" | "valid" | "invalid";
      readonly versionId: string | null;
      readonly versionNumber: number | null;
      readonly sha: string | null;
      readonly configuration: ValidAppearance | null;
    }
  | typeof UNAVAILABLE;

const NOTHING_PUBLISHED: PublishedAppearance = Object.freeze({
  status: "ready",
  stored: "none",
  versionId: null,
  versionNumber: null,
  sha: null,
  configuration: null,
});

export async function resolvePublishedAppearance(
  sources: Pick<AppearanceSources, "reads">,
  validate: AppearanceValidator,
): Promise<PublishedAppearance> {
  try {
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.published()));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOTHING_PUBLISHED;
    }
    const f = readExact(rows[0], PUBLISHED_COLUMNS);
    const row = {
      versionId: f?.get("version_id"),
      versionNumber: f?.get("version_number"),
      theme: f?.get("theme_key"),
      configuration: f?.get("configuration"),
      sha: f?.get("configuration_sha256"),
      publishedAt: f?.get("published_at"),
    };
    if (
      f === null ||
      !isUuid(row.versionId) ||
      !isVersionNumber(row.versionNumber) ||
      !isThemeKey(row.theme) ||
      !isPlainObject(row.configuration) ||
      !isSha256(row.sha) ||
      !isTimestamp(row.publishedAt)
    ) {
      return UNAVAILABLE;
    }
    const result = validate(row.configuration, "publish");
    return Object.freeze({
      status: "ready",
      stored: result.ok ? "valid" : "invalid",
      versionId: row.versionId,
      versionNumber: row.versionNumber,
      sha: row.sha,
      configuration: result.ok ? result.value : null,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

// Whether the request's own session holds manage_site_appearance (global
// grant, aal2); any refusal or failure is false.
export async function resolveAppearanceEditor(
  sources: Pick<AppearanceSources, "staff">,
): Promise<boolean> {
  try {
    const staff = await verifiedStaffWith(sources.staff, APPEARANCE_CAPABILITY);
    return "userId" in staff;
  } catch {
    return false;
  }
}

export type PageAppearance = {
  // "default": nothing usable, the owner's design; "published": the live
  // version; "draft": the editor's preview of the saved draft (or of the
  // published version when there is no draft).
  readonly source: "default" | "published" | "draft";
  readonly configuration: ValidAppearance | null;
};

const DEFAULT_PAGE: PageAppearance = Object.freeze({
  source: "default",
  configuration: null,
});

// The appearance a dynamic page renders. In preview mode a holder sees the
// saved draft (draft-mode validation); anyone else, an invalid draft or any
// failure falls back to the published version, and that to the defaults.
export async function resolvePageAppearance(
  sources: AppearanceSources,
  validate: AppearanceValidator,
  preview: boolean,
): Promise<PageAppearance> {
  try {
    if (preview === true && (await resolveAppearanceEditor(sources))) {
      const draft = await previewConfiguration(sources, validate);
      if (draft !== undefined) {
        return draft;
      }
    }
    const published = await resolvePublishedAppearance(sources, validate);
    return published.status === "ready" && published.configuration !== null
      ? Object.freeze({
          source: "published",
          configuration: published.configuration,
        })
      : DEFAULT_PAGE;
  } catch {
    return DEFAULT_PAGE;
  }
}

// The holder's preview configuration, or undefined to fall back.
async function previewConfiguration(
  sources: AppearanceSources,
  validate: AppearanceValidator,
): Promise<PageAppearance | undefined> {
  const reads = await portFrom(sources.reads);
  if (reads === null) {
    return undefined;
  }
  const rows = rowsOf(await attempt(() => reads.preview(SITE_THEME_KEY)));
  if (rows === null || rows.length !== 1) {
    return undefined;
  }
  const f = readExact(rows[0], PREVIEW_COLUMNS);
  const id = f?.get("version_id");
  const revision = f?.get("revision");
  const configuration = f?.get("configuration");
  if (
    f === null ||
    !nullableId(id) ||
    !(revision === null || isRevision(revision))
  ) {
    return undefined;
  }
  if (id === null) {
    return configuration === null && revision === null
      ? DEFAULT_PAGE
      : undefined;
  }
  if (!isPlainObject(configuration)) {
    return undefined;
  }
  const result = validate(configuration, "draft");
  return result.ok
    ? Object.freeze({ source: "draft", configuration: result.value })
    : undefined;
}

type StaffContext = { readonly reads: AppearanceReads } | Refusal;

async function staffContext(sources: AppearanceSources): Promise<StaffContext> {
  const staff = await verifiedStaffWith(sources.staff, APPEARANCE_CAPABILITY);
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { reads };
}

// ---------------------------------------------------------------------------
// Studio reads
// ---------------------------------------------------------------------------

export type StoredDraft = {
  readonly id: string;
  readonly revision: number;
  readonly basedOnVersionId: string | null;
  readonly updatedAt: string;
  // null when the stored draft does not pass draft-mode validation (the
  // studio offers to start again from the published version).
  readonly configuration: ValidAppearance | null;
};
export type StoredPublished = {
  readonly id: string;
  readonly versionNumber: number;
  readonly publishedAt: string;
  readonly configuration: ValidAppearance | null;
};
export type AppearanceOverview = {
  readonly draft: StoredDraft | null;
  readonly published: StoredPublished | null;
  readonly activeTheme: string | null;
};

// The overview row, read strictly. undefined when it is unusable.
function readOverview(
  row: unknown,
  validate: AppearanceValidator,
): AppearanceOverview | undefined {
  const f = readExact(row, OVERVIEW_COLUMNS);
  if (f === null) {
    return undefined;
  }
  const draftId = f.get("draft_id");
  const draftRevision = f.get("draft_revision");
  const draftConfiguration = f.get("draft_configuration");
  const draftBase = f.get("draft_based_on_version_id");
  const draftUpdated = f.get("draft_updated_at");
  const publishedId = f.get("published_id");
  const publishedNumber = f.get("published_version_number");
  const publishedConfiguration = f.get("published_configuration");
  const publishedAt = f.get("published_at");
  const activeTheme = f.get("active_theme_key");
  if (!(activeTheme === null || isThemeKey(activeTheme))) {
    return undefined;
  }
  let draft: StoredDraft | null = null;
  if (draftId === null) {
    if (
      draftRevision !== null ||
      draftConfiguration !== null ||
      draftBase !== null ||
      draftUpdated !== null
    ) {
      return undefined;
    }
  } else {
    if (
      !isUuid(draftId) ||
      !isRevision(draftRevision) ||
      !isPlainObject(draftConfiguration) ||
      !nullableId(draftBase) ||
      !isTimestamp(draftUpdated)
    ) {
      return undefined;
    }
    const result = validate(draftConfiguration, "draft");
    draft = Object.freeze({
      id: draftId,
      revision: draftRevision,
      basedOnVersionId: draftBase,
      updatedAt: draftUpdated,
      configuration: result.ok ? result.value : null,
    });
  }
  let published: StoredPublished | null = null;
  if (publishedId === null) {
    if (
      publishedNumber !== null ||
      publishedConfiguration !== null ||
      publishedAt !== null
    ) {
      return undefined;
    }
  } else {
    if (
      !isUuid(publishedId) ||
      !isVersionNumber(publishedNumber) ||
      !isPlainObject(publishedConfiguration) ||
      !isTimestamp(publishedAt)
    ) {
      return undefined;
    }
    const result = validate(publishedConfiguration, "publish");
    published = Object.freeze({
      id: publishedId,
      versionNumber: publishedNumber,
      publishedAt,
      configuration: result.ok ? result.value : null,
    });
  }
  return Object.freeze({ draft, published, activeTheme });
}

async function overviewOf(
  reads: AppearanceReads,
  validate: AppearanceValidator,
): Promise<AppearanceOverview | undefined> {
  const rows = rowsOf(await attempt(() => reads.overview(SITE_THEME_KEY)));
  return rows === null || rows.length !== 1
    ? undefined
    : readOverview(rows[0], validate);
}

export type VersionSummary = {
  readonly id: string;
  readonly versionNumber: number | null;
  readonly state: VersionState;
  readonly label: string | null;
  readonly sha: string;
  readonly basedOnVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly publishedByUserId: string | null;
  readonly supersededAt: string | null;
  readonly discardedAt: string | null;
};

function readVersionSummary(row: unknown): VersionSummary | null {
  const f = readExact(row, VERSION_LIST_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("version_id"),
    versionNumber: f.get("version_number"),
    state: f.get("state"),
    label: f.get("label"),
    sha: f.get("configuration_sha256"),
    basedOnVersionId: f.get("based_on_version_id"),
    createdAt: f.get("created_at"),
    updatedAt: f.get("updated_at"),
    publishedAt: f.get("published_at"),
    publishedByUserId: f.get("published_by_user_id"),
    supersededAt: f.get("superseded_at"),
    discardedAt: f.get("discarded_at"),
  };
  const numbered = value.state === "published" || value.state === "superseded";
  if (
    !isUuid(value.id) ||
    !isOneOf(VERSION_STATES, value.state) ||
    !(numbered
      ? isVersionNumber(value.versionNumber)
      : value.versionNumber === null) ||
    !isLabel(value.label) ||
    !isSha256(value.sha) ||
    !nullableId(value.basedOnVersionId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !(numbered ? isTimestamp(value.publishedAt) : value.publishedAt === null) ||
    !(numbered
      ? isUuid(value.publishedByUserId)
      : value.publishedByUserId === null) ||
    !(value.state === "superseded"
      ? isTimestamp(value.supersededAt)
      : value.supersededAt === null) ||
    !(value.state === "discarded"
      ? isTimestamp(value.discardedAt)
      : value.discardedAt === null)
  ) {
    return null;
  }
  return Object.freeze(value) as VersionSummary;
}

export type AssetSummary = {
  readonly id: string;
  readonly sha: string;
  readonly mediaType: AssetMediaType;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
};

const isDimension = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 16 &&
  (value as number) <= 4096;

function readAssetSummary(row: unknown): AssetSummary | null {
  const f = readExact(row, ASSET_LIST_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("asset_id"),
    sha: f.get("sha256"),
    mediaType: f.get("media_type"),
    byteSize: f.get("byte_size"),
    width: f.get("width"),
    height: f.get("height"),
    createdAt: f.get("created_at"),
  };
  if (
    !isUuid(value.id) ||
    !isSha256(value.sha) ||
    !isMediaType(value.mediaType) ||
    !Number.isSafeInteger(value.byteSize) ||
    (value.byteSize as number) < 1 ||
    (value.byteSize as number) > MAX_ASSET_BYTES ||
    !isDimension(value.width) ||
    !isDimension(value.height) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }
  return Object.freeze(value) as AssetSummary;
}

export type Pager = { readonly page: number; readonly hasNext: boolean };

// One page of a list read strictly: every row or none, at most one row more
// than the page holds.
function pageRows<T>(
  rows: readonly unknown[] | null,
  reader: (row: unknown) => T | null,
  page: number,
  size: number,
): { readonly rows: readonly T[]; readonly pager: Pager } | null {
  if (rows === null || rows.length > size + 1) {
    return null;
  }
  const read = readRows(rows, reader);
  return read === null
    ? null
    : {
        rows: Object.freeze(read.slice(0, size)),
        pager: Object.freeze({ page, hasNext: read.length > size }),
      };
}

// The page a value names: 1 for anything that is not a plain page number
// whose offset is within the database's bound.
export function appearancePageOf(value: unknown, size: number): number {
  const text = Array.isArray(value) ? undefined : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,4}$/.test(text)) {
    return 1;
  }
  const page = Number(text);
  return (page - 1) * size <= MAX_LIST_OFFSET ? page : 1;
}

export type AppearanceStudioView =
  | {
      readonly status: "ready";
      readonly theme: string;
      readonly overview: AppearanceOverview;
      readonly versions: readonly VersionSummary[];
      readonly versionsPager: Pager;
      readonly assets: readonly AssetSummary[];
      readonly assetsPager: Pager;
    }
  | Refusal;

export async function resolveAppearanceStudio(
  sources: AppearanceSources,
  validate: AppearanceValidator,
): Promise<AppearanceStudioView> {
  try {
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const [overview, versionRows, assetRows] = await Promise.all([
      overviewOf(context.reads, validate),
      attempt(() => context.reads.versions(SITE_THEME_KEY, 0)),
      attempt(() => context.reads.assets(0)),
    ]);
    const versions = pageRows(
      rowsOf(versionRows),
      readVersionSummary,
      1,
      VERSION_PAGE_SIZE,
    );
    const assets = pageRows(
      rowsOf(assetRows),
      readAssetSummary,
      1,
      ASSET_PAGE_SIZE,
    );
    if (overview === undefined || versions === null || assets === null) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      theme: SITE_THEME_KEY,
      overview,
      versions: versions.rows,
      versionsPager: versions.pager,
      assets: assets.rows,
      assetsPager: assets.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type VersionListView =
  | {
      readonly status: "ready";
      readonly versions: readonly VersionSummary[];
      readonly pager: Pager;
    }
  | Refusal;

export async function listAppearanceVersions(
  sources: AppearanceSources,
  pageValue: unknown,
): Promise<VersionListView> {
  try {
    const page = appearancePageOf(pageValue, VERSION_PAGE_SIZE);
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const read = pageRows(
      rowsOf(
        await attempt(() =>
          context.reads.versions(
            SITE_THEME_KEY,
            (page - 1) * VERSION_PAGE_SIZE,
          ),
        ),
      ),
      readVersionSummary,
      page,
      VERSION_PAGE_SIZE,
    );
    return read === null
      ? UNAVAILABLE
      : Object.freeze({
          status: "ready",
          versions: read.rows,
          pager: read.pager,
        });
  } catch {
    return UNAVAILABLE;
  }
}

export type AssetListView =
  | {
      readonly status: "ready";
      readonly assets: readonly AssetSummary[];
      readonly pager: Pager;
    }
  | Refusal;

export async function listAppearanceAssets(
  sources: AppearanceSources,
  pageValue: unknown,
): Promise<AssetListView> {
  try {
    const page = appearancePageOf(pageValue, ASSET_PAGE_SIZE);
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const read = pageRows(
      rowsOf(
        await attempt(() => context.reads.assets((page - 1) * ASSET_PAGE_SIZE)),
      ),
      readAssetSummary,
      page,
      ASSET_PAGE_SIZE,
    );
    return read === null
      ? UNAVAILABLE
      : Object.freeze({
          status: "ready",
          assets: read.rows,
          pager: read.pager,
        });
  } catch {
    return UNAVAILABLE;
  }
}

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

export type VersionView =
  | {
      readonly status: "ready";
      readonly id: string;
      readonly theme: string;
      readonly state: VersionState;
      readonly versionNumber: number | null;
      readonly sha: string;
      readonly label: string | null;
      readonly publishedAt: string | null;
      // null when the stored configuration does not pass draft-mode
      // validation.
      readonly configuration: ValidAppearance | null;
    }
  | typeof NOT_FOUND
  | Refusal;

// One version for the studio. A malformed id and an unknown one answer
// alike.
export async function readAppearanceVersion(
  sources: AppearanceSources,
  validate: AppearanceValidator,
  versionId: unknown,
): Promise<VersionView> {
  try {
    if (!isUuid(versionId)) {
      return NOT_FOUND;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const rows = rowsOf(await attempt(() => context.reads.version(versionId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const f = readExact(rows[0], VERSION_COLUMNS);
    const value = {
      id: f?.get("version_id"),
      theme: f?.get("theme_key"),
      state: f?.get("state"),
      versionNumber: f?.get("version_number"),
      configuration: f?.get("configuration"),
      sha: f?.get("configuration_sha256"),
      label: f?.get("label"),
      publishedAt: f?.get("published_at"),
    };
    const numbered =
      value.state === "published" || value.state === "superseded";
    if (
      f === null ||
      value.id !== versionId ||
      !isThemeKey(value.theme) ||
      !isOneOf(VERSION_STATES, value.state) ||
      !(numbered
        ? isVersionNumber(value.versionNumber)
        : value.versionNumber === null) ||
      !isPlainObject(value.configuration) ||
      !isSha256(value.sha) ||
      !isLabel(value.label) ||
      !(numbered
        ? isTimestamp(value.publishedAt)
        : value.publishedAt === null) ||
      !nullableTime(value.publishedAt)
    ) {
      return UNAVAILABLE;
    }
    const result = validate(value.configuration, "draft");
    return Object.freeze({
      status: "ready",
      id: value.id,
      theme: value.theme,
      state: value.state,
      versionNumber: value.versionNumber as number | null,
      sha: value.sha,
      label: value.label,
      publishedAt: value.publishedAt as string | null,
      configuration: result.ok ? result.value : null,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Studio commands
// ---------------------------------------------------------------------------

export type AppearanceCommandResult<Outcome extends string> =
  | {
      readonly status: "outcome";
      readonly outcome: Outcome;
      // The version (or asset) the outcome names, its revision, version
      // number or digest; null where the outcome carries none.
      readonly id: string | null;
      readonly revision: number | null;
      readonly versionNumber: number | null;
      readonly sha: string | null;
    }
  // The configuration (or argument) was refused, by the validator (with its
  // issues) or by the database (no issues).
  | { readonly status: "invalid"; readonly issues: readonly Issue[] }
  // Publication only: the stored draft fails the publish-mode contrast rules.
  | { readonly status: "accessibility"; readonly issues: readonly Issue[] }
  // Upload only: the file is not an acceptable image.
  | { readonly status: "image"; readonly problem: ImageProblem }
  | typeof UNCONFIRMED
  | Refusal;

const INVALID_ARGUMENTS = Object.freeze({
  status: "invalid",
  issues: Object.freeze([]),
} as const);

function outcomeOf<Outcome extends string>(
  outcome: Outcome,
  fields: {
    readonly id?: string | null;
    readonly revision?: number | null;
    readonly versionNumber?: number | null;
    readonly sha?: string | null;
  } = {},
): AppearanceCommandResult<Outcome> {
  return Object.freeze({
    status: "outcome",
    outcome,
    id: fields.id ?? null,
    revision: fields.revision ?? null,
    versionNumber: fields.versionNumber ?? null,
    sha: fields.sha ?? null,
  });
}

// One command row (outcome plus two columns), read strictly against the
// command's own outcomes: the successful outcomes carry both values, the
// others none. "denied" is a refusal and "invalid" the invalid argument.
function settleRow<Outcome extends string>(
  result: unknown,
  columns: readonly [string, string, string],
  outcomes: readonly string[],
  successes: readonly Outcome[],
  read: (
    outcome: Outcome,
    first: unknown,
    second: unknown,
  ) => AppearanceCommandResult<Outcome> | null,
): AppearanceCommandResult<Outcome> {
  const rows = rowsOf(result);
  if (rows === null || rows.length !== 1) {
    return UNCONFIRMED;
  }
  const f = readExact(rows[0], columns);
  const outcome = f?.get(columns[0]);
  const first = f?.get(columns[1]);
  const second = f?.get(columns[2]);
  if (
    f === null ||
    typeof outcome !== "string" ||
    !outcomes.includes(outcome)
  ) {
    return UNCONFIRMED;
  }
  if (successes.some((s) => s === outcome)) {
    return read(outcome as Outcome, first, second) ?? UNCONFIRMED;
  }
  if (first !== null || second !== null) {
    return UNCONFIRMED;
  }
  if (outcome === "denied") {
    return DENIED;
  }
  if (outcome === "invalid") {
    return INVALID_ARGUMENTS;
  }
  return outcomeOf(outcome as Outcome);
}

const revisionRow =
  <Outcome extends string>() =>
  (outcome: Outcome, id: unknown, revision: unknown) =>
    isUuid(id) && isRevision(revision)
      ? outcomeOf(outcome, { id, revision })
      : null;

// Binds the environment, then runs one change with the writes port.
async function change<T>(
  sources: AppearanceSources,
  context: { readonly reads: AppearanceReads },
  call: (writes: AppearanceWrites) => Promise<T>,
): Promise<T | typeof UNAVAILABLE> {
  const writes = await portFrom(sources.writes);
  if (
    writes === null ||
    !(await environmentBound(
      () => context.reads.environmentIdentity(),
      sources.environment,
    ))
  ) {
    return UNAVAILABLE;
  }
  return call(writes);
}

export type SaveOutcome = "created" | "saved" | "conflict";

// Saves the editor's validated configuration as the draft: created when no
// revision is expected, else at the expected revision.
export async function saveAppearanceDraft(
  sources: AppearanceSources,
  validate: AppearanceValidator,
  raw: unknown,
  expected: unknown,
): Promise<AppearanceCommandResult<SaveOutcome>> {
  try {
    if (!isExpected(expected)) {
      return INVALID_ARGUMENTS;
    }
    const result = validate(raw, "draft");
    if (!result.ok) {
      return Object.freeze({ status: "invalid", issues: result.issues });
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const answer = await change(sources, context, async (writes) =>
      attempt(() =>
        writes.saveDraft(SITE_THEME_KEY, expected, result.canonical),
      ),
    );
    return answer === UNAVAILABLE
      ? UNAVAILABLE
      : settleRow(
          answer,
          ["outcome", "version_id", "revision"],
          SAVE_OUTCOMES,
          ["created", "saved"],
          revisionRow<SaveOutcome>(),
        );
  } catch {
    return UNAVAILABLE;
  }
}

export type PublishOutcome = "published" | "conflict" | "not_found";

// Publishes the stored draft at the expected revision. The stored draft is
// re-read and validated in publish mode first: a contrast shortfall answers
// accessibility, any other issue invalid, and nothing is sent.
export async function publishAppearance(
  sources: AppearanceSources,
  validate: AppearanceValidator,
  draftId: unknown,
  expected: unknown,
  labelValue: unknown,
): Promise<AppearanceCommandResult<PublishOutcome>> {
  try {
    const label = labelOf(labelValue);
    if (!isUuid(draftId) || !isRevision(expected) || label === undefined) {
      return INVALID_ARGUMENTS;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const rows = rowsOf(
      await attempt(() => context.reads.overview(SITE_THEME_KEY)),
    );
    if (rows === null || rows.length !== 1) {
      return UNAVAILABLE;
    }
    // The stored draft as it is, validated by the caller's rules.
    const f = readExact(rows[0], OVERVIEW_COLUMNS);
    if (f === null || readOverview(rows[0], validate) === undefined) {
      return UNAVAILABLE;
    }
    if (f.get("draft_id") !== draftId) {
      return outcomeOf<PublishOutcome>("not_found");
    }
    if (f.get("draft_revision") !== expected) {
      return outcomeOf<PublishOutcome>("conflict");
    }
    const result = validate(f.get("draft_configuration"), "publish");
    if (!result.ok) {
      return Object.freeze({
        status: result.issues.every((issue) => issue.code === "contrast")
          ? "accessibility"
          : "invalid",
        issues: result.issues,
      });
    }
    const answer = await change(sources, context, async (writes) =>
      attempt(() => writes.publish(SITE_THEME_KEY, draftId, expected, label)),
    );
    return answer === UNAVAILABLE
      ? UNAVAILABLE
      : settleRow<PublishOutcome>(
          answer,
          ["outcome", "version_id", "version_number"],
          PUBLISH_OUTCOMES,
          ["published"],
          (outcome, id, versionNumber) =>
            id === draftId && isVersionNumber(versionNumber)
              ? outcomeOf(outcome, { id, versionNumber })
              : null,
        );
  } catch {
    return UNAVAILABLE;
  }
}

export type RestoreOutcome = "restored" | "conflict" | "not_found";

// Makes a published or superseded version the draft (created when no
// revision is expected, else overwritten at the expected revision).
export async function restoreAppearanceVersion(
  sources: AppearanceSources,
  versionId: unknown,
  expected: unknown,
): Promise<AppearanceCommandResult<RestoreOutcome>> {
  try {
    if (!isUuid(versionId) || !isExpected(expected)) {
      return INVALID_ARGUMENTS;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const answer = await change(sources, context, async (writes) =>
      attempt(() => writes.restore(versionId, expected)),
    );
    return answer === UNAVAILABLE
      ? UNAVAILABLE
      : settleRow(
          answer,
          ["outcome", "version_id", "revision"],
          RESTORE_OUTCOMES,
          ["restored"],
          revisionRow<RestoreOutcome>(),
        );
  } catch {
    return UNAVAILABLE;
  }
}

export type ResetOutcome = "reset" | "conflict";

// Replaces the draft with the owner's design (the empty configuration).
export async function resetAppearanceDraft(
  sources: AppearanceSources,
  expected: unknown,
): Promise<AppearanceCommandResult<ResetOutcome>> {
  try {
    if (!isExpected(expected)) {
      return INVALID_ARGUMENTS;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const answer = await change(sources, context, async (writes) =>
      attempt(() => writes.reset(SITE_THEME_KEY, expected)),
    );
    return answer === UNAVAILABLE
      ? UNAVAILABLE
      : settleRow(
          answer,
          ["outcome", "version_id", "revision"],
          RESET_OUTCOMES,
          ["reset"],
          revisionRow<ResetOutcome>(),
        );
  } catch {
    return UNAVAILABLE;
  }
}

export type DiscardOutcome = "discarded" | "conflict" | "not_found";

// Discards the draft at its expected revision.
export async function discardAppearanceDraft(
  sources: AppearanceSources,
  draftId: unknown,
  expected: unknown,
): Promise<AppearanceCommandResult<DiscardOutcome>> {
  try {
    if (!isUuid(draftId) || !isRevision(expected)) {
      return INVALID_ARGUMENTS;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const answer = await change(sources, context, async (writes) =>
      attempt(() => writes.discard(draftId, expected)),
    );
    if (answer === UNAVAILABLE) {
      return UNAVAILABLE;
    }
    const f = readExact(answer, ["kind", "outcome"]);
    const outcome = f?.get("outcome");
    if (f?.get("kind") !== "answer" || typeof outcome !== "string") {
      return readExact(answer, ["kind"])?.get("kind") === "rejected"
        ? UNAVAILABLE
        : UNCONFIRMED;
    }
    if (outcome === "denied") {
      return DENIED;
    }
    if (outcome === "invalid") {
      return INVALID_ARGUMENTS;
    }
    return outcome === "discarded" ||
      outcome === "conflict" ||
      outcome === "not_found"
      ? outcomeOf<DiscardOutcome>(
          outcome,
          outcome === "discarded" ? { id: draftId } : {},
        )
      : UNCONFIRMED;
  } catch {
    return UNAVAILABLE;
  }
}

export type UploadOutcome = "stored" | "exists" | "limit_reached";

// Stores one image in the library: inspected and stripped of its metadata
// here (PNG, JPEG or WebP only), then sent as base64 with its own media type
// and size; the database checks signature, size, dimensions and digest
// again.
export async function uploadAppearanceAsset(
  sources: AppearanceSources,
  bytes: unknown,
): Promise<AppearanceCommandResult<UploadOutcome>> {
  try {
    const image = inspectImage(bytes);
    if (image.status !== "ok") {
      return Object.freeze({ status: "image", problem: image.status });
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const answer = await change(sources, context, async (writes) =>
      attempt(() =>
        writes.uploadAsset(
          image.mediaType,
          image.width,
          image.height,
          base64Of(image.bytes),
        ),
      ),
    );
    return answer === UNAVAILABLE
      ? UNAVAILABLE
      : settleRow<UploadOutcome>(
          answer,
          ["outcome", "asset_id", "sha256"],
          UPLOAD_OUTCOMES,
          ["stored", "exists"],
          (outcome, id, sha) =>
            isUuid(id) && isSha256(sha)
              ? outcomeOf(outcome, { id, sha })
              : null,
        );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Serving an image
// ---------------------------------------------------------------------------

export const ASSET_EXTENSIONS = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
} as const);
export type AssetExtension = keyof typeof ASSET_EXTENSIONS;

export type AssetView =
  | {
      readonly status: "ready";
      // "public": referenced by the published version (cacheable);
      // "private": a library image only a holder may see (never cached).
      readonly scope: "public" | "private";
      readonly mediaType: AssetMediaType;
      readonly bytes: Uint8Array;
    }
  | typeof NOT_FOUND
  | typeof UNAVAILABLE;

function readAssetContent(rows: readonly unknown[] | null):
  | {
      readonly mediaType: AssetMediaType;
      readonly bytes: Uint8Array;
    }
  | null
  | undefined {
  if (rows === null || rows.length > 1) {
    return undefined;
  }
  if (rows.length === 0) {
    return null;
  }
  const f = readExact(rows[0], ASSET_CONTENT_COLUMNS);
  const mediaType = f?.get("media_type");
  const size = f?.get("byte_size");
  const bytes = bytesOfBase64(f?.get("content_base64"));
  if (
    f === null ||
    !isMediaType(mediaType) ||
    bytes === null ||
    bytes.length < 1 ||
    bytes.length > MAX_ASSET_BYTES ||
    size !== bytes.length
  ) {
    return undefined;
  }
  return { mediaType, bytes };
}

// An image by digest and extension: the published one first; else, for a
// holder only, the library image. The extension must match the stored media
// type; anything else is not found.
export async function readAppearanceAsset(
  sources: AppearanceSources,
  sha: unknown,
  extension: unknown,
): Promise<AssetView> {
  try {
    if (
      !isSha256(sha) ||
      typeof extension !== "string" ||
      !Object.hasOwn(ASSET_EXTENSIONS, extension)
    ) {
      return NOT_FOUND;
    }
    const wanted = ASSET_EXTENSIONS[extension as AssetExtension];
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const published = readAssetContent(
      rowsOf(await attempt(() => reads.publishedAsset(sha))),
    );
    if (published === undefined) {
      return UNAVAILABLE;
    }
    if (published !== null) {
      return published.mediaType === wanted
        ? Object.freeze({ status: "ready", scope: "public", ...published })
        : NOT_FOUND;
    }
    if (!(await resolveAppearanceEditor(sources))) {
      return NOT_FOUND;
    }
    const library = readAssetContent(
      rowsOf(await attempt(() => reads.asset(sha))),
    );
    if (library === undefined) {
      return UNAVAILABLE;
    }
    return library !== null && library.mediaType === wanted
      ? Object.freeze({ status: "ready", scope: "private", ...library })
      : NOT_FOUND;
  } catch {
    return UNAVAILABLE;
  }
}
