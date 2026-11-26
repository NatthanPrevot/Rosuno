// DEV-001 website and appearance studio: the configuration schema, its
// validator and pure helpers (studio specification sections 3.1 to 3.4).
//
// Driven with a synthetic registry (tests/site-appearance-fixtures.mjs) that
// carries the owner's token defaults exactly as the owner stylesheets define
// them. Every configuration and text here is test data. The database checks
// the stored shape and the text rule again (proved by
// apps/web/tests/dev-001-site-appearance-db-proof.mjs); these tests prove the
// application's full validation: every range edge and refusal, the canonical
// form, the contrast rule min(AA, owner), and that the TypeScript text rule
// is the database's rule.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APPEARANCE_BANNED_PHRASES,
  appearanceTextAllowed,
  appearanceTextIssue,
  canonicalJson,
  contrastRatio,
  databaseTextOctets,
  derivedHoverBackground,
  effectiveTokens,
  isValidatedAppearance,
  KIND_RULES,
  MAX_CONFIGURATION_BYTES,
  mixHex,
  OWNER_HOOK_DEFAULTS,
  onInkFor,
  referencedAssetsOf,
  sectionOrderOf,
  slotTextOf,
  SPACING_SCALE,
  validateAppearance,
} from "../src/application/appearance-schema.ts";
import {
  HOME_SECTIONS,
  HOME_SLOTS,
  OWNER_SITE_TOKENS,
  OWNER_WORKSPACE_TOKENS,
  SPEC_EXAMPLE,
  TEST_REGISTRY,
  validate,
} from "./site-appearance-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const MIGRATION = read(
  "../../supabase/migrations/20261130010000_dev_001_site_appearance.sql",
);

const ok = (raw, mode = "draft") => {
  const result = validate(raw, mode);
  assert.equal(result.ok, true, JSON.stringify(result.issues ?? []));
  return result;
};
const issuesOf = (raw, mode = "draft") => {
  const result = validate(raw, mode);
  if (result.ok) {
    assert.fail(`accepted: ${result.canonical}`);
  }
  return result.issues.map((issue) => `${issue.code} ${issue.path}`);
};
const refused = (raw, code, path, mode = "draft") => {
  const issues = issuesOf(raw, mode);
  assert.ok(
    issues.includes(`${code} ${path}`),
    `expected ${code} ${path}, got ${issues.join("; ")}`,
  );
};
const c = (extra) => ({ schema: 1, ...extra });
const comp = (id, style) => c({ components: { [id]: style } });

test("SA-1 the empty configuration is valid, canonical and frozen; the owner's defaults pass publish mode with no warning", () => {
  const result = ok({ schema: 1 }, "publish");
  assert.equal(result.canonical, '{"schema":1}');
  assert.deepEqual(result.warnings, []);
  assert.ok(Object.isFrozen(result.value));
  assert.ok(isValidatedAppearance(result.value));
  assert.equal(isValidatedAppearance({ schema: 1 }), false);
  // Values equal to the registry defaults are dropped, so they pass too.
  const same = ok(
    c({
      tokens: {
        site: { ...OWNER_SITE_TOKENS, radius: 14 },
        workspace: { ...OWNER_WORKSPACE_TOKENS, staffRadius: 16 },
      },
    }),
    "publish",
  );
  assert.equal(same.canonical, '{"schema":1}');
  assert.deepEqual(same.warnings, []);
});

test("SA-2 the whole configuration: a plain object of the nine keys with schema 1; anything else, null anywhere, an accessor, a class instance or a symbol key is refused", () => {
  for (const raw of [null, [], "x", 1, true, undefined]) {
    assert.deepEqual(issuesOf(raw), ["not_object "]);
  }
  refused(c({ extra: 1 }), "unknown_key", "/extra");
  refused({ schema: 2 }, "schema", "/schema");
  refused({}, "schema", "/schema");
  refused({ schema: "1" }, "schema", "/schema");
  refused(c({ tokens: null }), "not_object", "/tokens");
  refused(
    c({ tokens: { site: { ink: null } } }),
    "bad_color",
    "/tokens/site/ink",
  );
  const getter = { schema: 1 };
  Object.defineProperty(getter, "tokens", {
    get: () => ({}),
    enumerable: true,
  });
  assert.deepEqual(issuesOf(getter), ["not_object "]);
  class Configuration {
    schema = 1;
  }
  assert.deepEqual(issuesOf(new Configuration()), ["not_object "]);
  assert.deepEqual(issuesOf({ schema: 1, [Symbol("x")]: 1 }), ["not_object "]);
  const cyclic = { schema: 1 };
  cyclic.tokens = cyclic;
  assert.deepEqual(issuesOf(cyclic), ["not_object "]);
  assert.deepEqual(issuesOf({ schema: 1, n: 10n }), ["not_object "]);
  // Prototype keys are ordinary unknown keys, never merged.
  refused(
    JSON.parse('{"schema": 1, "__proto__": {"x": 1}}'),
    "unknown_key",
    "/__proto__",
  );
  refused(
    JSON.parse('{"schema": 1, "components": {"constructor": {}}}'),
    "unknown_id",
    "/components/constructor",
  );
});

