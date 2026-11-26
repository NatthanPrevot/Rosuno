// DEV-001 website and appearance studio: the stylesheet compiler (studio
// specification sections 1.5, 2.5 and 3.5) over the real presentation
// registry.
//
// Every configuration here is test data, validated by the registry-bound
// validator first, as every caller does. The tests prove what the compiler
// adds behind the validator: the empty configuration compiles to nothing;
// the specification's example compiles byte for byte; the output is
// deterministic; every selector comes from the registry (the two design
// roots, the type-role and role selectors, [data-rz="<id>"] instances,
// workspace ones outside the studio); instance declarations are !important
// and nothing else is; interactive kinds always carry their hover colour;
// every property comes from the fixed allow-list (no visibility, opacity,
// position, overflow, clip, outline, transform or content); the only url()
// is the same-origin asset route for a validated digest; and an unvalidated
// or unsafe value never reaches the output (the compiler throws and the
// route serves the empty default sheet).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contrastRatio,
  mixHex,
  validateAppearance,
} from "../src/application/appearance-schema.ts";
import { compileAppearanceCss } from "../src/presentation/appearance/compiler.ts";
import {
  APPEARANCE_REGISTRY,
  validateWithRegistry,
} from "../src/presentation/appearance/registry.ts";
import { SPEC_EXAMPLE } from "./site-appearance-fixtures.mjs";

const UNSAFE = { name: "Error", message: "appearance: unsafe value" };
const SHA = "c".repeat(64);
const SHA_LOGO = "d".repeat(64);

const valid = (raw, mode = "draft") => {
  const result = validateWithRegistry(raw, mode);
  assert.equal(result.ok, true, JSON.stringify(result.issues ?? []));
  return result.value;
};
const compile = (raw, mode) =>
  compileAppearanceCss(valid(raw, mode), APPEARANCE_REGISTRY);

// The stylesheet as a flat list of rules with their enclosing media query.
function rulesOf(css) {
  const rules = [];
  const body = css.replace(/^\/\* rosuno-appearance schema 1 \*\/\n/, "");
  const walk = (text, media) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open === -1) {
        assert.equal(text.slice(index).trim(), "");
        return;
      }
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let end = open + 1;
      while (depth > 0) {
        if (text[end] === "{") depth += 1;
        if (text[end] === "}") depth -= 1;
        end += 1;
      }
      const inner = text.slice(open + 1, end - 1);
      if (prelude.startsWith("@media")) {
        walk(inner, prelude);
      } else {
        rules.push({
          media,
          selector: prelude,
          declarations: inner
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              assert.match(line, /;$/, line);
              const colon = line.indexOf(":");
              return [line.slice(0, colon), line.slice(colon + 1, -1).trim()];
            }),
        });
      }
      index = end;
    }
  };
  walk(body, null);
  return rules;
}

