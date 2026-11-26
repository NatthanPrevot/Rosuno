// Website and appearance studio: the stylesheet compiler (DEV-001; studio
// specification section 3.5).
//
// Pure, synchronous and deterministic: a validated configuration and the
// registry in, the published stylesheet out (byte-identical for the same
// input; the empty configuration compiles to the empty string). It never
// takes a selector, a property name or a raw value from the configuration:
// selectors come only from the registry (the two design roots, the type-role
// and role selectors, and [data-rz="<id>"] for instances), properties only
// from the fixed per-group table below, and every value is serialized from a
// re-asserted typed value (#rrggbb colours, finite numbers within their
// bounds, fixed enums, fixed font stacks and shadows). The only url() form is
// the same-origin asset route for a validated SHA-256 digest. Anything else
// throws "appearance: unsafe value" and the caller serves the empty sheet.
//
// Specificity, so the result never depends on where the stylesheet link sits:
// tokens (0,4,0) over the owner's roots (0,3,0); type roles and roles gain
// :root over the owner's (0,2,0) rules; instances are (0,3,0) !important, over
// the layout classes' (0,2,0) !important. Workspace instances end
// :not(.rz-studio *), so the studio's own controls keep the owner's design.
// Slots and sections are not CSS: the compiler ignores them.

import {
  BREAKPOINTS,
  derivedHoverBackground,
  effectiveTokens,
  FONT_KEYS,
  GRADIENT_ANGLES,
  IMAGE_FITS,
  IMAGE_POSITIONS,
  isAppearanceId,
  isHex,
  isSha256,
  isValidatedAppearance,
  KIND_RULES,
  mixHex,
  onInkFor,
  SHADOWS,
  TRANSFORMS,
  WEIGHTS,
  WORDMARKS,
  type AppearanceRegistry,
  type AppearanceScope,
  type Background,
  type Breakpoint,
  type ComponentKind,
  type ComponentStyle,
  type Hex,
  type Typography,
  type ValidAppearance,
} from "../../application/appearance-schema.ts";

const UNSAFE = "appearance: unsafe value";
const HEADER = "/* rosuno-appearance schema 1 */";

const ROOTS: Readonly<Record<AppearanceScope, string>> = Object.freeze({
  site: ":root .rz:not(.rz .rz)",
  workspace: ":root .rzw:not(.rzw .rzw)",
});
const OUTSIDE_STUDIO = ":not(.rz-studio *)";

const MEDIA: Readonly<Record<Breakpoint, string>> = Object.freeze({
  desktop: "@media (min-width: 981px)",
  tablet: "@media (min-width: 701px) and (max-width: 980px)",
  phone: "@media (max-width: 700px)",
});

const FONT_STACKS: Readonly<Record<string, string>> = Object.freeze({
  "instrument-sans": '"Instrument Sans", "Inter", system-ui, sans-serif',
  inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
});

// The owner's elevation values per scope (theme.css and workspace.css roots).
const OWNER_E1 =
  "0 1px 1px rgba(15, 16, 19, 0.03), 0 1px 3px rgba(15, 16, 19, 0.05)";
const OWNER_E2 =
  "0 1px 2px rgba(15, 16, 19, 0.04), 0 8px 20px -6px rgba(15, 16, 19, 0.1)";
const OWNER_E3: Readonly<Record<AppearanceScope, string>> = Object.freeze({
  site: "0 1px 2px rgba(15, 16, 19, 0.04), 0 4px 8px -2px rgba(15, 16, 19, 0.04), 0 22px 48px -12px rgba(15, 16, 19, 0.16)",
  workspace:
    "0 1px 2px rgba(15, 16, 19, 0.04), 0 4px 8px -2px rgba(15, 16, 19, 0.04), 0 22px 48px -12px rgba(15, 16, 19, 0.18)",
});

const SHADOW_VALUES: Readonly<Record<string, string>> = Object.freeze({
  none: "none",
  e1: "var(--e1)",
  e2: "var(--e2)",
  e3: "var(--e3)",
});

const ASSET_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: "png",
  jpeg: "jpg",
  webp: "webp",
});

