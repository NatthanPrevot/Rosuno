// DEV-001 website and appearance studio application tests (no database):
// the ports, use cases and adapter of the appearance storage (studio
// specification sections 5.1 and 5.2).
//
// Every port is a synthetic in-memory double; every id, configuration, text
// and image is test data. The database decides every rule again (proved by
// apps/web/tests/dev-001-site-appearance-db-proof.mjs); these tests prove
// what the application adds: the capability check and the environment
// binding before anything is sent, the caller's validation of every
// configuration read or sent (publish mode for the live version and for a
// publication, which re-reads the stored draft first), strict row reading,
// the fixed outcome tables, the image inspection before an upload, the
// published-read memo, and literal, bounded calls in one adapter.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APPEARANCE_CAPABILITY,
  appearancePageOf,
  discardAppearanceDraft,
  isThemeKey,
  labelOf,
  listAppearanceAssets,
  listAppearanceVersions,
  publishAppearance,
  readAppearanceAsset,
  readAppearanceVersion,
  resetAppearanceDraft,
  resolveAppearanceEditor,
  resolveAppearanceStudio,
  resolvePageAppearance,
  resolvePublishedAppearance,
  restoreAppearanceVersion,
  saveAppearanceDraft,
  SITE_THEME_KEY,
  uploadAppearanceAsset,
} from "../src/application/appearance.ts";
import { base64Of } from "../src/application/appearance-image.ts";
import { DENIED } from "../src/application/professional-identity.ts";
import { canonicalJson } from "../src/application/appearance-schema.ts";
import { STAFF_CAPABILITIES } from "../src/application/staff-configuration.ts";
import {
  createAppearanceReads,
  createAppearanceWrites,
  invalidatePublishedAppearance,
  PUBLISHED_MEMO_MS,
} from "../src/infrastructure/appearance/appearance-adapter.ts";
import {
  addStaff,
  configurationSources,
  createWorld,
  grant,
  idOf,
} from "./configuration-fixtures.mjs";
import {
  cleanPng,
  idat,
  IEND,
  ihdr,
  png,
  pngChunk,
  SPEC_EXAMPLE,
  SVG,
  validate,
} from "./site-appearance-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const T = "2026-11-26T02:00:00.000000+00:00";
const T2 = "2026-11-26T03:00:00.000000+00:00";
const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DRAFT = idOf(70, 1);
const PUBLISHED = idOf(70, 2);
const OLD = idOf(70, 3);
const ASSET = idOf(71, 1);
const USER = idOf(72, 1);
const rows = (list) => Object.freeze({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const answer = (outcome) => Object.freeze({ kind: "answer", outcome });
const DEV_IDENTITY = rows([
  { environment_class: "development", project_ref: null },
]);
const EMPTY = { schema: 1 };
const LOW_CONTRAST = { schema: 1, tokens: { site: { ink: "#9a9a9a" } } };

const publishedRow = (overrides = {}) => ({
  version_id: PUBLISHED,
  version_number: 2,
  theme_key: "rosuno",
  configuration: SPEC_EXAMPLE,
  configuration_sha256: SHA,
  published_at: T,
  ...overrides,
});
const overviewRow = (overrides = {}) => ({
  draft_id: DRAFT,
  draft_revision: 3,
  draft_configuration: SPEC_EXAMPLE,
  draft_based_on_version_id: PUBLISHED,
  draft_updated_at: T2,
  published_id: PUBLISHED,
  published_version_number: 2,
  published_configuration: EMPTY,
  published_at: T,
  active_theme_key: "rosuno",
  ...overrides,
});
const versionRow = (n, overrides = {}) => ({
  version_id: idOf(73, n),
  version_number: n,
  state: "superseded",
  label: null,
  configuration_sha256: SHA,
  based_on_version_id: null,
  created_at: T,
  updated_at: T,
  published_at: T,
  published_by_user_id: USER,
  superseded_at: T2,
  discarded_at: null,
  ...overrides,
});
const assetRow = (n, overrides = {}) => ({
  asset_id: idOf(74, n),
  sha256: n.toString(16).padStart(64, "0"),
  media_type: "image/png",
  byte_size: 1000,
  width: 16,
  height: 16,
  created_at: T,
  ...overrides,
});
const contentRow = (bytes, overrides = {}) => ({
  media_type: "image/png",
  content_base64: base64Of(new Uint8Array(bytes)),
  byte_size: bytes.length,
  ...overrides,
});

// A synthetic world: a staff member (number 1) and the appearance ports,
// answering what each test configures and recording every call.
function appearanceWorld(answers = {}) {
  const world = createWorld();
  const staff = addStaff(world, 1);
  const calls = [];
  const port =
    (name, fallback) =>
    async (...args) => {
      calls.push([name, ...args]);
      const value = answers[name] ?? fallback;
      return typeof value === "function" ? value(...args) : value;
    };
  const reads = {
    published: port("published", rows([])),
    publishedAsset: port("publishedAsset", rows([])),
    overview: port("overview", rows([overviewRow()])),
    versions: port("versions", rows([])),
    version: port("version", rows([])),
    preview: port(
      "preview",
      rows([{ version_id: null, revision: null, configuration: null }]),
    ),
    assets: port("assets", rows([])),
    asset: port("asset", rows([])),
    environmentIdentity: port("environmentIdentity", DEV_IDENTITY),
  };
  const writes = {
    saveDraft: port(
      "saveDraft",
      rows([{ outcome: "saved", version_id: DRAFT, revision: 4 }]),
    ),
    publish: port(
      "publish",
      rows([{ outcome: "published", version_id: DRAFT, version_number: 3 }]),
    ),
    restore: port(
      "restore",
      rows([{ outcome: "restored", version_id: DRAFT, revision: 4 }]),
    ),
    reset: port(
      "reset",
      rows([{ outcome: "reset", version_id: DRAFT, revision: 4 }]),
    ),
    discard: port("discard", answer("discarded")),
    uploadAsset: port(
      "uploadAsset",
      rows([{ outcome: "stored", asset_id: ASSET, sha256: SHA }]),
    ),
  };
  const sources = {
    staff: configurationSources(world, staff.authId),
    reads: async () => reads,
    writes: async () => writes,
    environment: () => ({
      configuredClass: "development",
      expectedProjectRef: null,
    }),
  };
  return {
    world,
    staff,
    calls,
    sources,
    holder(overrides = {}) {
      grant(world, staff.userId, APPEARANCE_CAPABILITY, overrides);
      return this;
    },
    sent: () => calls.filter(([name]) => Object.hasOwn(writes, name)),
  };
}

test("APP-1 the capability code is the catalogue code the migration adds (pending owner confirmation A53) and a staff capability; the theme is rosuno", () => {
  assert.equal(APPEARANCE_CAPABILITY, "manage_site_appearance");
  assert.ok(STAFF_CAPABILITIES.includes(APPEARANCE_CAPABILITY));
  assert.equal(SITE_THEME_KEY, "rosuno");
  const migration = read(
    "../../supabase/migrations/20261130010000_dev_001_site_appearance.sql",
  );
  assert.match(
    migration,
    /^insert into public\.capability_definitions \(capability_code\)\nvalues \('manage_site_appearance'\);$/m,
  );
  // The six reads check has_staff_capability and the six commands lock the
  // caller through lock_current_capability_staff, each with this code.
  assert.equal(
    migration.match(
      /public\.has_staff_capability\('manage_site_appearance', null, false\)/g,
    ).length,
    6,
  );
  assert.equal(
    migration.match(
      /public\.lock_current_capability_staff\('manage_site_appearance', null\)/g,
    ).length,
    6,
  );
  assert.equal(migration.match(/'manage_site_appearance'/g).length, 13);
  // Every staff function passes a null jurisdiction: only a global grant counts.
  assert.doesNotMatch(migration, /'manage_site_appearance', (?!null)/);
  assert.equal(isThemeKey("rosuno"), true);
  for (const bad of ["Rosuno", "r", "rosuno;x", "", null, "a".repeat(33)]) {
    assert.equal(isThemeKey(bad), false, String(bad));
  }
});

test("APP-2 the published appearance: nothing published answers the defaults; a stored version is used only when it passes publish-mode validation (else the defaults, reported invalid); a malformed, contradictory or repeated row, an unreadable read or a missing port is unavailable", async () => {
  const none = await resolvePublishedAppearance(
    appearanceWorld().sources,
    validate,
  );
  assert.deepEqual(none, {
    status: "ready",
    stored: "none",
    versionId: null,
    versionNumber: null,
    sha: null,
    configuration: null,
  });
  const live = await resolvePublishedAppearance(
    appearanceWorld({ published: rows([publishedRow()]) }).sources,
    validate,
  );
  assert.equal(live.status, "ready");
  assert.equal(live.stored, "valid");
  assert.equal(live.versionId, PUBLISHED);
  assert.equal(live.versionNumber, 2);
  assert.equal(live.sha, SHA);
  assert.deepEqual(live.configuration.tokens, SPEC_EXAMPLE.tokens);
  const invalid = await resolvePublishedAppearance(
    appearanceWorld({
      published: rows([publishedRow({ configuration: LOW_CONTRAST })]),
    }).sources,
    validate,
  );
  assert.equal(invalid.stored, "invalid");
  assert.equal(invalid.configuration, null);
  assert.equal(invalid.versionId, PUBLISHED);
  for (const bad of [
    rows([publishedRow(), publishedRow()]),
    rows([{ ...publishedRow(), extra: 1 }]),
    rows([publishedRow({ version_number: 0 })]),
    rows([publishedRow({ configuration_sha256: "A".repeat(64) })]),
    rows([publishedRow({ configuration: "{}" })]),
    rows([publishedRow({ theme_key: "Rosuno" })]),
    rows([publishedRow({ published_at: "yesterday" })]),
    UNREADABLE,
  ]) {
    assert.deepEqual(
      await resolvePublishedAppearance(
        appearanceWorld({ published: bad }).sources,
        validate,
      ),
      { status: "unavailable" },
    );
  }
  const noPort = { ...appearanceWorld().sources, reads: async () => null };
  assert.deepEqual(await resolvePublishedAppearance(noPort, validate), {
    status: "unavailable",
  });
  const throwing = {
    ...appearanceWorld().sources,
    reads: async () => {
      throw new Error("x");
    },
  };
  assert.deepEqual(await resolvePublishedAppearance(throwing, validate), {
    status: "unavailable",
  });
});

test("APP-3 the editor is exactly a holder of manage_site_appearance as a global grant: a scoped, expired or revoked grant, another capability, no Staff Profile or no session is not one", async () => {
  assert.equal(
    await resolveAppearanceEditor(appearanceWorld().holder().sources),
    true,
  );
  assert.equal(await resolveAppearanceEditor(appearanceWorld().sources), false);
  assert.equal(
    await resolveAppearanceEditor(
      appearanceWorld().holder({ jurisdiction_id: idOf(75, 1) }).sources,
    ),
    false,
  );
  assert.equal(
    await resolveAppearanceEditor(
      appearanceWorld().holder({ revoked_at: T }).sources,
    ),
    false,
  );
  assert.equal(
    await resolveAppearanceEditor(
      appearanceWorld().holder({
        expires_at: "2026-01-01T00:00:00.000000+00:00",
      }).sources,
    ),
    false,
  );
  const other = appearanceWorld();
  grant(other.world, other.staff.userId, "manage_data_requests");
  assert.equal(await resolveAppearanceEditor(other.sources), false);
  const anonymous = appearanceWorld().holder();
  assert.equal(
    await resolveAppearanceEditor({
      ...anonymous.sources,
      staff: {
        ...anonymous.sources.staff,
        session: { currentSubject: async () => null },
      },
    }),
    false,
  );
});

test("APP-4 a dynamic page in preview mode shows a holder the saved draft (draft-mode validation); a non-holder, an invalid or unreadable draft falls back to the published version and that to the defaults; outside preview the draft is never read", async () => {
  const draft = { version_id: DRAFT, revision: 3, configuration: SPEC_EXAMPLE };
  const holder = appearanceWorld({
    preview: rows([draft]),
    published: rows([publishedRow({ configuration: EMPTY })]),
  }).holder();
  const shown = await resolvePageAppearance(holder.sources, validate, true);
  assert.equal(shown.source, "draft");
  assert.deepEqual(shown.configuration.slots, SPEC_EXAMPLE.slots);
  const plain = await resolvePageAppearance(holder.sources, validate, false);
  assert.equal(plain.source, "published");
  const visitor = appearanceWorld({
    preview: rows([draft]),
    published: rows([publishedRow()]),
  });
  const visited = await resolvePageAppearance(visitor.sources, validate, true);
  assert.equal(visited.source, "published");
  assert.ok(!visitor.calls.some(([name]) => name === "preview"));
  const badDraft = appearanceWorld({
    preview: rows([{ ...draft, configuration: { schema: 1, x: 1 } }]),
    published: rows([publishedRow()]),
  }).holder();
  assert.equal(
    (await resolvePageAppearance(badDraft.sources, validate, true)).source,
    "published",
  );
  const emptyPreview = appearanceWorld().holder();
  assert.deepEqual(
    await resolvePageAppearance(emptyPreview.sources, validate, true),
    { source: "default", configuration: null },
  );
  const broken = appearanceWorld({
    preview: UNREADABLE,
    published: UNREADABLE,
  }).holder();
  assert.deepEqual(
    await resolvePageAppearance(broken.sources, validate, true),
    { source: "default", configuration: null },
  );
  const contradictory = appearanceWorld({
    preview: rows([{ version_id: null, revision: 2, configuration: null }]),
  }).holder();
  assert.equal(
    (await resolvePageAppearance(contradictory.sources, validate, true)).source,
    "default",
  );
});

test("APP-5 the studio needs the capability: a holder reads the overview (the draft in draft mode, the published version in publish mode; an unreadable stored draft is reported, not used), the first page of versions and of the image library; every row is read strictly", async () => {
  const refused = appearanceWorld();
  assert.deepEqual(await resolveAppearanceStudio(refused.sources, validate), {
    status: "denied",
  });
  assert.ok(!refused.calls.some(([name]) => name === "overview"));
  const versions = Array.from({ length: 26 }, (_, i) => versionRow(i + 1));
  const assets = Array.from({ length: 51 }, (_, i) => assetRow(i + 1));
  const w = appearanceWorld({
    versions: rows(versions),
    assets: rows(assets),
  }).holder();
  const view = await resolveAppearanceStudio(w.sources, validate);
  assert.equal(view.status, "ready");
  assert.equal(view.theme, "rosuno");
  assert.equal(view.overview.draft.id, DRAFT);
  assert.equal(view.overview.draft.revision, 3);
  assert.deepEqual(view.overview.draft.configuration.slots, SPEC_EXAMPLE.slots);
  assert.equal(view.overview.published.versionNumber, 2);
  assert.equal(view.overview.activeTheme, "rosuno");
  assert.equal(view.versions.length, 25);
  assert.deepEqual(view.versionsPager, { page: 1, hasNext: true });
  assert.equal(view.assets.length, 50);
  assert.deepEqual(view.assetsPager, { page: 1, hasNext: true });
  assert.deepEqual(
    w.calls
      .filter(([name]) => ["overview", "versions", "assets"].includes(name))
      .sort(),
    [
      ["assets", 0],
      ["overview", "rosuno"],
      ["versions", "rosuno", 0],
    ],
  );
  const unreadableDraft = appearanceWorld({
    overview: rows([
      overviewRow({
        draft_configuration: { schema: 1, tokens: { site: { ink: "#FFF" } } },
      }),
    ]),
  }).holder();
  const shown = await resolveAppearanceStudio(
    unreadableDraft.sources,
    validate,
  );
  assert.equal(shown.status, "ready");
  assert.equal(shown.overview.draft.configuration, null);
  const lowContrastPublished = appearanceWorld({
    overview: rows([overviewRow({ published_configuration: LOW_CONTRAST })]),
  }).holder();
  assert.equal(
    (await resolveAppearanceStudio(lowContrastPublished.sources, validate))
      .overview.published.configuration,
    null,
  );
  const noDraft = appearanceWorld({
    overview: rows([
      overviewRow({
        draft_id: null,
        draft_revision: null,
        draft_configuration: null,
        draft_based_on_version_id: null,
        draft_updated_at: null,
      }),
    ]),
  }).holder();
  assert.equal(
    (await resolveAppearanceStudio(noDraft.sources, validate)).overview.draft,
    null,
  );
  for (const answers of [
    { overview: rows([overviewRow({ draft_id: null })]) },
    { overview: rows([overviewRow({ published_id: null })]) },
    { overview: rows([overviewRow(), overviewRow()]) },
    { overview: rows([]) },
    { overview: rows([overviewRow({ active_theme_key: "X" })]) },
    { versions: rows([versionRow(1, { state: "draft" })]) },
    {
      versions: rows([
        versionRow(1, {
          state: "discarded",
          discarded_at: null,
          version_number: null,
          published_at: null,
          published_by_user_id: null,
          superseded_at: null,
        }),
      ]),
    },
    { versions: rows([versionRow(1, { label: "x".repeat(81) })]) },
    { versions: rows(Array.from({ length: 27 }, (_, i) => versionRow(i + 1))) },
    { assets: rows([assetRow(1, { media_type: "image/svg+xml" })]) },
    { assets: rows([assetRow(1, { width: 15 })]) },
    { assets: UNREADABLE },
  ]) {
    assert.deepEqual(
      await resolveAppearanceStudio(
        appearanceWorld(answers).holder().sources,
        validate,
      ),
      { status: "unavailable" },
      JSON.stringify(answers).slice(0, 80),
    );
  }
  // A well-formed draft and discarded version read fine.
  const states = appearanceWorld({
    versions: rows([
      versionRow(1, {
        state: "draft",
        version_number: null,
        published_at: null,
        published_by_user_id: null,
        superseded_at: null,
      }),
      versionRow(2, {
        state: "discarded",
        version_number: null,
        published_at: null,
        published_by_user_id: null,
        superseded_at: null,
        discarded_at: T2,
      }),
      versionRow(3, {
        state: "published",
        superseded_at: null,
        label: "Spring",
      }),
    ]),
  }).holder();
  assert.deepEqual(
    (await resolveAppearanceStudio(states.sources, validate)).versions.map(
      (v) => v.state,
    ),
    ["draft", "discarded", "published"],
  );
});

test("APP-6 the version and library lists page 25 and 50 rows from the page a query names (offsets within the database's bound); one version reads with its configuration validated in draft mode; a malformed or unknown id is not found", async () => {
  assert.equal(appearancePageOf("3", 25), 3);
  assert.equal(appearancePageOf("0", 25), 1);
  assert.equal(appearancePageOf(["2"], 25), 1);
  assert.equal(appearancePageOf("4001", 25), 4001);
  assert.equal(appearancePageOf("4002", 25), 1);
  assert.equal(appearancePageOf("2001", 50), 2001);
  assert.equal(appearancePageOf("2002", 50), 1);
  const w = appearanceWorld({
    versions: rows([versionRow(1)]),
    assets: rows([assetRow(1)]),
  }).holder();
  const list = await listAppearanceVersions(w.sources, "2");
  assert.equal(list.status, "ready");
  assert.deepEqual(list.pager, { page: 2, hasNext: false });
  const library = await listAppearanceAssets(w.sources, "3");
  assert.equal(library.assets[0].mediaType, "image/png");
  assert.deepEqual(
    w.calls.filter(([n]) => n === "versions" || n === "assets"),
    [
      ["versions", "rosuno", 25],
      ["assets", 100],
    ],
  );
  assert.deepEqual(
    await listAppearanceVersions(appearanceWorld().sources, "1"),
    { status: "denied" },
  );
  const one = appearanceWorld({
    version: rows([
      {
        version_id: OLD,
        theme_key: "rosuno",
        state: "superseded",
        version_number: 1,
        configuration: SPEC_EXAMPLE,
        configuration_sha256: SHA,
        label: null,
        published_at: T,
      },
    ]),
  }).holder();
  const version = await readAppearanceVersion(one.sources, validate, OLD);
  assert.equal(version.status, "ready");
  assert.equal(version.versionNumber, 1);
  assert.deepEqual(version.configuration.tokens, SPEC_EXAMPLE.tokens);
  assert.deepEqual(await readAppearanceVersion(one.sources, validate, "x"), {
    status: "not-found",
  });
  assert.deepEqual(
    await readAppearanceVersion(
      appearanceWorld().holder().sources,
      validate,
      OLD,
    ),
    { status: "not-found" },
  );
  const wrongId = appearanceWorld({
    version: rows([
      {
        version_id: DRAFT,
        theme_key: "rosuno",
        state: "draft",
        version_number: null,
        configuration: EMPTY,
        configuration_sha256: SHA,
        label: null,
        published_at: null,
      },
    ]),
  }).holder();
  assert.deepEqual(
    await readAppearanceVersion(wrongId.sources, validate, OLD),
    { status: "unavailable" },
  );
});

test("APP-7 saving a draft: the configuration is validated in draft mode first (issues answer invalid, nothing is sent), the expected revision is null or 1 to 1,000,000, the capability and the environment binding come before the call, the canonical JSON is sent for the rosuno theme, and each database outcome maps to its fixed result", async () => {
  const w = appearanceWorld().holder();
  const saved = await saveAppearanceDraft(w.sources, validate, SPEC_EXAMPLE, 3);
  assert.deepEqual(saved, {
    status: "outcome",
    outcome: "saved",
    id: DRAFT,
    revision: 4,
    versionNumber: null,
    sha: null,
  });
  assert.deepEqual(w.sent(), [
    ["saveDraft", "rosuno", 3, validate(SPEC_EXAMPLE, "draft").canonical],
  ]);
  assert.equal(
    w.sent()[0][3],
    canonicalJson(validate(SPEC_EXAMPLE, "draft").value),
  );
  // Refusals before anything is sent.
  const invalid = await saveAppearanceDraft(
    w.sources,
    validate,
    { schema: 1, x: 1 },
    3,
  );
  assert.equal(invalid.status, "invalid");
  assert.deepEqual(
    invalid.issues.map((i) => i.code),
    ["unknown_key"],
  );
  for (const expected of [0, 1.5, "3", 1_000_001, undefined]) {
    assert.deepEqual(
      await saveAppearanceDraft(w.sources, validate, EMPTY, expected),
      { status: "invalid", issues: [] },
    );
  }
  assert.equal(w.sent().length, 1);
  // A low-contrast draft may be saved (draft mode warns only).
  assert.equal(
    (await saveAppearanceDraft(w.sources, validate, LOW_CONTRAST, null)).status,
    "outcome",
  );
  const refused = appearanceWorld();
  assert.deepEqual(
    await saveAppearanceDraft(refused.sources, validate, EMPTY, null),
    { status: "denied" },
  );
  assert.deepEqual(refused.sent(), []);
  for (const identity of [
    rows([{ environment_class: "unrecorded", project_ref: null }]),
    rows([
      { environment_class: "staging", project_ref: "syntheticprojectrefa" },
    ]),
    UNREADABLE,
  ]) {
    const unbound = appearanceWorld({ environmentIdentity: identity }).holder();
    assert.deepEqual(
      await saveAppearanceDraft(unbound.sources, validate, EMPTY, null),
      { status: "unavailable" },
    );
    assert.deepEqual(unbound.sent(), []);
  }
  const table = [
    [
      { outcome: "created", version_id: DRAFT, revision: 1 },
      {
        status: "outcome",
        outcome: "created",
        id: DRAFT,
        revision: 1,
        versionNumber: null,
        sha: null,
      },
    ],
    [
      { outcome: "conflict", version_id: null, revision: null },
      {
        status: "outcome",
        outcome: "conflict",
        id: null,
        revision: null,
        versionNumber: null,
        sha: null,
      },
    ],
    [
      { outcome: "invalid", version_id: null, revision: null },
      { status: "invalid", issues: [] },
    ],
    [
      { outcome: "denied", version_id: null, revision: null },
      { status: "denied" },
    ],
    [
      { outcome: "created", version_id: null, revision: 1 },
      { status: "unconfirmed" },
    ],
    [
      { outcome: "conflict", version_id: DRAFT, revision: 2 },
      { status: "unconfirmed" },
    ],
    [
      { outcome: "published", version_id: DRAFT, revision: 2 },
      { status: "unconfirmed" },
    ],
    [
      { outcome: "saved", version_id: DRAFT, revision: 0 },
      { status: "unconfirmed" },
    ],
  ];
  for (const [row, expected] of table) {
    const x = appearanceWorld({ saveDraft: rows([row]) }).holder();
    assert.deepEqual(
      await saveAppearanceDraft(x.sources, validate, EMPTY, null),
      expected,
      JSON.stringify(row),
    );
  }
  for (const result of [
    UNREADABLE,
    rows([]),
    rows([{ outcome: "saved", version_id: DRAFT, revision: 2, extra: 1 }]),
  ]) {
    const x = appearanceWorld({ saveDraft: result }).holder();
    assert.deepEqual(
      await saveAppearanceDraft(x.sources, validate, EMPTY, null),
      { status: "unconfirmed" },
    );
  }
});

test("APP-8 publishing re-reads the stored draft and validates it in publish mode before the call: another draft is not found, another revision a conflict, a contrast shortfall accessibility, any other issue invalid, and nothing is sent; the label is trimmed (empty is none, over 80 characters or a control character is invalid)", async () => {
  const w = appearanceWorld().holder();
  const published = await publishAppearance(
    w.sources,
    validate,
    DRAFT,
    3,
    "  Spring theme  ",
  );
  assert.deepEqual(published, {
    status: "outcome",
    outcome: "published",
    id: DRAFT,
    revision: null,
    versionNumber: 3,
    sha: null,
  });
  assert.deepEqual(w.sent(), [["publish", "rosuno", DRAFT, 3, "Spring theme"]]);
  const unlabelled = appearanceWorld().holder();
  await publishAppearance(unlabelled.sources, validate, DRAFT, 3, "   ");
  assert.deepEqual(unlabelled.sent(), [["publish", "rosuno", DRAFT, 3, null]]);
  const cases = [
    [
      appearanceWorld().holder(),
      [OLD, 3, null],
      {
        status: "outcome",
        outcome: "not_found",
        id: null,
        revision: null,
        versionNumber: null,
        sha: null,
      },
    ],
    [
      appearanceWorld().holder(),
      [DRAFT, 2, null],
      {
        status: "outcome",
        outcome: "conflict",
        id: null,
        revision: null,
        versionNumber: null,
        sha: null,
      },
    ],
    [
      appearanceWorld({
        overview: rows([overviewRow({ draft_configuration: LOW_CONTRAST })]),
      }).holder(),
      [DRAFT, 3, null],
      "accessibility",
    ],
    [
      appearanceWorld({
        overview: rows([
          overviewRow({
            draft_configuration: {
              schema: 1,
              components: { "home.nowhere": {} },
            },
          }),
        ]),
      }).holder(),
      [DRAFT, 3, null],
      "invalid",
    ],
    [
      appearanceWorld().holder(),
      [DRAFT, 3, "x".repeat(81)],
      { status: "invalid", issues: [] },
    ],
    [
      appearanceWorld().holder(),
      [DRAFT, 3, "a\u0007b"],
      { status: "invalid", issues: [] },
    ],
    [
      appearanceWorld().holder(),
      ["x", 3, null],
      { status: "invalid", issues: [] },
    ],
    [
      appearanceWorld().holder(),
      [DRAFT, null, null],
      { status: "invalid", issues: [] },
    ],
    [appearanceWorld(), [DRAFT, 3, null], { status: "denied" }],
  ];
  for (const [x, args, expected] of cases) {
    const result = await publishAppearance(x.sources, validate, ...args);
    if (typeof expected === "string") {
      assert.equal(result.status, expected);
      assert.ok(result.issues.length > 0);
    } else {
      assert.deepEqual(result, expected);
    }
    assert.deepEqual(x.sent(), [], JSON.stringify(args));
  }
  for (const [row, expected] of [
    [
      { outcome: "conflict", version_id: null, version_number: null },
      "conflict",
    ],
    [
      { outcome: "not_found", version_id: null, version_number: null },
      "not_found",
    ],
    [
      { outcome: "published", version_id: OLD, version_number: 3 },
      "unconfirmed",
    ],
    [
      { outcome: "published", version_id: DRAFT, version_number: null },
      "unconfirmed",
    ],
  ]) {
    const x = appearanceWorld({ publish: rows([row]) }).holder();
    const result = await publishAppearance(x.sources, validate, DRAFT, 3, null);
    assert.equal(result.outcome ?? result.status, expected);
  }
  assert.equal(labelOf(undefined), null);
  assert.equal(labelOf(""), null);
  assert.equal(labelOf(" A "), "A");
  assert.equal(labelOf(1), undefined);
});

test("APP-9 restoring, resetting and discarding send exactly their arguments after the capability and environment checks and map each database outcome to its fixed result", async () => {
  const w = appearanceWorld().holder();
  assert.deepEqual(await restoreAppearanceVersion(w.sources, OLD, null), {
    status: "outcome",
    outcome: "restored",
    id: DRAFT,
    revision: 4,
    versionNumber: null,
    sha: null,
  });
  assert.deepEqual(await resetAppearanceDraft(w.sources, 3), {
    status: "outcome",
    outcome: "reset",
    id: DRAFT,
    revision: 4,
    versionNumber: null,
    sha: null,
  });
  assert.deepEqual(await discardAppearanceDraft(w.sources, DRAFT, 4), {
    status: "outcome",
    outcome: "discarded",
    id: DRAFT,
    revision: null,
    versionNumber: null,
    sha: null,
  });
  assert.deepEqual(w.sent(), [
    ["restore", OLD, null],
    ["reset", "rosuno", 3],
    ["discard", DRAFT, 4],
  ]);
  for (const [call, args] of [
    [restoreAppearanceVersion, ["x", null]],
    [restoreAppearanceVersion, [OLD, 0]],
    [resetAppearanceDraft, [1.5]],
    [discardAppearanceDraft, [DRAFT, null]],
    [discardAppearanceDraft, ["x", 1]],
  ]) {
    const x = appearanceWorld().holder();
    assert.deepEqual(await call(x.sources, ...args), {
      status: "invalid",
      issues: [],
    });
    assert.deepEqual(x.sent(), []);
  }
  const refused = appearanceWorld();
  assert.deepEqual(await restoreAppearanceVersion(refused.sources, OLD, null), {
    status: "denied",
  });
  // A database refusal is the shared refusal value, as everywhere else.
  const databaseDenied = appearanceWorld({
    restore: rows([{ outcome: "denied", version_id: null, revision: null }]),
    discard: answer("denied"),
  }).holder();
  assert.equal(
    await restoreAppearanceVersion(databaseDenied.sources, OLD, 2),
    DENIED,
  );
  assert.equal(
    await discardAppearanceDraft(databaseDenied.sources, DRAFT, 2),
    DENIED,
  );
  assert.deepEqual(await resetAppearanceDraft(refused.sources, null), {
    status: "denied",
  });
  assert.deepEqual(await discardAppearanceDraft(refused.sources, DRAFT, 1), {
    status: "denied",
  });
  assert.deepEqual(refused.sent(), []);
  for (const [answers, call, args, expected] of [
    [
      {
        restore: rows([
          { outcome: "not_found", version_id: null, revision: null },
        ]),
      },
      restoreAppearanceVersion,
      [OLD, 2],
      "not_found",
    ],
    [
      {
        restore: rows([
          { outcome: "invalid", version_id: null, revision: null },
        ]),
      },
      restoreAppearanceVersion,
      [OLD, 2],
      "invalid",
    ],
    [
      { restore: rows([{ outcome: "reset", version_id: DRAFT, revision: 2 }]) },
      restoreAppearanceVersion,
      [OLD, 2],
      "unconfirmed",
    ],
    [
      {
        reset: rows([
          { outcome: "conflict", version_id: null, revision: null },
        ]),
      },
      resetAppearanceDraft,
      [2],
      "conflict",
    ],
    [
      { discard: answer("conflict") },
      discardAppearanceDraft,
      [DRAFT, 2],
      "conflict",
    ],
    [
      { discard: answer("not_found") },
      discardAppearanceDraft,
      [DRAFT, 2],
      "not_found",
    ],
    [
      { discard: answer("denied") },
      discardAppearanceDraft,
      [DRAFT, 2],
      "denied",
    ],
    [
      { discard: answer("archived") },
      discardAppearanceDraft,
      [DRAFT, 2],
      "unconfirmed",
    ],
    [
      { discard: { kind: "rejected" } },
      discardAppearanceDraft,
      [DRAFT, 2],
      "unavailable",
    ],
    [
      { discard: UNREADABLE },
      discardAppearanceDraft,
      [DRAFT, 2],
      "unconfirmed",
    ],
  ]) {
    const x = appearanceWorld(answers).holder();
    const result = await call(x.sources, ...args);
    assert.equal(result.outcome ?? result.status, expected);
  }
});

test("APP-10 uploading inspects the bytes first (an SVG, a GIF or damaged bytes answer image with their problem and nothing is sent), then sends the stripped image as base64 with its own media type and size after the capability and environment checks", async () => {
  const w = appearanceWorld().holder();
  const dirty = png(
    ihdr(),
    pngChunk("tEXt", Buffer.from("Author\u0000Synthetic", "latin1")),
    idat(),
    IEND,
  );
  const stored = await uploadAppearanceAsset(w.sources, new Uint8Array(dirty));
  assert.deepEqual(stored, {
    status: "outcome",
    outcome: "stored",
    id: ASSET,
    revision: null,
    versionNumber: null,
    sha: SHA,
  });
  assert.deepEqual(w.sent(), [
    ["uploadAsset", "image/png", 16, 16, cleanPng().toString("base64")],
  ]);
  for (const [bytes, problem] of [
    [SVG, "unsupported"],
    [Buffer.from("GIF89a", "latin1"), "unsupported"],
    [cleanPng().subarray(0, 30), "invalid"],
    [cleanPng(15, 15), "dimensions"],
  ]) {
    const x = appearanceWorld().holder();
    assert.deepEqual(
      await uploadAppearanceAsset(x.sources, new Uint8Array(bytes)),
      { status: "image", problem },
    );
    assert.deepEqual(x.sent(), []);
  }
  assert.deepEqual(await uploadAppearanceAsset(w.sources, "not bytes"), {
    status: "image",
    problem: "invalid",
  });
  const refused = appearanceWorld();
  assert.deepEqual(
    await uploadAppearanceAsset(refused.sources, new Uint8Array(cleanPng())),
    { status: "denied" },
  );
  assert.deepEqual(refused.sent(), []);
  for (const [row, expected] of [
    [{ outcome: "exists", asset_id: ASSET, sha256: SHA }, "exists"],
    [
      { outcome: "limit_reached", asset_id: null, sha256: null },
      "limit_reached",
    ],
    [{ outcome: "invalid", asset_id: null, sha256: null }, "invalid"],
    [{ outcome: "stored", asset_id: ASSET, sha256: null }, "unconfirmed"],
    [{ outcome: "limit_reached", asset_id: ASSET, sha256: SHA }, "unconfirmed"],
  ]) {
    const x = appearanceWorld({ uploadAsset: rows([row]) }).holder();
    const result = await uploadAppearanceAsset(
      x.sources,
      new Uint8Array(cleanPng()),
    );
    assert.equal(result.outcome ?? result.status, expected);
  }
});

test("APP-11 serving an image: the published one first (public), else for a holder only the library image (private); the extension must match the stored media type; a malformed digest or extension, a missing image or a non-holder is not found; malformed rows are unavailable", async () => {
  const bytes = cleanPng();
  const pub = appearanceWorld({ publishedAsset: rows([contentRow(bytes)]) });
  const served = await readAppearanceAsset(pub.sources, SHA, "png");
  assert.equal(served.status, "ready");
  assert.equal(served.scope, "public");
  assert.equal(served.mediaType, "image/png");
  assert.deepEqual(Buffer.from(served.bytes), bytes);
  assert.deepEqual(pub.calls, [["publishedAsset", SHA]]);
  assert.deepEqual(await readAppearanceAsset(pub.sources, SHA, "jpg"), {
    status: "not-found",
  });
  for (const [sha, extension] of [
    ["A".repeat(64), "png"],
    [SHA, "svg"],
    [SHA, "jpeg"],
    [SHA, "__proto__"],
    [SHA, null],
  ]) {
    const x = appearanceWorld();
    assert.deepEqual(await readAppearanceAsset(x.sources, sha, extension), {
      status: "not-found",
    });
    assert.deepEqual(x.calls, []);
  }
  const visitor = appearanceWorld({ asset: rows([contentRow(bytes)]) });
  assert.deepEqual(await readAppearanceAsset(visitor.sources, SHA_B, "png"), {
    status: "not-found",
  });
  assert.ok(!visitor.calls.some(([name]) => name === "asset"));
  const holder = appearanceWorld({
    asset: rows([contentRow(bytes, { media_type: "image/webp" })]),
  }).holder();
  const library = await readAppearanceAsset(holder.sources, SHA_B, "webp");
  assert.equal(library.scope, "private");
  assert.deepEqual(await readAppearanceAsset(holder.sources, SHA_B, "png"), {
    status: "not-found",
  });
  for (const row of [
    contentRow(bytes, { byte_size: bytes.length + 1 }),
    contentRow(bytes, { content_base64: "Zm9v\nYmFy" }),
    contentRow(bytes, { media_type: "image/gif" }),
    { ...contentRow(bytes), extra: 1 },
  ]) {
    assert.deepEqual(
      await readAppearanceAsset(
        appearanceWorld({ publishedAsset: rows([row]) }).sources,
        SHA,
        "png",
      ),
      { status: "unavailable" },
    );
  }
  assert.deepEqual(
    await readAppearanceAsset(
      appearanceWorld({ publishedAsset: UNREADABLE }).sources,
      SHA,
      "png",
    ),
    { status: "unavailable" },
  );
});

// A fake request client recording each call; answers by function name.
function fakeClient(answers = {}) {
  const calls = [];
  return {
    calls,
    client: {
      rpc: async (name, args) => {
        calls.push([name, args]);
        const value = answers[name];
        return typeof value === "function"
          ? value(args)
          : (value ?? { data: [], error: null, status: 200 });
      },
    },
  };
}

test("APP-12 the adapter calls each function by its literal name with exactly its named arguments, refuses malformed arguments before sending, parses the canonical configuration into an object, and reads the discard answer against its own outcomes", async () => {
  const { calls, client } = fakeClient({
    staff_discard_site_appearance_draft: {
      data: "discarded",
      error: null,
      status: 200,
    },
  });
  const reads = await createAppearanceReads(async () => client, 1000)();
  const writes = await createAppearanceWrites(async () => client, 1000)();
  await reads.publishedAsset(SHA);
  await reads.overview("rosuno");
  await reads.versions("rosuno", 25);
  await reads.version(OLD);
  await reads.preview("rosuno");
  await reads.assets(50);
  await reads.asset(SHA);
  await reads.environmentIdentity();
  await writes.saveDraft("rosuno", null, '{"schema":1}');
  await writes.publish("rosuno", DRAFT, 3, null);
  await writes.restore(OLD, 2);
  await writes.reset("rosuno", null);
  assert.deepEqual(await writes.discard(DRAFT, 2), {
    kind: "answer",
    outcome: "discarded",
  });
  await writes.uploadAsset("image/png", 16, 16, "iVBORw0KGgo=");
  assert.deepEqual(calls, [
    ["public_site_appearance_asset", { p_sha256: SHA }],
    ["staff_site_appearance_overview", { p_theme_key: "rosuno" }],
    ["staff_site_appearance_versions", { p_theme_key: "rosuno", p_offset: 25 }],
    ["staff_site_appearance_version", { p_version_id: OLD }],
    ["staff_site_appearance_preview", { p_theme_key: "rosuno" }],
    ["staff_site_appearance_assets", { p_offset: 50 }],
    ["staff_site_appearance_asset", { p_sha256: SHA }],
    ["deployment_environment_identity", undefined],
    [
      "staff_save_site_appearance_draft",
      {
        p_theme_key: "rosuno",
        p_expected_revision: null,
        p_configuration: { schema: 1 },
      },
    ],
    [
      "staff_publish_site_appearance",
      {
        p_theme_key: "rosuno",
        p_draft_id: DRAFT,
        p_expected_revision: 3,
        p_label: null,
      },
    ],
    [
      "staff_restore_site_appearance",
      { p_version_id: OLD, p_expected_revision: 2 },
    ],
    [
      "staff_reset_site_appearance",
      { p_theme_key: "rosuno", p_expected_revision: null },
    ],
    [
      "staff_discard_site_appearance_draft",
      { p_draft_id: DRAFT, p_expected_revision: 2 },
    ],
    [
      "staff_upload_site_appearance_asset",
      {
        p_media_type: "image/png",
        p_width: 16,
        p_height: 16,
        p_content_base64: "iVBORw0KGgo=",
      },
    ],
  ]);
  calls.length = 0;
  const refusedReads = [
    reads.publishedAsset("x"),
    reads.overview("Rosuno"),
    reads.versions("rosuno", 10),
    reads.versions("rosuno", 100025),
    reads.version("x"),
    reads.assets(25),
    reads.asset(SHA.toUpperCase()),
    writes.saveDraft("rosuno", 0, "{}"),
    writes.saveDraft("rosuno", null, "[]"),
    writes.saveDraft("rosuno", null, "not json"),
    writes.saveDraft(
      "rosuno",
      null,
      `{"schema":1,"x":"${"a".repeat(140000)}"}`,
    ),
    writes.publish("rosuno", DRAFT, 3, "x".repeat(81)),
    writes.restore(OLD, 1.5),
    writes.reset("r", null),
    writes.uploadAsset("image/svg+xml", 16, 16, "iVBORw0KGgo="),
    writes.uploadAsset("image/png", 15, 16, "iVBORw0KGgo="),
    writes.uploadAsset("image/png", 16, 16, "iVBORw0KGgo"),
    writes.uploadAsset("image/png", 16, 16, ""),
  ];
  for (const result of await Promise.all(refusedReads)) {
    assert.deepEqual(result, { kind: "unreadable" });
  }
  assert.deepEqual(await writes.discard("x", 1), { kind: "rejected" });
  assert.deepEqual(calls, []);
  const odd = fakeClient({
    staff_discard_site_appearance_draft: {
      data: "archived",
      error: null,
      status: 200,
    },
  });
  const oddWrites = await createAppearanceWrites(
    async () => odd.client,
    1000,
  )();
  assert.deepEqual(await oddWrites.discard(DRAFT, 1), { kind: "unreadable" });
  const failing = fakeClient({
    staff_site_appearance_overview: {
      data: null,
      error: { code: "42501", message: "x" },
      status: 403,
    },
  });
  const failingReads = await createAppearanceReads(
    async () => failing.client,
    1000,
  )();
  assert.deepEqual(await failingReads.overview("rosuno"), {
    kind: "unreadable",
  });
  assert.equal(await createAppearanceReads(async () => null, 1000)(), null);
});

test("APP-13 the published read is shared: concurrent reads make one call, its rows are kept for five seconds, a failed read is never kept, and invalidatePublishedAppearance drops the kept rows", async () => {
  invalidatePublishedAppearance();
  let now = 1_000_000;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { calls, client } = fakeClient({
    public_site_appearance: async () => {
      await gate;
      return { data: [publishedRow()], error: null, status: 200 };
    },
  });
  const reads = await createAppearanceReads(
    async () => client,
    1000,
    () => now,
  )();
  const both = Promise.all([reads.published(), reads.published()]);
  release();
  const [a, b] = await both;
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  now += PUBLISHED_MEMO_MS - 1;
  await reads.published();
  assert.equal(calls.length, 1);
  now += 1;
  await reads.published();
  assert.equal(calls.length, 2);
  invalidatePublishedAppearance();
  await reads.published();
  assert.equal(calls.length, 3);
  invalidatePublishedAppearance();
  const failing = fakeClient({
    public_site_appearance: {
      data: null,
      error: { code: "XX000" },
      status: 500,
    },
  });
  const failingReads = await createAppearanceReads(
    async () => failing.client,
    1000,
    () => now,
  )();
  assert.deepEqual(await failingReads.published(), { kind: "unreadable" });
  assert.deepEqual(await failingReads.published(), { kind: "unreadable" });
  assert.equal(failing.calls.length, 2);
  invalidatePublishedAppearance();
});

test("APP-14 the application modules stay provider-neutral and registry-agnostic: no presentation, infrastructure or package import, no database call; the adapter builds no privileged client and reads no table", () => {
  for (const file of [
    "src/application/appearance.ts",
    "src/application/appearance-schema.ts",
    "src/application/appearance-image.ts",
  ]) {
    const source = read(file);
    const imports = [...source.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.match(
        specifier,
        /^\.\/[a-z-]+\.ts$/,
        `${file} imports ${specifier}`,
      );
    }
    const code = codeOf(source);
    assert.doesNotMatch(
      code,
      /\brpc\b|\.from\("|presentation|infrastructure|process\.env|\bfetch\(|dangerouslySetInnerHTML|innerHTML/,
      file,
    );
  }
  const adapter = codeOf(
    read("src/infrastructure/appearance/appearance-adapter.ts"),
  );
  assert.doesNotMatch(
    adapter,
    /\badmin\b|createClient\b|service_role|SERVICE_ROLE|\.from\(/,
  );
  assert.equal(adapter.match(/client\.rpc\("/g).length, 15);
  // Log lines carry the call name and how it failed only.
  for (const [call] of adapter.matchAll(/logRequestEvent\([^;]*;/g)) {
    assert.doesNotMatch(call, /configuration|base64|text|bytes|label/i, call);
  }
});
