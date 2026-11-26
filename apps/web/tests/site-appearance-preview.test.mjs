// DEV-001 website and appearance studio: the studio's live preview (studio
// specification sections 5.3, 5.4, 5.6, 6.3, 7 and 8.1).
//
// The editor-only routes run from src/presentation/appearance/delivery.ts
// over synthetic, in-memory ports and the synthetic staff world (every id
// and configuration is test data); the loader, the bridge, the routes and
// the root layout are read as source. They prove:
// - the draft stylesheet and the editor status answer a holder of
//   manage_site_appearance only (anyone else 403, empty or {"editor":false}),
//   are never stored, read nothing of the request but its session, and fail
//   to the empty default sheet;
// - the loader does nothing outside preview mode, ends preview mode under a
//   foreign parent, blocks every activation in the capture phase before any
//   page listener (in a frame, before it even asks the server), asks the
//   server through the editor route only, and loads the bridge only for an
//   editor;
// - the bridge accepts one hello from its parent on this origin with one
//   port, reads every message through the protocol's guards, validates a
//   configuration itself before compiling it with the same compiler into a
//   constructable stylesheet, writes no markup, style attribute or inline
//   style, posts only on its port, and follows only preview addresses.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { APPEARANCE_CAPABILITY } from "../src/application/appearance.ts";
import { compileAppearanceCss } from "../src/presentation/appearance/compiler.ts";
import {
  DEFAULT_STYLESHEET,
  draftStylesheet,
  editorStatus,
} from "../src/presentation/appearance/delivery.ts";
import {
  APPEARANCE_REGISTRY,
  validateWithRegistry,
} from "../src/presentation/appearance/registry.ts";
import {
  addStaff,
  configurationSources,
  createWorld,
  grant,
  idOf,
} from "./configuration-fixtures.mjs";
import { SPEC_EXAMPLE } from "./site-appearance-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);

const rows = (list) => Object.freeze({ kind: "rows", rows: list });
const DRAFT = idOf(76, 1);
const headersOf = (response) => Object.fromEntries(response.headers.entries());

function world(preview) {
  const state = createWorld();
  const staff = addStaff(state, 1);
  const calls = [];
  const reads = {
    preview: async (theme) => {
      calls.push(["preview", theme]);
      return typeof preview === "function" ? preview() : preview;
    },
    published: async () => {
      calls.push(["published"]);
      return rows([]);
    },
  };
  return {
    calls,
    sources: {
      staff: configurationSources(state, staff.authId),
      reads: async () => reads,
      writes: async () => null,
      environment: () => ({
        configuredClass: "development",
        expectedProjectRef: null,
      }),
    },
    holder() {
      grant(state, staff.userId, APPEARANCE_CAPABILITY);
      return this;
    },
  };
}

test("SP-1 the draft stylesheet: the saved draft compiled for a holder, 403 and empty for anyone else, never stored, and the empty default sheet on any failure", async () => {
  const draftRow = rows([
    { version_id: DRAFT, revision: 3, configuration: SPEC_EXAMPLE },
  ]);
  const visitor = world(draftRow);
  const refused = await draftStylesheet(visitor.sources);
  assert.equal(refused.status, 403);
  assert.equal(await refused.text(), "");
  assert.equal(refused.headers.get("cache-control"), "private, no-store");
  assert.equal(
    visitor.calls.some(([name]) => name === "preview"),
    false,
  );
  const holder = world(draftRow).holder();
  const answer = await draftStylesheet(holder.sources);
  const expected = compileAppearanceCss(
    validateWithRegistry(SPEC_EXAMPLE, "draft").value,
    APPEARANCE_REGISTRY,
  );
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), expected);
  assert.deepEqual(headersOf(answer), {
    "cache-control": "private, no-store",
    "content-type": "text/css; charset=utf-8",
  });
  assert.deepEqual(
    holder.calls.filter(([name]) => name === "preview"),
    [["preview", "rosuno"]],
  );
  // A draft that does not validate (here: a forged colour) falls back to
  // the published version, here none: the default sheet.
  const forged = world(
    rows([
      {
        version_id: DRAFT,
        revision: 3,
        configuration: {
          schema: 1,
          tokens: { site: { ink: "#fff;}body{display:none" } },
        },
      },
    ]),
  ).holder();
  const fallback = await draftStylesheet(forged.sources);
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), DEFAULT_STYLESHEET);
  // An unreadable or throwing read: the default sheet, never stored.
  for (const broken of [
    Object.freeze({ kind: "unreadable" }),
    () => {
      throw new Error("synthetic");
    },
  ]) {
    const failing = await draftStylesheet(world(broken).holder().sources);
    assert.equal(failing.status, 200);
    assert.equal(await failing.text(), DEFAULT_STYLESHEET);
    assert.equal(failing.headers.get("cache-control"), "private, no-store");
  }
  // Nothing at all to read: the default sheet too.
  const none = await draftStylesheet({
    ...world(draftRow).holder().sources,
    reads: async () => null,
  });
  assert.equal(await none.text(), DEFAULT_STYLESHEET);
});

