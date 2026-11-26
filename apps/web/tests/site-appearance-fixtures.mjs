// DEV-001 website and appearance studio test fixtures (not a test file;
// loaded by the site appearance tests).
//
// A synthetic appearance registry shaped as the presentation registry will
// be (studio specification section 2): the owner's token defaults exactly as
// app/styles/theme.css and workspace.css define them, the nine type roles,
// the role selectors, a representative set of components of every kind, the
// eighteen Home text slots with their exact default texts and the Home
// section group. Every component id, label and file here is test data for
// the registry-generic validator; the real registry is presentation data.
// The image builders make synthetic 16x16 PNG, JPEG and WebP byte strings
// with optional metadata, animation and damage; nothing here contacts a
// provider, network or database.

import zlib from "node:zlib";

import { validateAppearance } from "../src/application/appearance-schema.ts";

// ---------------------------------------------------------------------------
// The synthetic registry
// ---------------------------------------------------------------------------

const token = (scope, key, cssName, type, value) => ({
  scope,
  key,
  cssName,
  type,
  default: value,
});
const colours = (scope, values) =>
  Object.entries(values).map(([key, value]) =>
    token(scope, key, `--${key.replace(/([0-9])$/, "-$1")}`, "color", value),
  );

export const OWNER_SITE_TOKENS = Object.freeze({
  ink: "#0f1013",
  ink2: "#2b2d33",
  muted: "#585c64",
  subtle: "#6f737b",
  faint: "#a3a6ac",
  line: "#eae8e4",
  line2: "#dddad4",
  line3: "#c9c5be",
  page: "#ffffff",
  paper: "#f6f5f2",
  paper2: "#eeece7",
  accent: "#2f3a9e",
});
export const OWNER_WORKSPACE_TOKENS = Object.freeze({
  ink: "#0f1013",
  ink2: "#2b2d33",
  muted: "#565a62",
  subtle: "#6b6f77",
  faint: "#a3a6ac",
  line: "#eae8e4",
  line2: "#dddad4",
  line3: "#c9c5be",
  page: "#ffffff",
  paper: "#f7f6f3",
  paper2: "#efede8",
  canvas: "#fafaf8",
  accent: "#2f3a9e",
  accent2: "#e9ecfa",
});

const TOKENS = [
  ...colours("site", OWNER_SITE_TOKENS),
  token("site", "radius", "--r", "length", 14),
  token("site", "fontDisplay", "--f-display", "font", "instrument-sans"),
  token("site", "fontBody", "--f-body", "font", "inter"),
  token("site", "elevation", "--e1", "elevation", "default"),
  ...colours("workspace", OWNER_WORKSPACE_TOKENS),
  token("workspace", "staffRadius", "--st-r", "length", 16),
  token("workspace", "fontDisplay", "--f-display", "font", "instrument-sans"),
  token("workspace", "fontBody", "--f-body", "font", "inter"),
  token("workspace", "elevation", "--e1", "elevation", "default"),
];

const typeRole = (id, selector, defaults, sizeRange, options = {}) => ({
  id,
  label: id,
  selector,
  defaults,
  sizeRange,
  lineHeightRange: options.heading ? [0.9, 1.4] : [1.3, 1.9],
  colorAllowed: options.color ?? false,
  transformAllowed: options.transform ?? false,
});