// A broad configuration touching every kind and group the registry offers.
const BROAD = Object.freeze({
  schema: 1,
  tokens: {
    site: {
      ink: "#1c1917",
      page: "#fffefc",
      accent: "#0f5f5a",
      radius: 10,
      fontDisplay: "inter",
      fontBody: "system",
      elevation: "flat",
    },
    workspace: {
      ink: "#14161a",
      canvas: "#f9f9f7",
      staffRadius: 12,
      elevation: "raised",
    },
  },
  type: {
    "type.display": {
      size: { desktop: 72, tablet: 56, phone: 40 },
      lineHeight: 1.02,
      letterSpacing: -0.03,
      weight: 700,
      color: "#1c1917",
    },
    "type.kicker": { transform: "uppercase", letterSpacing: 0.04 },
    "type.body": { size: { phone: 15 }, lineHeight: 1.65 },
  },
  roles: {
    "role.button.primary": {
      color: { background: "#0f5f5a" },
      border: { radius: 999 },
      typography: { weight: 600 },
      size: { height: 44, paddingX: 20 },
      shadow: "none",
    },
    "role.link": { color: { text: "#0f5f5a" } },
    "role.panel": { border: { radius: 18, width: 1, color: "#dddad4" } },
    "ws.button.secondary": {
      color: { text: "#14161a", border: "#c9c5be", borderHover: "#14161a" },
    },
    "ws.card": { shadow: "e2" },
  },
  components: {
    "site.header": {
      background: { type: "color", color: "#ffffff" },
      border: { bottom: { width: 1, color: "#eae8e4" } },
      shadow: "e1",
    },
    "site.header.nav": {
      color: { text: "#2b2d33", textHover: "#0f1013" },
      typography: { size: { desktop: 15 }, weight: 500 },
    },
    "site.footer": {
      border: { top: { width: 0 } },
      spacing: { padding: { desktop: { top: 64, bottom: 40 } } },
    },
    "home.hero.figure": {
      background: {
        type: "image",
        asset: { sha256: SHA, format: "webp" },
        fit: "cover",
        position: "center",
      },
      border: { radius: 24 },
    },
    "home.ways": {
      background: {
        type: "gradient",
        from: "#ffffff",
        to: "#f6f5f2",
        angle: 180,
      },
      spacing: {
        padding: {
          desktop: { top: 96, bottom: 96 },
          phone: { top: 56, bottom: 56 },
        },
      },
    },
    "home.ways.kicker": { typography: { transform: "uppercase" } },
    "home.issues.grid": { spacing: { gap: { desktop: 20, phone: 12 } } },
    "home.ways.card": {
      spacing: {
        padding: { desktop: { top: 32, right: 32, bottom: 32, left: 32 } },
      },
    },
    "home.attorneys.explore": {
      color: { background: "#ffffff", text: "#0f1013" },
      border: { radius: 12 },
    },
    "staff.sidebar": {
      background: { type: "color", color: "#ffffff" },
      border: { right: { color: "#eae8e4" } },
    },
    "attorney.top": { border: { bottom: { width: 1, color: "#eae8e4" } } },
  },
  slots: { "home.ways.title": "Talk now, or plan ahead." },
  sections: { "home.sections": { hidden: ["home.attorneys"] } },
  brand: {
    logo: {
      asset: { sha256: SHA_LOGO, format: "png" },
      width: 96,
      height: 24,
      wordmark: "hidden",
    },
  },
  assets: [
    { sha256: SHA, format: "webp" },
    { sha256: SHA_LOGO, format: "png" },
  ],
});

test("SC-1 the empty configuration, and one holding only text slots and sections, compile to the empty string", () => {
  assert.equal(compile({ schema: 1 }, "publish"), "");
  assert.equal(
    compile(
      {
        schema: 1,
        slots: { "home.ways.title": "Talk now, or plan ahead." },
        sections: { "home.sections": { hidden: ["home.how"] } },
      },
      "publish",
    ),
    "",
  );
  // A token set to the owner's own default is dropped by the validator, so
  // it compiles to nothing too.
  assert.equal(
    compile({ schema: 1, tokens: { site: { ink: "#0f1013", radius: 14 } } }),
    "",
  );
});

test("SC-2 the specification's section 3.6 example compiles byte for byte", () => {
  assert.equal(
    compile(SPEC_EXAMPLE, "publish"),
    `/* rosuno-appearance schema 1 */
:root .rz:not(.rz .rz) {
  --ink: #1c1917;
  --accent: #0f5f5a;
  --r: 10px;
  --rz-ink-hover: #302e2c;
  --rz-on-ink: #ffffff;
}
@media (min-width: 981px) {
  :root .rz .display {
    font-size: 72px;
  }
}
@media (min-width: 701px) and (max-width: 980px) {
  :root .rz .display {
    font-size: 56px;
  }
}
:root .rz .btn-ink:not([aria-disabled="true"]) {
  border-radius: 999px;
  font-weight: 600;
}
:root [data-rz="home.ways"][data-rz] {
  background: #f6f5f2 !important;
}
@media (min-width: 981px) {
  :root [data-rz="home.ways"][data-rz] {
    padding-top: 96px !important;
    padding-bottom: 96px !important;
  }
}
`,
  );
  assert.equal(mixHex("#1c1917", "#ffffff", 0.09), "#302e2c");
});

