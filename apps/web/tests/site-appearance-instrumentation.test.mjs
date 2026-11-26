// DEV-001 website and appearance studio: the owner design's instrumentation
// (studio specification sections 1.4, 1.6, 2.1 to 2.8 and 5.4).
//
// Source contracts over the real files and the real presentation registry,
// read as text, with no renderer. They prove that the defaults are the
// owner's design and that protected items stay out of reach:
// - every registry instance is a literal data-rz id on an element of its
//   declared file, right after its class; every data-rz, data-rz-slot and
//   data-rz-section literal in the app is in the registry; no id is computed;
// - every text slot renders through SlotText on its own element, the
//   registry's defaults are exactly the design's text, and no slot or
//   section exists outside Home (the content pages stay gated);
// - no stylesheet selects a data-rz attribute; the three hook tokens are
//   defined by no stylesheet, and the wrappers are exactly the listed ones
//   with the owner's values as fallbacks; the registry's token defaults are
//   the owner's roots;
// - protected items carry no data-rz: forms and their controls, the
//   booking panel, the Talk Now block, placeholders, and every protected
//   file; the hero, the available-now and legal-issue sections are always
//   rendered, whatever a stored configuration says.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  appearanceTextAllowed,
  KIND_RULES,
  groupsOfKind,
  sectionOrderOf,
} from "../src/application/appearance-schema.ts";
import {
  APPEARANCE_REGISTRY,
  HOME_SECTIONS,
} from "../src/presentation/appearance/registry.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = [...filesIn("app/"), ...filesIn("src/")].filter((file) =>
  /\.tsx?$/.test(file),
);
const tsx = sources.filter((file) => file.endsWith(".tsx"));
const styles = [
  "app/globals.css",
  ...filesIn("app/styles/").filter((f) => f.endsWith(".css")),
];

// Every JSX opening tag of a source that carries a data-rz attribute: its
// tag name, its attributes in order (name and raw value) and its position.
function instrumentedTags(source) {
  const tags = [];
  const code = codeOf(source);
  let at = code.indexOf("data-rz");
  while (at !== -1) {
    const open = code.lastIndexOf("<", at);
    const tag = /^<([A-Za-z][\w.]*)/.exec(code.slice(open));
    assert.ok(tag, `a tag opens before ${code.slice(at, at + 40)}`);
    // Read the attributes from the tag name to the end of the tag.
    const attributes = [];
    let index = open + tag[0].length;
    for (;;) {
      while (/\s/.test(code[index])) index += 1;
      if (code[index] === ">" || code.startsWith("/>", index)) break;
      const name = /^[A-Za-z][\w-]*/.exec(code.slice(index))[0];
      index += name.length;
      let value = null;
      if (code[index] === "=") {
        index += 1;
        const start = index;
        if (code[index] === '"') {
          index = code.indexOf('"', index + 1) + 1;
        } else {
          assert.equal(code[index], "{", `${name} value`);
          let depth = 0;
          do {
            if (code[index] === "{") depth += 1;
            if (code[index] === "}") depth -= 1;
            index += 1;
          } while (depth > 0);
        }
        value = code.slice(start, index);
      }
      attributes.push([name, value]);
    }
    tags.push({ name: tag[1], attributes, end: index });
    at = code.indexOf("data-rz", index);
  }
  return tags;
}

const literal = (value) => {
  assert.match(value, /^"[^"]*"$/, `a literal: ${value}`);
  return value.slice(1, -1);
};

const instrumented = new Map(
  tsx.map((file) => [file, instrumentedTags(read(file))]),
);

test("SI-1 every registry instance is a literal data-rz on an element of its declared file, right after the class; ids are unique and grammatical", () => {
  const ids = APPEARANCE_REGISTRY.components.map((spec) => spec.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const spec of APPEARANCE_REGISTRY.components) {
    assert.match(spec.id, /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){0,3}$/);
    assert.ok(spec.id.length <= 64);
    const tags = instrumented.get(spec.file);
    assert.ok(tags, `${spec.id}: ${spec.file}`);
    assert.ok(
      tags.some((tag) =>
        tag.attributes.some(
          ([name, value]) => name === "data-rz" && literal(value) === spec.id,
        ),
      ),
      `${spec.id} in ${spec.file}`,
    );
    // Its groups are exactly its kind's allow-list.
    assert.deepEqual(spec.groups, groupsOfKind(spec.kind), spec.id);
    assert.ok(Object.hasOwn(KIND_RULES, spec.kind), spec.id);
  }
  for (const [file, tags] of instrumented) {
    for (const tag of tags) {
      const names = tag.attributes.map(([name]) => name);
      const first = names.findIndex((name) => name.startsWith("data-rz"));
      // className first, then data-rz, then (optionally) the slot and the
      // section attributes, each a literal equal to the data-rz id.
      assert.equal(names[0], "className", `${file} <${tag.name}>`);
      assert.equal(first, 1, `${file} <${tag.name}> ${names.join(" ")}`);
      assert.equal(names[1], "data-rz", `${file} <${tag.name}>`);
      const id = literal(tag.attributes[1][1]);
      let index = 2;
      for (const extra of ["data-rz-slot", "data-rz-section"]) {
        if (names[index] === extra) {
          assert.equal(literal(tag.attributes[index][1]), id, `${file} ${id}`);
          index += 1;
        }
      }
      assert.ok(
        names.slice(index).every((name) => !name.startsWith("data-rz")),
        `${file} ${id}`,
      );
    }
  }
});