const TYPE_ROLES = [
  typeRole(
    "type.display",
    ".rz .display",
    {
      size: 88,
      lineHeight: 0.97,
      weight: 600,
      letterSpacing: -0.038,
      color: "ink",
    },
    [32, 112],
    { heading: true, color: true },
  ),
  typeRole(
    "type.h2",
    ".rz .h2",
    {
      size: 44,
      lineHeight: 1.05,
      weight: 600,
      letterSpacing: -0.033,
      color: "ink",
    },
    [24, 64],
    { heading: true, color: true },
  ),
  typeRole(
    "type.h3",
    ".rz .h3",
    {
      size: 24,
      lineHeight: 1.18,
      weight: 600,
      letterSpacing: -0.022,
      color: "ink",
    },
    [18, 40],
    { heading: true, color: true },
  ),
  typeRole(
    "type.h4",
    ".rz .h4",
    {
      size: 18,
      lineHeight: 1.3,
      weight: 600,
      letterSpacing: -0.014,
      color: "ink",
    },
    [14, 28],
    { heading: true, color: true },
  ),
  typeRole("type.lead", ".rz .lead", { size: 19, lineHeight: 1.55 }, [15, 24]),
  typeRole("type.body", ".rz .body", { size: 16, lineHeight: 1.6 }, [14, 20]),
  typeRole("type.small", ".rz .sm", { size: 14, lineHeight: 1.5 }, [12, 17]),
  typeRole("type.meta", ".rz .xs", { size: 12.5, lineHeight: 1.45 }, [12, 15]),
  typeRole(
    "type.kicker",
    ".rz .kicker",
    {
      size: 13.5,
      lineHeight: 1.4,
      weight: 500,
      letterSpacing: -0.005,
      color: "muted",
    },
    [12, 16],
    { color: true, transform: true },
  ),
];

const role = (id, kind, scope, selector, surfaces, textTokens) => ({
  id,
  label: id,
  kind,
  scope,
  selector,
  hoverSelector: `${selector}:hover`,
  surfaces,
  textTokens,
});

const ROLES = [
  role(
    "role.button.primary",
    "button",
    "site",
    '.rz .btn-ink:not([aria-disabled="true"])',
    ["ink"],
    ["onInk"],
  ),
  role(
    "role.button.secondary",
    "button",
    "site",
    ".rz .btn-line",
    ["page"],
    ["ink"],
  ),
  role("role.link", "link", "site", ".rz .link", ["page", "paper"], ["accent"]),
  role("role.panel", "card", "site", ".rz .panel", ["page"], ["ink", "muted"]),
  role(
    "role.chip",
    "chip",
    "site",
    ".rz .opt-chip:not(.on)",
    ["page"],
    ["ink2"],
  ),
  role(
    "ws.button.primary",
    "button",
    "workspace",
    ".rzw .btn-ink",
    ["ink"],
    ["onInk"],
  ),
  role(
    "ws.card",
    "card",
    "workspace",
    ".W .w-card",
    ["page"],
    ["ink", "muted"],
  ),
];

const ALL_GROUPS = [
  "color",
  "background",
  "typography",
  "spacing",
  "border",
  "shadow",
  "size",
];
const component = (id, kind, surface, textTokens, extra = {}) => ({
  id,
  label: id,
  kind,
  scope: "site",
  pages: ["public.home"],
  file: "test/synthetic.tsx",
  surface,
  groups: ALL_GROUPS,
  textTokens,
  ...extra,
});

const COMPONENTS = [
  component("site.header", "header", "page", ["ink", "muted"]),
  component("site.header.brand", "brand", "page", ["ink"]),
  component("site.header.nav", "nav", "page", ["muted"]),
  component("site.footer", "footer", "page", ["muted", "subtle"]),
  component("home.hero.title", "heading", "page", ["ink"], { largeText: true }),
  component("home.hero.lead", "text", "page", ["muted"]),
  component("home.hero.figure", "media", "paper", []),
  component("home.ways", "section", "page", ["ink", "muted", "subtle"]),
  component("home.ways.kicker", "text", "page", ["muted"], {
    within: "home.ways",
    transformAllowed: true,
  }),
  component("home.ways.title", "heading", "page", ["ink"], {
    within: "home.ways",
    largeText: true,
  }),
  component("home.ways.card", "card", "paper", ["ink", "muted"]),
  component("home.how", "section", "paper", ["ink", "muted", "subtle"]),
  component("home.issues.grid", "grid", "page", []),
  component("home.available.browse", "link", "page", ["accent"]),
  component("home.attorneys.explore", "button", "page", ["ink"]),
  component("home.attorneys.title", "heading", "paper", ["ink"], {
    groups: ["color"],
  }),
  component("client.chip", "chip", "page", ["ink2"]),
  component("client.account", "page", "page", ["ink"]),
  {
    ...component("staff.sidebar", "sidebar", "paper", ["ink", "muted"]),
    scope: "workspace",
  },
  { ...component("staff.top", "bar", "page", ["ink"]), scope: "workspace" },
];

