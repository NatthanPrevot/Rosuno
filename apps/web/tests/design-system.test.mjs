// Targeted WI-P2-002 design-system tests.
//
// They run on Node.js built-ins alone and read the stylesheet and the TSX
// sources as text, so they need no browser, renderer, or installed package.
// Each test checks a contract of the design system rather than its presence:
// token values are parsed and compared, contrast is computed, and the
// presentation source is checked for what it must never contain.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const appRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../", appRoot);

const stylesheetPath = "app/globals.css";
const modulePath = "src/presentation/design-system.tsx";
const pagePath = "app/page.tsx";
const layoutPath = "app/layout.tsx";

function read(relativePath, root = appRoot) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => !/(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/.test(file))
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

function importsOf(source) {
  return [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

// Source without its comments, so prose never satisfies or trips a check.
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*\n/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

// CSS as a tree of rules. A style rule holds its declarations in order; an
// at-rule holds the rules nested in it.
function parseCss(css) {
  const rules = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open === -1) {
      assert.equal(css.slice(index).trim(), "", "text outside any rule");
      break;
    }
    const prelude = css
      .slice(index, open)
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")");
    let depth = 1;
    let end = open + 1;
    while (depth > 0) {
      assert.ok(end < css.length, `unclosed rule: ${prelude}`);
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    }
    const body = css.slice(open + 1, end - 1);
    rules.push(
      prelude.startsWith("@")
        ? { prelude, rules: parseCss(body) }
        : {
            prelude,
            selectors: prelude.split(/,\s*(?![^()]*\))/),
            declarations: body
              .split(";")
              .map((declaration) => declaration.trim())
              .filter(Boolean)
              .map((declaration) => {
                const colon = declaration.indexOf(":");
                assert.ok(colon > 0, `not a declaration: ${declaration}`);
                return [
                  declaration.slice(0, colon).trim(),
                  declaration
                    .slice(colon + 1)
                    .trim()
                    .replace(/\s+/g, " ")
                    .replace(/\( /g, "(")
                    .replace(/ \)/g, ")"),
                ];
              }),
          },
    );
    index = end;
  }
  return rules;
}

const stylesheet = read(stylesheetPath);
const css = codeOf(stylesheet);
const tree = parseCss(css);
const moduleSource = read(modulePath);
const moduleCode = codeOf(moduleSource);
const pageSource = read(pagePath);
const pageCode = codeOf(pageSource);
const layoutSource = read(layoutPath);

// Every style rule with the at-rule it sits in ("" at the top level).
const styleRules = tree.flatMap((rule) =>
  rule.rules === undefined
    ? [{ ...rule, within: "" }]
    : rule.rules.map((nested) => {
        assert.equal(nested.rules, undefined, "at-rules nest one level only");
        return { ...nested, within: rule.prelude };
      }),
);

const topLevel = styleRules.filter((rule) => rule.within === "");

function rulesFor(selector, within = "") {
  return styleRules.filter(
    (rule) => rule.within === within && rule.selectors.includes(selector),
  );
}

// The declarations a selector receives in one context, later ones winning.
function declared(selector, within = "") {
  const rules = rulesFor(selector, within);
  assert.ok(rules.length > 0, `no rule for ${selector} in "${within}"`);
  return new Map(rules.flatMap((rule) => rule.declarations));
}

const tokens = declared(":root");

// A value with every custom property replaced by what the given scopes set.
function resolve(value, ...scopes) {
  let resolved = value;
  for (let pass = 0; /var\(/.test(resolved); pass += 1) {
    assert.ok(pass < 8, `unresolved reference in ${value}`);
    resolved = resolved.replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => {
      const scope = [...scopes, tokens].find((entry) => entry.has(name));
      assert.ok(scope, `${name} is not defined`);
      return scope.get(name);
    });
  }
  return resolved;
}

function token(name, ...scopes) {
  const scope = [...scopes, tokens].find((entry) => entry.has(name));
  assert.ok(scope, `${name} is not defined`);
  return resolve(scope.get(name), ...scopes);
}