// Registry selectors are fixed code, but they still may not carry anything
// that could end a rule or open another.
const SAFE_SELECTOR = /^[a-z0-9 .:()[\]="*,>-]+$/i;

// ---------------------------------------------------------------------------
// Serialization (every value re-asserted)
// ---------------------------------------------------------------------------

function unsafe(): never {
  throw new Error(UNSAFE);
}

function hex(value: unknown): string {
  return isHex(value) ? value : unsafe();
}

function finite(value: unknown, min: number, max: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : unsafe();
}

function trimmed(value: number, decimals: number): string {
  const text = String(Number(value.toFixed(decimals)));
  return text === "-0" ? "0" : text;
}

function px(value: unknown, min: number, max: number): string {
  return `${trimmed(finite(value, min, max), 3)}px`;
}

function oneOf<T>(list: readonly T[], value: unknown): T {
  const found = list.find((entry) => entry === value);
  return found === undefined ? unsafe() : found;
}

function font(value: unknown): string {
  return FONT_STACKS[oneOf(FONT_KEYS, value)];
}

function lineHeight(value: unknown): string {
  return finite(value, 0.5, 3).toFixed(2);
}

function letterSpacing(value: unknown): string {
  const text = finite(value, -0.1, 0.1).toFixed(3);
  return `${text === "-0.000" ? "0.000" : text}em`;
}

function selector(value: string): string {
  return SAFE_SELECTOR.test(value) && !value.includes("/*") ? value : unsafe();
}

function assetUrl(asset: unknown): string {
  if (asset === null || typeof asset !== "object") {
    return unsafe();
  }
  const { sha256, format } = asset as { sha256?: unknown; format?: unknown };
  if (!isSha256(sha256)) {
    return unsafe();
  }
  const extension = ASSET_EXTENSION[oneOf(["png", "jpeg", "webp"], format)];
  return `url("/appearance/assets/${sha256}.${extension}")`;
}

function background(value: Background): string {
  switch (value.type) {
    case "color":
      return hex(value.color);
    case "gradient":
      return `linear-gradient(${oneOf(GRADIENT_ANGLES, value.angle)}deg, ${hex(value.from)}, ${hex(value.to)})`;
    case "image":
      return `${assetUrl(value.asset)} ${oneOf(IMAGE_POSITIONS, value.position)} / ${oneOf(IMAGE_FITS, value.fit)} no-repeat`;
    default:
      return unsafe();
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Declaration = readonly [property: string, value: string];
type Block = {
  readonly base: Declaration[];
  readonly hover: Declaration[];
  readonly media: Record<Breakpoint, Declaration[]>;
};

function emptyBlock(): Block {
  return {
    base: [],
    hover: [],
    media: { desktop: [], tablet: [], phone: [] },
  };
}

function ruleText(
  selectorText: string,
  declarations: readonly Declaration[],
  important: boolean,
  indent: string,
): string {
  const suffix = important ? " !important" : "";
  return [
    `${indent}${selectorText} {`,
    ...declarations.map(
      ([property, value]) => `${indent}  ${property}: ${value}${suffix};`,
    ),
    `${indent}}`,
  ].join("\n");
}

function blockText(
  base: string,
  hover: string | null,
  block: Block,
  important: boolean,
): string[] {
  const out: string[] = [];
  if (block.base.length > 0) {
    out.push(ruleText(base, block.base, important, ""));
  }
  if (block.hover.length > 0) {
    out.push(ruleText(hover ?? unsafe(), block.hover, important, ""));
  }
  for (const breakpoint of BREAKPOINTS) {
    const declarations = block.media[breakpoint];
    if (declarations.length > 0) {
      out.push(
        `${MEDIA[breakpoint]} {\n${ruleText(base, declarations, important, "  ")}\n}`,
      );
    }
  }
  return out;
}

// Responsive values: the breakpoints in fixed order.
function eachBreakpoint<T>(
  value: unknown,
  emit: (breakpoint: Breakpoint, item: T) => void,
): void {
  if (value === null || typeof value !== "object") {
    unsafe();
  }
  for (const key of Object.keys(value as object)) {
    if (!BREAKPOINTS.some((breakpoint) => breakpoint === key)) {
      unsafe();
    }
  }
  for (const breakpoint of BREAKPOINTS) {
    const item = (value as Record<string, unknown>)[breakpoint];
    if (item !== undefined) {
      emit(breakpoint, item as T);
    }
  }
}

type TypographyPermit = {
  readonly family: boolean;
  readonly weight: boolean;
  readonly size: readonly [number, number] | null;
  readonly lineHeight: readonly [number, number] | null;
  readonly letterSpacing: boolean;
  readonly transform: boolean;
  readonly color: boolean;
};

function typographyInto(
  block: Block,
  typography: Typography & { readonly color?: Hex },
  permit: TypographyPermit,
): void {
  for (const key of Object.keys(typography)) {
    if (
      ![
        "family",
        "weight",
        "size",
        "lineHeight",
        "letterSpacing",
        "transform",
        "color",
      ].includes(key)
    ) {
      unsafe();
    }
  }
  if (typography.color !== undefined) {
    if (!permit.color) {
      unsafe();
    }
    block.base.push(["color", hex(typography.color)]);
  }
  if (typography.family !== undefined) {
    if (!permit.family) {
      unsafe();
    }
    block.base.push(["font-family", font(typography.family)]);
  }
  if (typography.weight !== undefined) {
    if (!permit.weight) {
      unsafe();
    }
    block.base.push(["font-weight", String(oneOf(WEIGHTS, typography.weight))]);
  }
  if (typography.size !== undefined) {
    const [min, max] = permit.size ?? unsafe();
    eachBreakpoint<number>(typography.size, (breakpoint, size) => {
      block.media[breakpoint].push(["font-size", px(size, min, max)]);
    });
  }
  if (typography.lineHeight !== undefined) {
    const [min, max] = permit.lineHeight ?? unsafe();
    block.base.push([
      "line-height",
      lineHeight(finite(typography.lineHeight, min, max)),
    ]);
  }
  if (typography.letterSpacing !== undefined) {
    if (!permit.letterSpacing) {
      unsafe();
    }
    block.base.push([
      "letter-spacing",
      letterSpacing(typography.letterSpacing),
    ]);
  }
  if (typography.transform !== undefined) {
    if (!permit.transform) {
      unsafe();
    }
    block.base.push([
      "text-transform",
      oneOf(TRANSFORMS, typography.transform),
    ]);
  }
}

const SIDES = ["top", "right", "bottom", "left"] as const;
const INTERACTIVE: readonly ComponentKind[] = ["button", "link", "nav", "chip"];

function borderSide(
  block: Block,
  side: "top" | "right" | "bottom",
  value: { readonly width?: number; readonly color?: Hex },
): void {
  if (value.width !== undefined) {
    const width = finite(value.width, 0, 2);
    block.base.push([`border-${side}-width`, px(width, 0, 2)]);
    if (width > 0) {
      block.base.push([`border-${side}-style`, "solid"]);
    }
  }
  if (value.color !== undefined) {
    block.base.push([`border-${side}-color`, hex(value.color)]);
  }
}

// The declarations of one component or role style, per the kind's
// allow-list (re-checked here), in a fixed property order.
function styleBlock(
  style: ComponentStyle,
  kind: ComponentKind,
  ink: Hex,
  transformFlagged: boolean,
): Block {
  const rule = KIND_RULES[kind] ?? unsafe();
  const block = emptyBlock();
  for (const group of Object.keys(style)) {
    if (
      ![
        "color",
        "background",
        "typography",
        "spacing",
        "border",
        "shadow",
        "size",
      ].includes(group)
    ) {
      unsafe();
    }
  }
  if (style.background !== undefined) {
    if (!rule.background.includes(style.background.type)) {
      unsafe();
    }
    block.base.push(["background", background(style.background)]);
  }
  const colors = style.color;
  if (colors !== undefined) {
    for (const key of Object.keys(colors)) {
      if (!rule.color.some((allowed) => allowed === key)) {
        unsafe();
      }
    }
    if (colors.text !== undefined) {
      block.base.push(["color", hex(colors.text)]);
    }
    if (colors.background !== undefined) {
      block.base.push(["background", hex(colors.background)]);
    }
    if (colors.border !== undefined) {
      block.base.push(["border-color", hex(colors.border)]);
    }
  }
  if (style.border !== undefined) {
    const border = rule.border ?? unsafe();
    const value = style.border;
    if (value.radius !== undefined) {
      if (border.radius === null) {
        unsafe();
      }
      block.base.push([
        "border-radius",
        value.radius === 999 && border.pill
          ? "999px"
          : px(value.radius, border.radius[0], border.radius[1]),
      ]);
    }
    if (value.width !== undefined) {
      if (!border.width) {
        unsafe();
      }
      const width = finite(value.width, 0, 2);
      block.base.push(["border-width", px(width, 0, 2)]);
      if (width > 0) {
        block.base.push(["border-style", "solid"]);
      }
    }
    if (value.color !== undefined) {
      if (!border.color) {
        unsafe();
      }
      block.base.push(["border-color", hex(value.color)]);
    }
    if (value.top !== undefined) {
      if (!border.top) {
        unsafe();
      }
      borderSide(block, "top", value.top);
    }
    if (value.right !== undefined) {
      if (!border.right) {
        unsafe();
      }
      borderSide(block, "right", value.right);
    }
    if (value.bottom !== undefined) {
      if (!border.bottom) {
        unsafe();
      }
      borderSide(block, "bottom", value.bottom);
    }
  }
  if (style.typography !== undefined) {
    const type = rule.typography ?? unsafe();
    typographyInto(block, style.typography, {
      family: type.family,
      weight: type.weight,
      size: type.size,
      lineHeight: type.lineHeight,
      letterSpacing: type.letterSpacing,
      transform:
        type.transform === "always" ||
        (type.transform === "flagged" && transformFlagged),
      color: false,
    });
  }
  if (style.spacing !== undefined) {
    const { padding, gap } = style.spacing;
    if (padding !== undefined) {
      const limits = rule.padding ?? unsafe();
      eachBreakpoint<Record<string, unknown>>(padding, (breakpoint, sides) => {
        if (sides === null || typeof sides !== "object") {
          unsafe();
        }
        for (const key of Object.keys(sides)) {
          if (!SIDES.some((side) => side === key)) {
            unsafe();
          }
        }
        for (const side of SIDES) {
          if (sides[side] !== undefined) {
            block.media[breakpoint].push([
              `padding-${side}`,
              px(sides[side], 0, limits.max),
            ]);
          }
        }
      });
    }
    if (gap !== undefined) {
      const max = rule.gap ?? unsafe();
      eachBreakpoint<number>(gap, (breakpoint, value) => {
        block.media[breakpoint].push(["gap", px(value, 0, max)]);
      });
    }
  }
  if (style.shadow !== undefined) {
    if (!rule.shadow) {
      unsafe();
    }
    block.base.push([
      "box-shadow",
      SHADOW_VALUES[oneOf(SHADOWS, style.shadow)],
    ]);
  }
  if (style.size !== undefined) {
    if (!rule.size) {
      unsafe();
    }
    if (style.size.height !== undefined) {
      block.base.push(["height", px(style.size.height, 32, 56)]);
    }
    if (style.size.paddingX !== undefined) {
      block.base.push(["padding-left", px(style.size.paddingX, 8, 40)]);
      block.base.push(["padding-right", px(style.size.paddingX, 8, 40)]);
    }
  }
  // Interactive kinds: an overridden base colour always carries its hover
  // colour, so it can never mask the owner's hover rule.
  if (INTERACTIVE.includes(kind) && colors !== undefined) {
    const text = colors.textHover ?? colors.text;
    if (text !== undefined) {
      block.hover.push(["color", hex(text)]);
    }
    const fill =
      colors.backgroundHover ??
      (colors.background === undefined
        ? undefined
        : derivedHoverBackground(hex(colors.background), ink));
    if (fill !== undefined) {
      block.hover.push(["background", hex(fill)]);
    }
    const edge = colors.borderHover ?? colors.border;
    if (edge !== undefined) {
      block.hover.push(["border-color", hex(edge)]);
    }
  }
  return block;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function tokenRule(
  configuration: ValidAppearance,
  registry: AppearanceRegistry,
  scope: AppearanceScope,
): string | null {
  const overrides = (configuration.tokens?.[scope] ?? {}) as Readonly<
    Record<string, unknown>
  >;
  const specs = registry.tokens.filter((spec) => spec.scope === scope);
  for (const key of Object.keys(overrides)) {
    if (!specs.some((spec) => spec.key === key)) {
      unsafe();
    }
  }
  const declarations: Declaration[] = [];
  for (const spec of specs) {
    const value = overrides[spec.key];
    if (value === undefined) {
      continue;
    }
    if (!/^--[a-z0-9-]+$/.test(spec.cssName)) {
      unsafe();
    }
    switch (spec.type) {
      case "color":
        declarations.push([spec.cssName, hex(value)]);
        break;
      case "length": {
        const [min, max] = spec.range ?? unsafe();
        if (!Number.isInteger(value)) {
          unsafe();
        }
        declarations.push([spec.cssName, px(value, min, max)]);
        break;
      }
      case "font":
        declarations.push([spec.cssName, font(value)]);
        break;
      case "elevation": {
        const elevation = oneOf(["default", "flat", "raised"], value);
        if (elevation === "flat") {
          declarations.push(["--e1", "none"], ["--e2", OWNER_E1]);
        } else if (elevation === "raised") {
          declarations.push(["--e1", OWNER_E2], ["--e2", OWNER_E3[scope]]);
        }
        break;
      }
      default:
        unsafe();
    }
  }
  // The derived hooks, only when their source token is overridden.
  const tokens = effectiveTokens(configuration, registry, scope);
  if (overrides.ink !== undefined) {
    const ink = hex(tokens.ink);
    declarations.push(
      ["--rz-ink-hover", mixHex(ink, "#ffffff", 0.09)],
      ["--rz-on-ink", onInkFor(ink)],
    );
  }
  if (overrides.page !== undefined) {
    declarations.push([
      "--rz-surface-hover",
      mixHex(hex(tokens.page), hex(tokens.ink), 0.012),
    ]);
  }
  return declarations.length === 0
    ? null
    : ruleText(ROOTS[scope], declarations, false, "");
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

function instanceSelector(id: string, scope: AppearanceScope): string {
  if (!isAppearanceId(id)) {
    unsafe();
  }
  return `:root [data-rz="${id}"][data-rz]${scope === "workspace" ? OUTSIDE_STUDIO : ""}`;
}

export function compileAppearanceCss(
  configuration: ValidAppearance,
  registry: AppearanceRegistry,
): string {
  if (!isValidatedAppearance(configuration)) {
    unsafe();
  }
  const out: string[] = [];
  for (const scope of ["site", "workspace"] as const) {
    const rule = tokenRule(configuration, registry, scope);
    if (rule !== null) {
      out.push(rule);
    }
  }
  const types = configuration.type ?? {};
  for (const id of Object.keys(types)) {
    if (!registry.typeRoles.some((spec) => spec.id === id)) {
      unsafe();
    }
  }
  for (const spec of registry.typeRoles) {
    const typography = types[spec.id];
    if (typography === undefined) {
      continue;
    }
    const block = emptyBlock();
    typographyInto(block, typography, {
      family: true,
      weight: true,
      size: spec.sizeRange,
      lineHeight: spec.lineHeightRange,
      letterSpacing: true,
      transform: spec.transformAllowed,
      color: spec.colorAllowed,
    });
    out.push(
      ...blockText(`:root ${selector(spec.selector)}`, null, block, false),
    );
  }
  const site = hex(effectiveTokens(configuration, registry, "site").ink);
  const workspace = hex(
    effectiveTokens(configuration, registry, "workspace").ink,
  );
  const roles = configuration.roles ?? {};
  for (const id of Object.keys(roles)) {
    if (!registry.roles.some((spec) => spec.id === id)) {
      unsafe();
    }
  }
  for (const spec of registry.roles) {
    const style = roles[spec.id];
    if (style === undefined) {
      continue;
    }
    const block = styleBlock(
      style,
      spec.kind,
      spec.scope === "site" ? site : workspace,
      false,
    );
    out.push(
      ...blockText(
        `:root ${selector(spec.selector)}`,
        spec.hoverSelector === undefined
          ? `:root ${selector(spec.selector)}:hover`
          : `:root ${selector(spec.hoverSelector)}`,
        block,
        false,
      ),
    );
  }
  const components = configuration.components ?? {};
  for (const id of Object.keys(components)) {
    if (!registry.components.some((spec) => spec.id === id)) {
      unsafe();
    }
  }
  for (const spec of registry.components) {
    const style = components[spec.id];
    if (style === undefined) {
      continue;
    }
    if (!spec.groups.every((group) => typeof group === "string")) {
      unsafe();
    }
    for (const group of Object.keys(style)) {
      if (!spec.groups.some((allowed) => allowed === group)) {
        unsafe();
      }
    }
    const base = instanceSelector(spec.id, spec.scope);
    const block = styleBlock(
      style,
      spec.kind,
      spec.scope === "site" ? site : workspace,
      spec.transformAllowed === true,
    );
    out.push(...blockText(base, `${base}:hover`, block, true));
  }
  const logo = configuration.brand?.logo;
  if (logo !== undefined) {
    const url = assetUrl(logo.asset);
    const width = px(logo.width, 16, 240);
    const height = px(logo.height, 12, 64);
    const wordmark = oneOf(WORDMARKS, logo.wordmark);
    for (const spec of registry.components) {
      if (spec.kind !== "brand") {
        continue;
      }
      const base = instanceSelector(spec.id, spec.scope);
      out.push(
        ruleText(
          `${base} .mark`,
          [
            ["width", width],
            ["height", height],
            ["background", `${url} left center / contain no-repeat`],
          ],
          true,
          "",
        ),
        ruleText(
          `${base} .mark::before, ${base} .mark::after`,
          [["display", "none"]],
          true,
          "",
        ),
      );
      if (wordmark === "hidden") {
        out.push(
          ruleText(
            base,
            [
              ["font-size", "0"],
              ["gap", "0"],
            ],
            true,
            "",
          ),
        );
      }
    }
  }
  return out.length === 0 ? "" : `${[HEADER, ...out].join("\n")}\n`;
}