test("SI-2 every data-rz, data-rz-slot and data-rz-section literal in the app is in the registry, in the file the registry names; none is computed", () => {
  const known = new Map(
    APPEARANCE_REGISTRY.components.map((spec) => [spec.id, spec]),
  );
  // DEV-001: website & appearance studio: the preview bridge names the
  // attributes in exactly its constant lines below (checked after this loop).
  const BRIDGE = "src/presentation/appearance/preview-bridge.ts";
  for (const file of sources.filter((f) => f !== BRIDGE)) {
    const code = codeOf(read(file));
    assert.doesNotMatch(code, /data-rz(?:-slot|-section)?=\{/, file);
    assert.doesNotMatch(code, /["']data-rz/, file);
  }
  for (const [file, tags] of instrumented) {
    for (const tag of tags) {
      const id = literal(tag.attributes[1][1]);
      assert.ok(known.has(id), `${file}: ${id}`);
      assert.equal(known.get(id).file, file, id);
    }
  }
  // No other source (a .ts module) writes the attribute; the compiler only
  // selects it, in its one instance selector, with a registry id.
  for (const file of sources.filter((f) => f.endsWith(".ts"))) {
    const code = codeOf(read(file));
    if (file === "src/presentation/appearance/compiler.ts") {
      assert.deepEqual(code.match(/.*data-rz.*/g), [
        '  return `:root [data-rz="${id}"][data-rz]${scope === "workspace" ? OUTSIDE_STUDIO : ""}`;',
      ]);
      continue;
    }
    // DEV-001: website & appearance studio: the preview bridge reads the
    // three instrumented attributes and sets only its own studio marks
    // (selection, hover, the section order approximation), never an id.
    if (file === BRIDGE) {
      assert.deepEqual(code.match(/.*data-rz.*/g), [
        'const ELEMENT = "data-rz";',
        'const SLOT = "data-rz-slot";',
        'const SECTION = "data-rz-section";',
        'const SELECTED = "data-rz-studio-selected";',
        'const HOVERED = "data-rz-studio-hovered";',
        'const ORDERED = "data-rz-studio-order";',
        'const PLACE = "data-rz-studio-place";',
      ]);
      assert.deepEqual(
        [
          ...code.matchAll(/\.(?:set|remove|toggle)Attribute\(\s*([A-Za-z]+)/g),
        ].map((m) => m[1]),
        [
          "attribute",
          "attribute",
          "PLACE",
          "ORDERED",
          "ORDERED",
          "PLACE",
          "PLACE",
        ],
      );
      assert.deepEqual(
        [...code.matchAll(/\bmark\(([A-Z]+),/g)].map((m) => m[1]).sort(),
        ["HOVERED", "HOVERED", "HOVERED", "SELECTED", "SELECTED"],
      );
      assert.doesNotMatch(code, /setAttributeNS|\.dataset\b/);
      continue;
    }
    assert.doesNotMatch(code, /data-rz=/, file);
  }
});

const SLOT_DEFAULTS = Object.freeze({
  "home.hero.title": "Talk to a lawyer\nin minutes.",
  "home.hero.lead":
    "Describe what’s going on in plain words. Meet an attorney now, or book a time that suits you.",
  "home.available.browse": "Browse all attorneys",
  "home.ways.kicker": "Two ways to consult",
  "home.ways.title": "Talk now, or at a time that suits you.",
  "home.ways.now.title": "When you’d like answers today",
  "home.ways.now.link": "See who’s available",
  "home.ways.schedule.title": "When you’d rather plan ahead",
  "home.ways.schedule.link": "Browse open times",
  "home.how.kicker": "How Rosuno works",
  "home.how.title": "From a question to a conversation.",
  "home.issues.kicker": "Browse by legal issue",
  "home.issues.title": "Not sure what to search for?",
  "home.issues.lead":
    "Pick the area that sounds closest and start from a familiar situation.",
  "home.attorneys.title": "Are you an attorney?",
  "home.attorneys.body":
    "Manage consultations, availability and requests with Rosuno.",
  "home.attorneys.apply": "Apply to join",
  "home.attorneys.explore": "Explore Rosuno for attorneys",
});

test("SI-3 the eighteen Home slots: defaults are exactly the design's text, each renders through SlotText on its own element as often as the registry says, and no slot text stays hard-coded", () => {
  assert.deepEqual(
    Object.fromEntries(
      APPEARANCE_REGISTRY.slots.map((slot) => [slot.id, slot.defaultText]),
    ),
    SLOT_DEFAULTS,
  );
  const page = codeOf(read("app/page.tsx"));
  for (const slot of APPEARANCE_REGISTRY.slots) {
    assert.equal(slot.page, "public.home", slot.id);
    assert.ok(appearanceTextAllowed(slot.defaultText), slot.id);
    assert.ok([...slot.defaultText].length <= slot.max, slot.id);
    assert.ok(slot.defaultText.split("\n").length <= slot.lines, slot.id);
    // The element carries data-rz and data-rz-slot with the slot's id, and
    // holds the slot component with exactly that id.
    const pattern = new RegExp(
      `data-rz="${slot.id.replaceAll(".", "\\.")}"\\s+data-rz-slot="${slot.id.replaceAll(".", "\\.")}"[^>]*>\\s*<SlotText appearance=\\{appearance\\} id="${slot.id.replaceAll(".", "\\.")}" />`,
      "g",
    );
    assert.equal(page.match(pattern)?.length, slot.occurrences, slot.id);
    assert.equal(
      page.split(`<SlotText appearance={appearance} id="${slot.id}" />`)
        .length - 1,
      slot.occurrences,
      slot.id,
    );
    // The design's text is no longer written in the page itself.
    for (const line of slot.defaultText.split("\n")) {
      assert.equal(page.includes(line), false, `${slot.id}: ${line}`);
    }
    // Its own instance exists with the same id.
    assert.ok(
      APPEARANCE_REGISTRY.components.some((spec) => spec.id === slot.id),
      slot.id,
    );
  }
  // Slots render only on Home: no other source uses the slot component.
  assert.deepEqual(
    sources.filter((file) => /<SlotText\b/.test(codeOf(read(file)))),
    ["app/page.tsx"],
  );
  // The slot component renders text nodes and its own <br /> only.
  const slot = codeOf(read("src/presentation/appearance/slot.tsx"));
  assert.doesNotMatch(
    slot,
    /dangerouslySetInnerHTML|innerHTML|style=|className=|href=/,
  );
  assert.match(
    slot,
    /slotTextOf\(appearance, slotSpecOf\(id\)\)\.split\("\\n"\)/,
  );
  assert.equal(slot.match(/<br \/>/g).length, 1);
});

test("SI-4 regulated and protected text is never a slot, and only Home has slots and sections (the gated content pages have none)", () => {
  const slotIds = APPEARANCE_REGISTRY.slots.map((slot) => slot.id);
  assert.deepEqual(slotIds, Object.keys(SLOT_DEFAULTS));
  for (const page of APPEARANCE_REGISTRY.pages) {
    assert.equal(page.slots, page.id === "public.home", page.id);
    assert.equal(page.sections, page.id === "public.home", page.id);
  }
  assert.deepEqual(
    APPEARANCE_REGISTRY.sectionGroups.map((group) => group.id),
    ["home.sections"],
  );
  const page = read("app/page.tsx");
  // Process statements, status names, the neutral-order statement, the
  // legal examples note and the hero status claim stay fixed text.
  for (const fixed of [
    "Talk to an attorney right now",
    "These attorneys can take a consultation request at this moment.",
    "Available now",
    "Talk now",
    "Schedule",
    "Listed in no particular order — not ranked or recommended.",
    "Examples only — choosing an area isn’t legal advice or a legal",
    "Four simple steps. Nothing is confirmed until the attorney",
    "It’s confirmed only once the attorney accepts.",
    "Video or audio, right in your browser",
    "Attorneys turn on Talk Now when they’re ready to take requests.",
  ]) {
    assert.ok(page.includes(fixed), fixed);
  }
  // The gated content pages and their statements have no slot or section.
  for (const file of [
    "src/application/public-content.ts",
    "src/presentation/public-site.tsx",
    "app/how-it-works/page.tsx",
    "app/about/page.tsx",
    "app/contact/page.tsx",
    "app/terms/page.tsx",
    "app/disclosures/page.tsx",
    "app/for-attorneys/page.tsx",
  ]) {
    assert.doesNotMatch(read(file), /data-rz-slot|data-rz-section|SlotText/);
  }
  // Every page that renders a slot or a section group awaits connection().
  for (const file of sources) {
    const code = codeOf(read(file));
    if (/<SlotText\b|sectionOrderOf\(/.test(code) && file.startsWith("app/")) {
      assert.match(code, /await connection\(\);/, file);
    }
  }
});

test("SI-5 the Home section group: the hero fixed first, only the two-ways, how-it-works and attorney sections hideable, and a forged configuration can never hide or move a fixed or protected section", () => {
  assert.deepEqual(
    HOME_SECTIONS.sections.map((s) => [
      s.id,
      s.fixed,
      s.reorderable,
      s.hideable,
    ]),
    [
      ["home.hero", "first", false, false],
      ["home.available", null, true, false],
      ["home.ways", null, true, true],
      ["home.how", null, true, true],
      ["home.issues", null, true, false],
      ["home.attorneys", null, true, true],
    ],
  );
  for (const section of HOME_SECTIONS.sections) {
    if (!section.hideable) {
      assert.ok(section.reason, section.id);
    }
  }
  const all = HOME_SECTIONS.sections.map((s) => s.id);
  assert.deepEqual(sectionOrderOf(null, HOME_SECTIONS), all);
  for (const forged of [
    { sections: { "home.sections": { hidden: all } } },
    {
      sections: {
        "home.sections": {
          order: ["home.hero", "home.attorneys"],
          hidden: ["home.hero", "home.available", "home.issues"],
        },
      },
    },
    { sections: { "home.sections": { order: [...all].reverse() } } },
  ]) {
    const order = sectionOrderOf(forged, HOME_SECTIONS);
    assert.equal(order[0], "home.hero");
    for (const kept of ["home.hero", "home.available", "home.issues"]) {
      assert.ok(order.includes(kept), kept);
    }
  }
  assert.deepEqual(
    sectionOrderOf(
      {
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
      },
      HOME_SECTIONS,
    ),
    ["home.hero", "home.available", "home.how", "home.ways", "home.issues"],
  );
  // Home renders exactly the group's sections, in the resolved order, each
  // section's root carrying its own id.
  const page = codeOf(read("app/page.tsx"));
  assert.match(
    page,
    /\{sectionOrderOf\(configuration, HOME_SECTIONS\)\.map\(\(id\) => sections\[id\]\)\}/,
  );
  const map = page.slice(
    page.indexOf("const sections: Readonly<Record<string, ReactNode>> = {"),
    page.indexOf("return (", page.indexOf("const sections:")),
  );
  assert.deepEqual(
    [...map.matchAll(/^ {4}"(home\.[a-z]+)":/gm)].map((m) => m[1]),
    all,
  );
  for (const id of all) {
    assert.equal(
      page.split(`data-rz-section="${id}"`).length - 1,
      1,
      `${id} section root`,
    );
    assert.match(map, new RegExp(`key="${id.replace(".", "\\.")}"`), id);
  }
  // DEV-001: website & appearance studio: the published configuration, or
  // in the studio's preview mode (exactly rz-preview=1, read with the other
  // query value) the editor's saved draft, as the use case decides for a
  // holder of manage_site_appearance; validated against the registry, read
  // once after the session and the directory.
  assert.equal(
    page.split(
      'await resolvePageAppearance(\n    APPEARANCE_SOURCES,\n    validateWithRegistry,\n    previewValue === "1",\n  );',
    ).length,
    2,
  );
  assert.equal(
    page.split(
      'const { jurisdiction, "rz-preview": previewValue } = await searchParams;',
    ).length,
    2,
  );
  assert.equal(page.match(/previewValue/g).length, 2);
  assert.ok(
    page.indexOf("await homeDirectory(jurisdiction)") <
      page.indexOf("await resolvePageAppearance("),
  );
  assert.doesNotMatch(page, /searchParams\[/);
});

test("SI-6 no stylesheet selects a data-rz attribute; the three hook tokens are defined by no stylesheet; the wrappers are exactly the listed ones, with the owner's values as fallbacks", () => {
  // DEV-001: website & appearance studio: the one declaration of a hook in
  // the repository is the studio root's reset of all three to the
  // guaranteed-invalid value (initial), so inside the studio every wrapped
  // owner rule computes its own literal fallback, exactly as with nothing
  // published; no stylesheet gives a hook a value.
  const STUDIO_HOOK_RESET = [
    "  --rz-on-ink: initial;\n",
    "  --rz-ink-hover: initial;\n",
    "  --rz-surface-hover: initial;\n",
  ].join("");
  for (const file of styles) {
    const css = read(file);
    assert.doesNotMatch(css, /\[data-rz/, file);
    const hooks = css.match(/--rz-(?:on-ink|ink-hover|surface-hover)\s*:/g);
    if (file !== "app/styles/product-staff.css") {
      assert.equal(hooks, null, file);
      continue;
    }
    assert.equal(hooks.length, 3, file);
    assert.equal(css.split(STUDIO_HOOK_RESET).length, 2, file);
    const start = css.indexOf("\n.W.st .rz-studio {\n");
    assert.ok(start >= 0, file);
    assert.ok(
      css.indexOf(STUDIO_HOOK_RESET) > start &&
        css.indexOf(STUDIO_HOOK_RESET) < css.indexOf("}", start),
      file,
    );
  }
  // DEV-001: website & appearance studio (G3, the G2 carry-over): every
  // owner rule (and the canonical .rz-ink surface) that sets white text or an
  // icon on an ink fill now reads the on-ink hook, the literal unchanged as
  // its fallback; each wrapper is pinned with its file, its rule and its
  // declaration.
  const wrapped = styles.flatMap((file) =>
    [
      ...read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ].flatMap((m) =>
      m[2]
        .split(";")
        .map((declaration) => declaration.trim())
        .filter((declaration) => /var\(--rz-/.test(declaration))
        .map(
          (declaration) =>
            `${file} | ${m[1].trim().replace(/\s+/g, " ")} | ${declaration}`,
        ),
    ),
  );
  assert.deepEqual(wrapped, [
    "app/styles/attorney.css | .W .w-chd.today > b | color: var(--rz-on-ink, #fff)",
    "app/styles/attorney.css | .W .w-mc.today .w-mcn | color: var(--rz-on-ink, #fff)",
    "app/styles/attorney.css | .W .w-mb.me | color: var(--rz-on-ink, #fff)",
    "app/styles/client.css | .cx .cx-chip.on | color: var(--rz-on-ink, #fff)",
    "app/styles/client.css | .cx .cx-chip2.on | color: var(--rz-on-ink, #fff)",
    "app/styles/client.css | .cx .cx-chip2.on svg | color: var(--rz-on-ink, #fff)",
    "app/styles/layout.css | .rz .l-fnone-w28-h28-r50pc-dgrid-picenter-7eb0e7, .rzw .l-fnone-w28-h28-r50pc-dgrid-picenter-7eb0e7 | color: var(--rz-on-ink, #fff) !important",
    "app/styles/layout.css | .rz .l-fnone-w32-h32-r50pc-dgrid-picenter-166ebb, .rzw .l-fnone-w32-h32-r50pc-dgrid-picenter-166ebb | color: var(--rz-on-ink, #fff) !important",
    "app/styles/layout.css | .rz .l-h26-bgink-cfff, .rzw .l-h26-bgink-cfff | color: var(--rz-on-ink, #fff) !important",
    "app/styles/layout.css | .rz .l-w28-h28-r50pc-dgrid-picenter-bgink-c8181b, .rzw .l-w28-h28-r50pc-dgrid-picenter-bgink-c8181b | color: var(--rz-on-ink, #fff) !important",
    "app/styles/layout.css | .rz .l-w30-h30-r50pc-dgrid-picenter-bgink-cfff, .rzw .l-w30-h30-r50pc-dgrid-picenter-bgink-cfff | color: var(--rz-on-ink, #fff) !important",
    "app/styles/product-staff.css | .W.st button.btn-ink | color: var(--rz-on-ink, #fff)",
    "app/styles/site.css | .rz .rz-ink | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .st-nav .w-ni.on | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .st-nav .w-ni.on svg | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .st-av | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .st-fn | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .pm-done .pm-dot | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .pm-do .btn-ink | color: var(--rz-on-ink, #fff)",
    "app/styles/staff.css | .W.st .p2-fb .btn-ink | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .btn-ink | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .btn-ink:hover | background: var(--rz-ink-hover, #24262b)",
    "app/styles/theme.css | .rz .btn-ink:hover | border-color: var(--rz-ink-hover, #24262b)",
    "app/styles/theme.css | .rz .btn-line:hover | background: var(--rz-surface-hover, #fcfcfb)",
    "app/styles/theme.css | .rz .opt-chip:hover | background: var(--rz-surface-hover, #fcfcfb)",
    "app/styles/theme.css | .rz .opt-chip.on | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .save.on | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .handoff .hi | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .cal .d.sel | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .qa.open .pm | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .fbtn.on | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .fbtn.on svg | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .stepper .done .sn | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .vstep.done .sn | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .nav-i .ct | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .wk .hd.today b | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .slot.on | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .gcard.on .cbx | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .kind.bk | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .cal-hd.today b | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .mc.today .mn | color: var(--rz-on-ink, #fff)",
    "app/styles/theme.css | .rz .life li.done .sn | color: var(--rz-on-ink, #fff)",
    "app/styles/workspace.css | .rzw .btn-ink | color: var(--rz-on-ink, #fff)",
    "app/styles/workspace.css | .rzw .btn-ink:hover | background: var(--rz-ink-hover, #26282e)",
    "app/styles/workspace.css | .rzw .btn-line:hover | background: var(--rz-surface-hover, #fcfcfb)",
    "app/styles/workspace.css | .rzw .kind.bk | color: var(--rz-on-ink, #fff)",
    "app/styles/workspace.css | .rzw .chip.on | color: var(--rz-on-ink, #fff)",
  ]);
  const rules = styles.flatMap((file) =>
    [
      ...read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ].map((m) => ({
      selectors: m[1].trim().replace(/\s+/g, " ").split(/,\s*/),
      body: m[2],
    })),
  );
  // Every on-ink wrapper sits on an ink fill: its own rule fills with ink,
  // its element carries the classes of an ink-filled rule (a staff button
  // keeping the shared primary button's fill), or its selector is inside a
  // rule that fills with ink; its fallback is the owner's white.
  const inkFill = /background(?:-color)?:\s*var\(--ink\)/;
  const inkSelectors = rules
    .filter((rule) => inkFill.test(rule.body))
    .flatMap((rule) => rule.selectors);
  const classesOf = (selector) =>
    selector
      .split(/[\s>]+/)
      .pop()
      .match(/\.[\w-]+/g) ?? [];
  for (const rule of rules.filter((r) => /var\(--rz-on-ink/.test(r.body))) {
    assert.ok(
      inkFill.test(rule.body) ||
        rule.selectors.every(
          (selector) =>
            inkSelectors.some((ink) => selector.startsWith(`${ink} `)) ||
            inkSelectors.some(
              (ink) =>
                classesOf(ink).length > 0 &&
                classesOf(ink).every((c) => classesOf(selector).includes(c)),
            ),
        ),
      rule.selectors.join(", "),
    );
    assert.deepEqual(
      [...rule.body.matchAll(/var\(--rz-on-ink, ([^)]+)\)/g)].map((m) => m[1]),
      ["#fff"],
      rule.selectors.join(", "),
    );
  }
  // Each wrapper sits in exactly its rule (studio specification 1.4).
  const rule = (file, selector) => {
    const css = read(file);
    const start = css.indexOf(`\n${selector} {\n`);
    assert.ok(start >= 0, `${file} ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };
  for (const [file, selector, declarations] of [
    [
      "app/styles/theme.css",
      ".rz .btn-ink",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/theme.css",
      ".rz .btn-ink:hover",
      [
        "background: var(--rz-ink-hover, #24262b);",
        "border-color: var(--rz-ink-hover, #24262b);",
      ],
    ],
    [
      "app/styles/theme.css",
      ".rz .btn-line:hover",
      ["background: var(--rz-surface-hover, #fcfcfb);"],
    ],
    [
      "app/styles/theme.css",
      ".rz .opt-chip:hover",
      ["background: var(--rz-surface-hover, #fcfcfb);"],
    ],
    [
      "app/styles/theme.css",
      ".rz .opt-chip.on",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/workspace.css",
      ".rzw .btn-ink",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/workspace.css",
      ".rzw .btn-ink:hover",
      ["background: var(--rz-ink-hover, #26282e);"],
    ],
    [
      "app/styles/workspace.css",
      ".rzw .btn-line:hover",
      ["background: var(--rz-surface-hover, #fcfcfb);"],
    ],
    [
      "app/styles/workspace.css",
      ".rzw .chip.on",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/staff.css",
      ".W.st .pm-do .btn-ink",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/staff.css",
      ".W.st .p2-fb .btn-ink",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/product-staff.css",
      ".W.st button.btn-ink",
      ["color: var(--rz-on-ink, #fff);"],
    ],
    [
      "app/styles/client.css",
      ".cx .cx-chip.on",
      ["color: var(--rz-on-ink, #fff);"],
    ],
  ]) {
    const body = rule(file, selector);
    for (const declaration of declarations) {
      assert.ok(
        body.includes(`  ${declaration}\n`),
        `${selector} ${declaration}`,
      );
    }
  }
  // The semantic success button keeps its own literal white.
  assert.ok(
    rule("app/styles/product-staff.css", ".W.st button.btn-ok").includes(
      "  color: #fff;\n",
    ),
  );
});

test("SI-7 the registry's token defaults are exactly the owner's roots", () => {
  const block = (file, selector) => {
    const css = read(file);
    const start = css.indexOf(`\n${selector} {\n`);
    assert.ok(start >= 0, selector);
    const body = css.slice(start, css.indexOf("\n}", start));
    return new Map(
      [...body.matchAll(/^ {2}(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [
        m[1],
        m[2].replace(/\s+/g, " ").trim(),
      ]),
    );
  };
  const roots = {
    site: block("app/styles/theme.css", ".rz:not(.rz .rz)"),
    workspace: block("app/styles/workspace.css", ".rzw:not(.rzw .rzw)"),
  };
  const staff = block("app/styles/staff.css", ".W.st");
  const fonts = {
    "instrument-sans": '"Instrument Sans", "Inter", system-ui, sans-serif',
    inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  };
  for (const spec of APPEARANCE_REGISTRY.tokens) {
    const root = spec.key === "staffRadius" ? staff : roots[spec.scope];
    switch (spec.type) {
      case "color":
        assert.equal(root.get(spec.cssName), spec.default, spec.key);
        break;
      case "length":
        assert.equal(root.get(spec.cssName), `${spec.default}px`, spec.key);
        break;
      case "font":
        assert.equal(root.get(spec.cssName), fonts[spec.default], spec.key);
        break;
      case "elevation":
        assert.equal(spec.default, "default");
        assert.ok(root.has("--e1") && root.has("--e2") && root.has("--e3"));
        break;
      default:
        assert.fail(spec.key);
    }
  }
  assert.deepEqual(
    APPEARANCE_REGISTRY.tokens
      .filter((spec) => spec.scope === "site")
      .map((spec) => spec.key),
    [
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
      "radius",
      "fontDisplay",
      "fontBody",
      "elevation",
    ],
  );
  // Status, semantic and layout tokens are not offered.
  for (const name of [
    "--live",
    "--live-ink",
    "--star",
    "--urgent",
    "--hold",
    "--no",
    "--chrome",
  ]) {
    assert.ok(
      !APPEARANCE_REGISTRY.tokens.some((spec) => spec.cssName === name),
      name,
    );
  }
});

test("SI-8 protected items carry no data-rz: forms and controls, the booking panel, the Talk Now block, placeholders, and every protected file", () => {
  for (const [file, tags] of instrumented) {
    for (const tag of tags) {
      assert.ok(
        ![
          "form",
          "input",
          "select",
          "textarea",
          "button",
          "label",
          "fieldset",
          "dialog",
        ].includes(tag.name),
        `${file} <${tag.name}>`,
      );
      const className = tag.attributes[0][1];
      assert.doesNotMatch(
        className,
        /\b(?:ph|w-talk|pm2-r|rz-alert|signedout|aw-gate)\b/,
        `${file} ${className}`,
      );
    }
  }
  const protectedFiles = [
    "app/home-finder.tsx",
    ...sources.filter((file) =>
      /^app\/(?:sign-in|sign-up|forgot-password|reset-password|auth|account|client|attorney|staff|find-an-attorney\/select|api)\//.test(
        file,
      ),
    ),
    ...sources.filter((file) =>
      /(?:^|\/)(?:actions\.ts|forms\.tsx)$/.test(file),
    ),
    "src/presentation/design-system.tsx",
    "src/presentation/workspace-navigation.tsx",
  ];
  for (const file of protectedFiles) {
    assert.doesNotMatch(codeOf(read(file)), /data-rz/, file);
  }
  // The files that do carry ids are exactly the registry's files.
  assert.deepEqual(
    [...instrumented]
      .filter(([, tags]) => tags.length > 0)
      .map(([file]) => file),
    [
      ...new Set(APPEARANCE_REGISTRY.components.map((spec) => spec.file)),
    ].sort(),
  );
  // The registry lists the protected areas for the studio's lock rows.
  assert.ok(APPEARANCE_REGISTRY.protectedAreas.length >= 10);
  for (const area of APPEARANCE_REGISTRY.protectedAreas) {
    assert.match(area.id, /^protected\.[a-z-]+$/);
    assert.ok(area.label && area.reason, area.id);
    assert.ok(
      !APPEARANCE_REGISTRY.components.some((spec) => spec.id === area.id),
    );
  }
});

test("SI-9 roles and type roles are the owner design's fixed selectors", () => {
  assert.deepEqual(
    APPEARANCE_REGISTRY.roles.map((spec) => [
      spec.id,
      spec.kind,
      spec.scope,
      spec.selector,
      spec.hoverSelector ?? null,
    ]),
    [
      [
        "role.button.primary",
        "button",
        "site",
        '.rz .btn-ink:not([aria-disabled="true"])',
        '.rz .btn-ink:not([aria-disabled="true"]):hover',
      ],
      [
        "role.button.secondary",
        "button",
        "site",
        ".rz .btn-line",
        ".rz .btn-line:hover",
      ],
      [
        "role.button.tertiary",
        "button",
        "site",
        ".rz .btn-quiet",
        ".rz .btn-quiet:hover",
      ],
      ["role.link", "link", "site", ".rz .link", ".rz .link:hover"],
      ["role.panel", "card", "site", ".rz .panel", null],
      ["role.well", "card", "site", ".rz .well", null],
      ["role.chip", "chip", "site", ".rz .opt-chip:not(.on)", null],
      ["role.client.card", "card", "site", ".cx .cx-card", null],
      [
        "ws.button.primary",
        "button",
        "workspace",
        '.rzw .btn-ink:not([aria-disabled="true"]):not(.rz-studio *)',
        '.rzw .btn-ink:not([aria-disabled="true"]):not(.rz-studio *):hover',
      ],
      [
        "ws.button.secondary",
        "button",
        "workspace",
        ".rzw .btn-line:not(.rz-studio *)",
        ".rzw .btn-line:not(.rz-studio *):hover",
      ],
      [
        "ws.button.tertiary",
        "button",
        "workspace",
        ".rzw .btn-quiet:not(.rz-studio *)",
        ".rzw .btn-quiet:not(.rz-studio *):hover",
      ],
      [
        "ws.link",
        "link",
        "workspace",
        ".rzw .link:not(.rz-studio *)",
        ".rzw .link:not(.rz-studio *):hover",
      ],
      [
        "ws.chip",
        "chip",
        "workspace",
        ".rzw .chip:not(.on):not(.rz-studio *)",
        null,
      ],
      ["ws.card", "card", "workspace", ".W .w-card:not(.rz-studio *)", null],
    ],
  );
  assert.deepEqual(
    APPEARANCE_REGISTRY.typeRoles.map((spec) => [
      spec.id,
      spec.selector,
      spec.defaults.size,
      ...spec.sizeRange,
      spec.colorAllowed,
      spec.transformAllowed,
    ]),
    [
      ["type.display", ".rz .display", 88, 32, 112, true, false],
      ["type.h2", ".rz .h2", 44, 24, 64, true, false],
      ["type.h3", ".rz .h3", 24, 18, 40, true, false],
      ["type.h4", ".rz .h4", 18, 14, 28, true, false],
      ["type.lead", ".rz .lead", 19, 15, 24, false, false],
      ["type.body", ".rz .body", 16, 14, 20, false, false],
      ["type.small", ".rz .sm", 14, 12, 17, false, false],
      ["type.meta", ".rz .xs", 12.5, 12, 15, false, false],
      ["type.kicker", ".rz .kicker", 13.5, 12, 16, true, true],
    ],
  );
  // Every type role's default size is its owner rule's size.
  const theme = read("app/styles/theme.css");
  for (const spec of APPEARANCE_REGISTRY.typeRoles) {
    const start = theme.indexOf(`\n${spec.selector} {\n`);
    const body = theme.slice(start, theme.indexOf("}", start));
    assert.ok(
      body.includes(`  font-size: ${spec.defaults.size}px;\n`),
      spec.id,
    );
  }
});

test("SI-10 the registry is frozen all the way down", () => {
  const walk = (value, at) => {
    if (value !== null && typeof value === "object") {
      assert.ok(Object.isFrozen(value), at);
      for (const [key, item] of Object.entries(value)) {
        walk(item, `${at}.${key}`);
      }
    }
  };
  walk(APPEARANCE_REGISTRY, "registry");
  assert.ok(Object.isFrozen(HOME_SECTIONS));
  assert.equal(APPEARANCE_REGISTRY.sectionGroups[0], HOME_SECTIONS);
});
