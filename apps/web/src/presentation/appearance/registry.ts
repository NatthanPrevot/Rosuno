// Website and appearance studio: the component registry (DEV-001; studio
// specification section 2).
//
// Presentation data only: every design token the studio may override (with
// the owner's own default, exactly as app/styles/theme.css, workspace.css and
// staff.css define it), the type roles and kind-wide roles (fixed selectors
// of the owner's design), every instrumented element (its data-rz id, kind,
// file, surface and the text colours that sit on it, as contrast baselines),
// the Home text slots with the design's exact text as default, the Home
// section group, the pages the studio previews, and the protected areas the
// studio shows as locked. Nothing here is computed from a request, and every
// id is a literal, so the instrumentation test can trace each one to its
// element. The validator and the compiler read this registry; neither ever
// takes a selector, a property or a value from a configuration.
//
// Protected items (forms, booking and payment panels, the Talk Now control,
// placeholders, legal and process statements, navigation labels, gating
// notices and errors, the gated content pages' statements, accessibility
// rules and the studio itself) carry no data-rz id, are never hideable, and
// their text is never a slot.

import {
  groupsOfKind,
  validateAppearance,
  type AppearanceRegistry,
  type AppearanceScope,
  type ComponentKind,
  type ComponentSpec,
  type PageSpec,
  type ProtectedArea,
  type RoleSpec,
  type SectionGroupSpec,
  type SlotSpec,
  type TokenSpec,
  type TypeRoleSpec,
  type ValidationMode,
  type ValidationResult,
} from "../../application/appearance-schema.ts";

// ---------------------------------------------------------------------------
// Tokens (the owner's roots: .rz:not(.rz .rz) and .rzw:not(.rzw .rzw); the
// staff radius on .W.st)
// ---------------------------------------------------------------------------

const color = (
  scope: AppearanceScope,
  key: string,
  cssName: string,
  value: string,
): TokenSpec => ({ scope, key, cssName, type: "color", default: value });

const SITE_TOKENS: readonly TokenSpec[] = [
  color("site", "ink", "--ink", "#0f1013"),
  color("site", "ink2", "--ink-2", "#2b2d33"),
  color("site", "muted", "--muted", "#585c64"),
  color("site", "subtle", "--subtle", "#6f737b"),
  color("site", "faint", "--faint", "#a3a6ac"),
  color("site", "line", "--line", "#eae8e4"),
  color("site", "line2", "--line-2", "#dddad4"),
  color("site", "line3", "--line-3", "#c9c5be"),
  color("site", "page", "--page", "#ffffff"),
  color("site", "paper", "--paper", "#f6f5f2"),
  color("site", "paper2", "--paper-2", "#eeece7"),
  color("site", "accent", "--accent", "#2f3a9e"),
  {
    scope: "site",
    key: "radius",
    cssName: "--r",
    type: "length",
    default: 14,
    range: [6, 22],
  },
  {
    scope: "site",
    key: "fontDisplay",
    cssName: "--f-display",
    type: "font",
    default: "instrument-sans",
  },
  {
    scope: "site",
    key: "fontBody",
    cssName: "--f-body",
    type: "font",
    default: "inter",
  },
  {
    scope: "site",
    key: "elevation",
    cssName: "--e1",
    type: "elevation",
    default: "default",
  },
];

const WORKSPACE_TOKENS: readonly TokenSpec[] = [
  color("workspace", "ink", "--ink", "#0f1013"),
  color("workspace", "ink2", "--ink-2", "#2b2d33"),
  color("workspace", "muted", "--muted", "#565a62"),
  color("workspace", "subtle", "--subtle", "#6b6f77"),
  color("workspace", "faint", "--faint", "#a3a6ac"),
  color("workspace", "line", "--line", "#eae8e4"),
  color("workspace", "line2", "--line-2", "#dddad4"),
  color("workspace", "line3", "--line-3", "#c9c5be"),
  color("workspace", "page", "--page", "#ffffff"),
  color("workspace", "paper", "--paper", "#f7f6f3"),
  color("workspace", "paper2", "--paper-2", "#efede8"),
  color("workspace", "canvas", "--canvas", "#fafaf8"),
  color("workspace", "accent", "--accent", "#2f3a9e"),
  color("workspace", "accent2", "--accent-2", "#e9ecfa"),
  {
    scope: "workspace",
    key: "staffRadius",
    cssName: "--st-r",
    type: "length",
    default: 16,
    range: [8, 24],
  },
  {
    scope: "workspace",
    key: "fontDisplay",
    cssName: "--f-display",
    type: "font",
    default: "instrument-sans",
  },
  {
    scope: "workspace",
    key: "fontBody",
    cssName: "--f-body",
    type: "font",
    default: "inter",
  },
  {
    scope: "workspace",
    key: "elevation",
    cssName: "--e1",
    type: "elevation",
    default: "default",
  },
];