test("SA-3 tokens: colours are lowercase #rrggbb; radius 6 to 22 and staffRadius 8 to 24 in whole pixels; fonts and elevation are enums; each scope has exactly its keys", () => {
  for (const bad of [
    "#ABCDEF",
    "#fff",
    "red",
    "#fff;}body{display:none",
    "#12345g",
    "rgb(0,0,0)",
    " #ffffff",
    1,
  ]) {
    refused(
      c({ tokens: { site: { ink: bad } } }),
      "bad_color",
      "/tokens/site/ink",
    );
  }
  ok(c({ tokens: { site: { radius: 6 } } }));
  ok(c({ tokens: { site: { radius: 22 } } }));
  for (const bad of [5, 23, 10.5, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
    refused(
      c({ tokens: { site: { radius: bad } } }),
      "out_of_range",
      "/tokens/site/radius",
    );
  }
  ok(c({ tokens: { workspace: { staffRadius: 8 } } }));
  ok(c({ tokens: { workspace: { staffRadius: 24 } } }));
  refused(
    c({ tokens: { workspace: { staffRadius: 25 } } }),
    "out_of_range",
    "/tokens/workspace/staffRadius",
  );
  for (const font of ["instrument-sans", "inter", "system"]) {
    ok(c({ tokens: { site: { fontDisplay: font, fontBody: font } } }));
  }
  refused(
    c({ tokens: { site: { fontBody: "Comic Sans" } } }),
    "bad_enum",
    "/tokens/site/fontBody",
  );
  ok(c({ tokens: { site: { elevation: "flat" } } }));
  refused(
    c({ tokens: { site: { elevation: "deep" } } }),
    "bad_enum",
    "/tokens/site/elevation",
  );
  refused(
    c({ tokens: { site: { canvas: "#ffffff" } } }),
    "unknown_key",
    "/tokens/site/canvas",
  );
  refused(
    c({ tokens: { workspace: { radius: 10 } } }),
    "unknown_key",
    "/tokens/workspace/radius",
  );
  refused(
    c({ tokens: { site: { live: "#12a150" } } }),
    "unknown_key",
    "/tokens/site/live",
  );
  refused(c({ tokens: { brand: {} } }), "unknown_key", "/tokens/brand");
});

test("SA-4 type roles: registry ids only; size per breakpoint within the role's range on a 0.5 step; weight enum; line height within the role's range on a 0.01 step; letter spacing -0.05 to 0.08 em on a 0.001 step; transform only on the kicker; colour only where allowed", () => {
  ok(
    c({
      type: {
        "type.display": { size: { desktop: 32, tablet: 112, phone: 40.5 } },
      },
    }),
  );
  refused(
    c({ type: { "type.display": { size: { desktop: 31.5 } } } }),
    "out_of_range",
    "/type/type.display/size/desktop",
  );
  refused(
    c({ type: { "type.display": { size: { desktop: 112.5 } } } }),
    "out_of_range",
    "/type/type.display/size/desktop",
  );
  refused(
    c({ type: { "type.display": { size: { desktop: 72.25 } } } }),
    "out_of_range",
    "/type/type.display/size/desktop",
  );
  refused(
    c({ type: { "type.display": { size: { wide: 72 } } } }),
    "unknown_key",
    "/type/type.display/size/wide",
  );
  refused(
    c({ type: { "type.small": { size: { desktop: 11.5 } } } }),
    "out_of_range",
    "/type/type.small/size/desktop",
  );
  refused(
    c({ type: { "type.unknown": {} } }),
    "unknown_id",
    "/type/type.unknown",
  );
  ok(
    c({
      type: {
        "type.h2": { weight: 700, lineHeight: 0.9, letterSpacing: -0.05 },
      },
    }),
  );
  refused(
    c({ type: { "type.h2": { weight: 650 } } }),
    "bad_enum",
    "/type/type.h2/weight",
  );
  refused(
    c({ type: { "type.h2": { lineHeight: 1.41 } } }),
    "out_of_range",
    "/type/type.h2/lineHeight",
  );
  refused(
    c({ type: { "type.body": { lineHeight: 1.29 } } }),
    "out_of_range",
    "/type/type.body/lineHeight",
  );
  ok(c({ type: { "type.body": { lineHeight: 1.9, letterSpacing: 0.08 } } }));
  refused(
    c({ type: { "type.body": { letterSpacing: 0.0805 } } }),
    "out_of_range",
    "/type/type.body/letterSpacing",
  );
  refused(
    c({ type: { "type.body": { letterSpacing: 0.1 + 0.2 - 0.29 } } }),
    "out_of_range",
    "/type/type.body/letterSpacing",
  );
  ok(c({ type: { "type.kicker": { transform: "uppercase" } } }));
  refused(
    c({ type: { "type.h3": { transform: "uppercase" } } }),
    "group_not_allowed",
    "/type/type.h3/transform",
  );
  refused(
    c({ type: { "type.kicker": { transform: "capitalize" } } }),
    "bad_enum",
    "/type/type.kicker/transform",
  );
  ok(c({ type: { "type.h3": { color: "#1c1917" } } }));
  refused(
    c({ type: { "type.body": { color: "#1c1917" } } }),
    "group_not_allowed",
    "/type/type.body/color",
  );
  refused(
    c({ type: { "type.body": { opacity: 0 } } }),
    "unknown_key",
    "/type/type.body/opacity",
  );
});

test("SA-5 components and roles: registry ids only; each group and property only where the kind allows it; spacing from the scale within the kind's bound; borders, sizes, shadows and backgrounds within their ranges", () => {
  refused(comp("home.unknown", {}), "unknown_id", "/components/home.unknown");
  refused(
    c({ roles: { "role.unknown": {} } }),
    "unknown_id",
    "/roles/role.unknown",
  );
  // Groups a kind does not allow.
  refused(
    comp("home.ways", { typography: { weight: 600 } }),
    "group_not_allowed",
    "/components/home.ways/typography",
  );
  refused(
    comp("home.ways.card", { color: { text: "#000000" } }),
    "group_not_allowed",
    "/components/home.ways.card/color",
  );
  refused(
    comp("home.hero.title", { color: { textHover: "#000000" } }),
    "group_not_allowed",
    "/components/home.hero.title/color/textHover",
  );
  refused(
    comp("home.ways.card", { size: { height: 40 } }),
    "group_not_allowed",
    "/components/home.ways.card/size",
  );
  refused(
    comp("home.ways", { display: "none" }),
    "unknown_key",
    "/components/home.ways/display",
  );
  refused(
    comp("home.ways", { visibility: "hidden" }),
    "unknown_key",
    "/components/home.ways/visibility",
  );
  // A component the registry narrows to fewer groups.
  ok(comp("home.attorneys.title", { color: { text: "#1c1917" } }));
  refused(
    comp("home.attorneys.title", { typography: { weight: 600 } }),
    "group_not_allowed",
    "/components/home.attorneys.title/typography",
  );
  // Spacing.
  ok(
    comp("home.ways", {
      spacing: {
        padding: { desktop: { top: 200, bottom: 0 }, phone: { top: 48 } },
      },
    }),
  );
  refused(
    comp("home.ways", { spacing: { padding: { desktop: { top: 30 } } } }),
    "out_of_range",
    "/components/home.ways/spacing/padding/desktop/top",
  );
  refused(
    comp("home.ways", { spacing: { padding: { desktop: { left: 8 } } } }),
    "group_not_allowed",
    "/components/home.ways/spacing/padding/desktop/left",
  );
  refused(
    comp("home.ways", { spacing: { gap: { desktop: 8 } } }),
    "group_not_allowed",
    "/components/home.ways/spacing/gap",
  );
  ok(
    comp("home.ways.card", {
      spacing: {
        padding: { desktop: { top: 64, right: 64, bottom: 64, left: 64 } },
      },
    }),
  );
  refused(
    comp("home.ways.card", {
      spacing: {
        padding: { desktop: { top: 72, right: 72, bottom: 72, left: 72 } },
      },
    }),
    "out_of_range",
    "/components/home.ways.card/spacing/padding/desktop/top",
  );
  refused(
    comp("home.ways.card", {
      spacing: { padding: { desktop: { top: 24, right: 24, bottom: 24 } } },
    }),
    "out_of_range",
    "/components/home.ways.card/spacing/padding/desktop",
  );
  refused(
    comp("home.ways.card", {
      spacing: {
        padding: { desktop: { top: 24, right: 20, bottom: 24, left: 24 } },
      },
    }),
    "out_of_range",
    "/components/home.ways.card/spacing/padding/desktop",
  );
  ok(comp("home.issues.grid", { spacing: { gap: { desktop: 48, phone: 0 } } }));
  refused(
    comp("home.issues.grid", { spacing: { gap: { desktop: 52 } } }),
    "out_of_range",
    "/components/home.issues.grid/spacing/gap/desktop",
  );
  assert.ok(SPACING_SCALE.includes(200) && !SPACING_SCALE.includes(30));
  // Borders.
  ok(
    c({
      roles: { "role.button.primary": { border: { radius: 999, width: 1.5 } } },
    }),
  );
  ok(
    comp("home.attorneys.explore", {
      border: { radius: 32, width: 0, color: "#dddad4" },
    }),
  );
  refused(
    comp("home.attorneys.explore", { border: { radius: 33 } }),
    "out_of_range",
    "/components/home.attorneys.explore/border/radius",
  );
  refused(
    comp("home.attorneys.explore", { border: { width: 1.25 } }),
    "out_of_range",
    "/components/home.attorneys.explore/border/width",
  );
  refused(
    comp("home.ways.card", { border: { radius: 999 } }),
    "out_of_range",
    "/components/home.ways.card/border/radius",
  );
  ok(comp("home.hero.figure", { border: { radius: 48 } }));
  refused(
    comp("home.hero.figure", { border: { radius: 49 } }),
    "out_of_range",
    "/components/home.hero.figure/border/radius",
  );
  refused(
    comp("home.hero.figure", { border: { width: 1 } }),
    "group_not_allowed",
    "/components/home.hero.figure/border/width",
  );
  ok(
    comp("site.header", {
      border: { bottom: { width: 2, color: "#eae8e4" } },
      shadow: "e1",
    }),
  );
  refused(
    comp("site.header", { border: { top: { width: 1 } } }),
    "group_not_allowed",
    "/components/site.header/border/top",
  );
  refused(
    comp("site.header", { border: { bottom: { width: 3 } } }),
    "out_of_range",
    "/components/site.header/border/bottom/width",
  );
  ok(comp("staff.sidebar", { border: { right: { color: "#dddad4" } } }));
  refused(
    comp("staff.sidebar", { border: { right: { width: 1 } } }),
    "unknown_key",
    "/components/staff.sidebar/border/right/width",
  );
  refused(
    comp("site.header", { shadow: "e4" }),
    "bad_enum",
    "/components/site.header/shadow",
  );
  // Sizes and typography per kind.
  ok(
    comp("home.attorneys.explore", {
      size: { height: 32, paddingX: 40 },
      typography: { size: { desktop: 18 }, transform: "uppercase" },
    }),
  );
  refused(
    comp("home.attorneys.explore", { size: { height: 57 } }),
    "out_of_range",
    "/components/home.attorneys.explore/size/height",
  );
  refused(
    comp("home.attorneys.explore", { size: { width: 100 } }),
    "unknown_key",
    "/components/home.attorneys.explore/size/width",
  );
  refused(
    comp("site.header.nav", { typography: { size: { desktop: 17 } } }),
    "out_of_range",
    "/components/site.header.nav/typography/size/desktop",
  );
  refused(
    comp("site.header.nav", { typography: { family: "inter" } }),
    "group_not_allowed",
    "/components/site.header.nav/typography/family",
  );
  ok(
    comp("home.ways.kicker", {
      typography: { transform: "uppercase", size: { desktop: 12 } },
    }),
  );
  refused(
    comp("home.hero.lead", { typography: { transform: "uppercase" } }),
    "group_not_allowed",
    "/components/home.hero.lead/typography/transform",
  );
  refused(
    comp("home.hero.lead", { typography: { size: { desktop: 11.5 } } }),
    "out_of_range",
    "/components/home.hero.lead/typography/size/desktop",
  );
  ok(
    comp("home.hero.title", {
      typography: { family: "system", size: { desktop: 112 }, lineHeight: 1.4 },
    }),
  );
  refused(
    comp("home.hero.title", { typography: { size: { desktop: 13.5 } } }),
    "out_of_range",
    "/components/home.hero.title/typography/size/desktop",
  );
  // Backgrounds.
  ok(
    comp("home.ways", {
      background: {
        type: "gradient",
        from: "#ffffff",
        to: "#f6f5f2",
        angle: 135,
      },
    }),
  );
  refused(
    comp("home.ways", {
      background: {
        type: "gradient",
        from: "#ffffff",
        to: "#f6f5f2",
        angle: 30,
      },
    }),
    "bad_enum",
    "/components/home.ways/background/angle",
  );
  refused(
    comp("home.ways", {
      background: { type: "gradient", from: "#ffffff", angle: 45 },
    }),
    "not_object",
    "/components/home.ways/background/to",
  );
  refused(
    comp("home.ways", { background: { type: "url", value: "x" } }),
    "bad_enum",
    "/components/home.ways/background/type",
  );
  refused(
    comp("home.ways.card", {
      background: {
        type: "gradient",
        from: "#ffffff",
        to: "#ffffff",
        angle: 0,
      },
    }),
    "group_not_allowed",
    "/components/home.ways.card/background/type",
  );
  refused(
    comp("home.ways", {
      background: {
        type: "image",
        asset: { sha256: "a".repeat(64), format: "png" },
        fit: "cover",
        position: "center",
      },
    }),
    "group_not_allowed",
    "/components/home.ways/background/type",
  );
  refused(
    comp("home.ways", {
      background: { type: "color", color: "#ffffff", extra: 1 },
    }),
    "unknown_key",
    "/components/home.ways/background/extra",
  );
  // Every kind has a rule; none allows a property outside the allow-list.
  assert.equal(Object.keys(KIND_RULES).length, 16);
});

test("SA-6 page text slots: registry slots only; plain text within the slot's length and line limits, NFC, without surrounding spaces, markup characters, links, contact details or regulated phrases; a text equal to its default is dropped", () => {
  const slot = (id, text) => c({ slots: { [id]: text } });
  ok(slot("home.ways.title", "Talk now, or plan ahead."));
  ok(slot("home.hero.title", "Talk to a lawyer\nin minutes today."));
  refused(slot("home.unknown", "x"), "unknown_id", "/slots/home.unknown");
  refused(
    slot("home.ways.title", 1),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(slot("home.ways.title", ""), "slot_length", "/slots/home.ways.title");
  refused(
    slot("home.ways.title", "a".repeat(81)),
    "slot_length",
    "/slots/home.ways.title",
  );
  ok(slot("home.ways.title", "a".repeat(80)));
  ok(slot("home.ways.title", "\u{1F600}".repeat(80)));
  refused(
    slot("home.ways.title", "Talk\nnow"),
    "slot_lines",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.hero.title", "a\nb\nc"),
    "slot_lines",
    "/slots/home.hero.title",
  );
  refused(
    slot("home.ways.title", "<b>Talk</b>"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Talk {now}"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", " Talk"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Talk\u0007"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Talk\u202Enow"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Cafe\u0301"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "\uFF1Cb\uFF1E bold"),
    "slot_characters",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "See https://example.test"),
    "slot_link",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Mail a@example.test"),
    "slot_link",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Find the best attorney"),
    "slot_banned",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "Top-Rated lawyers"),
    "slot_banned",
    "/slots/home.ways.title",
  );
  refused(
    slot("home.ways.title", "FREE consultations"),
    "slot_banned",
    "/slots/home.ways.title",
  );
  ok(slot("home.ways.title", "Freedom to choose"));
  const defaults = ok(
    c({
      slots: Object.fromEntries(HOME_SLOTS.map((s) => [s.id, s.defaultText])),
    }),
    "publish",
  );
  assert.equal(defaults.canonical, '{"schema":1}');
  // Every registry default text passes its own slot rule.
  for (const s of HOME_SLOTS) {
    assert.equal(appearanceTextAllowed(s.defaultText), true, s.id);
  }
});

test("SA-7 sections: the order is a permutation of exactly the reorderable sections and only hideable sections are hidden, each once; the default order and an empty hidden list are dropped", () => {
  const sections = (value) => c({ sections: { "home.sections": value } });
  const order = [
    "home.available",
    "home.how",
    "home.ways",
    "home.issues",
    "home.attorneys",
  ];
  const result = ok(
    sections({ order, hidden: ["home.attorneys", "home.ways"] }),
  );
  assert.deepEqual(result.value.sections["home.sections"], {
    order,
    hidden: ["home.attorneys", "home.ways"],
  });
  refused(
    sections({ order: order.slice(1) }),
    "section_order",
    "/sections/home.sections/order",
  );
  refused(
    sections({ order: ["home.hero", ...order.slice(1)] }),
    "section_order",
    "/sections/home.sections/order",
  );
  refused(
    sections({ order: [...order.slice(0, 4), "home.how"] }),
    "section_order",
    "/sections/home.sections/order",
  );
  refused(
    sections({ order: "home.ways" }),
    "section_order",
    "/sections/home.sections/order",
  );
  refused(
    sections({ hidden: ["home.available"] }),
    "section_hidden",
    "/sections/home.sections/hidden",
  );
  refused(
    sections({ hidden: ["home.hero"] }),
    "section_hidden",
    "/sections/home.sections/hidden",
  );
  refused(
    sections({ hidden: ["home.ways", "home.ways"] }),
    "section_hidden",
    "/sections/home.sections/hidden",
  );
  refused(
    sections({ pinned: [] }),
    "unknown_key",
    "/sections/home.sections/pinned",
  );
  refused(
    c({ sections: { "about.sections": {} } }),
    "unknown_id",
    "/sections/about.sections",
  );
  const defaults = ok(
    sections({
      order: [
        "home.available",
        "home.ways",
        "home.how",
        "home.issues",
        "home.attorneys",
      ],
      hidden: [],
    }),
  );
  assert.equal(defaults.canonical, '{"schema":1}');
});

test("SA-8 images: the asset list is exactly the sorted set of images the backgrounds and the logo reference (absent when none), at most 20, one format per digest; the logo has its size bounds", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const figure = (sha, format = "png") => ({
    "home.hero.figure": {
      background: {
        type: "image",
        asset: { sha256: sha, format },
        fit: "cover",
        position: "top",
      },
    },
  });
  const logo = (sha, extra = {}) => ({
    logo: {
      asset: { sha256: sha, format: "webp" },
      width: 120,
      height: 32,
      wordmark: "hidden",
      ...extra,
    },
  });
  const result = ok(
    c({
      components: figure(b),
      brand: logo(a),
      assets: [
        { sha256: a, format: "webp" },
        { sha256: b, format: "png" },
      ],
    }),
  );
  assert.deepEqual(referencedAssetsOf(result.value), [
    { sha256: a, format: "webp" },
    { sha256: b, format: "png" },
  ]);
  refused(c({ components: figure(a) }), "asset_reference", "/assets");
  refused(
    c({ components: figure(a), assets: [{ sha256: a, format: "jpeg" }] }),
    "asset_reference",
    "/assets",
  );
  refused(
    c({ assets: [{ sha256: a, format: "png" }] }),
    "asset_reference",
    "/assets",
  );
  refused(c({ assets: [] }), "asset_reference", "/assets");
  refused(
    c({
      components: figure(b),
      brand: logo(a),
      assets: [
        { sha256: b, format: "png" },
        { sha256: a, format: "webp" },
      ],
    }),
    "asset_reference",
    "/assets",
  );
  refused(
    c({
      assets: Array.from({ length: 21 }, (_, i) => ({
        sha256: i.toString(16).padStart(64, "0"),
        format: "png",
      })),
    }),
    "asset_reference",
    "/assets",
  );
  refused(
    c({ components: figure(a, "gif") }),
    "bad_enum",
    "/components/home.hero.figure/background/asset/format",
  );
  refused(
    c({ components: figure("A".repeat(64)) }),
    "asset_reference",
    "/components/home.hero.figure/background/asset/sha256",
  );
  refused(
    c({
      brand: logo(a, { width: 241 }),
      assets: [{ sha256: a, format: "webp" }],
    }),
    "out_of_range",
    "/brand/logo/width",
  );
  refused(
    c({
      brand: logo(a, { height: 11 }),
      assets: [{ sha256: a, format: "webp" }],
    }),
    "out_of_range",
    "/brand/logo/height",
  );
  refused(
    c({
      brand: logo(a, { wordmark: "gone" }),
      assets: [{ sha256: a, format: "webp" }],
    }),
    "bad_enum",
    "/brand/logo/wordmark",
  );
  refused(
    c({ brand: { logo: { asset: { sha256: a, format: "webp" }, width: 16 } } }),
    "not_object",
    "/brand/logo/height",
  );
});

