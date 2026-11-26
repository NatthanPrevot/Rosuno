// Website and appearance studio: the studio's own words (DEV-001; studio
// specification sections 6.1 to 6.8).
//
// Fixed copy only: control labels, the save status, the outcome of every
// command as the database answered it, the validator's issues in plain
// words, and the consent notice for images. No message repeats a
// configuration, a page text or anything the server answered beyond its
// fixed outcome. None of these words is regulated vocabulary (a test runs
// the page-text phrase rule over every string here).

import type {
  ColorKey,
  ComponentKind,
  IssueCode,
  StyleGroup,
} from "../../application/appearance-schema.ts";
import type { ImageProblem } from "../../application/appearance-image.ts";
import type { SaveStatus } from "./editor-state.ts";

export const STUDIO_TITLE = "Website & appearance";
export const STUDIO_SUBTITLE =
  "Theme, page text and sections. Changes go live only when you publish.";
export const STUDIO_NAVIGATION_LABEL = "Content & brand";
export const STUDIO_HOME_SUMMARY =
  "Change the site’s colours, fonts, page text and sections, preview them, and publish when ready.";

export const NARROW_WINDOW_NOTICE =
  "Use a wider window to edit. On a phone you can still read the version history.";

export type Tone = "neutral" | "success" | "warning" | "error";
export type Message = { readonly tone: Tone; readonly text: string };

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export const DEVICES = Object.freeze([
  { id: "desktop", label: "Desktop", width: 1440 },
  { id: "tablet", label: "Tablet", width: 768 },
  { id: "phone", label: "Phone", width: 390 },
] as const);
export type Device = (typeof DEVICES)[number]["id"];

export const ZOOMS = Object.freeze([
  "fit",
  "100",
  "75",
  "60",
  "50",
  "40",
  "33",
  "25",
] as const);
export type Zoom = (typeof ZOOMS)[number];
export const ZOOM_LABELS: Readonly<Record<Zoom, string>> = Object.freeze({
  fit: "Fit",
  "100": "100%",
  "75": "75%",
  "60": "60%",
  "50": "50%",
  "40": "40%",
  "33": "33%",
  "25": "25%",
});

export const MODE_LABELS = Object.freeze({
  select: "Select",
  browse: "Browse",
});
export const MODE_HINTS = Object.freeze({
  select: "Click an element in the preview to edit it.",
  browse: "Links in the preview open other pages; nothing is submitted.",
});

export const SAVE_STATUS_LABELS: Readonly<Record<SaveStatus, string>> =
  Object.freeze({
    saved: "All changes are saved in the draft.",
    pending: "Saving soon…",
    saving: "Saving…",
    failed: "Not saved.",
    conflict: "Not saved: this draft was changed elsewhere.",
    invalid: "Not saved: some values were refused.",
  });
export const NO_DRAFT_LABEL = "No draft yet: your first change starts one.";

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export const LAYER_GROUPS = Object.freeze({
  theme: "Theme (applies everywhere)",
  sections: "Sections",
  components: "Elements on this page",
  roles: "Element styles (all of a kind)",
  type: "Text styles",
  content: "Page text",
  logo: "Logo",
  protected: "Protected (not editable)",
});
export const NOT_IN_PREVIEW = "not shown in this preview";
export const CHANGED_MARK = "changed";
export const SITE_THEME_LABEL = "Public site and client account";
export const WORKSPACE_THEME_LABEL = "Attorney and staff workspaces";

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export const SCOPE_NOTES = Object.freeze({
  token:
    "Global token: changes every page that uses it. Element overrides win over it.",
  component:
    "Override for this element only. Global tokens still apply to everything else.",
  role: "Applies to every element of this kind. A single element’s own override wins over it.",
  type: "Applies to every text of this style on the public site.",
});

export const GROUP_LABELS: Readonly<Record<StyleGroup, string>> = Object.freeze(
  {
    color: "Colours",
    background: "Background",
    typography: "Typography",
    spacing: "Spacing and alignment",
    border: "Borders and shape",
    shadow: "Shadow",
    size: "Size",
  },
);