test("SC-3 compilation is deterministic: the same configuration, in any key order, gives byte-identical output", () => {
  const first = compile(BROAD);
  assert.equal(compile(BROAD), first);
  const reversed = (value) =>
    value === null || typeof value !== "object" || Array.isArray(value)
      ? value
      : Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reversed(item)]),
        );
  assert.equal(compile(reversed(BROAD)), first);
  assert.ok(first.endsWith("}\n"));
  assert.doesNotMatch(first, /\r|\t|\n\n/);
  assert.ok(first.startsWith("/* rosuno-appearance schema 1 */\n"));
});

test("SC-4 every selector comes from the registry: the design roots, type-role and role selectors (and their hover), and [data-rz] instances, workspace ones outside the studio", () => {
  const css = compile(BROAD);
  const allowed = new Set([
    ":root .rz:not(.rz .rz)",
    ":root .rzw:not(.rzw .rzw)",
    ...APPEARANCE_REGISTRY.typeRoles.map((spec) => `:root ${spec.selector}`),
    ...APPEARANCE_REGISTRY.roles.flatMap((spec) => [
      `:root ${spec.selector}`,
      `:root ${spec.hoverSelector ?? `${spec.selector}:hover`}`,
    ]),
    ...APPEARANCE_REGISTRY.components.flatMap((spec) => {
      const base = `:root [data-rz="${spec.id}"][data-rz]${spec.scope === "workspace" ? ":not(.rz-studio *)" : ""}`;
      return [
        base,
        `${base}:hover`,
        `${base} .mark`,
        `${base} .mark::before, ${base} .mark::after`,
      ];
    }),
  ]);
  const rules = rulesOf(css);
  assert.ok(rules.length > 30);
  for (const rule of rules) {
    assert.ok(allowed.has(rule.selector), rule.selector);
  }
  for (const rule of rules.filter((r) => r.selector.includes("data-rz"))) {
    const id = /data-rz="([^"]+)"/.exec(rule.selector)[1];
    const spec = APPEARANCE_REGISTRY.components.find((c) => c.id === id);
    assert.ok(spec, id);
    assert.equal(
      rule.selector.includes(":not(.rz-studio *)"),
      spec.scope === "workspace",
      rule.selector,
    );
  }
  // Workspace roles stay outside the studio too.
  for (const spec of APPEARANCE_REGISTRY.roles) {
    assert.equal(
      spec.selector.endsWith(":not(.rz-studio *)"),
      spec.scope === "workspace",
      spec.id,
    );
  }
  // Media blocks are exactly the three breakpoints.
  assert.deepEqual(
    [...new Set(rules.map((rule) => rule.media).filter(Boolean))].sort(),
    [
      "@media (max-width: 700px)",
      "@media (min-width: 701px) and (max-width: 980px)",
      "@media (min-width: 981px)",
    ],
  );
});

test("SC-5 instance declarations end !important; token, type-role and role declarations never do", () => {
  for (const rule of rulesOf(compile(BROAD))) {
    const instance = rule.selector.includes("[data-rz=");
    for (const [property, value] of rule.declarations) {
      assert.equal(
        value.endsWith(" !important"),
        instance,
        `${rule.selector} ${property}`,
      );
    }
  }
});

test("SC-6 only allow-listed properties are emitted, and nothing can hide, move, clip or outline an element", () => {
  const properties = new Set(
    rulesOf(compile(BROAD)).flatMap((rule) =>
      rule.declarations.map(([property]) => property),
    ),
  );
  const allowed = new Set([
    ...APPEARANCE_REGISTRY.tokens.map((spec) => spec.cssName),
    "--e2",
    "--rz-ink-hover",
    "--rz-on-ink",
    "--rz-surface-hover",
    "color",
    "background",
    "border-color",
    "border-radius",
    "border-width",
    "border-style",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-right-color",
    "border-bottom-width",
    "border-bottom-style",
    "border-bottom-color",
    "font-family",
    "font-weight",
    "font-size",
    "line-height",
    "letter-spacing",
    "text-transform",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "gap",
    "box-shadow",
    "height",
    // the logo mark only:
    "width",
    "display",
  ]);
  for (const property of properties) {
    assert.ok(allowed.has(property), property);
  }
  for (const banned of [
    "visibility",
    "opacity",
    "position",
    "z-index",
    "overflow",
    "clip",
    "clip-path",
    "outline",
    "transform",
    "content",
    "pointer-events",
  ]) {
    assert.equal(properties.has(banned), false, banned);
  }
  // display and width appear only on the logo mark, and display only hides
  // the mark's two drawn circles.
  for (const rule of rulesOf(compile(BROAD))) {
    for (const [property, value] of rule.declarations) {
      if (property === "display") {
        assert.match(rule.selector, /\.mark::before, .*\.mark::after$/);
        assert.equal(value, "none !important");
      }
      if (property === "width") {
        assert.match(rule.selector, / \.mark$/);
      }
    }
  }
});