const slot = (id, defaultText, max, lines = 1) => ({
  id,
  page: "public.home",
  label: id,
  defaultText,
  max,
  lines,
  occurrences: 1,
});

export const HOME_SLOTS = Object.freeze([
  slot("home.hero.title", "Talk to a lawyer\nin minutes.", 60, 2),
  slot(
    "home.hero.lead",
    "Describe what’s going on in plain words. Meet an attorney now, or book a time that suits you.",
    180,
  ),
  slot("home.available.browse", "Browse all attorneys", 32),
  slot("home.ways.kicker", "Two ways to consult", 40),
  slot("home.ways.title", "Talk now, or at a time that suits you.", 80),
  slot("home.ways.now.title", "When you’d like answers today", 60),
  slot("home.ways.now.link", "See who’s available", 32),
  slot("home.ways.schedule.title", "When you’d rather plan ahead", 60),
  slot("home.ways.schedule.link", "Browse open times", 32),
  slot("home.how.kicker", "How Rosuno works", 40),
  slot("home.how.title", "From a question to a conversation.", 80),
  slot("home.issues.kicker", "Browse by legal issue", 40),
  slot("home.issues.title", "Not sure what to search for?", 80),
  slot(
    "home.issues.lead",
    "Pick the area that sounds closest and start from a familiar situation.",
    160,
  ),
  slot("home.attorneys.title", "Are you an attorney?", 48),
  slot(
    "home.attorneys.body",
    "Manage consultations, availability and requests with Rosuno.",
    120,
  ),
  slot("home.attorneys.apply", "Apply to join", 32),
  slot("home.attorneys.explore", "Explore Rosuno for attorneys", 40),
]);

export const HOME_SECTIONS = Object.freeze({
  id: "home.sections",
  page: "public.home",
  sections: [
    {
      id: "home.hero",
      label: "Hero",
      fixed: "first",
      reorderable: false,
      hideable: false,
      reason: "holds the search form",
    },
    {
      id: "home.available",
      label: "Available now",
      fixed: null,
      reorderable: true,
      hideable: false,
      reason: "link target",
    },
    {
      id: "home.ways",
      label: "Two ways",
      fixed: null,
      reorderable: true,
      hideable: true,
    },
    {
      id: "home.how",
      label: "How it works",
      fixed: null,
      reorderable: true,
      hideable: true,
    },
    {
      id: "home.issues",
      label: "Browse by issue",
      fixed: null,
      reorderable: true,
      hideable: false,
      reason: "header link target",
    },
    {
      id: "home.attorneys",
      label: "For attorneys",
      fixed: null,
      reorderable: true,
      hideable: true,
    },
  ],
});

export const TEST_REGISTRY = Object.freeze({
  tokens: TOKENS,
  typeRoles: TYPE_ROLES,
  roles: ROLES,
  components: COMPONENTS,
  slots: HOME_SLOTS,
  sectionGroups: [HOME_SECTIONS],
  pages: [
    {
      id: "public.home",
      label: "Home",
      path: "/",
      rendering: "dynamic",
      slots: true,
      sections: true,
    },
  ],
  protectedAreas: [
    { id: "home.finder", label: "Search form", reason: "functional control" },
  ],
});

export const validate = (raw, mode) =>
  validateAppearance(raw, TEST_REGISTRY, mode);