test("SA-9 the size bound is the database's: at most 65,536 octets of the configuration's database text form (jsonb's spaced separators), measured on the canonical value", () => {
  const many = Array.from({ length: 420 }, (_, i) => ({
    id: `home.big${i}`,
    page: "public.home",
    label: "x",
    defaultText: "Default",
    max: 160,
    lines: 1,
    occurrences: 1,
  }));
  const registry = { ...TEST_REGISTRY, slots: many };
  const text = "a".repeat(148);
  const slotsFor = (n) =>
    Object.fromEntries(many.slice(0, n).map((s) => [s.id, text]));
  // Find the largest count that fits, then one more must not.
  let fits = 0;
  for (let n = 300; n <= 420; n += 1) {
    const raw = { schema: 1, slots: slotsFor(n) };
    if (databaseTextOctets(raw) <= MAX_CONFIGURATION_BYTES) {
      fits = n;
    }
  }
  assert.ok(fits > 300 && fits < 420);
  assert.equal(
    validateAppearance({ schema: 1, slots: slotsFor(fits) }, registry, "draft")
      .ok,
    true,
  );
  const over = validateAppearance(
    { schema: 1, slots: slotsFor(fits + 1) },
    registry,
    "draft",
  );
  assert.deepEqual(over.ok ? [] : over.issues.map((i) => i.code), [
    "too_large",
  ]);
  // The compact form of the refused one is still under the bound: the
  // database's spaced form decides, as the database's own check does.
  assert.ok(
    canonicalJson({ schema: 1, slots: slotsFor(fits + 1) }).length <=
      MAX_CONFIGURATION_BYTES,
  );
  assert.equal(
    databaseTextOctets({ b: [1, 2], a: "\u00e9" }),
    '{"a": "\u00e9", "b": [1, 2]}'.length + 1,
  );
});