// ---------------------------------------------------------------------------
// Type roles (site scope; theme.css .rz .display … .rz .kicker)
// ---------------------------------------------------------------------------

const HEADING_LINE_HEIGHTS = [0.9, 1.4] as const;
const TEXT_LINE_HEIGHTS = [1.3, 1.9] as const;

const TYPE_ROLES: readonly TypeRoleSpec[] = [
  {
    id: "type.display",
    label: "Display heading",
    selector: ".rz .display",
    defaults: {
      size: 88,
      lineHeight: 0.97,
      weight: 600,
      letterSpacing: -0.038,
      color: "ink",
    },
    sizeRange: [32, 112],
    lineHeightRange: HEADING_LINE_HEIGHTS,
    colorAllowed: true,
    transformAllowed: false,
  },
  {
    id: "type.h2",
    label: "Section heading",
    selector: ".rz .h2",
    defaults: {
      size: 44,
      lineHeight: 1.05,
      weight: 600,
      letterSpacing: -0.033,
      color: "ink",
    },
    sizeRange: [24, 64],
    lineHeightRange: HEADING_LINE_HEIGHTS,
    colorAllowed: true,
    transformAllowed: false,
  },
  {
    id: "type.h3",
    label: "Card heading",
    selector: ".rz .h3",
    defaults: {
      size: 24,
      lineHeight: 1.18,
      weight: 600,
      letterSpacing: -0.022,
      color: "ink",
    },
    sizeRange: [18, 40],
    lineHeightRange: HEADING_LINE_HEIGHTS,
    colorAllowed: true,
    transformAllowed: false,
  },
  {
    id: "type.h4",
    label: "Small heading",
    selector: ".rz .h4",
    defaults: {
      size: 18,
      lineHeight: 1.3,
      weight: 600,
      letterSpacing: -0.014,
      color: "ink",
    },
    sizeRange: [14, 28],
    lineHeightRange: HEADING_LINE_HEIGHTS,
    colorAllowed: true,
    transformAllowed: false,
  },
  {
    id: "type.lead",
    label: "Lead paragraph",
    selector: ".rz .lead",
    defaults: { size: 19, lineHeight: 1.55, letterSpacing: -0.011 },
    sizeRange: [15, 24],
    lineHeightRange: TEXT_LINE_HEIGHTS,
    colorAllowed: false,
    transformAllowed: false,
  },
  {
    id: "type.body",
    label: "Body text",
    selector: ".rz .body",
    defaults: { size: 16, lineHeight: 1.6 },
    sizeRange: [14, 20],
    lineHeightRange: TEXT_LINE_HEIGHTS,
    colorAllowed: false,
    transformAllowed: false,
  },
  {
    id: "type.small",
    label: "Small text",
    selector: ".rz .sm",
    defaults: { size: 14, lineHeight: 1.5 },
    sizeRange: [12, 17],
    lineHeightRange: TEXT_LINE_HEIGHTS,
    colorAllowed: false,
    transformAllowed: false,
  },
  {
    id: "type.meta",
    label: "Meta text",
    selector: ".rz .xs",
    defaults: { size: 12.5, lineHeight: 1.45 },
    sizeRange: [12, 15],
    lineHeightRange: TEXT_LINE_HEIGHTS,
    colorAllowed: false,
    transformAllowed: false,
  },
  {
    // The kicker inherits the design root's line height (1.5).
    id: "type.kicker",
    label: "Kicker",
    selector: ".rz .kicker",
    defaults: {
      size: 13.5,
      lineHeight: 1.5,
      weight: 500,
      letterSpacing: -0.005,
      color: "subtle",
    },
    sizeRange: [12, 16],
    lineHeightRange: TEXT_LINE_HEIGHTS,
    colorAllowed: true,
    transformAllowed: true,
  },
];