test("SP-2 the editor status: {editor:true} only for a holder of the global grant; everyone else, and any failure, {editor:false} with 403; never stored", async () => {
  const yes = await editorStatus(world(rows([])).holder().sources);
  assert.equal(yes.status, 200);
  assert.deepEqual(await yes.json(), { editor: true });
  assert.deepEqual(headersOf(yes), {
    "cache-control": "private, no-store",
    "content-type": "application/json",
  });
  const no = await editorStatus(world(rows([])).sources);
  assert.equal(no.status, 403);
  assert.deepEqual(await no.json(), { editor: false });
  assert.equal(no.headers.get("cache-control"), "private, no-store");
  const broken = await editorStatus({
    staff: {
      ...world(rows([])).holder().sources.staff,
      reads: async () => null,
    },
  });
  assert.equal(broken.status, 403);
  assert.deepEqual(await broken.json(), { editor: false });
});

test("SP-3 the two preview routes export GET and dynamic only, call their one delivery function with the appearance sources, and read nothing of the request", () => {
  for (const [file, call] of [
    [
      "app/appearance/draft.css/route.ts",
      "  return draftStylesheet(APPEARANCE_SOURCES);",
    ],
    [
      "app/appearance/editor/route.ts",
      "  return editorStatus(APPEARANCE_SOURCES);",
    ],
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.deepEqual(importsOf(source), [
      "../../../src/infrastructure/appearance/appearance-adapter.ts",
      "../../../src/presentation/appearance/delivery.ts",
    ]);
    assert.deepEqual(
      [
        ...code.matchAll(/^export (?:async function|function|const) (\w+)/gm),
      ].map((m) => m[1]),
      ["dynamic", "GET"],
    );
    assert.match(code, /^export const dynamic = "force-dynamic";$/m);
    assert.match(
      code,
      /^export async function GET\(\): Promise<Response> \{$/m,
    );
    assert.equal(code.split(call).length, 2, file);
    assert.doesNotMatch(
      code,
      /request|\.rpc\(|cookies|headers\(|searchParams|logRequestEvent|revalidate/i,
    );
  }
});

test("SP-4 the root layout renders the preview loader, which renders nothing and acts only in preview mode", () => {
  const layout = read("app/layout.tsx");
  assert.ok(
    importsOf(layout).includes(
      "../src/presentation/appearance/preview-loader.tsx",
    ),
  );
  assert.equal(layout.match(/<AppearancePreviewLoader \/>/g).length, 1);
  const source = read("src/presentation/appearance/preview-loader.tsx");
  const code = codeOf(source);
  assert.match(source, /^"use client";\n/);
  assert.deepEqual(importsOf(source), ["react", "./protocol.ts"]);
  // It renders nothing.
  assert.match(code, /export function AppearancePreviewLoader\(\): null \{/);
  assert.equal(code.match(/\n {2}return null;\n\}/g).length, 1);
  assert.doesNotMatch(
    code.slice(code.indexOf("export function AppearancePreviewLoader")),
    /</,
  );
  // Nothing outside preview mode; a foreign parent ends it.
  const effect = code.slice(code.indexOf("useEffect(() => {"));
  assert.ok(
    effect.startsWith(
      "useEffect(() => {\n    if (!isPreviewSearch(window.location.search)) {\n      return;\n    }\n    const framed = framedHere();\n    if (framed === null) {\n      return;\n    }\n",
    ),
  );
  assert.ok(
    code.includes(
      "return window.parent.location.origin === window.location.origin\n      ? true\n      : null;",
    ),
  );
  // In a frame, every activation is blocked before the server is asked.
  assert.ok(
    effect.indexOf("framed ? blockInteractions() : null") <
      effect.indexOf("isEditor(controller.signal)"),
  );
  // The server decides through the editor route only, same origin, never
  // stored; the bridge loads only for an editor.
  assert.ok(
    code.includes(
      'await fetch("/appearance/editor", {\n    credentials: "same-origin",\n    cache: "no-store",\n    signal,\n  });',
    ),
  );
  assert.equal(code.match(/fetch\(/g).length, 1);
  assert.ok(
    code.includes(
      'if (!editor || cancelled) {\n          return;\n        }\n        const { startPreviewBridge } = await import("./preview-bridge.ts");',
    ),
  );
  assert.equal(code.match(/import\(/g).length, 1);
  // The guard: capture-phase listeners that stop the event before any page
  // or React listener; submissions, clicks, Enter and Space on controls and
  // presses on form controls.
  assert.ok(
    code.includes(
      "event.preventDefault();\n    event.stopImmediatePropagation();",
    ),
  );
  assert.ok(code.includes("window.addEventListener(type, block, true);"));
  for (const type of [
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
    "submit",
    "keydown",
    "pointerdown",
    "mousedown",
  ]) {
    assert.ok(code.includes(`  "${type}",\n`), type);
  }
  assert.doesNotMatch(
    code,
    /innerHTML|style=|\.style\.|dangerouslySetInnerHTML|postMessage|localStorage|document\.cookie/,
  );
});

test("SP-5 the bridge accepts one hello from its parent on this origin with one port, reads every message through the guards, validates and compiles a configuration itself into a constructable stylesheet, writes no markup or style attribute, and posts only on its port", () => {
  const source = read("src/presentation/appearance/preview-bridge.ts");
  const code = codeOf(source);
  assert.match(source, /^"use client";\n/);
  assert.deepEqual(importsOf(source), [
    "../../application/appearance-schema.ts",
    "./compiler.ts",
    "./preview-loader.tsx",
    "./protocol.ts",
    "./registry.ts",
  ]);
  // The hello: once, from the parent window, this origin, one port.
  assert.ok(
    code.includes(
      "    if (\n      port !== null ||\n      event.origin !== window.location.origin ||\n      event.source !== window.parent ||\n      event.ports.length !== 1\n    ) {\n      return;\n    }\n    const hello = readHello(event.data);\n    if (hello === null) {\n      return;\n    }",
    ),
  );
  assert.ok(code.includes('window.removeEventListener("message", onHello);'));
  assert.equal(code.match(/addEventListener\("message"/g).length, 1);
  assert.ok(code.includes("const message = readStudioMessage(event.data);"));
  // A configuration is validated here, in draft mode, then compiled by the
  // same compiler into constructable stylesheets.
  const apply = code.slice(code.indexOf("const apply = (raw: unknown) => {"));
  assert.ok(
    apply.startsWith(
      'const apply = (raw: unknown) => {\n    const result = validateWithRegistry(raw, "draft");\n    if (!result.ok) {\n      return;\n    }\n    let css: string;\n    try {\n      css = compileAppearanceCss(result.value, REGISTRY);\n    } catch {\n      return;\n    }\n    live.replaceSync(css);',
    ),
  );
  assert.equal(code.match(/new CSSStyleSheet\(\)/g).length, 3);
  assert.ok(code.includes("document.adoptedStyleSheets = ["));
  // No markup, style attribute, inline style or evaluation; text nodes and
  // line breaks only; the only element made is the draft link and <br>.
  assert.doesNotMatch(
    code,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\(\s*["']style|\beval\(|new Function|createElement\("style"\)/,
  );
  assert.deepEqual(
    [...code.matchAll(/createElement\("([a-z]+)"\)/g)].map((m) => m[1]),
    ["br", "link"],
  );
  assert.ok(code.includes("document.createTextNode(line)"));
  // It posts only on its port, never to a window; the draft stylesheet is
  // the only address it links.
  assert.doesNotMatch(
    code,
    /window\.parent\.postMessage|top\.postMessage|"\*"/,
  );
  assert.equal(code.match(/\.postMessage\(/g).length, 1);
  assert.ok(
    code.includes(
      "const post = (message: unknown) => port?.postMessage(message);",
    ),
  );
  assert.ok(
    code.includes("draft.href = `/appearance/draft.css?r=${Date.now()}`;"),
  );
  // Browse mode follows only preview addresses (same origin, registry pages
  // and profiles, rz-preview=1).
  assert.equal(code.match(/previewAddressOf\(/g).length, 2);
  assert.ok(code.includes("window.location.assign(address);"));
  // Selection: registry ids only.
  assert.ok(code.includes("if (!isElementId(id) || !COMPONENT_IDS.has(id)) {"));
  // No storage, cookie or network access of its own.
  assert.doesNotMatch(
    code,
    /fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/,
  );
});

test("SP-6 Home renders the editor's saved draft only in preview mode, exactly rz-preview=1, through the use case that decides who is an editor", () => {
  const page = codeOf(read("app/page.tsx"));
  assert.ok(
    page.includes(
      'const { jurisdiction, "rz-preview": previewValue } = await searchParams;',
    ),
  );
  assert.ok(page.includes('    previewValue === "1",\n  );'));
  assert.ok(page.includes('readonly "rz-preview"?: QueryValue;'));
});