test("SA-10 colour helpers: WCAG ratios reproduce the owner design's figures; mixing rounds each channel; the ink fill's text colour and the derived hover follow the specification", () => {
  const ratio = (a, b) => Math.round(contrastRatio(a, b) * 100) / 100;
  assert.equal(ratio("#0f1013", "#ffffff"), 19.02);
  assert.equal(ratio("#585c64", "#ffffff"), 6.71);
  assert.equal(ratio("#585c64", "#f6f5f2"), 6.15);
  assert.equal(ratio("#6f737b", "#ffffff"), 4.76);
  assert.equal(ratio("#6f737b", "#f6f5f2"), 4.36);
  assert.equal(ratio("#2f3a9e", "#ffffff"), 9.46);
  assert.equal(ratio("#6b6f77", "#f7f6f3"), 4.67);
  assert.equal(ratio("#6b6f77", "#fafaf8"), 4.82);
  assert.equal(ratio("#ffffff", "#0f1013"), 19.02);
  assert.equal(mixHex("#1c1917", "#ffffff", 0.09), "#302e2c");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.throws(() => mixHex("#fff", "#ffffff", 0.5));
  assert.throws(() => contrastRatio("red", "#ffffff"));
  assert.equal(onInkFor("#0f1013"), "#ffffff");
  assert.equal(onInkFor("#f0f0f0"), "#0f1013");
  assert.equal(
    derivedHoverBackground("#0f1013", "#0f1013"),
    mixHex("#0f1013", "#ffffff", 0.09),
  );
  assert.equal(
    derivedHoverBackground("#ffffff", "#0f1013"),
    mixHex("#ffffff", "#0f1013", 0.03),
  );
  const site = effectiveTokens(null, TEST_REGISTRY, "site");
  assert.equal(site.ink, "#0f1013");
  assert.equal(site.onInk, OWNER_HOOK_DEFAULTS.site.onInk);
  assert.equal(site.inkHover, "#24262b");
  assert.equal(site.surfaceHover, "#fcfcfb");
  assert.equal(
    effectiveTokens(null, TEST_REGISTRY, "workspace").inkHover,
    "#26282e",
  );
  const changed = effectiveTokens(
    { schema: 1, tokens: { site: { ink: "#1c1917" } } },
    TEST_REGISTRY,
    "site",
  );
  assert.equal(changed.inkHover, "#302e2c");
  assert.equal(changed.onInk, "#ffffff");
  assert.equal(changed.surfaceHover, mixHex("#ffffff", "#1c1917", 0.012));
});

