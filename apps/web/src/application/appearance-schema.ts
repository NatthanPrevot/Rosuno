// Website and appearance studio: the configuration schema, its validator and
// the pure helpers around it (DEV-001; studio specification sections 3.1 to
// 3.4).
//
// A site appearance is typed data, never code: token overrides (colours,
// radii, fonts, elevation), type-role and component styles from a fixed
// allow-list per component kind, page text slots, section order and
// visibility, and logo and image references. The validator is pure,
// deterministic and isomorphic (server routes, server actions, the studio and
// the preview bridge run the same code). It is generic over a registry value:
// the concrete registry of components, roles, slots and sections is
// presentation data handed in by the caller, so this module never imports
// presentation code.
//
// What the validator guarantees for an accepted configuration:
// - every key is known (strict at every depth), no null, every number finite,
//   within its range and on its step, every colour #rrggbb lowercase, every
//   enum one of its values;
// - every component, role, type role, slot and section group is in the
//   registry, and every style group is allowed for its kind;
// - page texts are plain text within their length and line limits, with no
//   markup character, link, contact detail or regulated phrase (the same rule
//   as the database's site_appearance_text_allowed);
// - section order is a permutation of exactly the reorderable sections and
//   only hideable sections are hidden;
// - the asset list is exactly the set of images the configuration
//   references;
// - its database text form is at most 65,536 octets;
// - in publish mode, every text and background pair keeps at least
//   min(WCAG AA, the owner design's own ratio) (in draft mode those come back
//   as warnings).
// Nothing here emits CSS or markup; the compiler re-asserts every value it
// serializes.

// ---------------------------------------------------------------------------
// Vocabulary and types
// ---------------------------------------------------------------------------

export const APPEARANCE_SCHEMA_VERSION = 1;
export const BREAKPOINTS = Object.freeze([
  "desktop",
  "tablet",
  "phone",
] as const);
export type Breakpoint = (typeof BREAKPOINTS)[number];
export type Responsive<T> = { readonly [K in Breakpoint]?: T };
export type Hex = string;
export type Sha256 = string;
export const ASSET_FORMATS = Object.freeze(["png", "jpeg", "webp"] as const);
export type AssetFormat = (typeof ASSET_FORMATS)[number];
export type AssetRef = {
  readonly sha256: Sha256;
  readonly format: AssetFormat;
};
export const FONT_KEYS = Object.freeze([
  "instrument-sans",
  "inter",
  "system",
] as const);
export type FontKey = (typeof FONT_KEYS)[number];
export const WEIGHTS = Object.freeze([400, 500, 600, 700] as const);
export type Weight = (typeof WEIGHTS)[number];
export const ELEVATIONS = Object.freeze(["default", "flat", "raised"] as const);
export type Elevation = (typeof ELEVATIONS)[number];
export const SHADOWS = Object.freeze(["none", "e1", "e2", "e3"] as const);
export type Shadow = (typeof SHADOWS)[number];
export const TRANSFORMS = Object.freeze(["none", "uppercase"] as const);
export const GRADIENT_ANGLES = Object.freeze([
  0, 45, 90, 135, 180, 225, 270, 315,
] as const);
export const IMAGE_FITS = Object.freeze(["cover", "contain"] as const);
export const IMAGE_POSITIONS = Object.freeze([
  "center",
  "top",
  "bottom",
  "left",
  "right",
] as const);
export const WORDMARKS = Object.freeze(["shown", "hidden"] as const);

export type SiteTokens = {
  readonly ink?: Hex;
  readonly ink2?: Hex;
  readonly muted?: Hex;
  readonly subtle?: Hex;
  readonly faint?: Hex;
  readonly line?: Hex;
  readonly line2?: Hex;
  readonly line3?: Hex;
  readonly page?: Hex;
  readonly paper?: Hex;
  readonly paper2?: Hex;
  readonly accent?: Hex;
  readonly radius?: number;
  readonly fontDisplay?: FontKey;
  readonly fontBody?: FontKey;
  readonly elevation?: Elevation;
};
export type WorkspaceTokens = Omit<SiteTokens, "radius"> & {
  readonly canvas?: Hex;
  readonly accent2?: Hex;
  readonly staffRadius?: number;
};

export type Typography = {
  readonly family?: FontKey;
  readonly weight?: Weight;
  readonly size?: Responsive<number>;
  readonly lineHeight?: number;
  readonly letterSpacing?: number;
  readonly transform?: "none" | "uppercase";
};
export type Background =
  | { readonly type: "color"; readonly color: Hex }
  | {
      readonly type: "gradient";
      readonly from: Hex;
      readonly to: Hex;
      readonly angle: (typeof GRADIENT_ANGLES)[number];
    }
  | {
      readonly type: "image";
      readonly asset: AssetRef;
      readonly fit: (typeof IMAGE_FITS)[number];
      readonly position: (typeof IMAGE_POSITIONS)[number];
    };
export type Sides = {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
};
export type ColorKey =
  | "text"
  | "background"
  | "border"
  | "textHover"
  | "backgroundHover"
  | "borderHover";
export type ComponentStyle = {
  readonly color?: { readonly [K in ColorKey]?: Hex };
  readonly background?: Background;
  readonly typography?: Typography;
  readonly spacing?: {
    readonly padding?: Responsive<Sides>;
    readonly gap?: Responsive<number>;
  };
  readonly border?: {
    readonly radius?: number;
    readonly width?: number;
    readonly color?: Hex;
    readonly top?: { readonly width?: number; readonly color?: Hex };
    readonly right?: { readonly color?: Hex };
    readonly bottom?: { readonly width?: number; readonly color?: Hex };
  };
  readonly shadow?: Shadow;
  readonly size?: { readonly height?: number; readonly paddingX?: number };
};
export type SectionsConfig = {
  readonly order?: readonly string[];
  readonly hidden?: readonly string[];
};
export type BrandLogo = {
  readonly asset: AssetRef;
  readonly width: number;
  readonly height: number;
  readonly wordmark: (typeof WORDMARKS)[number];
};

export type AppearanceConfiguration = {
  readonly schema: 1;
  readonly tokens?: {
    readonly site?: SiteTokens;
    readonly workspace?: WorkspaceTokens;
  };
  readonly type?: Readonly<
    Record<string, Typography & { readonly color?: Hex }>
  >;
  readonly roles?: Readonly<Record<string, ComponentStyle>>;
  readonly components?: Readonly<Record<string, ComponentStyle>>;
  readonly slots?: Readonly<Record<string, string>>;
  readonly sections?: Readonly<Record<string, SectionsConfig>>;
  readonly brand?: { readonly logo?: BrandLogo };
  readonly assets?: readonly AssetRef[];
};

declare const VALID: unique symbol;
export type ValidAppearance = AppearanceConfiguration & {
  readonly [VALID]: true;
};

export type IssueCode =
  | "not_object"
  | "unknown_key"
  | "schema"
  | "too_large"
  | "bad_color"
  | "out_of_range"
  | "bad_enum"
  | "unknown_id"
  | "group_not_allowed"
  | "slot_length"
  | "slot_lines"
  | "slot_characters"
  | "slot_banned"
  | "slot_link"
  | "section_order"
  | "section_hidden"
  | "asset_reference"
  | "contrast";
// path is a JSON Pointer (RFC 6901) into the configuration; for a contrast
// issue, against names the other colour of the pair.
export type Issue = {
  readonly path: string;
  readonly code: IssueCode;
  readonly required?: number;
  readonly actual?: number;
  readonly against?: string;
};
export type ValidationMode = "draft" | "publish";
export type ValidationResult =
  | {
      readonly ok: true;
      readonly value: ValidAppearance;
      readonly canonical: string;
      readonly warnings: readonly Issue[];
    }
  | { readonly ok: false; readonly issues: readonly Issue[] };