// The studio specification's section 3.6 example input.
export const SPEC_EXAMPLE = Object.freeze({
  schema: 1,
  tokens: { site: { ink: "#1c1917", accent: "#0f5f5a", radius: 10 } },
  type: { "type.display": { size: { desktop: 72, tablet: 56 } } },
  roles: {
    "role.button.primary": {
      border: { radius: 999 },
      typography: { weight: 600 },
    },
  },
  components: {
    "home.ways": {
      background: { type: "color", color: "#f6f5f2" },
      spacing: { padding: { desktop: { top: 96, bottom: 96 } } },
    },
  },
  slots: { "home.ways.title": "Talk now, or plan ahead." },
  sections: {
    "home.sections": {
      order: [
        "home.available",
        "home.how",
        "home.ways",
        "home.issues",
        "home.attorneys",
      ],
      hidden: ["home.attorneys"],
    },
  },
});

// ---------------------------------------------------------------------------
// Synthetic images
// ---------------------------------------------------------------------------

export function pngChunk(type, data, { badCrc = false } = {}) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((zlib.crc32(body) ^ (badCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function ihdr(width = 16, height = 16, colorType = 2, depth = 8) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  return pngChunk("IHDR", header);
}

export function idat(width = 16, height = 16) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), Buffer.alloc(width * 3, 0x80));
  }
  return pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows)));
}

export const IEND = pngChunk("IEND", Buffer.alloc(0));

// A PNG from chunk buffers (the signature added).
export const png = (...chunks) => Buffer.concat([PNG_SIGNATURE, ...chunks]);

// A clean 16x16 RGB PNG.
export function cleanPng(width = 16, height = 16) {
  return png(ihdr(width, height), idat(width, height), IEND);
}

export function jpegSegment(marker, body) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, body]);
}

const huffman = (table) => {
  const counts = Buffer.alloc(16);
  counts[0] = 1;
  return jpegSegment(
    0xc4,
    Buffer.concat([Buffer.from([table]), counts, Buffer.from([0])]),
  );
};

export function sof(marker = 0xc0, width = 16, height = 16) {
  const body = Buffer.alloc(9);
  body[0] = 8;
  body.writeUInt16BE(height, 1);
  body.writeUInt16BE(width, 3);
  body[5] = 1;
  body[6] = 1;
  body[7] = 0x11;
  body[8] = 0;
  return jpegSegment(marker, body);
}

export const JFIF = jpegSegment(
  0xe0,
  Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
);
export const DQT = jpegSegment(
  0xdb,
  Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]),
);
export const DHT = Buffer.concat([huffman(0x00), huffman(0x10)]);
export const SCAN = Buffer.concat([
  jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x00]),
]);
export const EOI = Buffer.from([0xff, 0xd9]);
export const SOI = Buffer.from([0xff, 0xd8]);

// A JPEG from segments (SOI, the given parts, then the scan and EOI).
export const jpeg = (...parts) => Buffer.concat([SOI, ...parts, SCAN, EOI]);

// A clean 16x16 baseline greyscale JPEG.
export function cleanJpeg(width = 16, height = 16) {
  return jpeg(JFIF, DQT, sof(0xc0, width, height), DHT);
}

export function webpChunk(fourcc, data) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([
    Buffer.from(fourcc, "latin1"),
    size,
    data,
    Buffer.alloc(data.length % 2),
  ]);
}

export function vp8l(width = 16, height = 16) {
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0);
  return webpChunk(
    "VP8L",
    Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(4)]),
  );
}

export function vp8(width = 16, height = 16) {
  const data = Buffer.alloc(14);
  data[0] = 0x10; // key frame (bit 0 clear), version 0, shown
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", data);
}

export function vp8x(flags, width = 16, height = 16) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", data);
}

// A WebP from chunks (the RIFF header with its exact length added).
export function webp(...chunks) {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
}

// A clean 16x16 lossless WebP.
export const cleanWebp = (width = 16, height = 16) => webp(vp8l(width, height));

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>alert(1)</script></svg>',
);
export const GIF = Buffer.from(
  "GIF89a\u0010\u0000\u0010\u0000\u0000\u0000\u0000;",
  "latin1",
);
export const HTML = Buffer.from("<!doctype html><title>x</title>");