test("SA-11 contrast: required = min(AA, the owner's own ratio); publish mode refuses a shortfall, draft mode reports it as a warning; token pairs, derived hooks, type roles, roles and components are checked", () => {
  const publishIssues = (raw) => {
    const result = validate(raw, "publish");
    assert.equal(result.ok, false);
    assert.ok(result.issues.every((i) => i.code === "contrast"));
    return result.issues;
  };
  // subtle on paper is 4.36 in the owner's design: a paper keeping 4.36
  // passes; one lowering it fails, needing 4.36, not 4.5.
  ok(c({ tokens: { site: { paper: "#f6f5f2" } } }), "publish");
  const darker = publishIssues(c({ tokens: { site: { paper: "#e9e7e2" } } }));
  const subtle = darker.find(
    (i) => i.path === "/tokens/site/subtle" && i.against === "paper",
  );
  assert.equal(subtle.required, 4.36);
  assert.ok(subtle.actual < 4.36);
  const draft = validate(
    c({ tokens: { site: { paper: "#e9e7e2" } } }),
    "draft",
  );
  assert.equal(draft.ok, true);
  assert.ok(draft.warnings.some((w) => w.path === "/tokens/site/subtle"));
  // A light ink fails every ink pair (4.5 required) but keeps a readable
  // derived on-ink colour.
  const light = publishIssues(c({ tokens: { site: { ink: "#9a9a9a" } } }));
  assert.ok(
    light.some(
      (i) =>
        i.path === "/tokens/site/ink" &&
        i.against === "page" &&
        i.required === 4.5,
    ),
  );
  assert.ok(
    !light.some((i) => i.path === "/tokens/site/onInk" && i.against === "ink"),
  );
  // An accent too pale for links and the focus ring.
  assert.ok(
    publishIssues(c({ tokens: { site: { accent: "#9fa6e0" } } })).some(
      (i) => i.path === "/tokens/site/accent",
    ),
  );
  assert.ok(
    publishIssues(c({ tokens: { workspace: { canvas: "#d0d0d0" } } })).some(
      (i) => i.against === "canvas",
    ),
  );
  // A type role colour on both surfaces (large text: 3.0).
  ok(c({ type: { "type.display": { color: "#767676" } } }), "publish");
  assert.ok(
    publishIssues(c({ type: { "type.h4": { color: "#a0a0a0" } } })).some(
      (i) => i.path === "/type/type.h4/color",
    ),
  );
  // A section background against its text tokens; a component within it.
  const dark = publishIssues(
    comp("home.ways", { background: { type: "color", color: "#1a1a1a" } }),
  );
  assert.ok(
    dark.some(
      (i) =>
        i.path === "/components/home.ways/background" && i.against === "ink",
    ),
  );
  assert.ok(
    publishIssues(
      c({
        components: {
          "home.ways": {
            background: {
              type: "gradient",
              from: "#ffffff",
              to: "#202020",
              angle: 90,
            },
          },
        },
      }),
    ).length > 0,
  );
  ok(
    c({
      components: {
        "home.ways": { background: { type: "color", color: "#202024" } },
        "home.ways.title": { color: { text: "#ffffff" } },
        "home.ways.kicker": { color: { text: "#f0f0f0" } },
      },
    }),
    "draft",
  );
  // A button: text on its background and on its hover.
  assert.ok(
    publishIssues(
      c({
        roles: { "role.button.primary": { color: { background: "#e0e0e0" } } },
      }),
    ).some((i) => i.path.startsWith("/roles/role.button.primary")),
  );
  ok(
    c({
      roles: {
        "role.button.primary": {
          color: { background: "#1c1917", text: "#ffffff" },
        },
      },
    }),
    "publish",
  );
  assert.ok(
    publishIssues(
      c({
        roles: {
          "role.button.primary": {
            color: {
              background: "#1c1917",
              text: "#ffffff",
              backgroundHover: "#f0f0f0",
            },
          },
        },
      }),
    ).some((i) => i.against === "hover"),
  );
  // A link colour on page and paper.
  assert.ok(
    publishIssues(
      c({ roles: { "role.link": { color: { text: "#8a8fd0" } } } }),
    ).some((i) => i.path === "/roles/role.link/color/text"),
  );
  // Owner defaults, again, pass every check.
  assert.deepEqual(validate(c({}), "publish").warnings, []);
});