// ---------------------------------------------------------------------------
// The registry's shape (the data lives in presentation code)
// ---------------------------------------------------------------------------

export type AppearanceScope = "site" | "workspace";
export const COMPONENT_KINDS = Object.freeze([
  "page",
  "header",
  "footer",
  "brand",
  "nav",
  "section",
  "media",
  "heading",
  "text",
  "link",
  "button",
  "card",
  "grid",
  "sidebar",
  "bar",
  "chip",
] as const);
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export const STYLE_GROUPS = Object.freeze([
  "color",
  "background",
  "typography",
  "spacing",
  "border",
  "shadow",
  "size",
] as const);
export type StyleGroup = (typeof STYLE_GROUPS)[number];

export type TokenSpec = {
  readonly scope: AppearanceScope;
  readonly key: string;
  readonly cssName: string;
  readonly type: "color" | "length" | "font" | "elevation";
  readonly default: string | number;
  readonly range?: readonly [number, number];
};
export type TypeRoleSpec = {
  readonly id: string;
  readonly label: string;
  readonly selector: string;
  readonly defaults: {
    readonly size: number;
    readonly lineHeight: number;
    readonly weight?: Weight;
    readonly letterSpacing?: number;
    // The token key of the role's default text colour (contrast baseline).
    readonly color?: string;
  };
  readonly sizeRange: readonly [number, number];
  readonly lineHeightRange: readonly [number, number];
  readonly colorAllowed: boolean;
  readonly transformAllowed: boolean;
};
export type RoleSpec = {
  readonly id: string;
  readonly label: string;
  readonly kind: ComponentKind;
  readonly scope: AppearanceScope;
  readonly selector: string;
  readonly hoverSelector?: string;
  // Token keys of the surfaces the role sits on and of its default text
  // colours (contrast baselines).
  readonly surfaces: readonly string[];
  readonly textTokens: readonly string[];
  readonly largeText?: boolean;
};
export type ComponentSpec = {
  readonly id: string;
  readonly label: string;
  readonly kind: ComponentKind;
  readonly scope: AppearanceScope;
  readonly pages: readonly string[];
  readonly file: string;
  // The token key of the surface the component sits on; a section whose
  // background override becomes its surface.
  readonly surface: string;
  readonly within?: string;
  readonly groups: readonly StyleGroup[];
  readonly textTokens: readonly string[];
  readonly largeText?: boolean;
  readonly transformAllowed?: boolean;
};
export type SlotSpec = {
  readonly id: string;
  readonly page: string;
  readonly label: string;
  readonly defaultText: string;
  readonly max: number;
  readonly lines: 1 | 2;
  readonly occurrences: number;
};
export type SectionSpec = {
  readonly id: string;
  readonly label: string;
  readonly fixed: "first" | null;
  readonly reorderable: boolean;
  readonly hideable: boolean;
  readonly reason?: string;
};
export type SectionGroupSpec = {
  readonly id: string;
  readonly page: string;
  readonly sections: readonly SectionSpec[];
};
export type PageSpec = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly rendering: "dynamic" | "static";
  readonly slots: boolean;
  readonly sections: boolean;
};
export type ProtectedArea = {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
};
export type AppearanceRegistry = {
  readonly tokens: readonly TokenSpec[];
  readonly typeRoles: readonly TypeRoleSpec[];
  readonly roles: readonly RoleSpec[];
  readonly components: readonly ComponentSpec[];
  readonly slots: readonly SlotSpec[];
  readonly sectionGroups: readonly SectionGroupSpec[];
  readonly pages: readonly PageSpec[];
  readonly protectedAreas: readonly ProtectedArea[];
};

// ---------------------------------------------------------------------------
// Limits and fixed tables
// ---------------------------------------------------------------------------

export const MAX_CONFIGURATION_BYTES = 65536;
export const MAX_ASSET_REFERENCES = 20;
export const MAX_TEXT_CHARACTERS = 300;
export const SPACING_SCALE = Object.freeze([
  0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56,
  64, 72, 80, 88, 96, 104, 112, 120, 128, 144, 160, 176, 200,
] as const);

const TOP_KEYS = Object.freeze([
  "schema",
  "tokens",
  "type",
  "roles",
  "components",
  "slots",
  "sections",
  "brand",
  "assets",
]);
const COLOR_TOKENS = Object.freeze([
  "ink",
  "ink2",
  "muted",
  "subtle",
  "faint",
  "line",
  "line2",
  "line3",
  "page",
  "paper",
  "paper2",
  "accent",
]);
export const SITE_TOKEN_KEYS = Object.freeze([
  ...COLOR_TOKENS,
  "radius",
  "fontDisplay",
  "fontBody",
  "elevation",
]);
export const WORKSPACE_TOKEN_KEYS = Object.freeze([
  ...COLOR_TOKENS,
  "canvas",
  "accent2",
  "staffRadius",
  "fontDisplay",
  "fontBody",
  "elevation",
]);
const TOKEN_RANGES: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({ radius: [6, 22], staffRadius: [8, 24] });

// The owner's literal fallbacks of the three hook tokens (studio spec section
// 1.4): the values the wrapped owner rules compute when no compiled sheet
// defines the hook.
export const OWNER_HOOK_DEFAULTS = Object.freeze({
  site: Object.freeze({
    onInk: "#ffffff",
    inkHover: "#24262b",
    surfaceHover: "#fcfcfb",
  }),
  workspace: Object.freeze({
    onInk: "#ffffff",
    inkHover: "#26282e",
    surfaceHover: "#fcfcfb",
  }),
});
const DARK_ON_INK = "#0f1013";

// Contrast pairs checked on the tokens of each scope (foreground, background).
export const TOKEN_CONTRAST_PAIRS = Object.freeze({
  site: Object.freeze([
    ["ink", "page"],
    ["ink", "paper"],
    ["ink", "paper2"],
    ["ink2", "page"],
    ["muted", "page"],
    ["muted", "paper"],
    ["muted", "paper2"],
    ["subtle", "page"],
    ["subtle", "paper"],
    ["accent", "page"],
    ["accent", "paper"],
    ["onInk", "ink"],
    ["onInk", "inkHover"],
  ] as const),
  workspace: Object.freeze([
    ["ink", "page"],
    ["ink", "paper"],
    ["ink", "canvas"],
    ["muted", "page"],
    ["muted", "paper"],
    ["subtle", "page"],
    ["subtle", "paper"],
    ["subtle", "canvas"],
    ["accent", "page"],
    ["accent", "accent2"],
    ["onInk", "ink"],
  ] as const),
});
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