export const KIND_LABELS: Readonly<Record<ComponentKind, string>> =
  Object.freeze({
    page: "Page",
    header: "Header",
    footer: "Footer",
    brand: "Logo",
    nav: "Navigation",
    section: "Section",
    media: "Image area",
    heading: "Heading",
    text: "Text",
    link: "Link",
    button: "Button",
    card: "Card",
    grid: "Grid",
    sidebar: "Sidebar",
    bar: "Top bar",
    chip: "Chip",
  });

export const COLOR_KEY_LABELS: Readonly<Record<ColorKey, string>> =
  Object.freeze({
    text: "Text colour",
    background: "Fill colour",
    border: "Border colour",
    textHover: "Text colour on hover",
    backgroundHover: "Fill colour on hover",
    borderHover: "Border colour on hover",
  });

export const TOKEN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ink: "Ink (main text and dark fills)",
  ink2: "Secondary text",
  muted: "Muted text",
  subtle: "Subtle text",
  faint: "Faint marks (not for text)",
  line: "Lines",
  line2: "Stronger lines",
  line3: "Strongest lines",
  page: "Page background",
  paper: "Paper background",
  paper2: "Deeper paper background",
  canvas: "Workspace canvas",
  accent: "Accent (links and focus ring)",
  accent2: "Accent tint",
  radius: "Corner radius",
  staffRadius: "Staff panel corner radius",
  fontDisplay: "Display font (headings)",
  fontBody: "Body font",
  elevation: "Shadows and depth",
  onInk: "Text on ink",
  inkHover: "Ink on hover",
});

export const FONT_LABELS = Object.freeze({
  "instrument-sans": "Instrument Sans",
  inter: "Inter",
  system: "The device’s system font",
});
export const ELEVATION_LABELS = Object.freeze({
  default: "As designed",
  flat: "Flatter",
  raised: "Raised",
});
export const SHADOW_LABELS = Object.freeze({
  none: "No shadow",
  e1: "Subtle",
  e2: "Medium",
  e3: "Strong",
});
export const WEIGHT_LABELS = Object.freeze({
  400: "Regular (400)",
  500: "Medium (500)",
  600: "Semibold (600)",
  700: "Bold (700)",
});
export const TRANSFORM_LABELS = Object.freeze({
  none: "As written",
  uppercase: "Capitals",
});
export const BACKGROUND_LABELS = Object.freeze({
  none: "As designed",
  color: "Colour",
  gradient: "Gradient",
  image: "Image",
});
export const FIT_LABELS = Object.freeze({
  cover: "Fill the area",
  contain: "Show the whole image",
});
export const POSITION_LABELS = Object.freeze({
  center: "Centre",
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
});
export const BREAKPOINT_LABELS = Object.freeze({
  desktop: "Desktop",
  tablet: "Tablet",
  phone: "Phone",
});
export const SIDE_LABELS = Object.freeze({
  top: "Top",
  right: "Right",
  bottom: "Bottom",
  left: "Left",
});
export const INHERITS = "As designed";
export const RESET_PROPERTY = "Reset";
export const PILL_LABEL = "Fully rounded (pill)";

// The contrast line under a colour control (pair: "Muted text on paper
// background"): the ratio and the minimum in words, never colour alone.
export function contrastText(
  actual: number,
  required: number,
  pair: string,
): Message {
  const ratio = (Math.round(actual * 100) / 100).toFixed(2);
  const needs = (Math.floor(required * 100) / 100).toString();
  return actual + 1e-9 >= required
    ? {
        tone: "success",
        text: `${pair}: ${ratio}:1, readable (needs ${needs}).`,
      }
    : {
        tone: "error",
        text: `${pair}: ${ratio}:1, too little contrast (needs ${needs}).`,
      };
}

