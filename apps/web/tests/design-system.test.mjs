// Design-system tests (DEV-001). The owner's UI/UX design system (the
// UIUX-HANDOFF-P2 build, build_p8) lives in app/styles and is rendered by the
// primitives of src/presentation/design-system.tsx.
//
// They run on Node.js built-ins alone and read the stylesheets and the TSX
// sources as text, so they need no browser, renderer, or installed package.
// Each test checks a contract rather than presence: references are resolved,
// tokens are traced to their definitions, contrast is computed, and sources
// are checked for what they must never contain (remote resources, inline
// styles, business rules in the primitives).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const appRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../", appRoot);

const globalPath = "app/globals.css";
const entryPath = "app/styles/rosuno.css";
const modulePath = "src/presentation/design-system.tsx";
const layoutPath = "app/layout.tsx";

// The owner's design layers, in cascade order, and the canonical additions.
const partials = Object.freeze([
  "fonts.css",
  "theme.css",
  "client.css",
  "workspace.css",
  "attorney.css",
  "staff.css",
  "layout.css",
  "site.css",
  "product.css",
  "product-client.css",
  "product-workspace.css",
  "product-attorney.css",
  "product-staff.css",
  "product-auth.css",
]);
const stylePaths = Object.freeze([
  globalPath,
  entryPath,
  ...partials.map((file) => `app/styles/${file}`),
]);
// Stylesheets written for the canonical app (not ported from the build).
const canonicalStylePaths = Object.freeze([globalPath, "app/styles/site.css"]);

const weights = Object.freeze([400, 500, 600, 700]);
const subsets = Object.freeze(["latin", "latin-ext"]);
const families = Object.freeze([
  ["Instrument Sans", "instrument-sans"],
  ["Inter", "inter"],
]);

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

// CSS as a flat list of style rules with their enclosing at-rules.
function parseCss(css, context = []) {
  const rules = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open === -1) {
      assert.equal(css.slice(index).trim(), "", "text outside any rule");
      break;
    }
    const prelude = css.slice(index, open).trim().replace(/\s+/g, " ");
    let depth = 1;
    let end = open + 1;
    while (depth > 0) {
      assert.ok(end < css.length, `unclosed rule: ${prelude}`);
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    }
    const body = css.slice(open + 1, end - 1);
    if (prelude.startsWith("@") && !prelude.startsWith("@font-face")) {
      rules.push(...parseCss(body, [...context, prelude]));
    } else {
      rules.push({
        prelude,
        context,
        declarations: body
          .split(/;(?![^(]*\))/)
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
                .replace(/\s+/g, " "),
            ];
          }),
      });
    }
    index = end;
  }
  return rules;
}

function cssOf(path) {
  // @import lines are checked separately; the parser reads rules only.
  return codeOf(read(path)).replace(/^@import [^;]+;$/gm, "");
}

const moduleSource = read(modulePath);
const moduleCode = codeOf(moduleSource);
const rulesByFile = new Map(stylePaths.map((p) => [p, parseCss(cssOf(p))]));
const allRules = [...rulesByFile.values()].flat();

function declarationsOf(selector) {
  return allRules
    .filter((rule) => rule.prelude.split(/,\s*/).includes(selector))
    .flatMap((rule) => rule.declarations);
}

function tokenValue(name) {
  const root = allRules.find(
    (rule) => rule.prelude === ".rz:not(.rz .rz)" && rule.context.length === 0,
  );
  assert.ok(root, "the design root defines the tokens");
  const found = root.declarations.find(([property]) => property === name);
  assert.ok(found, `token ${name} is defined at the design root`);
  return found[1];
}