test("SA-12 canonical JSON is deterministic and order-independent; the specification's example validates, canonicalizes its sections and keeps its values", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}',
  );
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  const result = ok(SPEC_EXAMPLE, "publish");
  assert.deepEqual(result.value.tokens, SPEC_EXAMPLE.tokens);
  assert.deepEqual(result.value.sections["home.sections"].hidden, [
    "home.attorneys",
  ]);
  assert.equal(result.canonical, canonicalJson(result.value));
  const reversed = (value) =>
    value === null || typeof value !== "object" || Array.isArray(value)
      ? value
      : Object.fromEntries(
          Object.keys(value)
            .reverse()
            .map((key) => [key, reversed(value[key])]),
        );
  const shuffled = reversed(SPEC_EXAMPLE);
  assert.notEqual(JSON.stringify(shuffled), JSON.stringify(SPEC_EXAMPLE));
  assert.equal(validate(shuffled, "publish").canonical, result.canonical);
  // Validating the canonical form again is the identity.
  assert.equal(
    validate(JSON.parse(result.canonical), "publish").canonical,
    result.canonical,
  );
});

test("SA-13 CSS and markup payloads never pass: no value outside its grammar, no unknown key, no selector-like id", () => {
  for (const payload of [
    "#fff;}body{display:none",
    "</style><script>alert(1)</script>",
    "\\23 fff",
    "@import url(x)",
    "expression(alert(1))",
    "url(javascript:x)",
    "#ffffff !important",
    "#ff\u0000ff",
  ]) {
    refused(
      c({ tokens: { site: { accent: payload } } }),
      "bad_color",
      "/tokens/site/accent",
    );
    refused(
      c({ tokens: { site: { fontBody: payload } } }),
      "bad_enum",
      "/tokens/site/fontBody",
    );
    refused(
      comp("home.ways", { background: { type: "color", color: payload } }),
      "bad_color",
      "/components/home.ways/background/color",
    );
  }
  refused(
    comp('home.ways"]{x}', {}),
    "unknown_id",
    '/components/home.ways"]{x}',
  );
  refused(
    comp("home.ways", { "color;": {} }),
    "unknown_key",
    "/components/home.ways/color;",
  );
  refused(
    c({ roles: { "role.button.primary:hover": {} } }),
    "unknown_id",
    "/roles/role.button.primary:hover",
  );
});