// ---------------------------------------------------------------------------
// Roles (kind-wide; fixed selectors, no data-rz)
// ---------------------------------------------------------------------------

function role(
  id: string,
  label: string,
  kind: ComponentKind,
  scope: AppearanceScope,
  selector: string,
  surfaces: readonly string[],
  textTokens: readonly string[],
  hover = true,
): RoleSpec {
  return {
    id,
    label,
    kind,
    scope,
    selector,
    ...(hover ? { hoverSelector: `${selector}:hover` } : {}),
    surfaces,
    textTokens,
  };
}

// Workspace roles never reach the studio's own controls.
const OUTSIDE_STUDIO = ":not(.rz-studio *)";

const ROLES: readonly RoleSpec[] = [
  role(
    "role.button.primary",
    "Primary buttons",
    "button",
    "site",
    '.rz .btn-ink:not([aria-disabled="true"])',
    ["ink"],
    ["onInk"],
  ),
  role(
    "role.button.secondary",
    "Secondary buttons",
    "button",
    "site",
    ".rz .btn-line",
    ["page"],
    ["ink"],
  ),
  role(
    "role.button.tertiary",
    "Quiet buttons",
    "button",
    "site",
    ".rz .btn-quiet",
    ["page", "paper"],
    ["ink2"],
  ),
  role(
    "role.link",
    "Links",
    "link",
    "site",
    ".rz .link",
    ["page", "paper"],
    ["ink"],
  ),
  role(
    "role.panel",
    "Panels",
    "card",
    "site",
    ".rz .panel",
    ["page"],
    ["ink", "muted", "subtle"],
    false,
  ),
  role(
    "role.well",
    "Wells",
    "card",
    "site",
    ".rz .well",
    ["paper"],
    ["ink", "muted", "subtle"],
    false,
  ),
  role(
    "role.chip",
    "Choice chips",
    "chip",
    "site",
    ".rz .opt-chip:not(.on)",
    ["page"],
    ["ink2"],
    false,
  ),
  role(
    "role.client.card",
    "Client account cards",
    "card",
    "site",
    ".cx .cx-card",
    ["page"],
    ["ink", "muted", "subtle"],
    false,
  ),
  role(
    "ws.button.primary",
    "Workspace primary buttons",
    "button",
    "workspace",
    `.rzw .btn-ink:not([aria-disabled="true"])${OUTSIDE_STUDIO}`,
    ["ink"],
    ["onInk"],
  ),
  role(
    "ws.button.secondary",
    "Workspace secondary buttons",
    "button",
    "workspace",
    `.rzw .btn-line${OUTSIDE_STUDIO}`,
    ["page"],
    ["ink"],
  ),
  role(
    "ws.button.tertiary",
    "Workspace quiet buttons",
    "button",
    "workspace",
    `.rzw .btn-quiet${OUTSIDE_STUDIO}`,
    ["page", "canvas"],
    ["ink2"],
  ),
  role(
    "ws.link",
    "Workspace links",
    "link",
    "workspace",
    `.rzw .link${OUTSIDE_STUDIO}`,
    ["page", "paper", "canvas"],
    ["accent"],
  ),
  role(
    "ws.chip",
    "Workspace chips",
    "chip",
    "workspace",
    `.rzw .chip:not(.on)${OUTSIDE_STUDIO}`,
    ["page"],
    ["ink2"],
    false,
  ),
  role(
    "ws.card",
    "Workspace cards",
    "card",
    "workspace",
    `.W .w-card${OUTSIDE_STUDIO}`,
    ["page"],
    ["ink", "muted", "subtle"],
    false,
  ),
];