function rgbOf(color) {
  const hex = color.trim().toLowerCase();
  if (hex === "#fff" || hex === "#ffffff" || hex === "white")
    return [255, 255, 255];
  const match = /^#([0-9a-f]{6})$/.exec(hex);
  assert.ok(match, `not a six-digit colour: ${color}`);
  return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground, background) {
  const [a, b] = [luminance(rgbOf(foreground)), luminance(rgbOf(background))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// DEV-001: website & appearance studio: a hook token (--rz-*) is defined by
// no repository stylesheet, only by a published appearance, so a wrapped
// value computes its fallback; the fallback is the owner's literal. The one
// repository declaration of a hook is the studio root's reset to the
// guaranteed-invalid value (initial), which computes the same fallback.
function resolve(value) {
  const hook = /^var\((--rz-[a-z-]+), ([^()]+)\)$/.exec(value.trim());
  if (hook) {
    const declared = allRules.filter((rule) =>
      rule.declarations.some(([property]) => property === hook[1]),
    );
    assert.ok(
      declared.every(
        (rule) =>
          rule.prelude === ".W.st .rz-studio" &&
          rule.context.length === 0 &&
          rule.declarations.filter(([property]) => property === hook[1])
            .length === 1 &&
          rule.declarations.find(([property]) => property === hook[1])[1] ===
            "initial",
      ),
      `${hook[1]} is defined by no repository stylesheet but the studio's reset to initial`,
    );
    return hook[2];
  }
  const match = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return match ? tokenValue(match[1]) : value;
}

const exportedComponents = Object.freeze(
  [
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
  ].sort(),
);

function componentSource(name) {
  const start = moduleCode.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, name);
  const next = moduleCode.indexOf("\nexport ", start + 1);
  return moduleCode.slice(start, next === -1 ? undefined : next);
}

test("1. the design system is exactly its contracted files and entry chain", () => {
  assert.deepEqual(
    filesIn("app/styles/"),
    [...[...partials, "rosuno.css"].map((file) => `app/styles/${file}`)].sort(),
  );
  const fontFiles = families.flatMap(([, slug]) => [
    `public/fonts/${slug}/OFL.txt`,
    ...weights.flatMap((weight) =>
      subsets.map(
        (subset) =>
          `public/fonts/${slug}/${slug}-${subset}-${weight}-normal.woff2`,
      ),
    ),
  ]);
  assert.deepEqual(
    filesIn("public/"),
    [...fontFiles, "public/icons/chevron-down.svg"].sort(),
  );
  // The layout loads the one global stylesheet, which loads the entry, which
  // loads the layers in cascade order. DEV-001: website & appearance studio:
  // the layout also renders the preview loader (a client component that
  // renders nothing and loads no stylesheet).
  assert.deepEqual(importsOf(read(layoutPath)), [
    "next",
    "react",
    "../src/presentation/appearance/preview-loader.tsx",
    "./globals.css",
  ]);
  assert.deepEqual(
    [...read(globalPath).matchAll(/^@import "([^"]+)";$/gm)].map((m) => m[1]),
    ["./styles/rosuno.css"],
  );
  assert.deepEqual(
    [...read(entryPath).matchAll(/^@import "([^"]+)";$/gm)].map((m) => m[1]),
    partials.map((file) => `./${file}`),
  );
  for (const path of stylePaths.filter(
    (p) => p !== globalPath && p !== entryPath,
  )) {
    assert.doesNotMatch(read(path), /@import/, path);
  }
  // Each woff2 file is a real WOFF2 font.
  for (const file of fontFiles.filter((f) => f.endsWith(".woff2"))) {
    const bytes = readFileSync(new URL(file, appRoot));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", file);
  }
});

test("2. the design system adds no dependency, package, or tool configuration", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@supabase/ssr",
    "@supabase/supabase-js",
    "next",
    "react",
    "react-dom",
  ]);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), [
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "typescript",
  ]);
  for (const file of [
    "postcss.config.js",
    "postcss.config.mjs",
    "tailwind.config.js",
    "tailwind.config.ts",
    ".postcssrc",
    "app/fonts",
  ]) {
    assert.equal(existsSync(new URL(file, appRoot)), false, file);
  }
  const rootManifest = JSON.parse(read("package.json", repositoryRoot));
  assert.equal(rootManifest.dependencies, undefined);
});