type Range = readonly [number, number];
type KindRule = {
  readonly color: readonly ColorKey[];
  readonly background: readonly Background["type"][];
  readonly typography: {
    readonly family: boolean;
    readonly weight: boolean;
    readonly size: Range | null;
    readonly lineHeight: Range | null;
    readonly letterSpacing: boolean;
    readonly transform: "always" | "flagged" | "never";
  } | null;
  readonly padding: {
    readonly sides: "vertical" | "uniform";
    readonly max: number;
  } | null;
  readonly gap: number | null;
  readonly border: {
    readonly radius: Range | null;
    readonly pill: boolean;
    readonly width: boolean;
    readonly color: boolean;
    readonly top: boolean;
    readonly right: boolean;
    readonly bottom: boolean;
  } | null;
  readonly shadow: boolean;
  readonly size: boolean;
};
const NONE: KindRule = Object.freeze({
  color: [],
  background: [],
  typography: null,
  padding: null,
  gap: null,
  border: null,
  shadow: false,
  size: false,
});
const BORDER_NONE = Object.freeze({
  radius: null,
  pill: false,
  width: false,
  color: false,
  top: false,
  right: false,
  bottom: false,
});
const TYPE_NONE = Object.freeze({
  family: false,
  weight: false,
  size: null,
  lineHeight: null,
  letterSpacing: false,
  transform: "never" as const,
});
// The property-group allow-list per component kind (studio spec section 2.2).
// Nothing outside it exists: no display, visibility, opacity, position,
// z-index, width, height (other than a button's height and the logo's size),
// overflow, clip, outline, transform, content, raw value or selector.
export const KIND_RULES: Readonly<Record<ComponentKind, KindRule>> =
  Object.freeze({
    page: { ...NONE, background: ["color"] },
    header: {
      ...NONE,
      background: ["color"],
      border: { ...BORDER_NONE, bottom: true },
      shadow: true,
    },
    footer: {
      ...NONE,
      background: ["color"],
      border: { ...BORDER_NONE, top: true },
      padding: { sides: "vertical", max: 200 },
    },
    brand: { ...NONE, color: ["text"] },
    nav: {
      ...NONE,
      color: ["text", "textHover", "backgroundHover"],
      typography: { ...TYPE_NONE, weight: true, size: [12, 16] },
    },
    section: {
      ...NONE,
      background: ["color", "gradient"],
      padding: { sides: "vertical", max: 200 },
    },
    media: {
      ...NONE,
      background: ["color", "gradient", "image"],
      border: { ...BORDER_NONE, radius: [0, 48] },
    },
    heading: {
      ...NONE,
      color: ["text"],
      typography: {
        family: true,
        weight: true,
        size: [14, 112],
        lineHeight: [0.9, 1.4],
        letterSpacing: true,
        transform: "never",
      },
    },
    text: {
      ...NONE,
      color: ["text"],
      typography: {
        family: false,
        weight: true,
        size: [12, 24],
        lineHeight: [1.3, 1.9],
        letterSpacing: true,
        transform: "flagged",
      },
    },
    link: {
      ...NONE,
      color: ["text", "textHover"],
      typography: { ...TYPE_NONE, weight: true, size: [12, 18] },
    },
    button: {
      ...NONE,
      color: [
        "text",
        "background",
        "border",
        "textHover",
        "backgroundHover",
        "borderHover",
      ],
      border: {
        ...BORDER_NONE,
        radius: [0, 32],
        pill: true,
        width: true,
        color: true,
      },
      typography: {
        ...TYPE_NONE,
        weight: true,
        size: [12, 18],
        letterSpacing: true,
        transform: "always",
      },
      shadow: true,
      size: true,
    },
    card: {
      ...NONE,
      background: ["color"],
      border: { ...BORDER_NONE, radius: [0, 32], width: true, color: true },
      shadow: true,
      padding: { sides: "uniform", max: 64 },
    },
    grid: { ...NONE, gap: 48 },
    sidebar: {
      ...NONE,
      background: ["color"],
      border: { ...BORDER_NONE, right: true },
    },
    bar: {
      ...NONE,
      background: ["color"],
      border: { ...BORDER_NONE, bottom: true },
    },
    chip: {
      ...NONE,
      color: ["text", "background", "border"],
      border: { ...BORDER_NONE, radius: [0, 32], pill: true },
    },
  });

// The groups a kind allows at all.
export function groupsOfKind(kind: ComponentKind): readonly StyleGroup[] {
  const rule = KIND_RULES[kind];
  return STYLE_GROUPS.filter((group) => {
    switch (group) {
      case "color":
        return rule.color.length > 0;
      case "background":
        return rule.background.length > 0;
      case "typography":
        return rule.typography !== null;
      case "spacing":
        return rule.padding !== null || rule.gap !== null;
      case "border":
        return rule.border !== null;
      case "shadow":
        return rule.shadow;
      case "size":
        return rule.size;
    }
  });
}

const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){0,3}$/;
const HEX = /^#[0-9a-f]{6}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PILL = 999;

export function isAppearanceId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ID.test(value);
}
export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX.test(value);
}
export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256.test(value);
}

// ---------------------------------------------------------------------------
// Page text (the database's site_appearance_text_allowed is the same rule)
// ---------------------------------------------------------------------------

// Regulated vocabulary refused in editable text (recommendation and ranking,
// qualification and status, outcome and price, legal text). Owner-confirmable
// (decision D5); held in code as a fixed safety bound.
export const APPEARANCE_BANNED_PHRASES = Object.freeze([
  "best",
  "top rated",
  "recommended",
  "recommend",
  "recommends",
  "ranked",
  "ranking",
  "perfect",
  "right lawyer",
  "match",
  "matched",
  "matching",
  "ai selected",
  "rosuno recommends",
  "independent",
  "licensed",
  "certified",
  "board certified",
  "accredited",
  "specialist",
  "specialists",
  "specialized",
  "specialised",
  "expert",
  "experts",
  "vetted",
  "verified",
  "approved",
  "endorsed",
  "live in your state",
  "guarantee",
  "guaranteed",
  "guarantees",
  "promise",
  "cheapest",
  "lowest",
  "free",
  "risk free",
  "no win no fee",
  "legal advice",
  "disclaimer",
  "disclaimers",
  "liability",
  "liable",
  "warranty",
  "warranties",
  "warrant",
  "terms of use",
  "terms of service",
  "privacy policy",
  "we collect",
  "personal data",
  "cookie policy",
  "governing law",
] as const);

// NUL included here only: the database cannot hold it at all.
const TEXT_CONTROL =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const TEXT_MARKUP = /[<>{}\\]/;
const TEXT_LINK = /(https?:|www\.|javascript:|data:|@[a-z0-9-]+\.[a-z])/i;
const TEXT_EDGE = /^[ \n]|[ \n]$/;

export function characterCount(text: string): number {
  return [...text].length;
}

// The text's form for the phrase test: NFKC, ASCII letters lowered, every run
// of other characters one space, padded with spaces.
function phraseForm(nfkc: string): string {
  return ` ${nfkc
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")} `;
}

export type TextIssueCode =
  "slot_length" | "slot_characters" | "slot_link" | "slot_banned";

// Why a page text is refused (null when it is allowed), in the order the
// studio reports it.
export function appearanceTextIssue(text: unknown): TextIssueCode | null {
  if (typeof text !== "string") {
    return "slot_characters";
  }
  const count = characterCount(text);
  if (count < 1 || count > MAX_TEXT_CHARACTERS) {
    return "slot_length";
  }
  if (text !== text.normalize("NFC") || TEXT_EDGE.test(text)) {
    return "slot_characters";
  }
  const nfkc = text.normalize("NFKC");
  if (TEXT_CONTROL.test(nfkc) || TEXT_MARKUP.test(nfkc)) {
    return "slot_characters";
  }
  if (TEXT_LINK.test(nfkc)) {
    return "slot_link";
  }
  const form = phraseForm(nfkc);
  return APPEARANCE_BANNED_PHRASES.some((phrase) =>
    form.includes(` ${phrase} `),
  )
    ? "slot_banned"
    : null;
}