// ---------------------------------------------------------------------------
// Instances (data-rz ids)
// ---------------------------------------------------------------------------

const PUBLIC_PAGES = [
  "public.home",
  "public.directory",
  "public.profile",
  "public.content",
] as const;

type InstanceOptions = {
  readonly within?: string;
  readonly largeText?: boolean;
  readonly transformAllowed?: boolean;
};

function instance(
  id: string,
  label: string,
  kind: ComponentKind,
  scope: AppearanceScope,
  pages: readonly string[],
  file: string,
  surface: string,
  textTokens: readonly string[],
  options: InstanceOptions = {},
): ComponentSpec {
  return {
    id,
    label,
    kind,
    scope,
    pages,
    file,
    surface,
    ...(options.within === undefined ? {} : { within: options.within }),
    groups: groupsOfKind(kind),
    textTokens,
    ...(options.largeText === true ? { largeText: true } : {}),
    ...(options.transformAllowed === true ? { transformAllowed: true } : {}),
  };
}

const CHROME = "src/presentation/site-chrome.tsx";
const PUBLIC_SITE = "src/presentation/public-site.tsx";
const AUTH_FRAME = "src/presentation/auth-frame.tsx";
const CARD = "src/presentation/attorney-card.tsx";
const DIRECTORY = "app/find-an-attorney/page.tsx";
const PROFILE = "app/attorneys/[attorney]/page.tsx";
const HOME = "app/page.tsx";
const CLIENT = "src/presentation/client-account.tsx";
const ATTORNEY = "src/presentation/attorney-workspace.tsx";
const STAFF = "src/presentation/staff-workspace.tsx";
const HOME_PAGE = ["public.home"];
const AUTH_PAGES = ["auth.sign-in", "auth.sign-up"];

const SITE_COMPONENTS: readonly ComponentSpec[] = [
  instance(
    "site.header",
    "Site header",
    "header",
    "site",
    PUBLIC_PAGES,
    CHROME,
    "page",
    ["ink", "ink2"],
  ),
  instance(
    "site.header.brand",
    "Header logo",
    "brand",
    "site",
    PUBLIC_PAGES,
    CHROME,
    "page",
    ["ink"],
    { within: "site.header" },
  ),
  instance(
    "site.header.nav",
    "Header navigation",
    "nav",
    "site",
    PUBLIC_PAGES,
    CHROME,
    "page",
    ["ink2"],
    { within: "site.header" },
  ),
  instance(
    "site.footer",
    "Site footer",
    "footer",
    "site",
    PUBLIC_PAGES,
    CHROME,
    "page",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "site.footer.brand",
    "Footer logo",
    "brand",
    "site",
    PUBLIC_PAGES,
    CHROME,
    "page",
    ["ink"],
    { within: "site.footer" },
  ),
  instance(
    "site.footer.column",
    "Footer link columns",
    "nav",
    "site",
    PUBLIC_PAGES,
    CHROME,
    "page",
    ["muted"],
    { within: "site.footer" },
  ),
  instance(
    "content.frame",
    "Content page frame",
    "section",
    "site",
    ["public.content"],
    PUBLIC_SITE,
    "page",
    ["ink", "ink2", "muted", "subtle"],
  ),
  instance(
    "content.pages-nav",
    "Content page navigation",
    "nav",
    "site",
    ["public.content"],
    PUBLIC_SITE,
    "page",
    ["ink2"],
    { within: "content.frame" },
  ),
  instance(
    "content.title",
    "Content page title",
    "heading",
    "site",
    ["public.content"],
    PUBLIC_SITE,
    "page",
    ["ink"],
    { within: "content.frame", largeText: true },
  ),
  instance(
    "auth.frame",
    "Sign-in and sign-up frame",
    "section",
    "site",
    AUTH_PAGES,
    AUTH_FRAME,
    "paper",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "auth.aside.title",
    "Sign-in side heading",
    "heading",
    "site",
    AUTH_PAGES,
    AUTH_FRAME,
    "paper",
    ["ink"],
    { within: "auth.frame", largeText: true },
  ),
  instance(
    "directory.card",
    "Attorney cards",
    "card",
    "site",
    ["public.home", "public.directory"],
    CARD,
    "page",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "directory.title",
    "Directory title",
    "heading",
    "site",
    ["public.directory"],
    DIRECTORY,
    "page",
    ["ink"],
    { largeText: true },
  ),
  instance(
    "profile.title",
    "Profile title",
    "heading",
    "site",
    ["public.profile"],
    PROFILE,
    "page",
    ["ink"],
    { largeText: true },
  ),
];