function luminance(color) {
  assert.match(
    color,
    /^#[0-9a-f]{6}$/,
    `${color} is not a six-digit hex color`,
  );
  const [red, green, blue] = [1, 3, 5]
    .map((start) => parseInt(color.slice(start, start + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

// A length in rem. clamp() reports the bound asked for.
function rem(value, bound = "max") {
  const clamp = value.match(/^clamp\(([^,]+),.*,\s*([^,]+)\)$/);
  const length = clamp ? clamp[bound === "min" ? 1 : 2].trim() : value;
  const match = length.match(/^(\d*\.?\d+)(rem|px)$/);
  assert.ok(match, `${value} is not a rem or px length`);
  return match[2] === "px" ? Number(match[1]) / 16 : Number(match[1]);
}

function milliseconds(value) {
  const match = value.match(/^(\d*\.?\d+)(ms|s)$/);
  assert.ok(match, `${value} is not a duration`);
  return match[2] === "s" ? Number(match[1]) * 1000 : Number(match[1]);
}

// Words that would mean a feature, record, provider, or business rule had
// entered the design system. The approved density names are not among them.
const featureVocabulary =
  /lawyer|consultation|referral|intake|booking|payment|payout|ledger|refund|invoice|retainer|\bfee\b|\bprice|pricing|stripe|\bdaily\b|\bresend\b|supabase|postgres|database|\bsql\b|jurisdiction|california|arizona|eligib|bookab|engagement|marketplace|complaint|licen[cs]e|practice area|\bmatters?\b|appointment|calendar|schedul|\bcourt|lawsuit|\blegal\b|\bbar number|dashboard|\binbox\b|sign.?in|sign.?up|password|\bauth/i;

const densities = ["public", "client", "attorney", "admin"];
const tones = ["success", "warning", "error", "information", "neutral"];

const exportedComponents = [
  "Alert",
  "Button",
  "ButtonLink",
  "Choice",
  "Cluster",
  "Columns",
  "Dialog",
  "DialogActions",
  "DialogBody",
  "DialogDismissal",
  "Disclosure",
  "Display",
  "Eyebrow",
  "FieldGroup",
  "Heading",
  "Icon",
  "MediaFrame",
  "NotificationRegion",
  "Page",
  "Rule",
  "SelectField",
  "Stack",
  "Status",
  "Surface",
  "Table",
  "Text",
  "TextAreaField",
  "TextField",
];

// The source of one exported component, up to the next top-level declaration.
function componentSource(name) {
  const start = moduleCode.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported`);
  const next = moduleCode
    .slice(start + 1)
    .search(/^(?:export |type |function |const )/m);
  return next === -1
    ? moduleCode.slice(start)
    : moduleCode.slice(start, start + 1 + next);
}

test("1. the design system is exactly its contracted files", () => {
  for (const file of [
    stylesheetPath,
    layoutPath,
    pagePath,
    modulePath,
    "tests/design-system.test.mjs",
    "tests/application-shell.test.mjs",
  ]) {
    assert.ok(existsSync(new URL(file, appRoot)), `missing ${file}`);
  }
  // One presentation module and one stylesheet; no second copy of either.
  assert.deepEqual(filesIn("src/presentation/"), [modulePath]);
  assert.deepEqual(
    readdirSync(new URL("src/", appRoot))
      .filter((entry) => !/^(?:\.DS_Store|Thumbs\.db)$/.test(entry))
      .sort(),
    ["application", "presentation"],
  );
  assert.deepEqual(filesIn("tests/"), [
    "tests/application-shell.test.mjs",
    "tests/design-system.test.mjs",
  ]);
  const sources = [...filesIn("app/"), ...filesIn("src/")];
  assert.deepEqual(
    sources.filter((file) => !/\.tsx?$/.test(file)),
    [stylesheetPath],
  );
  // No style language other than CSS, no CSS module, and no bundled font,
  // image, or media asset.
  for (const file of [...sources, ...filesIn("tests/")]) {
    assert.doesNotMatch(
      file,
      /\.(?:module\.css|s[ac]ss|less|styl|pcss|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|mp3|wav|pdf)$/i,
      file,
    );
  }
  for (const entry of readdirSync(appRoot)) {
    assert.doesNotMatch(
      entry,
      /^(?:public|static|assets|fonts|images|styles)$/,
      entry,
    );
  }
});

test("2. the design system adds no dependency, package, or tool configuration", () => {
  const appPackage = JSON.parse(read("package.json"));
  // The same packages and scripts as the application shell, by name. Their
  // versions and commands are held by the P0 controls.
  assert.deepEqual(Object.keys(appPackage.dependencies).sort(), [
    "next",
    "react",
    "react-dom",
  ]);
  assert.deepEqual(Object.keys(appPackage.devDependencies).sort(), [
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "typescript",
  ]);
  assert.deepEqual(Object.keys(appPackage.scripts).sort(), [
    "build",
    "dev",
    "start",
    "test:application-shell",
    "typecheck",
  ]);
  for (const field of [
    "optionalDependencies",
    "peerDependencies",
    "overrides",
    "resolutions",
    "pnpm",
  ]) {
    assert.equal(Object.hasOwn(appPackage, field), false, field);
  }
  const rootPackage = JSON.parse(read("package.json", repositoryRoot));
  assert.deepEqual(rootPackage.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(rootPackage.devDependencies).sort(), [
    "prettier",
    "typescript",
  ]);
  // No font, icon, motion, styling, or component package, by any route.
  const prohibited =
    /tailwind|\bsass\b|\bless\b|stylus|styled-components|@emotion|@stitches|vanilla-extract|\bclsx\b|classnames|class-variance-authority|@radix-ui|shadcn|@headlessui|@mui|@chakra-ui|@mantine|bootstrap|\bantd\b|daisyui|framer-motion|\bmotion\b|\bgsap\b|animejs|react-spring|lottie|lucide|heroicons|react-icons|@tabler|phosphor|fontawesome|@fontsource|\bgeist\b|next\/font|autoprefixer|postcss-/i;
  for (const [name, manifest] of [
    ["apps/web/package.json", read("package.json")],
    ["package.json", read("package.json", repositoryRoot)],
    ["pnpm-workspace.yaml", read("pnpm-workspace.yaml", repositoryRoot)],
  ]) {
    assert.doesNotMatch(manifest, prohibited, name);
  }
  // The lockfile resolves no such package either. It names some only as
  // optional peers of Next.js, which are not installed.
  const lockfile = read("pnpm-lock.yaml", repositoryRoot);
  const resolved = [
    ...lockfile.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s':]+)@[^\n]*:$/gm),
  ].map((match) => match[1]);
  assert.ok(resolved.includes("next") && resolved.includes("react"));
  for (const name of resolved) {
    assert.doesNotMatch(name, prohibited, `pnpm-lock.yaml resolves ${name}`);
  }
  const importers = lockfile.slice(
    lockfile.indexOf("importers:"),
    lockfile.indexOf("\npackages:"),
  );
  assert.deepEqual(
    [...importers.matchAll(/^ {6}'?([^\s':]+)'?:$/gm)].map((match) => match[1]),
    [
      "prettier",
      "typescript",
      "next",
      "react",
      "react-dom",
      "@types/node",
      "@types/react",
      "@types/react-dom",
      "typescript",
    ],
  );
  // Application sources import React, Next.js, and their own files only.
  for (const file of [...filesIn("app/"), ...filesIn("src/")]) {
    if (file === stylesheetPath) continue;
    for (const specifier of importsOf(read(file))) {
      assert.match(
        specifier,
        /^(?:react|next|next\/server|\.{1,2}\/[\w./-]+)$/,
        `${file} imports ${specifier}`,
      );
    }
  }
  // No configuration file for such a tool beside the app or the repository.
  for (const root of [appRoot, repositoryRoot]) {
    for (const entry of readdirSync(root)) {
      assert.doesNotMatch(
        entry,
        /^(?:tailwind\.config|postcss\.config|\.postcssrc|components\.json|\.stylelintrc|stylelint\.config|\.babelrc|babel\.config)/,
        entry,
      );
    }
  }
  assert.match(
    read("pnpm-workspace.yaml", repositoryRoot),
    /^packages:\n {2}- apps\/web\n(?! {2}- )/m,
  );
});

test("3. the stylesheet is ordinary CSS with no external or remote reference", () => {
  // Media queries, one feature query, and the dialog's starting style are
  // the only at-rules: no import, font face, keyframes, layer, or
  // preprocessor directive.
  assert.deepEqual(
    [
      ...new Set([...css.matchAll(/@[a-z-]+/g)].map((match) => match[0])),
    ].sort(),
    ["@media", "@starting-style", "@supports"],
  );
  for (const rule of tree) {
    assert.doesNotMatch(rule.prelude, /;/, rule.prelude);
  }
  // CSS has no line comment. One would be dropped by codeOf here and yet
  // break the rule after it in a browser, so none may be written.
  assert.doesNotMatch(stylesheet.replace(/\/\*[\s\S]*?\*\//g, ""), /\/\//);
  assert.doesNotMatch(stylesheet, /url\s*\(|image-set\s*\(|src\s*:/i);
  assert.doesNotMatch(
    stylesheet,
    /https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}|\bdata:/i,
  );
  // No preprocessor syntax: variables, nesting parents, interpolation, maps.
  assert.doesNotMatch(
    css,
    /\$[a-z_-]|#\{|&|@(?:use|forward|include|mixin|extend|apply|tailwind|function|each|if)\b/i,
  );
  assert.doesNotMatch(
    css,
    /expression\s*\(|(?<![a-z-])behavior\s*:|-moz-binding/i,
  );
  // Every property and every selector is lower case plain CSS.
  for (const rule of styleRules) {
    for (const [property] of rule.declarations) {
      assert.match(property, /^-?-?[a-z][a-z0-9-]*$/, property);
    }
  }
  // The TSX sources reference nothing remote and embed no style or script.
  for (const [file, source] of [
    [modulePath, moduleSource],
    [pagePath, pageSource],
    [layoutPath, layoutSource],
  ]) {
    assert.doesNotMatch(
      source,
      /https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}|\bdata:|<link\b|<script\b|<style\b|<iframe\b|<object\b|<embed\b|\bstyle=|\bsrc=|\bsrcSet=|\bhref="(?!\/)|dangerouslySetInnerHTML(?!")/i,
      file,
    );
  }
  // Raw markup is named once, in the list of what a caller may not pass.
  assert.equal(moduleSource.match(/dangerouslySetInnerHTML/g).length, 1);
  assert.doesNotMatch(pageSource + layoutSource, /dangerouslySetInnerHTML/);
  // The root layout, and nothing else, loads the one stylesheet.
  assert.equal(layoutSource.match(/^import "\.\/globals\.css";$/gm)?.length, 1);
  for (const file of [...filesIn("app/"), ...filesIn("src/")]) {
    if (file === stylesheetPath) continue;
    assert.deepEqual(
      importsOf(read(file)).filter((specifier) => /\.css$/.test(specifier)),
      file === layoutPath ? ["./globals.css"] : [],
      file,
    );
  }
});

test("4. tokens cover every required category and none is dangling or unused", () => {
  for (const name of [
    "--rs-color-deep-cocoa",
    "--rs-color-chocolate",
    "--rs-color-cream",
    "--rs-color-warm-white",
    "--rs-color-premium-gold",
    "--rs-color-success",
    "--rs-color-warning",
    "--rs-color-error",
    "--rs-color-information",
    "--rs-font-display",
    "--rs-font-ui",
    "--rs-text-xs",
    "--rs-text-sm",
    "--rs-text-base",
    "--rs-text-md",
    "--rs-text-lg",
    "--rs-text-xl",
    "--rs-heading-sm",
    "--rs-heading-md",
    "--rs-heading-lg",
    "--rs-display-md",
    "--rs-display-lg",
    ...Array.from({ length: 9 }, (_, step) => `--rs-space-${step + 1}`),
    "--rs-radius-sm",
    "--rs-radius-md",
    "--rs-radius-lg",
    "--rs-border-width",
    "--rs-border-accent-width",
    "--rs-shadow-1",
    "--rs-shadow-2",
    "--rs-shadow-3",
    "--rs-focus-width",
    "--rs-focus-offset",
    "--rs-duration-fast",
    "--rs-duration-base",
    "--rs-duration-slow",
    "--rs-ease-standard",
    "--rs-ease-exit",
    "--rs-density-text",
    "--rs-density-gap",
    "--rs-density-pad",
    "--rs-density-section",
    "--rs-density-control",
    "--rs-density-cell-block",
    "--rs-density-cell-inline",
    "--rs-density-display",
  ]) {
    assert.ok(tokens.has(name), `missing token ${name}`);
  }
  // One namespace, and no reference to a property that is never set or
  // property that is set and never read.
  const set = new Set(
    styleRules.flatMap((rule) =>
      rule.declarations
        .map(([property]) => property)
        .filter((property) => property.startsWith("--")),
    ),
  );
  const readNames = new Set(
    [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]),
  );
  for (const name of set) {
    assert.match(name, /^--rs-[a-z0-9-]+$/, name);
    assert.ok(readNames.has(name), `${name} is set and never used`);
  }
  for (const name of readNames) {
    assert.ok(set.has(name), `${name} is used and never set`);
  }
  // References carry no fallback that could hide a missing token.
  assert.doesNotMatch(css, /var\([^)]*,/);
  // The spacing rhythm rises step by step.
  const spacing = Array.from({ length: 9 }, (_, step) =>
    rem(token(`--rs-space-${step + 1}`)),
  );
  assert.deepEqual(spacing, [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6]);
  // Every color token is a six-digit hex value, so each can be measured.
  const colorTokens = [...tokens].filter(([name]) =>
    name.startsWith("--rs-color-"),
  );
  assert.ok(colorTokens.length >= 30);
  for (const [name, value] of colorTokens) {
    assert.match(value, /^#[0-9a-f]{6}$/, name);
  }
  // Primitives take their lengths, colors, and timing from tokens: outside
  // the token block no color literal is written except the layer scrims,
  // and no color is written by name anywhere.
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (
        /^(?:background|color|border|outline|fill|stroke|accent-color|text-decoration|box-shadow|caret-color)/.test(
          property,
        )
      ) {
        assert.doesNotMatch(
          value.replace(/var\([^)]*\)/g, ""),
          /\b(?:black|white|gr[ae]y|red|green|blue|navy|maroon|brown|gold|silver|orange|yellow|purple|beige|ivory|tan|khaki|wheat|linen|bisque|sienna|peru|chocolate|goldenrod)\b/i,
          `${rule.prelude} ${property}: ${value}`,
        );
      }
    }
  }
  for (const rule of styleRules) {
    if (rule.selectors.includes(":root") && rule.selectors.length === 1) {
      continue;
    }
    for (const [property, value] of rule.declarations) {
      assert.doesNotMatch(
        value,
        /#[0-9a-f]{3,8}\b/i,
        `${rule.prelude} ${property}`,
      );
      if (/rgb|hsl|oklch|oklab|lab\(|lch\(|color\(/.test(value)) {
        assert.match(
          rule.prelude,
          /^\.rs-dialog::backdrop$|^\.rs-media\[data-overlay="(?:scrim|veil)"\]::after$|^\.rs-media__caption$/,
          `${rule.prelude} ${property}: ${value}`,
        );
        assert.match(value, /rgb\(31 20 14 \/ 0(?:\.\d+)?\)/, value);
      }
    }
  }
});

test("5. typography pairs a selective system serif with a system sans", () => {
  const systemSerif = [
    "ui-serif",
    "Iowan Old Style",
    "Palatino Linotype",
    "Palatino",
    "Book Antiqua",
    "Georgia",
    "Times New Roman",
    "serif",
  ];
  const systemSans = [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "Noto Sans",
    "sans-serif",
  ];
  const families = (name) =>
    token(name)
      .split(",")
      .map((family) => family.trim().replace(/^"|"$/g, ""));
  // Installed system families only, each stack ending in its generic family.
  assert.deepEqual(families("--rs-font-display"), systemSerif);
  assert.deepEqual(families("--rs-font-ui"), systemSans);
  assert.doesNotMatch(
    stylesheet,
    /@font-face|(?<![a-z-])font-display\s*:|\.woff|\.ttf|\.otf/i,
  );
  // Every font-family declaration is one of the two stacks.
  const familyRules = styleRules.flatMap((rule) =>
    rule.declarations
      .filter(([property]) => property === "font-family" || property === "font")
      .map(([, value]) => [rule.prelude, value]),
  );
  for (const [prelude, value] of familyRules) {
    assert.match(
      value,
      /^(?:var\(--rs-font-display\)|var\(--rs-font-ui\)|inherit)$/,
      prelude,
    );
  }
  // The serif is selective: the display heading, the major section heading,
  // the dialog title, and a bare first-level heading. Nothing else.
  assert.deepEqual(
    familyRules
      .filter(([, value]) => value === "var(--rs-font-display)")
      .map(([prelude]) => prelude)
      .sort(),
    [
      ".rs-dialog__title",
      ".rs-display",
      '.rs-heading[data-size="lg"]',
      "main > h1:not([class])",
    ],
  );
  // The display heading renders the element its caller names, a first-level
  // heading by default, and the section heading a second-level one.
  assert.match(
    componentSource("Display"),
    /^export function Display\(\{ as: Element = "h1", children \}: DisplayProps\) \{\n {2}return <Element className="rs-display">\{children\}<\/Element>;\n\}\n/,
  );
  assert.match(
    componentSource("Heading"),
    /as: Element = "h2",\n {2}size = "md",\n {2}id,\n {2}children,\n\}: HeadingProps\) \{\n {2}return \(\n {4}<Element className="rs-heading" data-size=\{size\} id=\{id\}>\n {6}\{children\}\n {4}<\/Element>/,
  );
  assert.match(
    moduleCode,
    /^type HeadingElement = "h1" \| "h2" \| "h3" \| "h4";$/m,
  );
  // Functional interface text is sans: the document, headings by default,
  // and controls, which inherit it.
  assert.equal(declared("html").get("font-family"), "var(--rs-font-ui)");
  assert.equal(declared("h1").get("font-family"), "var(--rs-font-ui)");
  assert.equal(declared(".rs-button").get("font-family"), "var(--rs-font-ui)");
  assert.equal(declared("button").get("font"), "inherit");
  for (const selector of [
    ".rs-control",
    ".rs-table",
    ".rs-status",
    ".rs-field__label",
    ".rs-alert",
    ".rs-eyebrow",
    ".rs-text",
  ]) {
    assert.equal(declared(selector).has("font-family"), false, selector);
  }
  // A strong scale: nothing smaller than 13px, default body text of at least
  // 16px (tests 8 and 11 bound the dense contexts), and display sizes well
  // clear of the headings.
  const scale = [
    "--rs-text-xs",
    "--rs-text-sm",
    "--rs-text-base",
    "--rs-text-md",
    "--rs-text-lg",
    "--rs-text-xl",
  ].map((name) => rem(token(name)));
  assert.deepEqual(
    scale,
    [...scale].sort((a, b) => a - b),
  );
  assert.equal(new Set(scale).size, scale.length);
  assert.ok(scale[0] >= 0.8125);
  assert.ok(rem(token("--rs-density-text")) >= 1);
  const headings = [
    "--rs-heading-sm",
    "--rs-heading-md",
    "--rs-heading-lg",
    "--rs-display-md",
    "--rs-display-lg",
  ];
  for (const bound of ["min", "max"]) {
    const sizes = headings.map((name) => rem(token(name), bound));
    assert.deepEqual(
      sizes,
      [...sizes].sort((a, b) => a - b),
      bound,
    );
  }
  assert.ok(rem(token("--rs-display-lg")) >= 5);
  assert.ok(rem(token("--rs-display-lg"), "min") >= 2.5);
  assert.ok(rem(token("--rs-heading-lg")) >= 2.5);
  // No font size is written outside the scale.
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (property === "font-size") {
        assert.match(value, /^(?:var\(--rs-[a-z-]+\)|100%)$/, rule.prelude);
      }
    }
  }
});

test("6. the palette is cream and warm white first, with strategic dark and readable contrast", () => {
  const color = (name, ...scopes) => token(name, ...scopes);
  const cocoa = color("--rs-color-deep-cocoa");
  const chocolate = color("--rs-color-chocolate");
  const cream = color("--rs-color-cream");
  const warmWhite = color("--rs-color-warm-white");
  const gold = color("--rs-color-premium-gold");
  // Two warm darks, two warm lights, and a mid-tone gold between them.
  assert.ok(luminance(cocoa) < luminance(chocolate));
  assert.ok(luminance(chocolate) < 0.05);
  assert.ok(luminance(cream) > 0.8);
  assert.ok(luminance(warmWhite) > luminance(cream));
  assert.ok(luminance(gold) > 0.2 && luminance(gold) < 0.45);
  for (const warm of [cocoa, chocolate, cream, warmWhite, gold]) {
    const [red, green, blue] = [1, 3, 5].map((start) =>
      parseInt(warm.slice(start, start + 2), 16),
    );
    assert.ok(red > green && green > blue, `${warm} is not a warm tone`);
  }
  // The application background is cream; content surfaces, tables, dialogs,
  // and controls are warm white.
  assert.equal(declared("html").get("background"), "var(--rs-color-cream)");
  for (const selector of [
    ".rs-surface",
    ".rs-table-region",
    ".rs-dialog",
    ".rs-control",
    ".rs-choice",
  ]) {
    assert.equal(
      declared(selector).get("background"),
      "var(--rs-color-warm-white)",
      selector,
    );
  }
  // Dark is opt-in. Every background is resolved in the light context and
  // measured: only the two dark surface tones, the layer scrims, and the
  // media frame with its caption band are dark.
  const lightScopes = [declared(".rs-status"), declared(".rs-surface")];
  const isDark = (value) =>
    /rgb\(31 20 14 \/ 0?\.[1-9]/.test(value) ||
    [...value.matchAll(/var\((--rs-[a-z0-9-]+)\)/g)]
      .map((match) => token(match[1], ...lightScopes))
      .some((color) => luminance(color) < 0.08);
  const darkBackgrounds = styleRules
    .filter((rule) =>
      rule.declarations.some(
        ([property, value]) =>
          /^background(?:-color)?$/.test(property) && isDark(value),
      ),
    )
    .map((rule) => `${rule.within} ${rule.prelude}`.trim())
    .sort();
  assert.deepEqual(darkBackgrounds, [
    ".rs-dialog::backdrop",
    ".rs-media",
    '.rs-media[data-overlay="scrim"]::after',
    '.rs-media[data-overlay="veil"]::after',
    ".rs-media__caption",
    '.rs-surface[data-tone="dark"]',
    '@media (min-width: 40rem) .rs-surface[data-tone="chocolate"]',
  ]);
  // The measure itself tells dark from light and from the mid-tone fills.
  for (const [name, expected] of [
    ["--rs-color-deep-cocoa", true],
    ["--rs-color-chocolate", true],
    ["--rs-color-ink", true],
    ["--rs-color-well-on-dark", true],
    ["--rs-color-gold-deep", false],
    ["--rs-color-information", false],
    ["--rs-color-cream", false],
  ]) {
    assert.equal(isDark(`var(${name})`), expected, name);
  }
  // The generic Surface renders the tone, emphasis, and density its caller
  // chooses, and defaults to the light, flat treatment.
  const surface = componentSource("Surface");
  assert.match(
    surface,
    /<Element\s+className="rs-surface"\s+data-tone=\{tone\}\s+data-emphasis=\{emphasis\}\s+data-density=\{density\}\s+aria-labelledby=\{labelledBy\}\s*>\s*\{children\}\s*<\/Element>/,
  );
  assert.match(surface, /tone = "light",\s+emphasis = "flat",\s+density,/);
  assert.match(
    moduleCode,
    /readonly tone\?: "light" \| "cream" \| "dark" \| "chocolate";\n {2}readonly emphasis\?: "flat" \| "raised" \| "selected";\n {2}readonly density\?: Density;/,
  );
  for (const selector of [
    '.rs-surface[data-tone="cream"]',
    '.rs-surface[data-tone="dark"]',
    '.rs-surface[data-tone="chocolate"]',
    '.rs-surface[data-emphasis="raised"]',
    '.rs-surface[data-emphasis="selected"]',
  ]) {
    assert.ok(rulesFor(selector).length > 0, selector);
  }

  const light = declared(".rs-surface");
  const dark = declared('.rs-surface[data-tone="dark"]');
  const chocolateWide = declared(
    '.rs-surface[data-tone="chocolate"]',
    "@media (min-width: 40rem)",
  );
  // Both dark tones, and the media frame, give the primitives inside them
  // the same context.
  assert.deepEqual(rulesFor('.rs-surface[data-tone="dark"]')[0].selectors, [
    '.rs-surface[data-tone="dark"]',
    ".rs-media",
  ]);
  const context = (scope) =>
    [...scope].filter(([property]) => property.startsWith("--rs-ctx-"));
  assert.deepEqual(context(chocolateWide), context(dark));
  assert.deepEqual(
    context(dark).map(([property]) => property),
    context(light).map(([property]) => property),
  );
  // The light context is restated by every light container.
  assert.deepEqual(rulesFor(":root")[1].selectors, [
    ":root",
    ".rs-surface",
    ".rs-dialog",
    ".rs-table-region",
    ".rs-choice",
    '.rs-alert[data-presentation="toast"]',
  ]);

  const gate = (foreground, background, minimum, label) => {
    const ratio = contrast(foreground, background);
    assert.ok(
      ratio >= minimum,
      `${label}: ${foreground} on ${background} is ${ratio.toFixed(2)}, below ${minimum}`,
    );
  };
  const lightGrounds = [warmWhite, cream, color("--rs-color-gold-tint")];
  const darkGrounds = [cocoa, chocolate];
  for (const [scope, grounds, name] of [
    [light, lightGrounds, "light"],
    [dark, darkGrounds, "dark"],
  ]) {
    // Text and glyph colors against every ground they can sit on.
    for (const role of [
      "fg",
      "muted",
      "accent",
      "success",
      "warning",
      "error",
      "information",
      "neutral",
    ]) {
      for (const ground of grounds) {
        gate(color(`--rs-ctx-${role}`, scope), ground, 4.5, `${name} ${role}`);
      }
    }
    // Semantic text on its own tinted surface, and the strong status
    // treatment, which swaps the two.
    for (const tone of tones) {
      gate(
        color(`--rs-ctx-${tone}`, scope),
        color(`--rs-ctx-${tone}-surface`, scope),
        4.5,
        `${name} ${tone} on its surface`,
      );
    }
    // The primary action label on both ends of its tonal background.
    for (const end of ["top", "bottom"]) {
      gate(
        color("--rs-ctx-action-fg", scope),
        color(`--rs-ctx-action-${end}`, scope),
        4.5,
        `${name} primary action ${end}`,
      );
    }
    // Focus rings and action outlines are distinguishable components.
    for (const ground of grounds) {
      gate(color("--rs-ctx-focus", scope), ground, 3, `${name} focus`);
      gate(color("--rs-ctx-action-line", scope), ground, 3, `${name} outline`);
    }
  }
  // Controls are warm white wells with ink text wherever they sit.
  for (const ground of [warmWhite, cream]) {
    gate(color("--rs-color-control-line"), ground, 3, "control outline");
  }
  gate(color("--rs-color-ink"), warmWhite, 7, "control text");
  gate(color("--rs-color-ink-placeholder"), warmWhite, 4.5, "placeholder");
  gate(color("--rs-color-error"), warmWhite, 4.5, "invalid outline");
  gate(color("--rs-color-on-dark"), cocoa, 7, "media caption");
});

test("7. gold is a restrained accent without gloss, bevel, or glass", () => {
  const gold = token("--rs-color-premium-gold");
  // Body and interface text is ink on light and cream on dark, never gold.
  assert.equal(declared("html").get("color"), "var(--rs-color-ink)");
  assert.equal(declared(".rs-text").get("color"), "var(--rs-ctx-fg)");
  assert.equal(
    token("--rs-ctx-fg", declared(".rs-surface")),
    token("--rs-color-ink"),
  );
  assert.equal(
    token("--rs-ctx-fg", declared('.rs-surface[data-tone="dark"]')),
    token("--rs-color-on-dark"),
  );
  // Premium gold itself draws selected edges and thin rules. It fills no
  // surface or control and colors no text.
  const uses = (reference) =>
    styleRules
      .flatMap((rule) =>
        rule.declarations
          .filter(
            ([property, value]) =>
              !property.startsWith("--") && value.includes(reference),
          )
          .map(([property]) => `${rule.prelude} ${property}`),
      )
      .sort();
  assert.deepEqual(uses("var(--rs-color-premium-gold)"), [
    ".rs-choice:has(:checked) border-color",
    ".rs-choice:has(:checked) box-shadow",
    '.rs-surface[data-emphasis="selected"] border-color',
    '.rs-surface[data-emphasis="selected"] box-shadow',
    '.rs-surface[data-tone="chocolate"][data-emphasis="selected"] border-color',
  ]);
  assert.deepEqual(uses("var(--rs-ctx-rule)"), [
    ".rs-eyebrow::after background",
    '.rs-rule[data-tone="gold"] background',
  ]);
  for (const scope of [
    declared(".rs-surface"),
    declared('.rs-surface[data-tone="dark"]'),
  ]) {
    assert.equal(token("--rs-ctx-rule", scope), gold);
  }
  // Both are hairlines: one pixel high, and short.
  assert.equal(
    declared(".rs-eyebrow::after").get("block-size"),
    "var(--rs-border-width)",
  );
  assert.equal(
    declared(".rs-rule").get("block-size"),
    "var(--rs-border-width)",
  );
  // The deeper gold steps fill only the primary action.
  assert.deepEqual(
    [
      ...uses("var(--rs-ctx-action-top)"),
      ...uses("var(--rs-ctx-action-bottom)"),
    ].filter((use) => !/^\.rs-button\[data-variant="primary"\]/.test(use)),
    [],
  );
  // Gold text is limited to the accent roles, and only through the context
  // accent, which is the deep step on light and the soft step on dark.
  const accentText = styleRules
    .filter((rule) =>
      rule.declarations.some(
        ([property, value]) =>
          property === "color" && value === "var(--rs-ctx-accent)",
      ),
    )
    .map((rule) => rule.prelude)
    .sort();
  assert.deepEqual(accentText, [
    '.rs-button[data-variant="tertiary"]',
    ".rs-disclosure__summary > .rs-icon",
    ".rs-eyebrow",
    '.rs-text[data-tone="accent"]',
    "a",
  ]);
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (property === "color") {
        assert.doesNotMatch(value, /gold/, `${rule.prelude} ${value}`);
      }
    }
  }
  // Tonal depth only: at most four gradients, each the whole value of its
  // declaration, linear, with a direction and two stops.
  const gradients = styleRules
    .flatMap((rule) => rule.declarations)
    .map(([, value]) => value)
    .filter((value) => /gradient/i.test(value));
  assert.ok(gradients.length >= 1 && gradients.length <= 4, gradients.join());
  for (const value of gradients) {
    const inner = value.match(/^linear-gradient\((.*)\)$/)?.[1];
    assert.ok(inner !== undefined, value);
    assert.doesNotMatch(inner, /gradient/i, value);
    const parts = inner.split(/,\s*(?![^(]*\))/);
    assert.equal(parts.length, 3, `a direction and two stops: ${value}`);
    assert.match(parts[0], /^\d+deg$/, value);
  }
  // No gloss, bevel, glow, glass, or blend effect.
  assert.doesNotMatch(
    css,
    /\binset\s+-?\d|text-shadow|backdrop-filter|blur\(|drop-shadow|mix-blend-mode|background-blend-mode|-webkit-box-reflect|mask-image|text-stroke|\bglow\b|\bgloss|bevel|metal/i,
  );
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (property === "filter") {
        assert.match(rule.prelude, /^\.rs-media__content > /, rule.prelude);
        assert.match(value, /^contrast\(1\.0\d\) saturate\(0\.9\d\)$/, value);
      }
    }
  }
});

test("8. the four density contexts are presentation variants that step evenly", () => {
  const variants = topLevel
    .map((rule) => rule.prelude.match(/^\[data-density="([a-z]+)"\]$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(variants, densities);
  const properties = [
    "--rs-density-text",
    "--rs-density-gap",
    "--rs-density-pad",
    "--rs-density-section",
    "--rs-density-control",
    "--rs-density-cell-block",
    "--rs-density-cell-inline",
    "--rs-density-display",
  ];
  const measured = densities.map((density) => {
    const scope = declared(`[data-density="${density}"]`);
    // A density sets spacing and scale and nothing else: no color, surface,
    // visibility, or content.
    assert.deepEqual([...scope.keys()], properties, density);
    return properties.map((property) => rem(token(property, scope)));
  });
  // The same limit holds for every density rule inside a media query.
  const densityRules = styleRules.filter((rule) =>
    /^\[data-density="/.test(rule.prelude),
  );
  assert.ok(densityRules.length >= 7);
  for (const rule of densityRules) {
    assert.ok(rule.declarations.length > 0, rule.prelude);
    for (const [property] of rule.declarations) {
      assert.ok(
        properties.includes(property),
        `${rule.within} ${rule.prelude} ${property}`,
      );
    }
  }
  // From the most generous to the most structured, no step ever grows, and
  // every measure is strictly tighter at the dense end than the open end.
  for (let step = 1; step < measured.length; step += 1) {
    measured[step].forEach((value, index) => {
      assert.ok(
        value <= measured[step - 1][index],
        `${densities[step]} ${properties[index]}`,
      );
    });
  }
  measured[0].forEach((value, index) => {
    assert.ok(value > measured.at(-1)[index], properties[index]);
  });
  // Text, gap, padding, and control size change at every step.
  for (const index of [0, 1, 2, 4]) {
    assert.equal(new Set(measured.map((row) => row[index])).size, 4);
  }
  // Even the densest context keeps readable text and usable controls.
  assert.ok(measured.at(-1)[0] >= 0.9375);
  assert.ok(measured.at(-1)[4] >= 2.5);
  // The defaults are the calm client context.
  assert.deepEqual(
    properties.map((property) => tokens.get(property)),
    properties.map((property) =>
      declared('[data-density="client"]').get(property),
    ),
  );
  // Density is selected by the data attribute alone. No selector keys a
  // density to anything but spacing, and no other attribute, class, or id
  // names a role, a person, or a record.
  for (const rule of styleRules) {
    if (/data-density/.test(rule.prelude)) {
      assert.match(
        rule.prelude,
        /^\[data-density(?:="(?:public|client|attorney|admin)")?\](?:, \[data-density="(?:public|client|attorney|admin)"\])*$/,
        rule.prelude,
      );
    }
    assert.doesNotMatch(
      rule.prelude,
      /#[a-z]|\[(?:data-(?:role|state|status|user|record|plan|tier)|role=|href|name=|value=)/i,
      rule.prelude,
    );
  }
  assert.deepEqual(
    [
      ...new Set(
        [...css.matchAll(/\[data-([a-z-]+)/g)].map((match) => match[1]),
      ),
    ].sort(),
    [
      "align",
      "columns",
      "density",
      "emphasis",
      "gap",
      "overlay",
      "presentation",
      "ratio",
      "size",
      "tone",
      "variant",
    ],
  );
  // In the module the density is a type and a pass-through attribute. It is
  // never compared, switched on, looked up, or given a default.
  assert.equal(
    moduleCode.match(/^export type Density = (.+);$/m)?.[1],
    densities.map((density) => `"${density}"`).join(" | "),
  );
  assert.deepEqual(
    moduleCode
      .split("\n")
      .filter((line) => /density/i.test(line))
      .map((line) => line.trim())
      .sort(),
    [
      '<div className="rs-page" data-density={density}>',
      "data-density={density}",
      "density,",
      "export function Page({ density, children }: PageProps) {",
      'export type Density = "public" | "client" | "attorney" | "admin";',
      "readonly density: Density;",
      "readonly density?: Density;",
    ],
  );
  for (const density of densities) {
    assert.equal(
      moduleCode.match(new RegExp(`\\b${density}\\b`, "g"))?.length,
      1,
      density,
    );
  }
});

test("9. keyboard focus is always visible", () => {
  const focus = declared(":focus-visible");
  assert.equal(
    focus.get("outline"),
    "var(--rs-focus-width) solid var(--rs-ctx-focus)",
  );
  assert.equal(focus.get("outline-offset"), "var(--rs-focus-offset)");
  assert.ok(rem(token("--rs-focus-width")) * 16 >= 2);
  assert.ok(rem(token("--rs-focus-offset")) * 16 >= 1);
  // Only three rules touch the outline at all: the shared ring, the ring of
  // a choice, and the native input inside a choice.
  const outlined = styleRules
    .filter((rule) =>
      rule.declarations.some(([property]) =>
        /^outline(?:-style|-width|-color)?$/.test(property),
      ),
    )
    .map((rule) => `${rule.within} ${rule.prelude}`.trim());
  assert.deepEqual(outlined, [
    ":focus-visible",
    ".rs-choice:has(:focus-visible)",
    "@supports selector(:has(*)) .rs-choice__input:focus-visible",
  ]);
  // The outline is removed or hidden in exactly one place, the native input
  // inside a choice, and only where :has() lets the ring be drawn around the
  // whole choice instead.
  const removed = styleRules
    .filter((rule) =>
      rule.declarations.some(
        ([property, value]) =>
          /^outline(?:-style|-width|-color)?$/.test(property) &&
          /(?:^|\s)(?:none|hidden|transparent|0(?:px|rem|em)?)(?:\s|$)/.test(
            value,
          ),
      ),
    )
    .map((rule) => `${rule.within} ${rule.prelude}`.trim());
  assert.deepEqual(removed, [
    "@supports selector(:has(*)) .rs-choice__input:focus-visible",
  ]);
  assert.equal(rulesFor(".rs-choice__input:focus-visible").length, 0);
  // A light container that takes focus itself draws the ring inside its own
  // light ground, so the ring stays visible when it sits on a dark surface.
  const inside = "calc(-1 * var(--rs-focus-width))";
  assert.deepEqual(
    [...declared(".rs-choice:has(:focus-visible)")],
    [
      ["outline", "var(--rs-focus-width) solid var(--rs-ctx-focus)"],
      ["outline-offset", inside],
    ],
  );
  for (const selector of [
    ".rs-table-region:focus-visible",
    ".rs-dialog:focus-visible",
  ]) {
    assert.deepEqual([...declared(selector)], [["outline-offset", inside]]);
  }
  // Those are exactly the focusable containers that restate the light
  // context, and their ring is readable on their own warm white ground.
  assert.ok(
    contrast(
      token("--rs-ctx-focus", declared(".rs-surface")),
      token("--rs-color-warm-white"),
    ) >= 3,
  );
  // No other rule moves the ring.
  assert.deepEqual(
    styleRules
      .filter((rule) =>
        rule.declarations.some(([property]) => property === "outline-offset"),
      )
      .map((rule) => rule.prelude),
    [
      ":focus-visible",
      ".rs-choice:has(:focus-visible)",
      ".rs-table-region:focus-visible, .rs-dialog:focus-visible",
    ],
  );
  // Focus is never styled through :focus alone, which would also ring on
  // pointer use or tempt its removal.
  assert.doesNotMatch(css, /:focus(?!-visible)/);
  // A scrolling table region can be reached and scrolled from the keyboard.
  assert.match(componentSource("Table"), /role="region"[\s\S]*tabIndex=\{0\}/);
  // Nothing in the module takes focus away or reorders it.
  assert.doesNotMatch(
    moduleCode,
    /tabIndex=\{(?!0\})|autoFocus|\.focus\(|\.blur\(/,
  );
});

test("10. motion is subtle, purposeful, and yields to reduced-motion preferences", () => {
  // No animation at all, so nothing moves on its own or repeats.
  assert.doesNotMatch(
    css,
    /@keyframes|\banimation(?:-name)?\s*:|\binfinite\b|marquee|\bblink\b/i,
  );
  const durations = ["fast", "base", "slow"].map((step) =>
    milliseconds(token(`--rs-duration-${step}`)),
  );
  assert.deepEqual(
    durations,
    [...durations].sort((a, b) => a - b),
  );
  assert.ok(durations[0] >= 80 && durations.at(-1) <= 400);
  for (const easing of ["--rs-ease-standard", "--rs-ease-exit"]) {
    const points = token(easing).match(
      /^cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)$/,
    );
    assert.ok(points, easing);
    // No overshoot or bounce.
    for (const point of points.slice(1)) {
      assert.ok(Number(point) >= 0 && Number(point) <= 1, easing);
    }
  }
  // Every transition names its properties and takes its timing from tokens.
  const transitions = styleRules.flatMap((rule) =>
    rule.declarations
      .filter(([property]) => property === "transition")
      .map(([, value]) => [rule.prelude, value]),
  );
  assert.ok(transitions.length >= 6);
  for (const [prelude, value] of transitions) {
    for (const part of value.split(/,\s*(?![^(]*\))/)) {
      assert.match(
        part,
        /^(?:background-color|border-color|box-shadow|color|opacity|transform) var\(--rs-duration-(?:fast|base|slow)\) var\(--rs-ease-(?:standard|exit)\)$|^(?:overlay|display) var\(--rs-duration-slow\) allow-discrete$/,
        `${prelude}: ${part}`,
      );
    }
  }
  // A transition longhand can only choose one of the two easings.
  for (const rule of styleRules) {
    if (rule.within === "@media (prefers-reduced-motion: reduce)") continue;
    for (const [property, value] of rule.declarations) {
      if (/^transition-/.test(property)) {
        assert.equal(property, "transition-timing-function", rule.prelude);
        assert.match(value, /^var\(--rs-ease-(?:standard|exit)\)$/, value);
      }
    }
  }
  // Movement is small: a one pixel press and a short dialog rise.
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (property === "transform") {
        assert.match(
          value,
          /^(?:none|translateY\((?:1px|-50%|var\(--rs-space-2\))\)|rotate\(180deg\))$/,
          `${rule.prelude}: ${value}`,
        );
      }
    }
  }
  // Open and close transitions for the dialog are CSS only.
  assert.ok(rulesFor(".rs-dialog[open]", "@starting-style").length === 1);
  // Reduced motion removes transition time and the press and rise movement.
  const reduced = "@media (prefers-reduced-motion: reduce)";
  assert.deepEqual(
    [...declared("*", reduced)],
    [
      ["scroll-behavior", "auto !important"],
      ["transition-duration", "0.01ms !important"],
      ["transition-delay", "0s !important"],
      ["animation-duration", "0.01ms !important"],
      ["animation-delay", "0s !important"],
      ["animation-iteration-count", "1 !important"],
    ],
  );
  assert.deepEqual(rulesFor("*", reduced)[0].selectors, [
    "*",
    "*::before",
    "*::after",
  ]);
  assert.equal(declared(".rs-dialog", reduced).get("transform"), "none");
  assert.equal(declared(".rs-button:active", reduced).get("transform"), "none");
  // !important appears nowhere else.
  for (const rule of styleRules) {
    if (rule.within === reduced && rule.selectors.includes("*")) continue;
    for (const [, value] of rule.declarations) {
      assert.doesNotMatch(value, /!important/, rule.prelude);
    }
  }
  // The module schedules and animates nothing.
  assert.doesNotMatch(
    moduleCode,
    /setTimeout|setInterval|requestAnimationFrame|queueMicrotask|\.animate\(|startViewTransition/,
  );
});

test("11. layouts are mobile first, touch friendly, and lighter in dark surface when narrow", () => {
  assert.deepEqual(
    tree.filter((rule) => rule.rules !== undefined).map((rule) => rule.prelude),
    [
      "@supports selector(:has(*))",
      "@starting-style",
      "@media (min-width: 40rem)",
      "@media (min-width: 64rem)",
      "@media (max-width: 39.9375rem)",
      "@media (pointer: coarse)",
      "@media (prefers-reduced-motion: reduce)",
    ],
  );
  const narrow = "@media (max-width: 39.9375rem)";
  const medium = "@media (min-width: 40rem)";
  const wide = "@media (min-width: 64rem)";
  // One column by default; columns appear only from the medium breakpoint.
  assert.equal(
    declared(".rs-columns").get("grid-template-columns"),
    "minmax(0, 1fr)",
  );
  assert.equal(
    rulesFor('.rs-columns[data-columns="3"]', wide)[0].declarations[0][1],
    "repeat(3, minmax(0, 1fr))",
  );
  assert.equal(
    styleRules.filter(
      (rule) => rule.within === "" && /rs-columns\[/.test(rule.prelude),
    ).length,
    0,
  );
  // The page never exceeds the viewport, and a wide table scrolls inside
  // its own region instead of the page.
  assert.match(declared(".rs-page").get("inline-size"), /^min\(100% - /);
  assert.equal(declared(".rs-table-region").get("overflow-x"), "auto");
  assert.equal(declared(".rs-table-region").get("max-inline-size"), "100%");
  // Narrow screens lower the density of the two dense contexts and keep
  // their controls touch sized.
  for (const density of ["attorney", "admin"]) {
    const base = declared(`[data-density="${density}"]`);
    const relaxed = declared(`[data-density="${density}"]`, narrow);
    assert.ok(relaxed.size >= 3, density);
    // What the narrow rule leaves unset falls back to the density's own
    // value, as it does in the cascade.
    for (const property of [
      "--rs-density-text",
      "--rs-density-control",
      "--rs-density-cell-block",
    ]) {
      assert.ok(
        rem(token(property, relaxed, base)) >= rem(token(property, base)),
        `${density} ${property}`,
      );
    }
    assert.ok(
      rem(token("--rs-density-control", relaxed, base)) >= 2.75,
      density,
    );
    assert.ok(rem(token("--rs-density-text", relaxed, base)) >= 1, density);
  }
  // The open public composition simplifies instead of growing.
  const publicNarrow = declared('[data-density="public"]', narrow);
  const publicBase = declared('[data-density="public"]');
  assert.ok(publicNarrow.size >= 3);
  for (const [property] of publicNarrow) {
    assert.ok(
      rem(token(property, publicNarrow)) < rem(token(property, publicBase)),
      property,
    );
  }
  assert.ok(
    rem(token("--rs-density-control", publicNarrow, publicBase)) >= 2.75,
  );
  // Actions stack at full width in markup order, so the action the caller
  // places first is the first one reached. Nothing reorders content.
  assert.deepEqual(
    [...declared(".rs-cluster:has(> .rs-button)", narrow)],
    [
      ["flex-direction", "column"],
      ["align-items", "stretch"],
    ],
  );
  assert.doesNotMatch(
    css,
    /\border\s*:|row-reverse|column-reverse|direction\s*:\s*rtl/,
  );
  assert.equal(
    declared(".rs-dialog", narrow).get("grid-template-columns"),
    "minmax(0, 1fr)",
  );
  assert.equal(
    declared(".rs-dialog").get("grid-template-columns"),
    "minmax(0, 1fr) auto",
  );
  // In the dialog the primary action area precedes the dismissal path.
  const dialogActions = declared(".rs-dialog__actions");
  assert.equal(dialogActions.get("grid-column"), "1");
  assert.equal(declared(".rs-dialog__dismissal").get("grid-column"), "2");
  // Touch targets are at least 44px on coarse pointers in every density.
  const coarse = rulesFor(".rs-button", "@media (pointer: coarse)")[0];
  assert.deepEqual(coarse.selectors, [
    ".rs-button",
    ".rs-control",
    ".rs-choice",
    ".rs-disclosure__summary",
    "main > button:not([class])",
  ]);
  assert.deepEqual(coarse.declarations, [
    ["min-block-size", "max(var(--rs-density-control), 2.75rem)"],
  ]);
  for (const selector of coarse.selectors) {
    assert.equal(
      declared(selector).get("min-block-size"),
      "var(--rs-density-control)",
      selector,
    );
  }
  // Content that a boundary renders bare is offset from the top by looking
  // at what precedes it, not at its position, because a streamed fallback
  // follows a template element.
  assert.deepEqual(
    [
      ...declared(
        "main > :where(h1, p):not([class]):not(:where(h1, p, a, button) ~ *)",
      ),
    ],
    [["margin-block-start", "var(--rs-space-8)"]],
  );
  assert.doesNotMatch(css, /main >[^{]*:first-child/);
  // The bare link of a boundary is a block-level touch target as well.
  assert.deepEqual(
    [...declared("main > a:not([class])", "@media (pointer: coarse)")],
    [
      ["display", "flex"],
      ["align-items", "center"],
      ["min-block-size", "2.75rem"],
    ],
  );
  // The supporting dark tone is a light panel until the medium breakpoint,
  // so a narrow screen shows less dark surface.
  const chocolateBase = declared('.rs-surface[data-tone="chocolate"]');
  assert.equal(chocolateBase.has("background"), false);
  assert.equal(
    [...chocolateBase.keys()].some((property) =>
      property.startsWith("--rs-ctx-"),
    ),
    false,
  );
  assert.equal(
    declared('.rs-surface[data-tone="chocolate"]', medium).get("background"),
    "var(--rs-color-chocolate)",
  );
  assert.equal(
    rulesFor('.rs-surface[data-tone="chocolate"]', narrow).length,
    0,
  );
  // Media crops to a compact ratio when narrow.
  assert.equal(declared(".rs-media", narrow).get("aspect-ratio"), "4 / 3");
  // Viewport units never size text on their own, so zoom keeps working:
  // a fluid size is always a clamp around a rem base.
  for (const [name, value] of tokens) {
    if (
      /^--rs-(?:text|heading|display)-/.test(name) &&
      /v[wh]|vmin|vmax/.test(value)
    ) {
      assert.match(
        value,
        /^clamp\([\d.]+rem, [\d.]+rem \+ [\d.]+vw, [\d.]+rem\)$/,
        name,
      );
    }
  }
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (property === "font-size" || property === "font") {
        assert.doesNotMatch(value, /v[wh]|vmin|vmax/, rule.prelude);
      }
    }
  }
});

test("12. rounding is moderate and elevation is restrained", () => {
  const radii = ["sm", "md", "lg"].map((size) =>
    rem(token(`--rs-radius-${size}`)),
  );
  assert.deepEqual(
    radii,
    [...radii].sort((a, b) => a - b),
  );
  assert.ok(radii[0] >= 0.25 && radii.at(-1) <= 1);
  // No pill or circle: every radius is one of the three tokens.
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (/radius/.test(property) && !property.startsWith("--")) {
        assert.match(value, /^var\(--rs-radius-(?:sm|md|lg)\)$/, rule.prelude);
      }
    }
  }
  assert.doesNotMatch(css, /9999|999px|100vmax|border-radius:\s*\d{3,}/);
  assert.equal(
    [...tokens.keys()].filter((name) => name.startsWith("--rs-radius-")).length,
    3,
  );
  // Three soft shadows, each a downward, low-opacity, warm-dark layer.
  const shadows = ["1", "2", "3"].map((level) => token(`--rs-shadow-${level}`));
  let previousReach = 0;
  for (const shadow of shadows) {
    const layers = shadow.split(/,\s*(?![^(]*\))/);
    assert.ok(layers.length <= 2, shadow);
    for (const layer of layers) {
      const parts = layer.match(
        /^0 (\d+)px (\d+)px(?: (-?\d+)px)? rgb\(31 20 14 \/ (0\.\d+)\)$/,
      );
      assert.ok(parts, `unexpected shadow layer: ${layer}`);
      assert.ok(Number(parts[4]) <= 0.25, layer);
      assert.ok(Number(parts[3] ?? 0) <= 0, layer);
    }
    const reach = Number(layers[0].match(/^0 (\d+)px/)[1]);
    assert.ok(reach > previousReach, shadow);
    previousReach = reach;
  }
  // Shadows come from the tokens, or draw a one pixel selection or state
  // ring. Nothing is lifted by default: a surface is flat until asked.
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (property === "box-shadow") {
        assert.match(
          value,
          /^(?:none|var\(--rs-shadow-[123]\)|0 0 0 var\(--rs-border-width\) var\(--rs-color-[a-z-]+\)(?:, var\(--rs-shadow-1\))?)$/,
          `${rule.prelude}: ${value}`,
        );
      }
    }
  }
  assert.equal(declared(".rs-surface").has("box-shadow"), false);
  assert.equal(
    declared('.rs-surface[data-emphasis="raised"]').get("box-shadow"),
    "var(--rs-shadow-2)",
  );
  assert.equal(declared(".rs-dialog").get("box-shadow"), "var(--rs-shadow-3)");
  // Refined one pixel borders, with one heavier accent edge.
  assert.equal(token("--rs-border-width"), "1px");
  assert.ok(rem(token("--rs-border-accent-width")) * 16 <= 4);
  for (const rule of styleRules) {
    for (const [property, value] of rule.declarations) {
      if (/^border(?:-(?:block|inline)(?:-(?:start|end))?)?$/.test(property)) {
        assert.match(
          value,
          /^(?:0|var\(--rs-border(?:-accent)?-width\) solid var\(--rs-[a-z-]+\))$/,
          `${rule.prelude} ${property}: ${value}`,
        );
      }
    }
  }
  // Surfaces are distinguished from the cream canvas by a line as well as
  // by tone, so the result is not flat beige on beige.
  assert.match(
    declared(".rs-surface").get("border"),
    /solid var\(--rs-ctx-line\)$/,
  );
  assert.notEqual(token("--rs-color-warm-white"), token("--rs-color-cream"));
  assert.ok(
    contrast(token("--rs-color-line-strong"), token("--rs-color-cream")) >
      contrast(token("--rs-color-line"), token("--rs-color-cream")),
  );
});

test("13. buttons have a primary, secondary, and tertiary hierarchy with every state", () => {
  assert.match(
    moduleCode,
    /^type ButtonVariant = "primary" \| "secondary" \| "tertiary";$/m,
  );
  // Secondary is the base treatment; primary and tertiary restyle it.
  const base = declared(".rs-button");
  const primary = declared('.rs-button[data-variant="primary"]');
  const tertiary = declared('.rs-button[data-variant="tertiary"]');
  assert.equal(base.get("background"), "var(--rs-ctx-quiet-bg)");
  assert.match(base.get("border"), /solid var\(--rs-ctx-action-line\)$/);
  assert.match(
    primary.get("background"),
    /^linear-gradient\(180deg, var\(--rs-ctx-action-top\), var\(--rs-ctx-action-bottom\)\)$/,
  );
  // A solid color sits under the gradient, declared after it, so that
  // hover never passes through a transparent fill.
  assert.deepEqual(
    [...primary.keys()].filter((property) => /^background/.test(property)),
    ["background", "background-color"],
  );
  assert.equal(primary.get("background-color"), "var(--rs-ctx-action-bottom)");
  assert.equal(primary.get("color"), "var(--rs-ctx-action-fg)");
  assert.equal(tertiary.get("background"), "transparent");
  assert.equal(tertiary.get("border-color"), "transparent");
  // The three levels differ in fill, so hierarchy does not rest on hue.
  assert.equal(
    new Set([base, primary, tertiary].map((rule) => rule.get("background")))
      .size,
    3,
  );
  const enabled = ':where(:not(:disabled, [aria-disabled="true"]))';
  for (const variant of [
    "",
    '[data-variant="primary"]',
    '[data-variant="tertiary"]',
  ]) {
    const hover = declared(`.rs-button${variant}:hover${enabled}`);
    assert.ok(hover.size >= 2, `hover ${variant}`);
    // Hover changes something the resting state sets.
    const resting = variant === "" ? base : declared(`.rs-button${variant}`);
    assert.ok(
      [...hover].some(([property, value]) => resting.get(property) !== value),
      `hover ${variant}`,
    );
  }
  for (const variant of ["", '[data-variant="primary"]']) {
    assert.ok(
      declared(`.rs-button${variant}:active${enabled}`).size >= 1,
      variant,
    );
  }
  assert.equal(
    declared(`.rs-button:active${enabled}`).get("transform"),
    "translateY(1px)",
  );
  // Disabled is visible and inert: hover and pressed styles never apply.
  const disabled = rulesFor(".rs-button:disabled")[0];
  assert.deepEqual(disabled.selectors, [
    ".rs-button:disabled",
    '.rs-button[aria-disabled="true"]',
    "main > button:not([class]):disabled",
  ]);
  assert.deepEqual(disabled.declarations, [
    ["box-shadow", "none"],
    ["cursor", "not-allowed"],
    ["opacity", "0.5"],
  ]);
  for (const rule of styleRules) {
    if (
      /\.rs-button.*:(?:hover|active)/.test(rule.prelude) &&
      rule.within === ""
    ) {
      for (const selector of rule.selectors) {
        assert.match(selector, /:where\(:not\(:disabled/, selector);
      }
    }
  }
  // Focus comes from the shared focus-visible ring, which no button rule
  // overrides.
  for (const rule of styleRules) {
    if (/rs-button/.test(rule.prelude)) {
      assert.equal(
        rule.declarations.some(([property]) => /^outline/.test(property)),
        false,
        rule.prelude,
      );
    }
  }
  // Size follows density and the label stays legible.
  assert.equal(base.get("min-block-size"), "var(--rs-density-control)");
  assert.equal(base.get("font-size"), "var(--rs-text-base)");
  assert.equal(base.get("border-radius"), "var(--rs-radius-md)");
  // The caller owns the variant, purpose, and type. A native button is
  // rendered, it never submits unless the caller says so, and the module
  // attaches no handler of its own.
  const button = componentSource("Button");
  assert.match(
    button,
    /\{\s*variant,\s*type = "button",\s*children,\s*\.\.\.native\s*\}: ButtonProps/,
  );
  assert.match(
    button,
    /<button\s+\{\.\.\.native\}\s+className="rs-button"\s+data-variant=\{variant\}\s+type=\{type\}\s*>/,
  );
  const link = componentSource("ButtonLink");
  assert.match(
    link,
    /<a \{\.\.\.native\} className="rs-button" data-variant=\{variant\} href=\{href\}>/,
  );
  assert.doesNotMatch(moduleCode, /variant = "/);
  assert.doesNotMatch(moduleCode, /\bon[A-Z][A-Za-z]+=/);
});

test("14. form primitives present labels, hints, groups, and caller messages only", () => {
  for (const name of ["TextField", "TextAreaField", "SelectField"]) {
    const source = componentSource(name);
    // Each control is labelled, described by its hint and messages, and
    // marked invalid only when the caller supplies messages.
    assert.match(
      source,
      /<FieldFrame id=\{id\} label=\{label\} hint=\{hint\} errors=\{errors\}>/,
      name,
    );
    assert.match(source, /className="rs-control"/, name);
    assert.match(source, /\bid=\{id\}/, name);
    assert.match(
      source,
      /aria-describedby=\{describedBy\(id, hint, presented\)\}/,
      name,
    );
    assert.match(
      source,
      /aria-invalid=\{presented\.length > 0 \? true : undefined\}/,
      name,
    );
    assert.match(source, /const presented = messagesOf\(errors\);/, name);
  }
  assert.match(componentSource("TextField"), /<input\s/);
  assert.match(componentSource("TextAreaField"), /<textarea\s/);
  assert.match(
    componentSource("SelectField"),
    /<select\s[\s\S]*\{children\}\s*<\/select>/,
  );
  const frame = moduleCode.slice(
    moduleCode.indexOf("function FieldFrame("),
    moduleCode.indexOf("type Described"),
  );
  assert.match(
    frame,
    /<label className="rs-field__label" htmlFor=\{id\}>\s*\{label\}\s*<\/label>/,
  );
  assert.match(
    frame,
    /\{present\(hint\) \? \(\s*<p className="rs-field__hint" id=\{`\$\{id\}-hint`\}>/,
  );
  // A control is described by its hint only when the hint is rendered, and
  // a group by its hint only when both the id and the hint are given.
  assert.match(
    moduleCode,
    /if \(present\(hint\)\) \{\n {4}ids\.push\(`\$\{id\}-hint`\);\n {2}\}\n {2}if \(messages\.length > 0\) \{\n {4}ids\.push\(`\$\{id\}-errors`\);/,
  );
  assert.match(
    componentSource("FieldGroup"),
    /const hintId = id !== undefined && present\(hint\) \? `\$\{id\}-hint` : undefined;/,
  );
  // An optional slot that holds nothing renders nothing: undefined, null,
  // false, and the empty string are all absent.
  assert.match(
    moduleCode,
    /function present\(node: ReactNode\): boolean \{\n {2}return node !== undefined && node !== null && node !== false && node !== "";\n\}/,
  );
  assert.doesNotMatch(
    moduleCode,
    /\b(?:hint|title|caption) (?:===|!==) undefined/,
  );
  assert.match(
    frame,
    /<ul className="rs-field__errors" id=\{`\$\{id\}-errors`\}>/,
  );
  // A message is text beside a glyph, in the caller's words and order.
  assert.match(
    frame,
    /presented\.map\(\(message, index\) => \(\s*<li key=\{index\}>\s*<Icon name="error" \/>\s*<span>\{message\}<\/span>\s*<\/li>\s*\)\)/,
  );
  assert.match(
    moduleCode,
    /function messagesOf\(messages: FieldMessages \| undefined\): readonly string\[\] \{\n {2}if \(messages === undefined\) \{\n {4}return \[\];\n {2}\}\n {2}return typeof messages === "string" \? \[messages\] : messages;\n\}/,
  );
  assert.match(
    componentSource("FieldGroup"),
    /<fieldset className="rs-fieldset" id=\{id\} aria-describedby=\{hintId\}>\s*<legend className="rs-fieldset__legend">\{legend\}<\/legend>\s*\{present\(hint\) \? \(\s*<p className="rs-field__hint" id=\{hintId\}>/,
  );
  assert.match(
    componentSource("Choice"),
    /<label className="rs-choice">\s*<input \{\.\.\.native\} className="rs-choice__input" type=\{type\} \/>/,
  );
  assert.match(
    componentSource("Disclosure"),
    /<details className="rs-disclosure" open=\{open\}>\s*<summary className="rs-disclosure__summary">/,
  );
  // The module does not validate, submit, or hold form state. The form
  // operation pattern of the application layer keeps that authority.
  assert.doesNotMatch(
    moduleCode,
    /<form\b|\baction=|formAction|onSubmit|FormData|\.test\(|\.match\(|\.exec\(|RegExp|\bpattern=|\brequired=|minLength=|maxLength=|\bvalidate|\bvalidity\b|checkValidity|useActionState|useFormStatus|useState|useReducer|defaultValue=|\bvalue=\{|\bchecked=\{/,
  );
  assert.doesNotMatch(
    moduleCode,
    /form-operation|runFormOperation|toFormAction|FormState|fieldErrors/,
  );
  // Calm, clear treatment: visible labels, quiet hints, an invalid state
  // drawn with an outline and a message, and generous field spacing.
  assert.equal(declared(".rs-field__label").get("font-weight"), "600");
  assert.equal(declared(".rs-field__hint").get("color"), "var(--rs-ctx-muted)");
  assert.equal(
    declared(".rs-field__errors").get("color"),
    "var(--rs-ctx-error)",
  );
  assert.equal(
    declared('.rs-control[aria-invalid="true"]').get("border-color"),
    "var(--rs-color-error)",
  );
  assert.ok(declared(".rs-control:hover").has("border-color"));
  assert.ok(declared(".rs-control:focus-visible").has("border-color"));
  assert.ok(declared(".rs-control:disabled").has("cursor"));
  // A disabled control or choice gives no hover feedback. The disabled rule
  // follows the hover rule and restates the resting border.
  assert.equal(
    declared(".rs-control:disabled").get("border-color"),
    declared(".rs-control").get("border").split(" solid ")[1],
  );
  assert.ok(
    topLevel.findIndex((rule) => rule.prelude === ".rs-control:disabled") >
      topLevel.findIndex((rule) => rule.prelude === ".rs-control:hover"),
  );
  assert.equal(
    rulesFor(".rs-choice:hover:where(:not(:has(:disabled)))").length,
    1,
  );
  assert.equal(rulesFor(".rs-choice:hover").length, 0);
  assert.equal(declared(".rs-fieldset").get("gap"), "var(--rs-density-gap)");
  assert.equal(
    declared(".rs-control").get("min-block-size"),
    "var(--rs-density-control)",
  );
  // Text in a control is at least 16px, so a phone does not zoom on focus.
  assert.ok(rem(resolve(declared(".rs-control").get("font-size"))) >= 1);
  // A selected choice shows a gold edge and tint as well as its native mark.
  assert.ok(declared(".rs-choice:has(:checked)").has("border-color"));
  assert.ok(declared(".rs-choice__input").has("accent-color"));
});

test("15. tables are light, aligned, and tighten with density", () => {
  const table = componentSource("Table");
  assert.match(table, /aria-labelledby=\{`\$\{id\}-caption`\}/);
  assert.match(
    table,
    /<table className="rs-table" id=\{id\}>\s*<caption className="rs-table__caption" id=\{`\$\{id\}-caption`\}>\s*\{caption\}\s*<\/caption>\s*\{children\}\s*<\/table>/,
  );
  // The caller supplies every column, row, and cell.
  assert.doesNotMatch(table, /<t(?:head|body|foot|r|h|d)\b/);
  const cells = declared(".rs-table :where(th, td)");
  assert.equal(
    cells.get("padding"),
    "var(--rs-density-cell-block) var(--rs-density-cell-inline)",
  );
  assert.equal(cells.get("text-align"), "start");
  assert.equal(
    cells.get("border-block-end"),
    "var(--rs-border-width) solid var(--rs-color-line)",
  );
  // Dividers are horizontal only, and no row is filled in alternation.
  assert.equal(declared(".rs-table").get("border-collapse"), "collapse");
  assert.doesNotMatch(
    css,
    /nth-child|nth-of-type|border-inline[^:]*:[^;]*rs-color-line\b/,
  );
  for (const rule of styleRules) {
    if (/^\.rs-table /.test(rule.prelude)) {
      assert.match(rule.prelude, /^\.rs-table :where\(/, rule.prelude);
    }
  }
  const header = declared(".rs-table :where(thead th)");
  assert.equal(header.get("font-weight"), "600");
  assert.equal(header.get("text-transform"), "uppercase");
  assert.equal(header.get("background"), "var(--rs-color-cream)");
  assert.equal(
    declared(".rs-table :where(tbody th)").get("font-weight"),
    "600",
  );
  assert.equal(
    declared('.rs-table :where([data-align="end"])').get("text-align"),
    "end",
  );
  assert.equal(
    declared(".rs-table").get("font-variant-numeric"),
    "tabular-nums",
  );
  // Rows stay comfortably tall even in the densest context.
  const admin = declared('[data-density="admin"]');
  assert.ok(rem(token("--rs-density-cell-block", admin)) >= 0.5);
  assert.ok(
    rem(token("--rs-density-cell-block", admin)) <
      rem(
        token("--rs-density-cell-block", declared('[data-density="client"]')),
      ),
  );
});

test("16. status and alerts carry caller-supplied meaning that never rests on color", () => {
  assert.equal(
    moduleCode
      .match(/^export type Tone =\s*([^;]+);$/m)?.[1]
      .replace(/\s+/g, " "),
    tones.map((tone) => `"${tone}"`).join(" | "),
  );
  // The visible text is required and rendered as given, beside a glyph.
  const status = componentSource("Status");
  assert.match(
    moduleCode,
    /type StatusProps = \{\n {2}readonly tone: Tone;\n {2}readonly emphasis\?: "subtle" \| "strong";\n {2}readonly children: ReactNode;\n\};/,
  );
  assert.match(
    status,
    /<span className="rs-status" data-tone=\{tone\} data-emphasis=\{emphasis\}>\s*<Icon name=\{TONE_ICONS\[tone\]\} \/>\s*<span>\{children\}<\/span>\s*<\/span>/,
  );
  // The tone has no default: the caller always states it.
  assert.doesNotMatch(
    moduleCode,
    /tone = "(?:success|warning|error|information|neutral)"/,
  );
  // Each semantic family has a glyph of its own shape.
  const glyphs = Object.fromEntries(
    [
      ...moduleCode
        .slice(moduleCode.indexOf("const TONE_ICONS"))
        .match(/\{([^}]*)\}/)[1]
        .matchAll(/(\w+): "(\w+)"/g),
    ].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(Object.keys(glyphs), tones);
  assert.equal(new Set(Object.values(glyphs)).size, tones.length);
  const paths = Object.fromEntries(
    [
      ...moduleCode
        .slice(
          moduleCode.indexOf("const ICON_PATHS"),
          moduleCode.indexOf("const TONE_ICONS"),
        )
        .matchAll(/(\w+):\s*"([^"]+)"/g),
    ].map((match) => [match[1], match[2]]),
  );
  const outlines = Object.values(glyphs).map(
    (name) => paths[name].split(" M")[0],
  );
  assert.equal(
    new Set(outlines).size,
    tones.length,
    "each tone has its own outline",
  );
  // The module writes no text of its own, so no status, label, or message
  // can come from anywhere but the caller. The markup of every component is
  // read with its expressions removed; what is left between two tags must
  // hold no letter or digit.
  for (const name of exportedComponents) {
    const source = componentSource(name);
    let markup = source.slice(source.indexOf("return"));
    for (let pass = 0; /\{[^{}]*\}/.test(markup); pass += 1) {
      assert.ok(pass < 16, name);
      markup = markup.replace(/\{[^{}]*\}/g, "");
    }
    assert.ok(/<[A-Za-z]/.test(markup), `${name} renders markup`);
    // Removing every expression also removes a conditional slot whole, so
    // the markup is read once more with only the innermost ones removed,
    // and a string literal may not stand in for text.
    assert.doesNotMatch(
      source.slice(source.indexOf("return")).replace(/\{[^{}]*\}/g, ""),
      />\s*[A-Za-z0-9][^<>]*</,
      name,
    );
    assert.doesNotMatch(source, />\s*\{\s*["'`]/, name);
    assert.deepEqual(
      markup
        .split(/<[^<>]*>/)
        .slice(1, -1)
        .map((text) => text.trim())
        .filter((text) => /[A-Za-z0-9]/.test(text)),
      [],
      name,
    );
  }
  const frameSource = moduleCode.slice(
    moduleCode.indexOf("function FieldFrame("),
    moduleCode.indexOf("type Described"),
  );
  assert.doesNotMatch(
    frameSource.replace(/\{[^{}]*\}/g, ""),
    />\s*[A-Za-z0-9][^<>]*</,
  );
  // Nor does it write text into an attribute that is read out or shown.
  assert.doesNotMatch(
    moduleCode,
    /\b(?:aria-label|aria-description|aria-roledescription|aria-valuetext|title|alt|placeholder|label|legend|summary|caption)="/,
  );
  assert.doesNotMatch(
    moduleCode,
    />\s*(?:Success|Warning|Error|Info|Live|Active|Pending|Approved|Verified|Available|Online|Offline|Paid|Open|Closed|Done)\b/,
  );
  // Tone sets color, tint, and line together, and the neutral family is the
  // default for both primitives.
  const families = tones.filter((tone) => tone !== "neutral");
  for (const tone of families) {
    const rule = declared(`:is(.rs-status, .rs-alert)[data-tone="${tone}"]`);
    assert.deepEqual(
      [...rule],
      [
        ["--rs-tone", `var(--rs-ctx-${tone})`],
        ["--rs-tone-surface", `var(--rs-ctx-${tone}-surface)`],
        ["--rs-tone-line", `var(--rs-ctx-${tone}-line)`],
      ],
    );
  }
  assert.equal(
    declared(".rs-status").get("--rs-tone"),
    "var(--rs-ctx-neutral)",
  );
  const badge = declared(".rs-status");
  assert.equal(badge.get("color"), "var(--rs-tone)");
  assert.equal(badge.get("background"), "var(--rs-tone-surface)");
  assert.match(badge.get("border"), /solid var\(--rs-tone-line\)$/);
  // Refined, not toy-like: a small radius rather than a pill.
  assert.equal(badge.get("border-radius"), "var(--rs-radius-sm)");
  assert.equal(badge.get("font-weight"), "600");
  // The four families are told apart in hue on both light and dark.
  for (const suffix of ["", "-on-dark"]) {
    const hues = families.map((tone) => token(`--rs-color-${tone}${suffix}`));
    assert.equal(new Set(hues).size, families.length);
  }
  // An alert shows the caller's title and message with the same glyph. It
  // announces itself only when the caller gives it a role, and the module
  // knows nothing of delivery, persistence, retries, or read state.
  const alert = componentSource("Alert");
  assert.match(alert, /<Icon name=\{TONE_ICONS\[tone\]\} \/>/);
  assert.match(alert, /<div>\{children\}<\/div>/);
  assert.match(alert, /role=\{role\}/);
  assert.match(moduleCode, /readonly role\?: "status" \| "alert";/);
  assert.doesNotMatch(
    moduleCode,
    /\bunread\b|\bread(?:At|By)\b|retry|retries|deliver|persist|\bqueue|dismissAfter|timeout|expires|\bsend\b|recipient|channel|template|subscribe/i,
  );
  const alertRule = declared(".rs-alert");
  assert.equal(alertRule.get("background"), "var(--rs-tone-surface)");
  assert.match(
    alertRule.get("border-inline-start"),
    /var\(--rs-border-accent-width\) solid var\(--rs-tone\)$/,
  );
  assert.equal(
    declared('.rs-alert[data-presentation="toast"]').get("box-shadow"),
    "var(--rs-shadow-2)",
  );
  assert.equal(declared(".rs-notification-region").get("position"), "fixed");
});