test("SA-14 the text rule is the database's: the same regulated phrases, characters, links and edges in TypeScript and in site_appearance_text_allowed", () => {
  const body = MIGRATION.slice(
    MIGRATION.indexOf("create function public.site_appearance_text_allowed("),
    MIGRATION.indexOf("create function public.site_appearance_shape_valid("),
  );
  const phrases = /!~ ' \(([a-z |]+)\) '/.exec(body)[1].split("|");
  assert.deepEqual(phrases, [...APPEARANCE_BANNED_PHRASES]);
  assert.equal(new Set(phrases).size, phrases.length);
  const source = read("src/application/appearance-schema.ts");
  const tsControl = /const TEXT_CONTROL =\s*\/\[([^\]]+)\]\//.exec(source)[1];
  const sqlControl = /n\.k !~ '\[(\\x01[^\]]+)\]'/.exec(body)[1];
  // The same class; TypeScript adds NUL, which PostgreSQL text cannot hold.
  assert.equal(
    tsControl
      .replace("\\u0000-\\u0009", "\\x01-\\x09")
      .replace(/\\u00([0-9a-f]{2})/g, "\\x$1"),
    sqlControl,
  );
  assert.match(body, /n\.k !~ '\[<>\{\}\\\\\]'/);
  assert.match(source, /const TEXT_MARKUP = \/\[<>\{\}\\\\\]\/;/);
  const sqlLink = /n\.k !~\* '([^']+)'/.exec(body)[1];
  assert.match(
    source,
    new RegExp(
      `const TEXT_LINK = /${sqlLink.replace(/[\\()|.?*+[\]^$]/g, "\\$&")}/i;`,
    ),
  );
  assert.match(body, /p_text !~ '\^\[ \\n\]\|\[ \\n\]\$'/);
  assert.match(source, /const TEXT_EDGE = \/\^\[ \\n\]\|\[ \\n\]\$\/;/);
  assert.match(body, /p_text is nfc normalized/);
  assert.match(body, /char_length\(p_text\) between 1 and 300/);
  assert.match(body, /normalize\(p_text, nfkc\)/);
  assert.match(
    body,
    /translate\(n\.k, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'\)/,
  );
  // The behaviour on a table of texts.
  const table = {
    "Talk to a lawyer\nin minutes.": null,
    "Describe what\u2019s going on in plain words.": null,
    "best attorney": "slot_banned",
    "Licensed in": "slot_banned",
    "Board-Certified": "slot_banned",
    "No win, no fee": "slot_banned",
    "Our privacy policy": "slot_banned",
    "ran\u212Aed lawyers": "slot_characters",
    "Ranked lawyers": "slot_banned",
    "best-in-class": "slot_banned",
    bestow: null,
    "www.example.test": "slot_link",
    "JavaScript:void(0)": "slot_link",
    "data:text/html": "slot_link",
    "ok@x": null,
    "Tab\there": "slot_characters",
    "": "slot_length",
    [`${"a".repeat(301)}`]: "slot_length",
  };
  for (const [text, expected] of Object.entries(table)) {
    assert.equal(appearanceTextIssue(text), expected, JSON.stringify(text));
  }
  assert.equal(appearanceTextIssue(null), "slot_characters");
});