export function appearanceTextAllowed(text: unknown): boolean {
  return appearanceTextIssue(text) === null;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function channels(hex: Hex): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function hexOf(values: readonly number[]): Hex {
  return `#${values
    .map((value) =>
      Math.min(255, Math.max(0, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// WCAG 2.x relative luminance of an sRGB colour.
export function relativeLuminance(hex: Hex): number {
  if (!isHex(hex)) {
    throw new TypeError("appearance: not a colour");
  }
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The WCAG contrast ratio of two colours (1 to 21).
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// a mixed towards b by t (0 to 1), each channel rounded.
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  if (!isHex(a) || !isHex(b) || !(t >= 0 && t <= 1)) {
    throw new TypeError("appearance: bad mix");
  }
  const ca = channels(a);
  const cb = channels(b);
  return hexOf(ca.map((value, i) => value * (1 - t) + cb[i] * t));
}

// The text colour of an ink fill: whichever of white and the owner's ink
// contrasts more with it (white on a tie).
export function onInkFor(ink: Hex): Hex {
  return contrastRatio(DARK_ON_INK, ink) > contrastRatio("#ffffff", ink)
    ? DARK_ON_INK
    : "#ffffff";
}

// The hover background derived for an overridden base background.
export function derivedHoverBackground(background: Hex, ink: Hex): Hex {
  return relativeLuminance(background) < 0.5
    ? mixHex(background, "#ffffff", 0.09)
    : mixHex(background, ink, 0.03);
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

function serialize(value: unknown, spaced: boolean): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const comma = spaced ? ", " : ",";
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item, spaced)).join(comma)}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}${spaced ? ": " : ":"}${serialize(
          (value as Record<string, unknown>)[key],
          spaced,
        )}`,
    )
    .join(comma)}}`;
}

// Deterministic JSON: keys sorted, no whitespace.
export function canonicalJson(value: unknown): string {
  return serialize(value, false);
}

// The UTF-8 length of the configuration's database text form (jsonb prints
// ", " and ": " separators), so the application and the database measure the
// 65,536-octet bound alike.
export function databaseTextOctets(value: unknown): number {
  return new TextEncoder().encode(serialize(value, true)).length;
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

const validated = new WeakSet<object>();

// Whether a value is a configuration this module validated (in this
// process); the compiler's defence in depth behind the branded type.
export function isValidatedAppearance(
  value: unknown,
): value is ValidAppearance {
  return typeof value === "object" && value !== null && validated.has(value);
}

type Entries = ReadonlyArray<readonly [string, unknown]>;

// The own data entries of a plain object, or null for anything else (an
// array, a class instance, an accessor, a symbol key).
function entriesOf(value: unknown): Entries | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function itemsOf(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined || !("value" in descriptor)) {
        return null;
      }
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

function pointer(...parts: readonly (string | number)[]): string {
  return parts
    .map(
      (part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    )
    .join("");
}

type Out = Record<string, unknown>;

class Reader {
  readonly issues: Issue[] = [];

  add(path: string, code: IssueCode, extra: Partial<Issue> = {}): void {
    this.issues.push(Object.freeze({ path, code, ...extra }));
  }

  // The entries of an object at path whose keys are all allowed; unknown keys
  // are reported. null when it is not an object.
  object(
    value: unknown,
    path: string,
    allowed: readonly string[] | null,
  ): Entries | null {
    const entries = entriesOf(value);
    if (entries === null) {
      this.add(path, "not_object");
      return null;
    }
    if (allowed === null) {
      return entries;
    }
    const known: Array<readonly [string, unknown]> = [];
    for (const entry of entries) {
      if (allowed.includes(entry[0])) {
        known.push(entry);
      } else {
        this.add(`${path}${pointer(entry[0])}`, "unknown_key");
      }
    }
    return known;
  }

  color(value: unknown, path: string): Hex | undefined {
    if (isHex(value)) {
      return value;
    }
    this.add(path, "bad_color");
    return undefined;
  }

  number(
    value: unknown,
    path: string,
    [min, max]: Range,
    step: number,
    also: readonly number[] = [],
  ): number | undefined {
    if (typeof value === "number" && also.includes(value)) {
      return value;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      !onStep(value, step)
    ) {
      this.add(path, "out_of_range");
      return undefined;
    }
    return value;
  }

  scale(value: unknown, path: string, max: number): number | undefined {
    if (
      typeof value === "number" &&
      SPACING_SCALE.some((entry) => entry === value) &&
      value <= max
    ) {
      return value;
    }
    this.add(path, "out_of_range");
    return undefined;
  }

  choice<T extends string | number>(
    list: readonly T[],
    value: unknown,
    path: string,
  ): T | undefined {
    const found = list.find((entry) => entry === value);
    if (found === undefined) {
      this.add(path, "bad_enum");
    }
    return found;
  }
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

// On the step and written without float noise (0.3, never
// 0.30000000000000004).
function onStep(value: number, step: number): boolean {
  const ratio = value / step;
  if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
    return false;
  }
  return Number(value.toFixed(decimalsOf(step))) === value;
}

function put(out: Out, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return;
  }
  out[key] = value;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      freezeDeep(item);
    }
    Object.freeze(value);
  }
  return value;
}

function readAssetRef(
  reader: Reader,
  value: unknown,
  path: string,
): AssetRef | undefined {
  const entries = reader.object(value, path, ["sha256", "format"]);
  if (entries === null) {
    return undefined;
  }
  const map = new Map(entries);
  const sha = map.get("sha256");
  const format = map.get("format");
  if (!isSha256(sha)) {
    reader.add(`${path}/sha256`, "asset_reference");
    return undefined;
  }
  const chosen = reader.choice(ASSET_FORMATS, format, `${path}/format`);
  return chosen === undefined ? undefined : { sha256: sha, format: chosen };
}

function readResponsive<T>(
  reader: Reader,
  value: unknown,
  path: string,
  item: (value: unknown, path: string) => T | undefined,
): Responsive<T> | undefined {
  const entries = reader.object(value, path, BREAKPOINTS);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [breakpoint, entry] of entries) {
    put(out, breakpoint, item(entry, `${path}${pointer(breakpoint)}`));
  }
  return out as Responsive<T>;
}

type TypographyRule = NonNullable<KindRule["typography"]>;

function readTypography(
  reader: Reader,
  value: unknown,
  path: string,
  rule: TypographyRule,
  transformAllowed: boolean,
  withColor: boolean,
): (Typography & { color?: Hex }) | undefined {
  const allowed = [
    ...(rule.family ? ["family"] : []),
    ...(rule.weight ? ["weight"] : []),
    ...(rule.size !== null ? ["size"] : []),
    ...(rule.lineHeight !== null ? ["lineHeight"] : []),
    ...(rule.letterSpacing ? ["letterSpacing"] : []),
    ...(transformAllowed ? ["transform"] : []),
    ...(withColor ? ["color"] : []),
  ];
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [key, entry] of entries) {
    const at = `${path}${pointer(key)}`;
    if (!allowed.includes(key)) {
      const known = [
        "family",
        "weight",
        "size",
        "lineHeight",
        "letterSpacing",
        "transform",
        "color",
      ].includes(key);
      reader.add(at, known ? "group_not_allowed" : "unknown_key");
      continue;
    }
    switch (key) {
      case "family":
        put(out, key, reader.choice(FONT_KEYS, entry, at));
        break;
      case "weight":
        put(out, key, reader.choice(WEIGHTS, entry, at));
        break;
      case "size":
        put(
          out,
          key,
          readResponsive(reader, entry, at, (v, p) =>
            reader.number(v, p, rule.size as Range, 0.5),
          ),
        );
        break;
      case "lineHeight":
        put(out, key, reader.number(entry, at, rule.lineHeight as Range, 0.01));
        break;
      case "letterSpacing":
        put(out, key, reader.number(entry, at, [-0.05, 0.08], 0.001));
        break;
      case "transform":
        put(out, key, reader.choice(TRANSFORMS, entry, at));
        break;
      case "color":
        put(out, key, reader.color(entry, at));
        break;
    }
  }
  return out as Typography;
}

function readBackground(
  reader: Reader,
  value: unknown,
  path: string,
  allowed: readonly Background["type"][],
): Background | undefined {
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const map = new Map(entries);
  const type = map.get("type");
  if (type !== "color" && type !== "gradient" && type !== "image") {
    reader.add(`${path}/type`, "bad_enum");
    return undefined;
  }
  if (!allowed.includes(type)) {
    reader.add(`${path}/type`, "group_not_allowed");
    return undefined;
  }
  const keys =
    type === "color"
      ? ["type", "color"]
      : type === "gradient"
        ? ["type", "from", "to", "angle"]
        : ["type", "asset", "fit", "position"];
  const known = reader.object(value, path, keys);
  if (known === null) {
    return undefined;
  }
  for (const key of keys) {
    if (!map.has(key)) {
      reader.add(`${path}${pointer(key)}`, "not_object");
      return undefined;
    }
  }
  if (type === "color") {
    const color = reader.color(map.get("color"), `${path}/color`);
    return color === undefined ? undefined : { type, color };
  }
  if (type === "gradient") {
    const from = reader.color(map.get("from"), `${path}/from`);
    const to = reader.color(map.get("to"), `${path}/to`);
    const angle = reader.choice(
      GRADIENT_ANGLES,
      map.get("angle"),
      `${path}/angle`,
    );
    return from === undefined || to === undefined || angle === undefined
      ? undefined
      : { type, from, to, angle };
  }
  const asset = readAssetRef(reader, map.get("asset"), `${path}/asset`);
  const fit = reader.choice(IMAGE_FITS, map.get("fit"), `${path}/fit`);
  const position = reader.choice(
    IMAGE_POSITIONS,
    map.get("position"),
    `${path}/position`,
  );
  return asset === undefined || fit === undefined || position === undefined
    ? undefined
    : { type, asset, fit, position };
}

function readStyle(
  reader: Reader,
  value: unknown,
  path: string,
  kind: ComponentKind,
  groups: readonly StyleGroup[],
  transformAllowed: boolean,
): ComponentStyle | undefined {
  const rule = KIND_RULES[kind];
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [group, entry] of entries) {
    const at = `${path}${pointer(group)}`;
    if (!STYLE_GROUPS.some((known) => known === group)) {
      reader.add(at, "unknown_key");
      continue;
    }
    if (!groups.some((known) => known === group)) {
      reader.add(at, "group_not_allowed");
      continue;
    }
    switch (group as StyleGroup) {
      case "color": {
        const colors = reader.object(entry, at, null);
        const read: Out = {};
        for (const [key, color] of colors ?? []) {
          if (!rule.color.some((allowed) => allowed === key)) {
            reader.add(
              `${at}${pointer(key)}`,
              colorKey(key) ? "group_not_allowed" : "unknown_key",
            );
            continue;
          }
          put(read, key, reader.color(color, `${at}${pointer(key)}`));
        }
        put(out, group, read);
        break;
      }
      case "background":
        put(out, group, readBackground(reader, entry, at, rule.background));
        break;
      case "typography":
        put(
          out,
          group,
          readTypography(
            reader,
            entry,
            at,
            rule.typography as TypographyRule,
            rule.typography?.transform === "always" ||
              (rule.typography?.transform === "flagged" && transformAllowed),
            false,
          ),
        );
        break;
      case "spacing": {
        const allowed = [
          ...(rule.padding !== null ? ["padding"] : []),
          ...(rule.gap !== null ? ["gap"] : []),
        ];
        const spacing = reader.object(entry, at, null);
        const read: Out = {};
        for (const [key, item] of spacing ?? []) {
          const itemAt = `${at}${pointer(key)}`;
          if (!allowed.includes(key)) {
            reader.add(
              itemAt,
              key === "padding" || key === "gap"
                ? "group_not_allowed"
                : "unknown_key",
            );
            continue;
          }
          if (key === "gap") {
            put(
              read,
              key,
              readResponsive(reader, item, itemAt, (v, p) =>
                reader.scale(v, p, rule.gap as number),
              ),
            );
            continue;
          }
          const padding = rule.padding as NonNullable<KindRule["padding"]>;
          put(
            read,
            key,
            readResponsive(reader, item, itemAt, (v, p) =>
              readSides(reader, v, p, padding),
            ),
          );
        }
        put(out, group, read);
        break;
      }
      case "border":
        put(
          out,
          group,
          readBorder(
            reader,
            entry,
            at,
            rule.border as NonNullable<KindRule["border"]>,
          ),
        );
        break;
      case "shadow":
        put(out, group, reader.choice(SHADOWS, entry, at));
        break;
      case "size": {
        const size = reader.object(entry, at, ["height", "paddingX"]);
        const read: Out = {};
        for (const [key, item] of size ?? []) {
          const itemAt = `${at}${pointer(key)}`;
          put(
            read,
            key,
            key === "height"
              ? reader.number(item, itemAt, [32, 56], 1)
              : reader.number(item, itemAt, [8, 40], 1),
          );
        }
        put(out, group, read);
        break;
      }
    }
  }
  return out as ComponentStyle;
}

function colorKey(key: string): boolean {
  return [
    "text",
    "background",
    "border",
    "textHover",
    "backgroundHover",
    "borderHover",
  ].includes(key);
}

function readSides(
  reader: Reader,
  value: unknown,
  path: string,
  rule: NonNullable<KindRule["padding"]>,
): Sides | undefined {
  const sides = ["top", "right", "bottom", "left"];
  const allowed = rule.sides === "vertical" ? ["top", "bottom"] : sides;
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [key, item] of entries) {
    const at = `${path}${pointer(key)}`;
    if (!allowed.includes(key)) {
      reader.add(at, sides.includes(key) ? "group_not_allowed" : "unknown_key");
      continue;
    }
    put(out, key, reader.scale(item, at, rule.max));
  }
  if (rule.sides === "uniform" && Object.keys(out).length > 0) {
    const values = sides.map((side) => out[side]);
    if (values.some((v) => v === undefined) || new Set(values).size !== 1) {
      reader.add(path, "out_of_range");
      return undefined;
    }
  }
  return out as Sides;
}

function readBorder(
  reader: Reader,
  value: unknown,
  path: string,
  rule: NonNullable<KindRule["border"]>,
): ComponentStyle["border"] | undefined {
  const allowed = [
    ...(rule.radius !== null ? ["radius"] : []),
    ...(rule.width ? ["width"] : []),
    ...(rule.color ? ["color"] : []),
    ...(rule.top ? ["top"] : []),
    ...(rule.right ? ["right"] : []),
    ...(rule.bottom ? ["bottom"] : []),
  ];
  const known = ["radius", "width", "color", "top", "right", "bottom"];
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [key, item] of entries) {
    const at = `${path}${pointer(key)}`;
    if (!allowed.includes(key)) {
      reader.add(at, known.includes(key) ? "group_not_allowed" : "unknown_key");
      continue;
    }
    switch (key) {
      case "radius":
        put(
          out,
          key,
          reader.number(
            item,
            at,
            rule.radius as Range,
            1,
            rule.pill ? [PILL] : [],
          ),
        );
        break;
      case "width":
        put(out, key, reader.number(item, at, [0, 2], 0.5));
        break;
      case "color":
        put(out, key, reader.color(item, at));
        break;
      default: {
        const sideKeys = key === "right" ? ["color"] : ["width", "color"];
        const side = reader.object(item, at, sideKeys);
        const read: Out = {};
        for (const [sideKey, sideValue] of side ?? []) {
          const sideAt = `${at}${pointer(sideKey)}`;
          put(
            read,
            sideKey,
            sideKey === "width"
              ? reader.number(sideValue, sideAt, [0, 2], 0.5)
              : reader.color(sideValue, sideAt),
          );
        }
        put(out, key, read);
      }
    }
  }
  return out as ComponentStyle["border"];
}

function readTokens(
  reader: Reader,
  value: unknown,
  path: string,
  scope: AppearanceScope,
  registry: AppearanceRegistry,
): Out | undefined {
  const keys = scope === "site" ? SITE_TOKEN_KEYS : WORKSPACE_TOKEN_KEYS;
  const entries = reader.object(value, path, keys);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [key, entry] of entries) {
    const at = `${path}${pointer(key)}`;
    let read: unknown;
    if (key === "radius" || key === "staffRadius") {
      read = reader.number(entry, at, TOKEN_RANGES[key], 1);
    } else if (key === "fontDisplay" || key === "fontBody") {
      read = reader.choice(FONT_KEYS, entry, at);
    } else if (key === "elevation") {
      read = reader.choice(ELEVATIONS, entry, at);
    } else {
      read = reader.color(entry, at);
    }
    const spec = registry.tokens.find(
      (t) => t.scope === scope && t.key === key,
    );
    if (read !== undefined && spec !== undefined && spec.default === read) {
      continue;
    }
    put(out, key, read);
  }
  return out;
}

function readSlots(
  reader: Reader,
  value: unknown,
  path: string,
  registry: AppearanceRegistry,
): Out | undefined {
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [id, text] of entries) {
    const at = `${path}${pointer(id)}`;
    const spec = registry.slots.find((slot) => slot.id === id);
    if (spec === undefined) {
      reader.add(at, "unknown_id");
      continue;
    }
    const problem = slotIssue(text, spec);
    if (problem !== null) {
      reader.add(at, problem);
      continue;
    }
    if (text !== spec.defaultText) {
      out[id] = text;
    }
  }
  return out;
}

// Why an override text is refused for a slot (null when allowed).
export function slotIssue(text: unknown, slot: SlotSpec): IssueCode | null {
  if (typeof text !== "string") {
    return "slot_characters";
  }
  const count = characterCount(text);
  if (count < 1 || count > slot.max) {
    return "slot_length";
  }
  if (text.split("\n").length > slot.lines) {
    return "slot_lines";
  }
  return appearanceTextIssue(text);
}

function readSections(
  reader: Reader,
  value: unknown,
  path: string,
  registry: AppearanceRegistry,
): Out | undefined {
  const entries = reader.object(value, path, null);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [id, group] of entries) {
    const at = `${path}${pointer(id)}`;
    const spec = registry.sectionGroups.find((g) => g.id === id);
    if (spec === undefined) {
      reader.add(at, "unknown_id");
      continue;
    }
    const parts = reader.object(group, at, ["order", "hidden"]);
    if (parts === null) {
      continue;
    }
    const read: Out = {};
    const reorderable = spec.sections
      .filter((s) => s.reorderable)
      .map((s) => s.id);
    const hideable = spec.sections.filter((s) => s.hideable).map((s) => s.id);
    for (const [part, list] of parts) {
      const items = itemsOf(list);
      const partAt = `${at}${pointer(part)}`;
      if (part === "order") {
        if (
          items === null ||
          items.length !== reorderable.length ||
          new Set(items).size !== items.length ||
          !items.every(
            (item) => typeof item === "string" && reorderable.includes(item),
          )
        ) {
          reader.add(partAt, "section_order");
          continue;
        }
        if (items.some((item, i) => item !== reorderable[i])) {
          read.order = [...(items as string[])];
        }
      } else {
        if (
          items === null ||
          new Set(items).size !== items.length ||
          !items.every(
            (item) => typeof item === "string" && hideable.includes(item),
          )
        ) {
          reader.add(partAt, "section_hidden");
          continue;
        }
        if (items.length > 0) {
          read.hidden = [...(items as string[])].sort();
        }
      }
    }
    put(out, id, read);
  }
  return out;
}

function readBrand(
  reader: Reader,
  value: unknown,
  path: string,
): Out | undefined {
  const entries = reader.object(value, path, ["logo"]);
  if (entries === null) {
    return undefined;
  }
  const out: Out = {};
  for (const [, logo] of entries) {
    const at = `${path}/logo`;
    const parts = reader.object(logo, at, [
      "asset",
      "width",
      "height",
      "wordmark",
    ]);
    if (parts === null) {
      continue;
    }
    const map = new Map(parts);
    for (const key of ["asset", "width", "height", "wordmark"]) {
      if (!map.has(key)) {
        reader.add(`${at}${pointer(key)}`, "not_object");
      }
    }
    const asset = readAssetRef(reader, map.get("asset"), `${at}/asset`);
    const width = reader.number(map.get("width"), `${at}/width`, [16, 240], 1);
    const height = reader.number(
      map.get("height"),
      `${at}/height`,
      [12, 64],
      1,
    );
    const wordmark = reader.choice(
      WORDMARKS,
      map.get("wordmark"),
      `${at}/wordmark`,
    );
    if (
      asset !== undefined &&
      width !== undefined &&
      height !== undefined &&
      wordmark !== undefined
    ) {
      out.logo = { asset, width, height, wordmark };
    }
  }
  return out;
}

const assetKey = (asset: AssetRef): string => `${asset.sha256}.${asset.format}`;

// The images a configuration references (image backgrounds and the logo),
// sorted by digest, each once.
export function referencedAssetsOf(
  configuration: AppearanceConfiguration | null,
): readonly AssetRef[] {
  const found = new Map<string, AssetRef>();
  const styles = [
    ...Object.values(configuration?.components ?? {}),
    ...Object.values(configuration?.roles ?? {}),
  ];
  for (const style of styles) {
    if (style.background?.type === "image") {
      const { sha256, format } = style.background.asset;
      found.set(assetKey(style.background.asset), { sha256, format });
    }
  }
  const logo = configuration?.brand?.logo;
  if (logo !== undefined) {
    found.set(assetKey(logo.asset), {
      sha256: logo.asset.sha256,
      format: logo.asset.format,
    });
  }
  return Object.freeze(
    [...found.values()].sort((a, b) =>
      a.sha256 < b.sha256
        ? -1
        : a.sha256 > b.sha256
          ? 1
          : a.format < b.format
            ? -1
            : 1,
    ),
  );
}

function readAssets(
  reader: Reader,
  value: unknown,
  path: string,
): AssetRef[] | undefined {
  const items = itemsOf(value);
  if (items === null) {
    reader.add(path, "not_object");
    return undefined;
  }
  if (items.length === 0 || items.length > MAX_ASSET_REFERENCES) {
    reader.add(path, "asset_reference");
    return undefined;
  }
  const read: AssetRef[] = [];
  items.forEach((item, i) => {
    const asset = readAssetRef(reader, item, `${path}/${i}`);
    if (asset !== undefined) {
      read.push(asset);
    }
  });
  for (let i = 1; i < read.length; i += 1) {
    if (!(read[i - 1].sha256 < read[i].sha256)) {
      reader.add(path, "asset_reference");
      return undefined;
    }
  }
  return read;
}

// The tokens of a scope as the page computes them: the registry defaults,
// the configuration's overrides and the three derived hooks (onInk, inkHover,
// surfaceHover; their owner fallbacks unless ink or page is overridden).
export function effectiveTokens(
  configuration: AppearanceConfiguration | null,
  registry: AppearanceRegistry,
  scope: AppearanceScope,
): Readonly<Record<string, string | number>> {
  const tokens: Record<string, string | number> = {};
  for (const spec of registry.tokens) {
    if (spec.scope === scope) {
      tokens[spec.key] = spec.default;
    }
  }
  const overrides = (configuration?.tokens?.[scope] ?? {}) as Readonly<
    Record<string, string | number>
  >;
  Object.assign(tokens, overrides);
  const hooks = OWNER_HOOK_DEFAULTS[scope];
  const ink = tokens.ink;
  const page = tokens.page;
  const inkChanged = Object.hasOwn(overrides, "ink") && isHex(ink);
  tokens.onInk = inkChanged ? onInkFor(ink as Hex) : hooks.onInk;
  tokens.inkHover = inkChanged
    ? mixHex(ink as Hex, "#ffffff", 0.09)
    : hooks.inkHover;
  tokens.surfaceHover =
    (inkChanged || Object.hasOwn(overrides, "page")) &&
    isHex(page) &&
    isHex(ink)
      ? mixHex(page as Hex, ink as Hex, 0.012)
      : hooks.surfaceHover;
  return Object.freeze(tokens);
}

const colorOf = (
  tokens: Readonly<Record<string, string | number>>,
  key: string,
): Hex | null => (isHex(tokens[key]) ? (tokens[key] as Hex) : null);

function isLarge(
  sizes: readonly number[],
  weight: number | undefined,
): boolean {
  return (
    sizes.length > 0 &&
    sizes.every(
      (size) => size >= 24 || (size >= 18.66 && (weight ?? 400) >= 700),
    )
  );
}

function pairIssue(
  path: string,
  against: string,
  foreground: Hex,
  background: Hex,
  aa: number,
  owner: number,
): Issue | null {
  const actual = contrastRatio(foreground, background);
  const required = Math.min(aa, owner);
  return actual + 1e-9 >= required
    ? null
    : Object.freeze({
        path,
        code: "contrast" as const,
        required: Math.round(required * 100) / 100,
        actual: Math.round(actual * 100) / 100,
        against,
      });
}

function backgroundColors(style: ComponentStyle): Hex[] | null {
  if (style.background?.type === "color") {
    return [style.background.color];
  }
  if (style.background?.type === "gradient") {
    return [style.background.from, style.background.to];
  }
  if (style.color?.background !== undefined) {
    return [style.color.background];
  }
  return null;
}

// Every contrast shortfall of a structurally valid configuration (studio spec
// section 3.3): required(pair) = min(AA, the owner design's own ratio).
export function contrastIssues(
  configuration: AppearanceConfiguration,
  registry: AppearanceRegistry,
): readonly Issue[] {
  const issues: Issue[] = [];
  const push = (issue: Issue | null) => {
    if (issue !== null) {
      issues.push(issue);
    }
  };
  for (const scope of ["site", "workspace"] as const) {
    const tokens = effectiveTokens(configuration, registry, scope);
    const owner = effectiveTokens(null, registry, scope);
    for (const [fg, bg] of TOKEN_CONTRAST_PAIRS[scope]) {
      const f = colorOf(tokens, fg);
      const b = colorOf(tokens, bg);
      const of = colorOf(owner, fg);
      const ob = colorOf(owner, bg);
      if (f === null || b === null || of === null || ob === null) {
        continue;
      }
      push(
        pairIssue(
          pointer("tokens", scope, fg),
          bg,
          f,
          b,
          AA_TEXT,
          contrastRatio(of, ob),
        ),
      );
    }
  }
  // Type roles: their colour on both site surfaces.
  for (const [id, style] of Object.entries(configuration.type ?? {})) {
    const spec = registry.typeRoles.find((r) => r.id === id);
    if (spec === undefined || style.color === undefined) {
      continue;
    }
    const tokens = effectiveTokens(configuration, registry, "site");
    const owner = effectiveTokens(null, registry, "site");
    const sizes = Object.values(style.size ?? {});
    const large = isLarge(
      sizes.length > 0 ? sizes : [spec.defaults.size],
      style.weight ?? spec.defaults.weight,
    );
    for (const surface of ["page", "paper"]) {
      const b = colorOf(tokens, surface);
      const ob = colorOf(owner, surface);
      const of = colorOf(owner, spec.defaults.color ?? "ink");
      if (b === null || ob === null || of === null) {
        continue;
      }
      push(
        pairIssue(
          pointer("type", id, "color"),
          surface,
          style.color,
          b,
          large ? AA_LARGE : AA_TEXT,
          contrastRatio(of, ob),
        ),
      );
    }
  }
  const instances: Array<{
    readonly area: "roles" | "components";
    readonly id: string;
    readonly style: ComponentStyle;
    readonly kind: ComponentKind;
    readonly scope: AppearanceScope;
    readonly surfaces: readonly string[];
    readonly within?: string;
    readonly textTokens: readonly string[];
    readonly largeText: boolean;
  }> = [];
  for (const [id, style] of Object.entries(configuration.roles ?? {})) {
    const spec = registry.roles.find((r) => r.id === id);
    if (spec !== undefined) {
      instances.push({
        area: "roles",
        id,
        style,
        kind: spec.kind,
        scope: spec.scope,
        surfaces: spec.surfaces,
        textTokens: spec.textTokens,
        largeText: spec.largeText === true,
      });
    }
  }
  for (const [id, style] of Object.entries(configuration.components ?? {})) {
    const spec = registry.components.find((c) => c.id === id);
    if (spec !== undefined) {
      instances.push({
        area: "components",
        id,
        style,
        kind: spec.kind,
        scope: spec.scope,
        surfaces: [spec.surface],
        within: spec.within,
        textTokens: spec.textTokens,
        largeText: spec.largeText === true,
      });
    }
  }
  for (const item of instances) {
    const { style } = item;
    const tokens = effectiveTokens(configuration, registry, item.scope);
    const owner = effectiveTokens(null, registry, item.scope);
    const ownBackground = backgroundColors(style);
    const withinStyle =
      item.within === undefined
        ? undefined
        : configuration.components?.[item.within];
    const surfaceColors =
      ownBackground ??
      (withinStyle === undefined ? null : backgroundColors(withinStyle)) ??
      item.surfaces
        .map((key) => colorOf(tokens, key))
        .filter((c): c is Hex => c !== null);
    const ownerSurfaces = item.surfaces
      .map((key) => colorOf(owner, key))
      .filter((c): c is Hex => c !== null);
    const changed =
      ownBackground !== null ||
      style.color !== undefined ||
      (withinStyle !== undefined && backgroundColors(withinStyle) !== null);
    if (!changed) {
      continue;
    }
    const sizes = Object.values(style.typography?.size ?? {});
    const aa =
      item.largeText || isLarge(sizes, style.typography?.weight)
        ? AA_LARGE
        : AA_TEXT;
    // The owner design's own lowest ratio for that text colour: on the
    // element's declared surfaces and on every surface the token pairs of its
    // scope check it against (so only a pair the owner design already keeps
    // below AA, such as subtle on paper, lowers the requirement).
    const ownerOf = (key: string | undefined): number => {
      const text = key === undefined ? null : colorOf(owner, key);
      if (text === null) {
        return Number.POSITIVE_INFINITY;
      }
      const surfaces = [
        ...ownerSurfaces,
        ...TOKEN_CONTRAST_PAIRS[item.scope]
          .filter(([fg]) => fg === key)
          .map(([, bg]) => colorOf(owner, bg))
          .filter((color): color is Hex => color !== null),
      ];
      return surfaces.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...surfaces.map((s) => contrastRatio(text, s)));
    };
    const texts: Array<readonly [Hex, string | undefined]> =
      style.color?.text !== undefined
        ? [[style.color.text, item.textTokens[0]]]
        : item.textTokens
            .map((key) => [colorOf(tokens, key), key] as const)
            .filter((pair): pair is readonly [Hex, string] => pair[0] !== null);
    const base = pointer(item.area, item.id);
    for (const [text, key] of texts) {
      for (const surface of surfaceColors) {
        push(
          pairIssue(
            style.color?.text !== undefined
              ? `${base}/color/text`
              : `${base}/background`,
            style.color?.text !== undefined ? "background" : (key ?? "text"),
            text,
            surface,
            aa,
            ownerOf(key),
          ),
        );
      }
    }
    const interactive = ["button", "link", "nav", "chip"].includes(item.kind);
    if (interactive && style.color !== undefined) {
      const ink = colorOf(tokens, "ink") ?? DARK_ON_INK;
      const hoverText = style.color.textHover ?? style.color.text;
      const hoverBackgrounds =
        style.color.backgroundHover !== undefined
          ? [style.color.backgroundHover]
          : ownBackground !== null
            ? ownBackground.map((b) => derivedHoverBackground(b, ink))
            : surfaceColors;
      const textsOnHover =
        hoverText !== undefined ? [hoverText] : texts.map(([text]) => text);
      for (const text of textsOnHover) {
        for (const surface of hoverBackgrounds) {
          push(
            pairIssue(
              `${base}/color/${style.color.textHover !== undefined ? "textHover" : "backgroundHover"}`,
              "hover",
              text,
              surface,
              aa,
              ownerOf(item.textTokens[0]),
            ),
          );
        }
      }
    }
  }
  return Object.freeze(issues);
}

// Validates and canonicalizes a configuration. The canonical form drops empty
// objects, token values and page texts equal to their defaults and a section
// order equal to the default order.
export function validateAppearance(
  raw: unknown,
  registry: AppearanceRegistry,
  mode: ValidationMode,
): ValidationResult {
  const reader = new Reader();
  try {
    // A cheap bound before any deep reading.
    let roughLength: number;
    try {
      roughLength = JSON.stringify(raw)?.length ?? 0;
    } catch {
      return {
        ok: false,
        issues: [Object.freeze({ path: "", code: "not_object" })],
      };
    }
    if (roughLength > MAX_CONFIGURATION_BYTES * 4) {
      return {
        ok: false,
        issues: [Object.freeze({ path: "", code: "too_large" })],
      };
    }
    const entries = reader.object(raw, "", TOP_KEYS);
    if (entries === null) {
      return { ok: false, issues: Object.freeze([...reader.issues]) };
    }
    const top = new Map(entries);
    if (top.get("schema") !== APPEARANCE_SCHEMA_VERSION) {
      reader.add("/schema", "schema");
    }
    const out: Out = { schema: APPEARANCE_SCHEMA_VERSION };
    if (top.has("tokens")) {
      const scopes = reader.object(top.get("tokens"), "/tokens", [
        "site",
        "workspace",
      ]);
      const read: Out = {};
      for (const [scope, value] of scopes ?? []) {
        put(
          read,
          scope,
          readTokens(
            reader,
            value,
            pointer("tokens", scope),
            scope as AppearanceScope,
            registry,
          ),
        );
      }
      put(out, "tokens", read);
    }
    if (top.has("type")) {
      const roles = reader.object(top.get("type"), "/type", null);
      const read: Out = {};
      for (const [id, value] of roles ?? []) {
        const at = pointer("type", id);
        const spec = registry.typeRoles.find((r) => r.id === id);
        if (spec === undefined) {
          reader.add(at, "unknown_id");
          continue;
        }
        put(
          read,
          id,
          readTypography(
            reader,
            value,
            at,
            {
              family: true,
              weight: true,
              size: spec.sizeRange,
              lineHeight: spec.lineHeightRange,
              letterSpacing: true,
              transform: spec.transformAllowed ? "always" : "never",
            },
            spec.transformAllowed,
            spec.colorAllowed,
          ),
        );
      }
      put(out, "type", read);
    }
    for (const area of ["roles", "components"] as const) {
      if (!top.has(area)) {
        continue;
      }
      const items = reader.object(top.get(area), pointer(area), null);
      const read: Out = {};
      for (const [id, value] of items ?? []) {
        const at = pointer(area, id);
        const spec =
          area === "roles"
            ? registry.roles.find((r) => r.id === id)
            : registry.components.find((c) => c.id === id);
        if (spec === undefined) {
          reader.add(at, "unknown_id");
          continue;
        }
        const groups =
          "groups" in spec
            ? spec.groups.filter((g) => groupsOfKind(spec.kind).includes(g))
            : groupsOfKind(spec.kind);
        put(
          read,
          id,
          readStyle(
            reader,
            value,
            at,
            spec.kind,
            groups,
            "transformAllowed" in spec && spec.transformAllowed === true,
          ),
        );
      }
      put(out, area, read);
    }
    if (top.has("slots")) {
      put(
        out,
        "slots",
        readSlots(reader, top.get("slots"), "/slots", registry),
      );
    }
    if (top.has("sections")) {
      put(
        out,
        "sections",
        readSections(reader, top.get("sections"), "/sections", registry),
      );
    }
    if (top.has("brand")) {
      put(out, "brand", readBrand(reader, top.get("brand"), "/brand"));
    }
    const listed = top.has("assets")
      ? readAssets(reader, top.get("assets"), "/assets")
      : undefined;
    if (reader.issues.length > 0) {
      return { ok: false, issues: Object.freeze([...reader.issues]) };
    }
    const referenced = referencedAssetsOf(out as AppearanceConfiguration);
    const listedKeys = (listed ?? []).map(assetKey);
    if (
      listedKeys.length !== referenced.length ||
      referenced.some((asset, i) => assetKey(asset) !== listedKeys[i])
    ) {
      return {
        ok: false,
        issues: [
          Object.freeze({ path: "/assets", code: "asset_reference" as const }),
        ],
      };
    }
    if (referenced.length > 0) {
      out.assets = referenced.map((asset) => ({ ...asset }));
    }
    if (databaseTextOctets(out) > MAX_CONFIGURATION_BYTES) {
      return {
        ok: false,
        issues: [Object.freeze({ path: "", code: "too_large" as const })],
      };
    }
    const value = freezeDeep(out) as ValidAppearance;
    const contrast = contrastIssues(value, registry);
    if (mode === "publish" && contrast.length > 0) {
      return { ok: false, issues: contrast };
    }
    validated.add(value);
    return {
      ok: true,
      value,
      canonical: canonicalJson(value),
      warnings: contrast,
    };
  } catch {
    return {
      ok: false,
      issues: [
        ...reader.issues,
        Object.freeze({ path: "", code: "not_object" as const }),
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Resolvers used by pages
// ---------------------------------------------------------------------------

// The text of a slot: the configuration's override when it passes the slot's
// rules, else the default.
export function slotTextOf(
  configuration: AppearanceConfiguration | null,
  slot: SlotSpec,
): string {
  const text = configuration?.slots?.[slot.id];
  return text !== undefined && slotIssue(text, slot) === null
    ? text
    : slot.defaultText;
}

// The sections of a group to render, in order: fixed sections first, the
// reorderable sections in the configuration's order when it is a permutation
// of exactly them (else the default order), every other section at its
// default place; hidden sections are left out only when they are hideable
// (a forged configuration cannot hide a fixed or protected section).
export function sectionOrderOf(
  configuration: AppearanceConfiguration | null,
  group: SectionGroupSpec,
): readonly string[] {
  const fixed = group.sections
    .filter((s) => s.fixed === "first")
    .map((s) => s.id);
  const rest = group.sections.filter((s) => s.fixed !== "first");
  const reorderable = rest.filter((s) => s.reorderable).map((s) => s.id);
  const wanted = configuration?.sections?.[group.id]?.order;
  const order =
    Array.isArray(wanted) &&
    wanted.length === reorderable.length &&
    new Set(wanted).size === wanted.length &&
    wanted.every((id) => reorderable.includes(id))
      ? [...wanted]
      : [...reorderable];
  const placed = rest.map((s) =>
    s.reorderable ? (order.shift() as string) : s.id,
  );
  const hidden = new Set(
    (configuration?.sections?.[group.id]?.hidden ?? []).filter((id) =>
      group.sections.some((s) => s.id === id && s.hideable && s.fixed === null),
    ),
  );
  return Object.freeze([...fixed, ...placed].filter((id) => !hidden.has(id)));
}