test("SC-7 tokens: overrides on the design roots, fonts and elevation from fixed tables, and the three hooks derived only from an overridden source", () => {
  const css = compile(BROAD);
  const rules = rulesOf(css);
  const site = rules.find((r) => r.selector === ":root .rz:not(.rz .rz)");
  assert.deepEqual(site.declarations, [
    ["--ink", "#1c1917"],
    ["--page", "#fffefc"],
    ["--accent", "#0f5f5a"],
    ["--r", "10px"],
    [
      "--f-display",
      '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    ],
    ["--f-body", 'system-ui, -apple-system, "Segoe UI", sans-serif'],
    ["--e1", "none"],
    [
      "--e2",
      "0 1px 1px rgba(15, 16, 19, 0.03), 0 1px 3px rgba(15, 16, 19, 0.05)",
    ],
    ["--rz-ink-hover", mixHex("#1c1917", "#ffffff", 0.09)],
    ["--rz-on-ink", "#ffffff"],
    ["--rz-surface-hover", mixHex("#fffefc", "#1c1917", 0.012)],
  ]);
  const workspace = rules.find(
    (r) => r.selector === ":root .rzw:not(.rzw .rzw)",
  );
  assert.deepEqual(workspace.declarations, [
    ["--ink", "#14161a"],
    ["--canvas", "#f9f9f7"],
    ["--st-r", "12px"],
    [
      "--e1",
      "0 1px 2px rgba(15, 16, 19, 0.04), 0 8px 20px -6px rgba(15, 16, 19, 0.1)",
    ],
    [
      "--e2",
      "0 1px 2px rgba(15, 16, 19, 0.04), 0 4px 8px -2px rgba(15, 16, 19, 0.04), 0 22px 48px -12px rgba(15, 16, 19, 0.18)",
    ],
    ["--rz-ink-hover", mixHex("#14161a", "#ffffff", 0.09)],
    ["--rz-on-ink", "#ffffff"],
  ]);
  // A light ink takes the owner's dark ink as its text colour.
  const light = rulesOf(
    compile({
      schema: 1,
      tokens: { site: { ink: "#3a5bd9", page: "#ffffff" } },
    }),
  );
  assert.ok(contrastRatio("#3a5bd9", "#ffffff") >= 4.5);
  assert.deepEqual(
    light[0].declarations.find(([p]) => p === "--rz-on-ink"),
    ["--rz-on-ink", "#ffffff"],
  );
  const pale = valid({ schema: 1, tokens: { workspace: { ink: "#8fa0c0" } } });
  const paleRules = rulesOf(compileAppearanceCss(pale, APPEARANCE_REGISTRY));
  assert.deepEqual(
    paleRules[0].declarations.find(([p]) => p === "--rz-on-ink"),
    ["--rz-on-ink", "#0f1013"],
  );
  // Without an ink or page override no hook is emitted.
  const accentOnly = compile({
    schema: 1,
    tokens: { site: { accent: "#0f5f5a" } },
  });
  assert.doesNotMatch(accentOnly, /--rz-/);
});

test("SC-8 interactive kinds always carry their hover colour: explicit, else derived (background) or the base value (text, border)", () => {
  const rules = rulesOf(compile(BROAD));
  const find = (selector) => rules.find((r) => r.selector === selector);
  const primary = find(':root .rz .btn-ink:not([aria-disabled="true"]):hover');
  assert.deepEqual(primary.declarations, [
    ["background", mixHex("#0f5f5a", "#ffffff", 0.09)],
  ]);
  assert.deepEqual(find(":root .rz .link:hover").declarations, [
    ["color", "#0f5f5a"],
  ]);
  assert.deepEqual(
    find(":root .rzw .btn-line:not(.rz-studio *):hover").declarations,
    [
      ["color", "#14161a"],
      ["border-color", "#14161a"],
    ],
  );
  assert.deepEqual(
    find(':root [data-rz="site.header.nav"][data-rz]:hover').declarations,
    [["color", "#0f1013 !important"]],
  );
  // A light background derives its hover towards the effective ink.
  assert.deepEqual(
    find(':root [data-rz="home.attorneys.explore"][data-rz]:hover')
      .declarations,
    [
      ["color", "#0f1013 !important"],
      ["background", `${mixHex("#ffffff", "#1c1917", 0.03)} !important`],
    ],
  );
  // Non-interactive kinds never get a hover rule.
  for (const rule of rules.filter((r) => r.selector.endsWith(":hover"))) {
    const id = /data-rz="([^"]+)"/.exec(rule.selector)?.[1];
    const kind =
      id === undefined
        ? APPEARANCE_REGISTRY.roles.find(
            (spec) =>
              rule.selector ===
              `:root ${spec.hoverSelector ?? `${spec.selector}:hover`}`,
          ).kind
        : APPEARANCE_REGISTRY.components.find((spec) => spec.id === id).kind;
    assert.ok(["button", "link", "nav", "chip"].includes(kind), rule.selector);
  }
});