const HOME_COMPONENTS: readonly ComponentSpec[] = [
  instance("home.hero", "Hero", "section", "site", HOME_PAGE, HOME, "page", [
    "ink",
    "muted",
  ]),
  instance(
    "home.hero.title",
    "Hero title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink"],
    { within: "home.hero", largeText: true },
  ),
  instance(
    "home.hero.lead",
    "Hero lead",
    "text",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["muted"],
    { within: "home.hero" },
  ),
  instance(
    "home.hero.figure",
    "Hero image",
    "media",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    [],
  ),
  instance(
    "home.available",
    "Available now",
    "section",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "home.available.title",
    "Available now title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.available", largeText: true },
  ),
  instance(
    "home.available.browse",
    "Browse all attorneys links",
    "link",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.available" },
  ),
  instance(
    "home.ways",
    "Two ways to consult",
    "section",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "home.ways.kicker",
    "Two ways kicker",
    "text",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["subtle"],
    { within: "home.ways", transformAllowed: true },
  ),
  instance(
    "home.ways.title",
    "Two ways title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink"],
    { within: "home.ways", largeText: true },
  ),
  instance(
    "home.ways.card",
    "Two ways cards",
    "card",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "home.ways.now.title",
    "Talk now card title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.ways.card", largeText: true },
  ),
  instance(
    "home.ways.now.link",
    "Talk now card link",
    "link",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.ways.card" },
  ),
  instance(
    "home.ways.schedule.title",
    "Schedule card title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.ways.card", largeText: true },
  ),
  instance(
    "home.ways.schedule.link",
    "Schedule card link",
    "link",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.ways.card" },
  ),
  instance(
    "home.how",
    "How Rosuno works",
    "section",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "home.how.kicker",
    "How it works kicker",
    "text",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["subtle"],
    { within: "home.how", transformAllowed: true },
  ),
  instance(
    "home.how.title",
    "How it works title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.how", largeText: true },
  ),
  instance(
    "home.how.steps",
    "How it works steps",
    "grid",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    [],
  ),
  instance(
    "home.issues",
    "Browse by legal issue",
    "section",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "home.issues.kicker",
    "Legal issue kicker",
    "text",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["subtle"],
    { within: "home.issues", transformAllowed: true },
  ),
  instance(
    "home.issues.title",
    "Legal issue title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink"],
    { within: "home.issues", largeText: true },
  ),
  instance(
    "home.issues.lead",
    "Legal issue lead",
    "text",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["muted"],
    { within: "home.issues" },
  ),
  instance(
    "home.issues.grid",
    "Legal issue grid",
    "grid",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    [],
  ),
  instance(
    "home.issues.tile",
    "Legal issue tiles",
    "card",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink", "subtle"],
  ),
  instance(
    "home.attorneys",
    "Attorney invitation",
    "section",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink", "muted"],
  ),
  instance(
    "home.attorneys.card",
    "Attorney invitation card",
    "card",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink", "muted"],
  ),
  instance(
    "home.attorneys.title",
    "Attorney invitation title",
    "heading",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.attorneys.card" },
  ),
  instance(
    "home.attorneys.body",
    "Attorney invitation text",
    "text",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["muted"],
    { within: "home.attorneys.card" },
  ),
  instance(
    "home.attorneys.apply",
    "Apply to join link",
    "link",
    "site",
    HOME_PAGE,
    HOME,
    "paper",
    ["ink"],
    { within: "home.attorneys.card" },
  ),
  instance(
    "home.attorneys.explore",
    "Attorney invitation button",
    "button",
    "site",
    HOME_PAGE,
    HOME,
    "page",
    ["ink"],
  ),
];