test("SA-15 resolvers: slot texts fall back to the default unless the override passes the slot's rule; section order keeps fixed sections first and never hides a fixed or non-hideable section, whatever a configuration says", () => {
  const title = HOME_SLOTS.find((s) => s.id === "home.ways.title");
  assert.equal(slotTextOf(null, title), title.defaultText);
  assert.equal(
    slotTextOf(
      { schema: 1, slots: { "home.ways.title": "Plan ahead." } },
      title,
    ),
    "Plan ahead.",
  );
  assert.equal(
    slotTextOf({ schema: 1, slots: { "home.ways.title": "<b>x</b>" } }, title),
    title.defaultText,
  );
  assert.equal(
    slotTextOf(
      { schema: 1, slots: { "home.ways.title": "best lawyers" } },
      title,
    ),
    title.defaultText,
  );
  const ids = HOME_SECTIONS.sections.map((s) => s.id);
  assert.deepEqual(sectionOrderOf(null, HOME_SECTIONS), ids);
  const valid = ok(
    c({
      sections: {
        "home.sections": {
          order: [
            "home.issues",
            "home.available",
            "home.how",
            "home.ways",
            "home.attorneys",
          ],
          hidden: ["home.ways"],
        },
      },
    }),
  );
  assert.deepEqual(sectionOrderOf(valid.value, HOME_SECTIONS), [
    "home.hero",
    "home.issues",
    "home.available",
    "home.how",
    "home.attorneys",
  ]);
  // A forged configuration (never validated) cannot hide or move protected
  // sections, and a malformed order falls back to the default.
  const forged = {
    schema: 1,
    sections: {
      "home.sections": {
        order: ["home.hero", "home.ways"],
        hidden: ["home.hero", "home.available", "home.issues", "home.how"],
      },
    },
  };
  assert.deepEqual(sectionOrderOf(forged, HOME_SECTIONS), [
    "home.hero",
    "home.available",
    "home.ways",
    "home.issues",
    "home.attorneys",
  ]);
});