test("SC-9 the only url() is the same-origin asset route for a validated digest, and the logo applies to every brand instance", () => {
  const css = compile(BROAD);
  const urls = [...css.matchAll(/url\(/g)];
  const routes = [
    ...css.matchAll(
      /url\("\/appearance\/assets\/([0-9a-f]{64})\.(png|jpg|webp)"\)/g,
    ),
  ];
  assert.equal(urls.length, routes.length);
  assert.ok(routes.some(([, sha, ext]) => sha === SHA && ext === "webp"));
  assert.ok(routes.some(([, sha, ext]) => sha === SHA_LOGO && ext === "png"));
  assert.doesNotMatch(
    css,
    /https?:|\/\/[a-z]|data:|javascript:|@import|expression\(|\\/i,
  );
  const brands = APPEARANCE_REGISTRY.components.filter(
    (c) => c.kind === "brand",
  );
  assert.deepEqual(
    brands.map((c) => c.id),
    [
      "site.header.brand",
      "site.footer.brand",
      "attorney.sidebar.brand",
      "staff.sidebar.brand",
    ],
  );
  const rules = rulesOf(css);
  for (const brand of brands) {
    const base = `:root [data-rz="${brand.id}"][data-rz]${brand.scope === "workspace" ? ":not(.rz-studio *)" : ""}`;
    assert.deepEqual(
      rules.find((r) => r.selector === `${base} .mark`).declarations,
      [
        ["width", "96px !important"],
        ["height", "24px !important"],
        [
          "background",
          `url("/appearance/assets/${SHA_LOGO}.png") left center / contain no-repeat !important`,
        ],
      ],
    );
    // The wordmark is hidden visually only; the links keep their names.
    assert.deepEqual(rules.find((r) => r.selector === base).declarations, [
      ["font-size", "0 !important"],
      ["gap", "0 !important"],
    ]);
  }
});

test("SC-10 injection payloads never reach the output: the validator refuses them, and an unvalidated value makes the compiler throw", () => {
  const payloads = [
    "#fff;}body{display:none}",
    "#ffffff;}",
    "</style><script>",
    "red",
    "#FFFFFF",
    "#fff",
    "\\0066\\0066",
    "expression(alert(1))",
    "url(javascript:x)",
    "@import url(x)",
  ];
  for (const payload of payloads) {
    for (const raw of [
      { schema: 1, tokens: { site: { ink: payload } } },
      { schema: 1, roles: { "role.link": { color: { text: payload } } } },
      {
        schema: 1,
        components: {
          "home.ways": { background: { type: "color", color: payload } },
        },
      },
      { schema: 1, type: { "type.h2": { color: payload } } },
    ]) {
      assert.equal(validateWithRegistry(raw, "draft").ok, false, payload);
    }
  }
  for (const raw of [
    { schema: 1, tokens: { site: { fontDisplay: '"Comic Sans"' } } },
    { schema: 1, roles: { "role.panel": { border: { radius: "10px;x" } } } },
    { schema: 1, components: { "home.ways": { style: "display:none" } } },
    { schema: 1, components: { "home.ways": { display: "none" } } },
    { schema: 1, components: { 'home.ways"]{}*': {} } },
    {
      schema: 1,
      components: {
        "home.hero.figure": {
          background: {
            type: "image",
            asset: { sha256: "../../x", format: "png" },
            fit: "cover",
            position: "center",
          },
        },
      },
    },
  ]) {
    assert.equal(validateWithRegistry(raw, "draft").ok, false);
  }
  // A configuration this process never validated is refused outright, even
  // when it looks valid.
  assert.throws(
    () => compileAppearanceCss({ schema: 1 }, APPEARANCE_REGISTRY),
    UNSAFE,
  );
  assert.throws(
    () =>
      compileAppearanceCss(
        {
          schema: 1,
          tokens: { site: { ink: "#fff;}body{display:none}" } },
        },
        APPEARANCE_REGISTRY,
      ),
    UNSAFE,
  );
  // Defence in depth: a registry whose id or selector could break out of a
  // rule makes the compiler throw even for a validated configuration.
  const forgedId = {
    ...APPEARANCE_REGISTRY,
    components: [
      {
        ...APPEARANCE_REGISTRY.components.find((c) => c.id === "home.ways"),
        id: 'home.ways"]{}body',
      },
    ],
  };
  const forgedConfig = validateAppearance(
    {
      schema: 1,
      components: {
        'home.ways"]{}body': {
          background: { type: "color", color: "#ffffff" },
        },
      },
    },
    forgedId,
    "draft",
  );
  assert.equal(forgedConfig.ok, true);
  assert.throws(
    () => compileAppearanceCss(forgedConfig.value, forgedId),
    UNSAFE,
  );
  const forgedSelector = {
    ...APPEARANCE_REGISTRY,
    roles: [
      {
        ...APPEARANCE_REGISTRY.roles.find((r) => r.id === "role.link"),
        selector: ".rz .link{}body",
        hoverSelector: undefined,
      },
    ],
  };
  const linkConfig = validateAppearance(
    { schema: 1, roles: { "role.link": { color: { text: "#0f5f5a" } } } },
    forgedSelector,
    "draft",
  );
  assert.equal(linkConfig.ok, true);
  assert.throws(
    () => compileAppearanceCss(linkConfig.value, forgedSelector),
    UNSAFE,
  );
});

test("SC-11 serialization: px without trailing zeros, line height with two decimals, letter spacing with three, gradient angles in degrees", () => {
  const css = compile(BROAD);
  assert.match(css, /font-size: 72px;/);
  assert.match(css, /line-height: 1\.02;/);
  assert.match(css, /letter-spacing: -0\.030em;/);
  assert.match(css, /letter-spacing: 0\.040em;/);
  assert.match(css, /line-height: 1\.65;/);
  assert.match(
    css,
    /background: linear-gradient\(180deg, #ffffff, #f6f5f2\) !important;/,
  );
  assert.match(
    css,
    /background: url\("\/appearance\/assets\/c{64}\.webp"\) center \/ cover no-repeat !important;/,
  );
  assert.match(css, /border-top-width: 0px !important;/);
  assert.doesNotMatch(css, /border-top-style/);
  assert.match(
    css,
    /border-bottom-width: 1px !important;\n {2}border-bottom-style: solid !important;/,
  );
  assert.match(css, /box-shadow: var\(--e1\) !important;/);
  assert.match(css, /box-shadow: var\(--e2\);/);
});