const ACCOUNT_COMPONENTS: readonly ComponentSpec[] = [
  instance(
    "client.account",
    "Client account",
    "page",
    "site",
    ["client.home"],
    CLIENT,
    "page",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "client.nav",
    "Client account navigation",
    "nav",
    "site",
    ["client.home"],
    CLIENT,
    "page",
    ["ink2"],
    { within: "client.account" },
  ),
  instance(
    "client.heading",
    "Client account heading",
    "heading",
    "site",
    ["client.home"],
    CLIENT,
    "page",
    ["ink"],
    { within: "client.account", largeText: true },
  ),
  instance(
    "attorney.workspace",
    "Attorney workspace",
    "page",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "canvas",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "attorney.sidebar",
    "Attorney sidebar",
    "sidebar",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "page",
    ["ink", "ink2", "muted", "subtle"],
  ),
  instance(
    "attorney.sidebar.brand",
    "Attorney sidebar logo",
    "brand",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "page",
    ["ink"],
    { within: "attorney.sidebar" },
  ),
  instance(
    "attorney.sidebar.nav",
    "Attorney navigation",
    "nav",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "page",
    ["ink2"],
    { within: "attorney.sidebar" },
  ),
  instance(
    "attorney.top",
    "Attorney top bar",
    "bar",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "canvas",
    ["ink", "subtle"],
  ),
  instance(
    "attorney.title",
    "Attorney page title",
    "heading",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "canvas",
    ["ink"],
    { within: "attorney.top" },
  ),
  instance(
    "attorney.card",
    "Attorney cards",
    "card",
    "workspace",
    ["attorney.dashboard"],
    ATTORNEY,
    "page",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "staff.workspace",
    "Staff workspace",
    "page",
    "workspace",
    ["staff.home"],
    STAFF,
    "paper",
    ["ink", "muted", "subtle"],
  ),
  instance(
    "staff.sidebar",
    "Staff sidebar",
    "sidebar",
    "workspace",
    ["staff.home"],
    STAFF,
    "page",
    ["ink", "ink2", "muted", "subtle"],
  ),
  instance(
    "staff.sidebar.brand",
    "Staff sidebar logo",
    "brand",
    "workspace",
    ["staff.home"],
    STAFF,
    "page",
    ["ink"],
    { within: "staff.sidebar" },
  ),
  instance(
    "staff.sidebar.nav",
    "Staff navigation",
    "nav",
    "workspace",
    ["staff.home"],
    STAFF,
    "page",
    ["ink2"],
    { within: "staff.sidebar" },
  ),
  instance(
    "staff.top",
    "Staff top bar",
    "bar",
    "workspace",
    ["staff.home"],
    STAFF,
    "paper",
    ["ink", "muted"],
  ),
  instance(
    "staff.title",
    "Staff page title",
    "heading",
    "workspace",
    ["staff.home"],
    STAFF,
    "paper",
    ["ink"],
    { within: "staff.top" },
  ),
  instance(
    "staff.panel",
    "Staff panels",
    "card",
    "workspace",
    ["staff.home"],
    STAFF,
    "page",
    ["ink", "muted", "subtle"],
  ),
];

// ---------------------------------------------------------------------------
// Text slots (v1: Home only; never regulated text)
// ---------------------------------------------------------------------------

function slot(
  id: string,
  label: string,
  defaultText: string,
  max: number,
  lines: 1 | 2 = 1,
  occurrences = 1,
): SlotSpec {
  return {
    id,
    page: "public.home",
    label,
    defaultText,
    max,
    lines,
    occurrences,
  };
}