export const CONTRAST_OK =
  "Text on this element keeps readable contrast (WCAG AA).";
export const CONTRAST_HEADING = "Contrast";

// ---------------------------------------------------------------------------
// Page text
// ---------------------------------------------------------------------------

export const SLOT_ISSUE_MESSAGES = Object.freeze({
  slot_length: "Too long or empty. Shorten it to the limit shown.",
  slot_lines: "Too many lines for this place on the page.",
  slot_characters:
    "Plain text only: no angle or curly brackets, backslashes, control characters or leading and trailing spaces.",
  slot_link: "No links, web addresses or email addresses in page text.",
  slot_banned:
    "This wording cannot be used in page text: it reads as a claim about order or preference, a qualification or status, an outcome or a price, or legal text. Rephrase it.",
} as const);
export const SLOT_NOT_SAVED = "Not saved until the text is allowed.";
export const SLOT_RESET = "Use the design’s text";
export function characterCountText(count: number, max: number): string {
  return `${count} of ${max} characters`;
}
export function lineLimitText(lines: 1 | 2): string {
  return lines === 1
    ? "One line."
    : "Up to two lines (press Enter for the break).";
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const SECTIONS_HINT =
  "Drag a section by its handle, or use Move up and Move down (Alt+Up and Alt+Down on a focused row).";
export const SHOW_ON_PAGE = "Show on page";
export const LOCKED_SECTION = "Fixed";
export function movedText(label: string, position: number, of: number) {
  return `${label} moved to position ${position} of ${of}.`;
}
export function visibilityText(label: string, hidden: boolean) {
  return hidden ? `${label} hidden.` : `${label} shown.`;
}

// ---------------------------------------------------------------------------
// Validator issues
// ---------------------------------------------------------------------------

export const ISSUE_MESSAGES: Readonly<Record<IssueCode, string>> =
  Object.freeze({
    not_object: "A value has the wrong shape.",
    unknown_key: "A setting the studio does not know.",
    schema: "The theme was made for another version of the studio.",
    too_large: "The theme is too large (at most 64 KB).",
    bad_color: "A colour must be written as #rrggbb.",
    out_of_range: "A value is outside its allowed range.",
    bad_enum: "A value is not one of the allowed choices.",
    unknown_id: "An element, style or text the studio does not know.",
    group_not_allowed: "A setting this element does not offer.",
    slot_length: SLOT_ISSUE_MESSAGES.slot_length,
    slot_lines: SLOT_ISSUE_MESSAGES.slot_lines,
    slot_characters: SLOT_ISSUE_MESSAGES.slot_characters,
    slot_banned: SLOT_ISSUE_MESSAGES.slot_banned,
    slot_link: SLOT_ISSUE_MESSAGES.slot_link,
    section_order: "The section order lists the wrong sections.",
    section_hidden: "Only the sections marked hideable can be hidden.",
    asset_reference: "The image list does not fit the images in use.",
    contrast: "Text would not keep readable contrast.",
  });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const REFUSALS: Readonly<Record<string, Message>> = Object.freeze({
  "step-up-required": {
    tone: "error",
    text: "Confirm your authenticator code again to continue (Account security).",
  },
  "sign-in-required": {
    tone: "error",
    text: "Your session has ended. Sign in again to continue.",
  },
  denied: {
    tone: "error",
    text: "This account no longer holds the website and appearance capability.",
  },
  unavailable: {
    tone: "error",
    text: "This could not be done right now. Nothing was changed. Try again.",
  },
  unconfirmed: {
    tone: "warning",
    text: "The answer could not be confirmed. Reload the studio to see the current state.",
  },
  invalid: {
    tone: "error",
    text: "The request was refused: some values are not allowed. Nothing was changed.",
  },
  accessibility: {
    tone: "error",
    text: "Not published: some text would not keep readable contrast. Fix the items listed.",
  },
});

export type Command =
  "save" | "publish" | "restore" | "reset" | "discard" | "upload" | "read";

const OUTCOMES: Readonly<Record<Command, Readonly<Record<string, Message>>>> =
  Object.freeze({
    save: {
      created: { tone: "success", text: "Draft started." },
      saved: { tone: "success", text: "Saved in the draft." },
      conflict: {
        tone: "warning",
        text: "This draft was changed elsewhere.",
      },
    },
    publish: {
      published: {
        tone: "success",
        text: "Visitors see it on their next page load.",
      },
      conflict: {
        tone: "warning",
        text: "Not published: the draft changed since you opened it. Load the latest draft and try again.",
      },
      not_found: {
        tone: "warning",
        text: "Not published: there is no draft to publish.",
      },
    },
    restore: {
      restored: {
        tone: "success",
        text: "That version is now your draft. Publish it to make it live.",
      },
      conflict: {
        tone: "warning",
        text: "Not restored: the draft changed elsewhere. Load the latest draft and try again.",
      },
      not_found: {
        tone: "warning",
        text: "Not restored: that version no longer exists.",
      },
    },
    reset: {
      reset: {
        tone: "success",
        text: "Your draft is the owner’s design again. The live site changes only when you publish.",
      },
      conflict: {
        tone: "warning",
        text: "Not reset: the draft changed elsewhere. Load the latest draft and try again.",
      },
    },
    discard: {
      discarded: {
        tone: "success",
        text: "Draft discarded. The editor shows the live version.",
      },
      conflict: {
        tone: "warning",
        text: "Not discarded: the draft changed elsewhere. Load the latest draft and try again.",
      },
      not_found: {
        tone: "warning",
        text: "There is no draft to discard.",
      },
    },
    upload: {
      stored: { tone: "success", text: "Image added to the library." },
      exists: {
        tone: "neutral",
        text: "This image is already in the library.",
      },
      limit_reached: {
        tone: "warning",
        text: "The library is full (100 images). Nothing was added.",
      },
    },
    read: {},
  });

export const IMAGE_PROBLEM_MESSAGES: Readonly<Record<ImageProblem, string>> =
  Object.freeze({
    unsupported: "Only PNG, JPEG and WebP images can be used (no SVG or GIF).",
    invalid: "This file is not a readable image.",
    too_large: "The image is larger than 900 KB.",
    dimensions: "The image must be 16 to 4096 pixels wide and high.",
    animated: "Animated images cannot be used.",
  });

// The message for a command's answer.
export function commandMessage(
  command: Command,
  result: {
    readonly status: string;
    readonly outcome?: string;
    readonly problem?: string;
    readonly versionNumber?: number | null;
  },
): Message {
  if (result.status === "outcome" && typeof result.outcome === "string") {
    const found = OUTCOMES[command][result.outcome];
    if (found !== undefined) {
      return command === "publish" &&
        result.outcome === "published" &&
        typeof result.versionNumber === "number"
        ? {
            tone: "success",
            text: `Version ${result.versionNumber} is live. ${found.text}`,
          }
        : found;
    }
  }
  if (result.status === "image" && typeof result.problem === "string") {
    const text = IMAGE_PROBLEM_MESSAGES[result.problem as ImageProblem];
    if (text !== undefined) {
      return { tone: "error", text };
    }
  }
  return REFUSALS[result.status] ?? REFUSALS.unconfirmed;
}

// ---------------------------------------------------------------------------
// Dialogs, versions, assets, import and export
// ---------------------------------------------------------------------------

export const PUBLISH_LABELS = Object.freeze({
  open: "Publish",
  title: "Publish to the live site",
  summary: "What changes against the live version",
  nothing: "Nothing differs from the live version.",
  accessibility: "Accessibility check",
  accessibilityOk:
    "Every text keeps readable contrast (at least WCAG AA, or the owner’s design where it is lower).",
  label: "Version name (optional, up to 80 characters)",
  confirm: "Publish to the live site",
  waitForSave: "Wait until every change is saved in the draft.",
  cancel: "Cancel",
  tokens: "Theme tokens",
  type: "Text styles",
  roles: "Element styles",
  components: "Elements",
  slots: "Page text",
  sections: "Section order or visibility",
  logo: "Logo",
  goTo: "Go to",
});

export const RESET_LABELS = Object.freeze({
  open: "Reset",
  title: "Reset to the owner’s design",
  body: "This replaces your draft with the default design. The live site changes only when you publish.",
  confirm: "Reset the draft",
});

export const RESTORE_LABELS = Object.freeze({
  title: "Restore as draft",
  body: "This version becomes your draft. The live site changes only when you publish.",
  unsaved:
    "Your draft has changes that are not published; restoring replaces them (Undo can bring them back).",
  confirm: "Restore as draft",
});

export const DISCARD_LABELS = Object.freeze({
  open: "Discard draft",
  title: "Discard the draft",
  body: "The draft is set aside and the editor starts again from the live version. The live site does not change.",
  confirm: "Discard the draft",
});

export const CONFLICT_LABELS = Object.freeze({
  title: "This draft was changed elsewhere",
  body: "Someone (or another window) saved the draft after you opened it. Choose which version to keep.",
  load: "Load the latest draft",
  keep: "Keep mine",
  keepTitle: "Keep your version",
  keepBody:
    "Your version replaces the draft saved elsewhere. Those changes are lost.",
  keepConfirm: "Keep my version",
});

export const STORED_DRAFT_UNREADABLE =
  "The saved draft could not be read (it does not fit the current studio). The editor starts from the live version; your first change replaces the unreadable draft.";
export const PUBLISHED_UNREADABLE =
  "The live version could not be read, so visitors see the owner’s design.";

export const VERSION_LABELS = Object.freeze({
  open: "Versions",
  title: "Versions",
  live: "Live",
  draft: "Draft",
  superseded: "Earlier version",
  discarded: "Discarded draft",
  view: "View",
  restore: "Restore as draft",
  more: "Older versions",
  newer: "Newer versions",
  viewing: (n: number | null) =>
    n === null ? "Viewing a version" : `Viewing version ${n}`,
  back: "Back to the draft",
  none: "No version has been published yet.",
  unreadable: "This version cannot be shown in the current studio.",
  close: "Close",
});

export const ASSET_LABELS = Object.freeze({
  open: "Images",
  title: "Image library",
  upload: "Add an image (PNG, JPEG or WebP, up to 900 KB)",
  uploadButton: "Upload",
  consent:
    "Images of people need their consent (A45). Until that is decided, use logos and abstract images only — no portraits.",
  useLogo: "Use as logo",
  useHero: "Use as hero image",
  none: "The library holds no image yet.",
  more: "More images",
  close: "Close",
  noDeletion: "Images cannot be deleted from the library in this version.",
});

export const LOGO_LABELS = Object.freeze({
  none: "The site uses the designed logo. Pick an image from the library to replace it.",
  width: "Logo width",
  height: "Logo height",
  wordmark: "Name beside the logo",
  shown: "Shown",
  hidden: "Hidden (the logo image carries the name)",
  remove: "Use the designed logo",
  choose: "Choose from the image library",
});

export const EXPORT_LABELS = Object.freeze({
  export: "Export",
  import: "Import",
  importTitle: "Import a theme (.json)",
  imported:
    "Theme imported into the draft. Images are not part of a theme file.",
  missingImages:
    "Some images this theme uses are not in this site’s library; add them before publishing.",
  unreadable: "This file is not a theme the studio can read.",
  tooLarge: "This file is too large to be a theme.",
});

export const HISTORY_LABELS = Object.freeze({
  undo: "Undo",
  redo: "Redo",
  undoHint: "Undo (Ctrl+Z)",
  redoHint: "Redo (Ctrl+Shift+Z)",
  save: "Save now",
  retry: "Retry",
});

export const UNSAVED_WARNING =
  "Changes are not saved in the draft yet. Leave anyway?";