test("3. stylesheets reference only same-origin assets that exist", () => {
  for (const path of stylePaths) {
    const source = read(path);
    const code = codeOf(source);
    assert.doesNotMatch(
      code,
      /https?:|\/\/[a-z]|data:|javascript:|expression\(|(?<![\w-])behavior\s*:|-moz-binding/i,
      path,
    );
    for (const [, target] of code.matchAll(/url\(\s*"([^"]+)"\s*\)/g)) {
      assert.match(
        target,
        /^\/(?:fonts|icons)\/[a-z0-9./-]+$/,
        `${path}: ${target}`,
      );
      assert.ok(
        existsSync(new URL(`public${target}`, appRoot)),
        `${path}: ${target} exists`,
      );
    }
    assert.doesNotMatch(
      code,
      /url\((?!\s*")/,
      `${path}: every url() is a quoted path`,
    );
  }
  // No rule still targets an inline style attribute.
  for (const rule of allRules) {
    assert.doesNotMatch(rule.prelude, /\[style/, rule.prelude);
  }
});

test("4. every token used is defined, and the design root holds the core tokens", () => {
  const defined = new Set(
    allRules.flatMap((rule) =>
      rule.declarations.filter(([p]) => p.startsWith("--")).map(([p]) => p),
    ),
  );
  for (const path of stylePaths) {
    // A token read with a fallback (var(--name, value)) may be undefined.
    for (const [, name] of codeOf(read(path)).matchAll(
      /var\(\s*(--[\w-]+)\s*\)/g,
    )) {
      assert.ok(
        defined.has(name),
        `${path} uses ${name}, which no rule defines`,
      );
    }
  }
  for (const name of [
    "--ink",
    "--ink-2",
    "--muted",
    "--subtle",
    "--line",
    "--page",
    "--paper",
    "--paper-2",
    "--accent",
    "--live",
    "--live-ink",
    "--r",
    "--f-display",
    "--f-body",
  ]) {
    tokenValue(name);
  }
});

test("5. typography is self-hosted Instrument Sans for display and Inter for text, under their licences", () => {
  assert.match(tokenValue("--f-display"), /^"Instrument Sans", "Inter",/);
  assert.match(tokenValue("--f-body"), /^"Inter",/);
  const faces = rulesByFile
    .get("app/styles/fonts.css")
    .filter((rule) => rule.prelude === "@font-face");
  assert.equal(faces.length, families.length * weights.length * subsets.length);
  for (const [family, slug] of families) {
    for (const weight of weights) {
      for (const subset of subsets) {
        const face = faces.find((rule) => {
          const values = Object.fromEntries(rule.declarations);
          return (
            values["font-family"] === `"${family}"` &&
            values["font-weight"] === String(weight) &&
            values.src ===
              `url("/fonts/${slug}/${slug}-${subset}-${weight}-normal.woff2") format("woff2")`
          );
        });
        assert.ok(face, `${family} ${weight} ${subset}`);
        const values = Object.fromEntries(face.declarations);
        assert.equal(values["font-display"], "swap");
        assert.equal(values["font-style"], "normal");
        assert.match(values["unicode-range"], /^U\+/);
      }
    }
    assert.match(
      read(`public/fonts/${slug}/OFL.txt`),
      /SIL Open Font License, Version 1\.1/,
    );
  }
  // No other family is loaded from a file.
  assert.equal(
    new Set(faces.map((f) => Object.fromEntries(f.declarations)["font-family"]))
      .size,
    2,
  );
});

test("6. text, primary actions and status pills keep readable contrast", () => {
  const page = tokenValue("--page");
  assert.ok(contrast(tokenValue("--ink"), page) >= 7, "ink on page");
  assert.ok(
    contrast(tokenValue("--ink-2"), page) >= 7,
    "secondary ink on page",
  );
  assert.ok(contrast(tokenValue("--muted"), page) >= 4.5, "muted text on page");
  assert.ok(
    contrast(tokenValue("--subtle"), page) >= 4.5,
    "subtle text on page",
  );
  assert.ok(
    contrast(tokenValue("--muted"), tokenValue("--paper")) >= 4.5,
    "muted on paper",
  );
  const primary = Object.fromEntries(declarationsOf(".rz .btn-ink"));
  // DEV-001: website & appearance studio: the text colour is the on-ink hook
  // with the owner's white as its fallback.
  assert.equal(primary.color, "var(--rz-on-ink, #fff)");
  assert.ok(
    contrast(resolve(primary.color), resolve(primary.background)) >= 7,
    "primary button",
  );
  for (const pill of ["pending", "ok", "no", "info"]) {
    const values = Object.fromEntries(declarationsOf(`.rz .pill.${pill}`));
    assert.ok(
      contrast(resolve(values.color), resolve(values.background)) >= 4.5,
      `${pill} pill: ${values.color} on ${values.background}`,
    );
  }
});

test("7. keyboard focus is always visible", () => {
  const focus = Object.fromEntries(declarationsOf(".rz :focus-visible"));
  assert.match(focus.outline, /^2px solid /);
  for (const rule of allRules.filter((r) => /:focus-visible/.test(r.prelude))) {
    for (const [property, value] of rule.declarations) {
      if (property === "outline") {
        assert.doesNotMatch(value, /^(?:none|0)\b/, rule.prelude);
      }
    }
  }
});

test("8. motion yields to reduced-motion preferences and phone targets stay large", () => {
  const reduced = rulesByFile
    .get("app/styles/site.css")
    .filter((rule) =>
      rule.context.includes("@media (prefers-reduced-motion: reduce)"),
    );
  const covered = reduced.flatMap((rule) => rule.prelude.split(/,\s*/));
  for (const selector of [".rz *", ".rzw *"]) {
    assert.ok(covered.includes(selector), selector);
  }
  const values = Object.fromEntries(
    reduced.flatMap((rule) => rule.declarations),
  );
  assert.equal(values["transition-duration"], "0.01ms !important");
  assert.equal(values["animation-duration"], "0.01ms !important");
  const phone = rulesByFile
    .get("app/styles/site.css")
    .filter((rule) => rule.context.includes("@media (max-width: 700px)"));
  const button = phone.find((rule) => rule.prelude === ".rz .btn");
  assert.ok(button, "phone button rule");
  assert.deepEqual(button.declarations, [["min-height", "44px"]]);
});

test("9. layout classes carry the former inline styles with their precedence", () => {
  const layout = rulesByFile.get("app/styles/layout.css");
  assert.ok(layout.length > 600, "every distinct inline style has a class");
  for (const rule of layout) {
    const [scoped, workspace] = rule.prelude.split(/,\s*/);
    const match = /^\.rz \.(l-[a-z0-9_-]+)$/.exec(scoped);
    assert.ok(match, rule.prelude);
    assert.equal(workspace, `.rzw .${match[1]}`);
    for (const [, value] of rule.declarations) {
      assert.match(value, / !important$/, rule.prelude);
    }
  }
  // Class names are unique.
  const names = layout.map((rule) => rule.prelude);
  assert.equal(new Set(names).size, names.length);
});

test("10. no source renders an inline style or raw markup", () => {
  for (const file of [
    ...filesIn("app/").filter((f) => /\.tsx$/.test(f)),
    ...filesIn("src/presentation/").filter((f) => /\.tsx$/.test(f)),
  ]) {
    // The primitives name the prop only to withhold it from callers.
    const code = codeOf(read(file)).replace(
      '"className" | "style" | "dangerouslySetInnerHTML"',
      " ",
    );
    assert.doesNotMatch(code, /\bstyle=\{/, file);
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/, file);
  }
});

test("11. buttons render the three-step hierarchy and never submit by default", () => {
  assert.match(
    moduleCode,
    /primary: "btn btn-ink",\s*secondary: "btn btn-line",\s*tertiary: "btn btn-quiet",/,
  );
  assert.match(componentSource("Button"), /type = "button"/);
  for (const selector of [
    ".rz .btn",
    ".rz .btn-ink",
    ".rz .btn-line",
    ".rz .btn-quiet",
  ]) {
    assert.ok(declarationsOf(selector).length > 0, selector);
  }
  assert.ok(declarationsOf('.rz .btn-ink[aria-disabled="true"]').length > 0);
});

test("12. form primitives present labels, hints, groups, and caller messages only", () => {
  const frame = moduleCode.slice(
    moduleCode.indexOf("function FieldFrame("),
    moduleCode.indexOf("type Described"),
  );
  assert.match(frame, /<label htmlFor=\{id\}>/);
  assert.match(frame, /className="hint" id=\{`\$\{id\}-hint`\}/);
  assert.match(frame, /className="rz-errors" id=\{`\$\{id\}-errors`\}/);
  for (const name of ["TextField", "TextAreaField", "SelectField"]) {
    const source = componentSource(name);
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
  }
  assert.match(componentSource("FieldGroup"), /<fieldset/);
  assert.match(componentSource("FieldGroup"), /<legend/);
  for (const selector of [
    ".rz .fld",
    ".rz .inp",
    ".rz .hint",
    ".rz .err",
    ".rz .check",
  ]) {
    assert.ok(declarationsOf(selector).length > 0, selector);
  }
  // Nothing in the module validates.
  assert.doesNotMatch(moduleCode, /\bpattern=|\brequired\b|\.test\(|RegExp/);
});

test("13. status and alerts carry caller meaning that never rests on colour", () => {
  assert.match(
    moduleCode,
    /success: "check",\s*warning: "warning",\s*error: "error",\s*information: "information",\s*neutral: "neutral",/,
  );
  for (const name of ["Status", "Alert"]) {
    assert.match(
      componentSource(name),
      /<Icon name=\{TONE_ICONS\[tone\]\} \/>/,
      name,
    );
  }
  assert.match(componentSource("Status"), /<span>\{children\}<\/span>/);
  assert.match(componentSource("Alert"), /role=\{role\}/);
});

test("14. tables, dialogs, disclosures and media keep their structure", () => {
  const table = componentSource("Table");
  assert.match(table, /role="region"/);
  assert.match(table, /aria-labelledby=\{`\$\{id\}-caption`\}/);
  assert.match(table, /tabIndex=\{0\}/);
  const dialog = componentSource("Dialog");
  assert.match(dialog, /<dialog/);
  assert.match(dialog, /aria-labelledby=\{`\$\{id\}-title`\}/);
  assert.match(componentSource("Disclosure"), /<details[\s\S]*<summary/);
  const media = componentSource("MediaFrame");
  assert.match(media, /<figure/);
  assert.doesNotMatch(media, /src=|<img|<video/);
});

test("15. the primitives module is presentation only", () => {
  assert.doesNotMatch(moduleSource, /["']use (?:client|server)["']/);
  assert.deepEqual(importsOf(moduleSource), ["react"]);
  assert.match(
    moduleSource,
    /^import type \{ ComponentPropsWithoutRef, ReactNode \} from "react";$/m,
  );
  assert.doesNotMatch(
    moduleCode,
    /application|\bdomain\b|infrastructure|adapter|provider|repository|policy|\bconfig\b|\.\.\/|\.\/[a-z]|getShellView|resolveSession|\bsession\b/i,
  );
  assert.doesNotMatch(
    moduleCode,
    /\buse[A-Z]\w*\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|\bcookies?\b|\bprocess\b|\benv\b|import\.meta|globalThis|\bwindow\b|\bdocument\b|\beval\s*\(|new Function|\basync\b|\bawait\b|\bDate\b|Math\.random|console\./,
  );
  assert.doesNotMatch(
    moduleCode,
    /\bclass\s+\w|\bnew\s+\w|\blet\s|\bvar\s|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(|\btry\s*\{|\bthrow\b|\bthis\b/,
  );
  assert.deepEqual(
    [...moduleCode.matchAll(/^export function (\w+)\(/gm)]
      .map((m) => m[1])
      .sort(),
    exportedComponents,
  );
  assert.deepEqual(
    [...moduleCode.matchAll(/^export type (\w+)/gm)].map((m) => m[1]),
    ["Density", "Tone", "IconName", "FieldMessages"],
  );
  assert.doesNotMatch(moduleCode, /export default/);
  assert.doesNotMatch(moduleCode, /\bstyle=/);
  assert.match(
    moduleCode,
    /Omit<\s*ComponentPropsWithoutRef<Tag>,\s*"className" \| "style" \| "dangerouslySetInnerHTML"\s*>/,
  );
  // Every class a primitive renders is defined by the design system.
  const definedClasses = new Set(
    allRules.flatMap((rule) =>
      [...rule.prelude.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]),
    ),
  );
  for (const name of exportedComponents) {
    const source = componentSource(name);
    for (const [, classes] of source.matchAll(/className="([^"]+)"/g)) {
      for (const className of classes.split(/\s+/)) {
        assert.ok(definedClasses.has(className), `${name} uses .${className}`);
      }
    }
  }
  for (const table of [
    "BUTTON_CLASSES",
    "TONE_PILLS",
    "SURFACE_CLASSES",
    "HEADING_CLASSES",
    "TEXT_SIZES",
  ]) {
    const start = moduleCode.indexOf(`const ${table}`);
    assert.ok(start >= 0, table);
    const body = moduleCode.slice(start, moduleCode.indexOf("}", start));
    for (const [, classes] of body.matchAll(/:\s*"([^"]+)"/g)) {
      for (const className of classes.split(/\s+/)) {
        assert.ok(definedClasses.has(className), `${table} uses .${className}`);
      }
    }
  }
});

test("16. the primitives and the canonical stylesheets hold no feature record or business rule", () => {
  const moduleText = moduleSource.replaceAll(
    'export type Density = "public" | "client" | "attorney" | "admin";',
    " ",
  );
  const featureVocabulary =
    /lawyer|consultation|referral|intake|booking|payment|payout|ledger|refund|\bfee\b|stripe|\bdaily\b|\bresend\b|supabase|postgres|database|jurisdiction|eligib|bookab|engagement|marketplace|complaint/i;
  for (const [file, source] of [
    [modulePath, moduleText],
    ...canonicalStylePaths.map((path) => [
      path,
      read(path).replaceAll(
        /\[data-density="(?:client|attorney|admin)"\]/g,
        " ",
      ),
    ]),
  ]) {
    assert.doesNotMatch(source, /attorney/i, file);
    assert.doesNotMatch(source, featureVocabulary, file);
    assert.doesNotMatch(
      source,
      /\b(?:demo|fake|mock|sample|dummy|lorem|ipsum|todo|fixme|john|jane|acme|example\.com)\b/i,
      file,
    );
    assert.doesNotMatch(
      source,
      /@[a-z0-9-]+\.[a-z]{2,}|[$€£¥]\s?\d|\d(?:\.\d)?\s?(?:stars?|reviews?)\b/i,
      file,
    );
  }
  assert.doesNotMatch(
    moduleCode,
    /\b(?:permission|capabilit\w*|isAdmin|isClient|isOwner|canEdit|canView|authorized|authenticated|anonymous|tenant|subscription)\b/i,
  );
});

test("17. the application layer and the presentation layer stay apart", () => {
  for (const file of filesIn("src/application/").filter((f) =>
    /\.tsx?$/.test(f),
  )) {
    const source = read(file);
    assert.doesNotMatch(source, /presentation\/|\.css["']|className=/, file);
  }
});