const SLOTS: readonly SlotSpec[] = [
  slot("home.hero.title", "Hero title", "Talk to a lawyer\nin minutes.", 60, 2),
  slot(
    "home.hero.lead",
    "Hero lead",
    "Describe what’s going on in plain words. Meet an attorney now, or book a time that suits you.",
    180,
  ),
  slot(
    "home.available.browse",
    "Browse all attorneys link",
    "Browse all attorneys",
    32,
    1,
    2,
  ),
  slot("home.ways.kicker", "Two ways kicker", "Two ways to consult", 40),
  slot(
    "home.ways.title",
    "Two ways title",
    "Talk now, or at a time that suits you.",
    80,
  ),
  slot(
    "home.ways.now.title",
    "Talk now card title",
    "When you’d like answers today",
    60,
  ),
  slot("home.ways.now.link", "Talk now card link", "See who’s available", 32),
  slot(
    "home.ways.schedule.title",
    "Schedule card title",
    "When you’d rather plan ahead",
    60,
  ),
  slot(
    "home.ways.schedule.link",
    "Schedule card link",
    "Browse open times",
    32,
  ),
  slot("home.how.kicker", "How it works kicker", "How Rosuno works", 40),
  slot(
    "home.how.title",
    "How it works title",
    "From a question to a conversation.",
    80,
  ),
  slot("home.issues.kicker", "Legal issue kicker", "Browse by legal issue", 40),
  slot(
    "home.issues.title",
    "Legal issue title",
    "Not sure what to search for?",
    80,
  ),
  slot(
    "home.issues.lead",
    "Legal issue lead",
    "Pick the area that sounds closest and start from a familiar situation.",
    160,
  ),
  slot(
    "home.attorneys.title",
    "Attorney invitation title",
    "Are you an attorney?",
    48,
  ),
  slot(
    "home.attorneys.body",
    "Attorney invitation text",
    "Manage consultations, availability and requests with Rosuno.",
    120,
  ),
  slot("home.attorneys.apply", "Apply to join link", "Apply to join", 32),
  slot(
    "home.attorneys.explore",
    "Attorney invitation button",
    "Explore Rosuno for attorneys",
    40,
  ),
];

// The Home slot ids, so a page can only render a slot the registry declares.
export type HomeSlotId =
  | "home.hero.title"
  | "home.hero.lead"
  | "home.available.browse"
  | "home.ways.kicker"
  | "home.ways.title"
  | "home.ways.now.title"
  | "home.ways.now.link"
  | "home.ways.schedule.title"
  | "home.ways.schedule.link"
  | "home.how.kicker"
  | "home.how.title"
  | "home.issues.kicker"
  | "home.issues.title"
  | "home.issues.lead"
  | "home.attorneys.title"
  | "home.attorneys.body"
  | "home.attorneys.apply"
  | "home.attorneys.explore";

// ---------------------------------------------------------------------------
// Section groups (v1: Home)
// ---------------------------------------------------------------------------