test("17. the dialog is a layered, caller-controlled frame", () => {
  const dialog = componentSource("Dialog");
  assert.match(
    dialog,
    /<dialog\s+className="rs-dialog"\s+id=\{id\}\s+data-presentation=\{presentation\}\s+open=\{open\}\s+aria-labelledby=\{`\$\{id\}-title`\}\s*>/,
  );
  assert.match(
    dialog,
    /<header className="rs-dialog__header">\s*<Title className="rs-dialog__title" id=\{`\$\{id\}-title`\}>\s*\{title\}\s*<\/Title>\s*<\/header>\s*\{children\}/,
  );
  // Closed unless the caller opens it, and the caller chooses the heading
  // level of the title.
  assert.match(dialog, /open = false,/);
  assert.match(dialog, /titleAs: Title = "h2",/);
  assert.match(moduleCode, /readonly titleAs\?: "h2" \| "h3" \| "h4";/);
  for (const [name, area] of [
    ["DialogBody", "body"],
    ["DialogActions", "actions"],
    ["DialogDismissal", "dismissal"],
  ]) {
    assert.match(
      componentSource(name),
      new RegExp(
        `return <div className="rs-dialog__${area}">\\{children\\}</div>;`,
      ),
      name,
    );
  }
  // No modal workflow or state machine: the module opens, closes, and
  // remembers nothing.
  assert.doesNotMatch(
    moduleCode,
    /showModal|\.show\(|\.close\(|returnValue|onClose|onCancel|method="dialog"|createPortal|useRef|useState|useEffect|\bstep\b|wizard/i,
  );
  const frame = declared(".rs-dialog");
  assert.equal(frame.get("box-shadow"), "var(--rs-shadow-3)");
  assert.equal(frame.get("border-radius"), "var(--rs-radius-lg)");
  assert.match(frame.get("inline-size"), /^min\(100% - /);
  assert.match(frame.get("max-block-size"), /^min\(100dvh - /);
  assert.equal(frame.get("overflow"), "auto");
  // Clearly layered. Opened by its attribute, a layered dialog is fixed
  // above the interface; the scrim is the one a modally opened dialog shows,
  // which takes a later caller, since the module opens nothing itself. The
  // placement does not depend on the open state, so the frame keeps its
  // place while it leaves.
  assert.equal(
    styleRules.filter(
      (rule) =>
        /\[open\]/.test(rule.prelude) &&
        rule.declarations.some(([property]) =>
          /^(?:position|inset|z-index|margin|grid-template-columns)$/.test(
            property,
          ),
        ),
    ).length,
    0,
  );
  assert.deepEqual(
    [...declared('.rs-dialog:not([data-presentation="inline"])')],
    [
      ["position", "fixed"],
      ["inset", "0"],
      ["z-index", "var(--rs-layer-dialog)"],
      ["margin", "auto"],
    ],
  );
  assert.ok(
    Number(token("--rs-layer-dialog")) >
      Number(token("--rs-layer-notification")),
  );
  assert.deepEqual(
    styleRules
      .filter((rule) =>
        rule.declarations.some(([property]) => property === "z-index"),
      )
      .flatMap((rule) =>
        rule.declarations
          .filter(([property]) => property === "z-index")
          .map(([, value]) => `${rule.prelude} ${value}`),
      ),
    [
      '.rs-dialog:not([data-presentation="inline"]) var(--rs-layer-dialog)',
      ".rs-notification-region var(--rs-layer-notification)",
      ".rs-media::after 1",
      ".rs-media__caption 2",
    ],
  );
  // The footer band is whole whichever areas the caller renders.
  assert.deepEqual(rulesFor(".rs-dialog__actions:last-child")[0].selectors, [
    ".rs-dialog__actions:last-child",
    ":not(.rs-dialog__actions) + .rs-dialog__dismissal",
  ]);
  assert.equal(
    declared(".rs-dialog__actions:last-child").get("grid-column"),
    "1 / -1",
  );
  // When narrow, only a dismissal that continues the actions band gives up
  // its own divider.
  assert.deepEqual(
    [
      ...declared(
        ".rs-dialog__actions + .rs-dialog__dismissal",
        "@media (max-width: 39.9375rem)",
      ),
    ],
    [
      ["padding-block-start", "0"],
      ["border-block-start", "0"],
    ],
  );
  assert.equal(
    rulesFor(".rs-dialog__dismissal", "@media (max-width: 39.9375rem)")
      .flatMap((rule) => rule.declarations)
      .some(([property]) => property === "border-block-start"),
    false,
  );
  assert.match(
    declared(".rs-dialog::backdrop").get("background"),
    /^rgb\(31 20 14 \/ 0\.[45]\d?\)$/,
  );
  // A strong serif title over quieter supporting content.
  const title = declared(".rs-dialog__title");
  assert.equal(title.get("font-family"), "var(--rs-font-display)");
  assert.ok(rem(resolve(title.get("font-size"))) >= 1.5);
  assert.equal(
    declared(".rs-dialog__body").get("color"),
    "var(--rs-color-ink-muted)",
  );
  // One footer band holds the primary action area and the dismissal path.
  for (const area of [".rs-dialog__actions", ".rs-dialog__dismissal"]) {
    assert.equal(
      declared(area).get("background"),
      "var(--rs-color-cream)",
      area,
    );
  }
  assert.equal(
    declared('.rs-dialog[data-presentation="inline"]').get("position"),
    "static",
  );
});

test("18. the media frame treats caller media and bundles no asset", () => {
  const frame = componentSource("MediaFrame");
  assert.match(
    frame,
    /<figure className="rs-media" data-ratio=\{ratio\} data-overlay=\{overlay\}>\s*<div className="rs-media__content">\{children\}<\/div>/,
  );
  assert.match(
    frame,
    /<figcaption className="rs-media__caption">\{caption\}<\/figcaption>/,
  );
  assert.match(
    moduleCode,
    /readonly ratio\?: "wide" \| "landscape" \| "standard" \| "portrait" \| "square";/,
  );
  assert.match(moduleCode, /readonly overlay\?: "none" \| "scrim" \| "veil";/);
  // No image, video, or source element is written anywhere in the design
  // system or on the page: media always comes from a later caller.
  for (const [file, source] of [
    [modulePath, moduleCode],
    [pagePath, pageCode],
    [layoutPath, layoutSource],
  ]) {
    assert.doesNotMatch(
      source,
      /<(?:img|picture|source|video|audio|canvas|image|Image)\b|next\/image|\bposter=|\bbackgroundImage\b/,
      file,
    );
  }
  const media = declared(".rs-media");
  assert.equal(media.get("aspect-ratio"), "16 / 9");
  assert.equal(media.get("overflow"), "hidden");
  assert.equal(media.get("border-radius"), "var(--rs-radius-lg)");
  for (const [ratio, value] of [
    ["wide", "21 / 9"],
    ["standard", "4 / 3"],
    ["portrait", "4 / 5"],
    ["square", "1"],
  ]) {
    assert.equal(
      declared(`.rs-media[data-ratio="${ratio}"]`).get("aspect-ratio"),
      value,
    );
  }
  // Crop, contrast treatment, and overlay for dark and light integration.
  const crop = declared(".rs-media__content > :where(img, video)");
  assert.equal(crop.get("object-fit"), "cover");
  assert.ok(crop.has("filter"));
  assert.match(
    declared('.rs-media[data-overlay="scrim"]::after').get("background"),
    /^linear-gradient\(180deg, rgb\(31 20 14 \/ 0\) \d+%, rgb\(31 20 14 \/ 0\.\d+\) 100%\)$/,
  );
  assert.match(
    declared('.rs-media[data-overlay="veil"]::after').get("background"),
    /^rgb\(31 20 14 \/ 0\.\d+\)$/,
  );
  assert.equal(declared(".rs-media::after").get("pointer-events"), "none");
  // An image nested in a picture gets the same crop and treatment.
  const nested = declared(".rs-media__content > picture > img");
  assert.equal(nested.get("object-fit"), "cover");
  assert.equal(nested.get("filter"), crop.get("filter"));
  assert.equal(nested.get("inline-size"), "100%");
  // The caption carries its own band, so it stays readable over any media
  // and under any overlay, even a white image with no overlay at all.
  const caption = declared(".rs-media__caption");
  const band = caption.get("background").match(/^rgb\(31 20 14 \/ (0\.\d+)\)$/);
  assert.ok(band, caption.get("background"));
  const alpha = Number(band[1]);
  const overWhite = `#${[31, 20, 14]
    .map((channel) =>
      Math.round(channel * alpha + 255 * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  assert.equal(caption.get("color"), "var(--rs-ctx-fg)");
  assert.ok(
    contrast(token("--rs-ctx-fg", declared(".rs-media")), overWhite) >= 4.5,
  );
  // The frame is a dark ground, so content inside it takes the dark context.
  assert.equal(
    token("--rs-ctx-fg", declared(".rs-media")),
    token("--rs-color-on-dark"),
  );
});

test("19. icons are a small inline set drawn with the current color", () => {
  const icon = componentSource("Icon");
  assert.match(
    icon,
    /<svg\s+className="rs-icon"\s+viewBox="0 0 24 24"\s+role=\{label === undefined \? undefined : "img"\}\s+aria-label=\{label\}\s+aria-hidden=\{label === undefined \? true : undefined\}\s+focusable="false"\s*>\s*<path d=\{ICON_PATHS\[name\]\} \/>\s*<\/svg>/,
  );
  const names = moduleCode
    .match(/^export type IconName =\s*([^;]+);$/m)[1]
    .match(/"([a-z]+)"/g)
    .map((name) => name.slice(1, -1));
  // A bounded utility set with no feature or domain vocabulary.
  assert.deepEqual(names, [
    "check",
    "warning",
    "error",
    "information",
    "neutral",
    "arrow",
    "chevron",
    "close",
  ]);
  const table = moduleCode.slice(
    moduleCode.indexOf("const ICON_PATHS"),
    moduleCode.indexOf("const TONE_ICONS"),
  );
  const paths = [...table.matchAll(/(\w+):\s*"([^"]+)"/g)];
  assert.deepEqual(
    paths.map((match) => match[1]),
    names,
  );
  for (const [, name, path] of paths) {
    // Path data only, inside the 24 by 24 grid.
    assert.match(path, /^M[\dMmLlHhVvAaZz .-]+$/, name);
    for (const number of path.match(/\d*\.?\d+/g)) {
      assert.ok(Number(number) <= 24, `${name}: ${number}`);
    }
  }
  assert.equal(new Set(paths.map((match) => match[2])).size, names.length);
  // One consistent outline treatment, colored by the text around it.
  const rule = declared(".rs-icon");
  assert.equal(rule.get("stroke"), "currentColor");
  assert.equal(rule.get("fill"), "none");
  assert.equal(rule.get("stroke-linecap"), "round");
  assert.equal(rule.get("stroke-linejoin"), "round");
  assert.ok(Number(rule.get("stroke-width")) >= 1.5);
  // One svg element in the whole module, and no color of its own.
  assert.equal(moduleCode.match(/<svg\b/g).length, 1);
  assert.doesNotMatch(
    moduleCode,
    /\bfill=|\bstroke=|<use\b|xlink|<image\b|<text\b|<foreignObject\b/,
  );
});

test("20. the presentation module is presentation only", () => {
  // No client or server directive, and one type-only import.
  assert.doesNotMatch(moduleSource, /["']use (?:client|server)["']/);
  assert.deepEqual(importsOf(moduleSource), ["react"]);
  assert.equal(moduleSource.match(/^import /gm).length, 1);
  assert.match(
    moduleSource,
    /^import type \{ ComponentPropsWithoutRef, ReactNode \} from "react";$/m,
  );
  assert.doesNotMatch(
    moduleCode,
    /\bimport\s*\(|\brequire\s*\(|^\s*export\s*(?:\*|\{[^}]*\})\s*from\s/m,
  );
  // It reaches no other layer, provider, store, or policy.
  assert.doesNotMatch(
    moduleCode,
    /application|\bdomain\b|infrastructure|adapter|provider|repository|policy|\bconfig\b|\.\.\/|\.\/[a-z]|getShellView|resolveSession|\bsession\b/i,
  );
  // No hook, effect, timer, network call, storage, cookie, environment
  // read, global, dynamic code, or asynchronous work.
  assert.doesNotMatch(
    moduleCode,
    /\buse[A-Z]\w*\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|\bcookies?\b|\bprocess\b|\benv\b|import\.meta|globalThis|\bwindow\b|\bdocument\b|\bnavigator\b|\blocation\b|\bhistory\b|\beval\s*\(|new Function|\basync\b|\bawait\b|\bPromise\b|\bDate\b|Math\.random|\bcrypto\b|console\./,
  );
  // No state and no control flow beyond choosing what to render: no class,
  // loop, switch, exception, or reassignable binding.
  assert.doesNotMatch(
    moduleCode,
    /\bclass\s+\w|\bnew\s+\w|\blet\s|\bvar\s|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(|\btry\s*\{|\bthrow\b|\bthis\b|\bdelete\b/,
  );
  // Module-level values are the two frozen-shape lookup tables.
  assert.deepEqual(
    [...moduleCode.matchAll(/^const (\w+)/gm)].map((match) => match[1]),
    ["ICON_PATHS", "TONE_ICONS"],
  );
  // Exactly the contracted primitives and types are exported.
  assert.deepEqual(
    [...moduleCode.matchAll(/^export function (\w+)\(/gm)]
      .map((match) => match[1])
      .sort(),
    exportedComponents,
  );
  assert.deepEqual(
    [...moduleCode.matchAll(/^export type (\w+)/gm)].map((match) => match[1]),
    ["Density", "Tone", "IconName", "FieldMessages"],
  );
  assert.equal(
    moduleCode.match(/^export /gm).length,
    exportedComponents.length + 4,
  );
  assert.doesNotMatch(moduleCode, /export default/);
  // Every component is one function that returns markup; its classes are
  // fixed rs-* names that the stylesheet defines, and it takes no class or
  // inline style from a caller.
  for (const name of exportedComponents) {
    const source = componentSource(name);
    assert.match(source, /\breturn\b/, name);
    for (const [, className] of source.matchAll(/className="([^"]+)"/g)) {
      assert.match(
        className,
        /^rs-[a-z]+(?:-[a-z]+)*(?:__[a-z]+)?$/,
        `${name} ${className}`,
      );
      assert.ok(
        new RegExp(`\\.${className}(?![a-z_-])`).test(css),
        `${name} uses .${className}, which the stylesheet does not define`,
      );
    }
  }
  assert.doesNotMatch(moduleCode, /className=\{|\bstyle=/);
  assert.match(
    moduleCode,
    /Omit<\s*ComponentPropsWithoutRef<Tag>,\s*"className" \| "style" \| "dangerouslySetInnerHTML"\s*>/,
  );
  // Every class in a selector belongs to the one rs- namespace, so the
  // stylesheet cannot grow general-purpose utility classes.
  for (const rule of styleRules) {
    for (const [, className] of rule.prelude.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      assert.match(
        className,
        /^rs-[a-z]+(?:-[a-z]+)*(?:__[a-z]+)?$/,
        `${rule.prelude} names .${className}`,
      );
    }
  }
  // Every class the stylesheet defines is rendered by the module, so the
  // two files describe one system.
  const rendered = new Set(
    [...moduleCode.matchAll(/className="([^"]+)"/g)].map((match) => match[1]),
  );
  const defined = new Set(
    [...css.matchAll(/\.(rs-[a-z]+(?:-[a-z]+)*(?:__[a-z]+)?)/g)].map(
      (match) => match[1],
    ),
  );
  assert.deepEqual([...defined].sort(), [...rendered].sort());
  // Every data attribute the module renders is one the stylesheet reads.
  assert.deepEqual(
    [
      ...new Set(
        [...moduleCode.matchAll(/\bdata-([a-z-]+)=/g)].map((match) => match[1]),
      ),
    ].sort(),
    [
      "columns",
      "density",
      "emphasis",
      "gap",
      "overlay",
      "presentation",
      "ratio",
      "size",
      "tone",
      "variant",
    ],
  );
});

test("21. the design system holds no feature record, workflow, or business rule", () => {
  // The approved density names appear only as the exact density tokens.
  const moduleText = moduleSource.replaceAll(
    'export type Density = "public" | "client" | "attorney" | "admin";',
    " ",
  );
  const styleText = stylesheet.replaceAll('[data-density="attorney"]', " ");
  for (const [file, source] of [
    [modulePath, moduleText],
    [stylesheetPath, styleText],
    [pagePath, pageSource],
    [layoutPath, layoutSource],
  ]) {
    assert.doesNotMatch(source, /attorney/i, file);
    assert.doesNotMatch(source, featureVocabulary, file);
    // Placeholder content is not a substitute for a real feature.
    assert.doesNotMatch(
      source
        .replaceAll("_", " ")
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2"),
      /\b(?:demo|fake|mock|sample|dummy|lorem|ipsum|todo|fixme|john|jane|acme|example\.com)\b/i,
      file,
    );
    // No address, number, amount, date, or rating that could be a record.
    assert.doesNotMatch(
      source,
      /@[a-z0-9-]+\.[a-z]{2,}|\(\d{3}\)|\d{3}-\d{4}|[$€£¥]\s?\d|\d\s?(?:USD|EUR|GBP)\b|\b\d{1,2}:\d{2}\b|\b(?:19|20)\d{2}\b|\d(?:\.\d)?\s?(?:stars?|reviews?)\b/i,
      file,
    );
  }
  // In the code of both files the four density names appear only as density
  // tokens: a data-density selector in the stylesheet and the one type in the
  // module.
  for (const density of densities) {
    const word = new RegExp(`\\b${density}\\b`, "g");
    assert.equal(
      css.match(word).length,
      css.match(new RegExp(`\\[data-density="${density}"\\]`, "g")).length,
      density,
    );
    assert.equal(moduleCode.match(word).length, 1, density);
  }
  assert.equal(moduleSource.match(/attorney/gi).length, 1);
  assert.equal(
    stylesheet.match(/attorney/gi).length,
    stylesheet.match(/\[data-density="attorney"\]/g).length,
  );
  // No selector or prop encodes a business state, role, or permission.
  assert.doesNotMatch(
    moduleCode,
    /\b(?:permission|capabilit\w*|isAdmin|isClient|isOwner|canEdit|canView|authorized|authenticated|anonymous|tenant|subscription)\b/i,
  );
  assert.doesNotMatch(
    css,
    /authenticated|anonymous|verified|approved|rejected|pending|\bpaid\b|overdue|\blive\b|online|offline|\bavailable\b|booked|premium-(?:user|plan|member)/i,
  );
});

test("22. the page shows the foundation through the design system and the server boundary", () => {
  assert.deepEqual(importsOf(pageSource), [
    "next/server",
    "../src/application/shell.ts",
    "../src/presentation/design-system.tsx",
  ]);
  assert.match(pageSource, /^import \{ connection \} from "next\/server";$/m);
  assert.match(
    pageSource,
    /^import \{ getShellView \} from "\.\.\/src\/application\/shell\.ts";$/m,
  );
  // Server state is read on the server, per request, through the
  // application layer, with nothing from the browser passed in.
  assert.doesNotMatch(pageSource, /["']use (?:client|server)["']/);
  assert.match(
    pageCode,
    /export default async function HomePage\(\) \{\n {2}await connection\(\);\n {2}const view = await getShellView\(\);\n {2}return \(\n/,
  );
  assert.equal(pageCode.match(/getShellView/g).length, 2);
  assert.equal(pageCode.match(/\bconnection\b/g).length, 2);
  assert.equal(pageCode.match(/\bawait\b/g).length, 2);
  // The one expression in the markup is the session state, shown as text
  // inside a status whose tone is fixed, not derived from that state.
  const markup = pageCode.slice(pageCode.indexOf("return ("));
  assert.deepEqual(
    [...markup.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]),
    ["view.session"],
  );
  assert.match(
    markup,
    /<Status tone="neutral">Session: \{view\.session\}<\/Status>/,
  );
  assert.doesNotMatch(
    pageCode,
    /\?|&&|\|\||===|!==|\bif\b|\bswitch\b|\.map\(|=>/,
  );
  // Every component on the page comes from the design system, and every
  // name the page imports from it is used.
  const imported = pageSource
    .match(
      /import \{([^}]+)\} from "\.\.\/src\/presentation\/design-system\.tsx";/,
    )[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert.deepEqual(imported, [...imported].sort());
  const used = [
    ...new Set([...markup.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(used, imported);
  for (const name of imported) {
    assert.ok(exportedComponents.includes(name), name);
  }
  // Native elements on the page are the option and table elements that the
  // select and table primitives take as children.
  assert.deepEqual(
    [
      ...new Set([...markup.matchAll(/<([a-z]\w*)/g)].map((match) => match[1])),
    ].sort(),
    ["option", "tbody", "td", "th", "thead", "tr"],
  );
  // The page styles nothing itself and wires no behavior.
  assert.doesNotMatch(
    markup,
    /className|\bstyle=|\bdata-|\bon[A-Z]\w*=|\bhref=|\baction=|<form\b|\bname=|\bvalue=|\brole=/,
  );
  // Every attribute value is one the design system defines or plain copy.
  const attribute = (name) =>
    [
      ...new Set(
        [...markup.matchAll(new RegExp(`\\b${name}="([^"]*)"`, "g"))].map(
          (match) => match[1],
        ),
      ),
    ].sort();
  // The page uses the public density variant and no other. It is a fixed
  // presentation prop, not derived from the session or an audience.
  assert.deepEqual(attribute("density"), ["public"]);
  assert.deepEqual(attribute("variant"), ["primary", "secondary", "tertiary"]);
  assert.deepEqual(attribute("tone"), [
    "chocolate",
    "dark",
    "error",
    "gold",
    "information",
    "muted",
    "neutral",
    "success",
    "warning",
  ]);
  assert.deepEqual(attribute("emphasis"), ["raised"]);
  assert.deepEqual(attribute("presentation"), ["inline"]);
  // Dark surfaces are the exception on the page, not the rule.
  const surfaces = [...markup.matchAll(/<Surface\b([^>]*)>/g)].map(
    (match) => match[1],
  );
  assert.ok(surfaces.length >= 3);
  assert.ok(
    surfaces.filter((props) => /tone="(?:dark|chocolate)"/.test(props)).length <
      surfaces.length,
  );
  assert.equal(surfaces.filter((props) => /tone="dark"/.test(props)).length, 1);
  // The copy describes the interface foundation itself. It holds no digit,
  // so no price, count, metric, date, or time can appear.
  const copy = markup
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<[^<>]*>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of [
    ...copy,
    ...[
      ...markup.matchAll(
        /\b(?:title|label|hint|legend|summary|caption|errors)="([^"]*)"/g,
      ),
    ].map((match) => match[1]),
  ]) {
    assert.doesNotMatch(line, /\d|[$€£¥%#@]/, line);
  }
  assert.ok(copy.includes("Rosuno"));
  // The root layout keeps its document, title, and server rendering, and
  // gains only the stylesheet.
  assert.doesNotMatch(layoutSource, /["']use client["']/);
  assert.deepEqual(importsOf(layoutSource), ["next", "react", "./globals.css"]);
  assert.match(layoutSource, /title: "Rosuno"/);
  assert.match(
    layoutSource,
    /<html lang="en">\s*<body>\s*<main>\{children\}<\/main>\s*<\/body>\s*<\/html>/,
  );
  assert.doesNotMatch(
    layoutSource,
    /className|<nav\b|<header\b|<footer\b|Provider|useState|\bfetch\b/,
  );
});

test("23. the application layer and the presentation layer stay apart", () => {
  for (const file of filesIn("src/application/")) {
    const source = read(file);
    assert.doesNotMatch(
      codeOf(source),
      /(?<![A-Za-z])presentation\b|design-system|\breact\b|\.tsx|\.css|\brs-[a-z]/i,
      file,
    );
    for (const specifier of importsOf(source)) {
      assert.match(
        specifier,
        /^\.\/[a-z-]+\.ts$/,
        `${file} imports ${specifier}`,
      );
    }
  }
  assert.deepEqual(filesIn("src/application/"), [
    "src/application/form-operation.ts",
    "src/application/session.ts",
    "src/application/shell.ts",
  ]);
  // Only the two error boundaries that Next.js requires are client modules.
  assert.deepEqual(
    [...filesIn("app/"), ...filesIn("src/")].filter((file) =>
      /["']use client["']/.test(read(file)),
    ),
    ["app/error.tsx", "app/global-error.tsx"],
  );
  // The design system makes no accessibility certification claim.
  for (const source of [moduleSource, stylesheet, pageSource]) {
    assert.doesNotMatch(
      source,
      /WCAG|\bAAA?\b|Section 508|ADA compliant|certif|accessible to all/i,
    );
  }
});