export const HOME_SECTIONS: SectionGroupSpec = {
  id: "home.sections",
  page: "public.home",
  sections: [
    {
      id: "home.hero",
      label: "Hero",
      fixed: "first",
      reorderable: false,
      hideable: false,
      reason: "Holds the search form and the page’s main heading.",
    },
    {
      id: "home.available",
      label: "Available now",
      fixed: null,
      reorderable: true,
      hideable: false,
      reason:
        "Other sections link to it, and the phone layout depends on it being present.",
    },
    {
      id: "home.ways",
      label: "Two ways to consult",
      fixed: null,
      reorderable: true,
      hideable: true,
    },
    {
      id: "home.how",
      label: "How Rosuno works",
      fixed: null,
      reorderable: true,
      hideable: true,
    },
    {
      id: "home.issues",
      label: "Browse by legal issue",
      fixed: null,
      reorderable: true,
      hideable: false,
      reason: "The header’s Legal matters link opens it.",
    },
    {
      id: "home.attorneys",
      label: "Attorney invitation",
      fixed: null,
      reorderable: true,
      hideable: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pages and protected areas
// ---------------------------------------------------------------------------

const PAGES: readonly PageSpec[] = [
  {
    id: "public.home",
    label: "Home",
    path: "/",
    rendering: "dynamic",
    slots: true,
    sections: true,
  },
  {
    id: "public.directory",
    label: "Find an attorney",
    path: "/find-an-attorney",
    rendering: "dynamic",
    slots: false,
    sections: false,
  },
  {
    id: "public.profile",
    label: "Attorney profile (open one from Find an attorney)",
    path: "/find-an-attorney",
    rendering: "dynamic",
    slots: false,
    sections: false,
  },
  {
    id: "public.content",
    label: "Content pages (How it works, About, Contact, Terms …)",
    path: "/how-it-works",
    rendering: "static",
    slots: false,
    sections: false,
  },
  {
    id: "auth.sign-in",
    label: "Sign in",
    path: "/sign-in",
    rendering: "static",
    slots: false,
    sections: false,
  },
  {
    id: "auth.sign-up",
    label: "Sign up",
    path: "/sign-up",
    rendering: "static",
    slots: false,
    sections: false,
  },
  {
    id: "client.home",
    label: "Client account",
    path: "/client",
    rendering: "dynamic",
    slots: false,
    sections: false,
  },
  {
    id: "attorney.dashboard",
    label: "Attorney workspace",
    path: "/attorney/dashboard",
    rendering: "dynamic",
    slots: false,
    sections: false,
  },
  {
    id: "staff.home",
    label: "Staff workspace",
    path: "/staff",
    rendering: "dynamic",
    slots: false,
    sections: false,
  },
];

const PROTECTED_AREAS: readonly ProtectedArea[] = [
  {
    id: "protected.forms",
    label: "Forms and their messages",
    reason:
      "Search, sign-in, sign-up, request, payment, privacy, complaint and staff forms are functional controls.",
  },
  {
    id: "protected.booking",
    label: "Booking and request panel",
    reason: "Requests and payments stay as designed.",
  },
  {
    id: "protected.talk-now",
    label: "Talk Now status",
    reason: "A live status control.",
  },
  {
    id: "protected.placeholders",
    label: "Pending text placeholders",
    reason: "Waiting for counsel or policy text.",
  },
  {
    id: "protected.neutral-order",
    label: "Neutral order statement",
    reason: "Attorneys are listed in no particular order.",
  },
  {
    id: "protected.legal-text",
    label: "Legal statements and footer statements",
    reason: "Legal text is set by counsel, not by the theme.",
  },
  {
    id: "protected.navigation",
    label: "Navigation labels",
    reason: "Entry points keep their names.",
  },
  {
    id: "protected.vocabulary",
    label: "Status and path names",
    reason: "Available now, Talk now, Schedule and status names stay fixed.",
  },
  {
    id: "protected.process",
    label: "Process statements",
    reason:
      "How requests, holds, prices and meetings work is described by fixed text.",
  },
  {
    id: "protected.notices",
    label: "Notices and errors",
    reason: "Access notices and error messages stay fixed.",
  },
  {
    id: "protected.content-pages",
    label: "Content page text",
    reason: "Waits for approved copy.",
  },
  {
    id: "protected.accessibility",
    label: "Focus, motion and touch targets",
    reason: "Accessibility rules cannot be changed.",
  },
  {
    id: "protected.studio",
    label: "The studio",
    reason: "The editor always keeps the owner’s design.",
  },
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      frozen(item);
    }
    Object.freeze(value);
  }
  return value;
}

// Frozen all the way down: nothing can change a selector, id or default at
// run time.
export const APPEARANCE_REGISTRY: AppearanceRegistry = frozen({
  tokens: [...SITE_TOKENS, ...WORKSPACE_TOKENS],
  typeRoles: [...TYPE_ROLES],
  roles: [...ROLES],
  components: [...SITE_COMPONENTS, ...HOME_COMPONENTS, ...ACCOUNT_COMPONENTS],
  slots: [...SLOTS],
  sectionGroups: [HOME_SECTIONS],
  pages: [...PAGES],
  protectedAreas: [...PROTECTED_AREAS],
});

// The validator every caller hands the application (routes, pages, actions):
// the registry-generic validator bound to this registry.
export function validateWithRegistry(
  raw: unknown,
  mode: ValidationMode,
): ValidationResult {
  return validateAppearance(raw, APPEARANCE_REGISTRY, mode);
}

// A Home slot's spec (every HomeSlotId is in the registry).
export function slotSpecOf(id: HomeSlotId): SlotSpec {
  const found = APPEARANCE_REGISTRY.slots.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error("appearance: unknown slot");
  }
  return found;
}
