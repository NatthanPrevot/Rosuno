// DEV-001 website and appearance studio: the studio (studio specification
// sections 6.1 to 6.8, 7 and 8.1).
//
// Source contracts over the real files, and the pure modules run directly
// with synthetic values only (no browser, server or database). They prove:
// - the studio page asks the step-up gate first and then only its use case
//   with the appearance sources and the registry's validator, and reads
//   nothing of the request; the actions ask the gate before every use case,
//   read every argument as an unknown own property, measure an upload before
//   reading it, log only a fixed outcome, and drop the published memo and
//   revalidate the studio only after a publication, a restore or a reset;
// - the client modules reach no infrastructure, write no inline style or raw
//   markup, never post to "*" and read every frame message through the
//   protocol's guards;
// - the protocol accepts only its exact message shapes within the size cap,
//   and preview addresses are same-origin registry pages with rz-preview=1;
// - the editor state: undo and redo, coalescing within 500 ms, the history
//   cap, the autosave machine (debounce, maximum wait, one save at a time,
//   retries, conflicts and refusals stop it), section moves, the change
//   summary and the image list kept equal to the images referenced;
// - the studio's own words hold no regulated phrase;
// - the studio root resets every workspace token to the owner's root value
//   and the three hooks to initial, so a published theme cannot reach it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  appearanceTextIssue,
  canonicalJson,
  validateAppearance,
} from "../src/application/appearance-schema.ts";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  autosaveDelay,
  changeSummary,
  droppedSection,
  editorReducer,
  EMPTY_CONFIGURATION,
  expectedRevision,
  exportFileName,
  HISTORY_LIMIT,
  initialEditorState,
  isDirty,
  movedSection,
  normalized,
  RETRY_DELAYS_MS,
  sectionsOf,
  summaryIsEmpty,
  valueAt,
  withHidden,
  withSections,
  withValue,
} from "../src/presentation/appearance/editor-state.ts";
import * as labels from "../src/presentation/appearance/labels.ts";
import {
  helloOf,
  isPreviewSearch,
  MAX_MESSAGE_CHARACTERS,
  previewAddressOf,
  readFrameMessage,
  readHello,
  readStudioMessage,
} from "../src/presentation/appearance/protocol.ts";
import {
  APPEARANCE_REGISTRY,
  HOME_SECTIONS,
} from "../src/presentation/appearance/registry.ts";

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
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const NONCE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SHA = "a".repeat(64);
const STUDIO = "app/staff/appearance/";
const CLIENT_MODULES = [
  "app/staff/appearance/assets.tsx",
  "app/staff/appearance/inspector.tsx",
  "app/staff/appearance/layers.tsx",
  "app/staff/appearance/preview-frame.tsx",
  "app/staff/appearance/publish-dialog.tsx",
  "app/staff/appearance/studio.tsx",
  "app/staff/appearance/versions.tsx",
];

// ---------------------------------------------------------------------------
// The page and the actions
// ---------------------------------------------------------------------------

test("ST-1 the studio page asks the step-up gate first, then only its use case with the appearance sources and the registry's validator, and reads nothing of the request", () => {
  const code = codeOf(read(`${STUDIO}page.tsx`));
  assert.ok(
    code.includes(
      '  await connection();\n  await requireSteppedUp("staff");\n  const view = await resolveAppearanceStudio(\n    APPEARANCE_SOURCES,\n    validateWithRegistry,\n  );\n',
    ),
  );
  assert.equal(code.match(/\bawait /g).length, 3);
  assert.ok(
    code.includes(
      '    return refusalPage(view, "/staff/appearance", STUDIO_TITLE);',
    ),
  );
  assert.doesNotMatch(
    code,
    /searchParams|params|headers\(|cookies\(|process\.env|\.rpc\(|\.from\(|style=|dangerouslySetInnerHTML/,
  );
  assert.match(code, /robots: \{ index: false, follow: false \},/);
  assert.deepEqual(importsOf(read(`${STUDIO}page.tsx`)), [
    "next",
    "next/server",
    "../../../src/application/appearance.ts",
    "../../../src/infrastructure/appearance/appearance-adapter.ts",
    "../../../src/presentation/appearance/labels.ts",
    "../../../src/presentation/appearance/registry.ts",
    "../../account/gate.ts",
    "../frame.tsx",
    "./studio.tsx",
  ]);
});

test("ST-2 every action asks the gate before its use case, reads its arguments as unknown own properties, and only a publication, a restore or a reset drops the memo and revalidates the studio", () => {
  const source = read(`${STUDIO}actions.ts`);
  const code = codeOf(source);
  assert.match(source, /^"use server";\n/);
  const exported = [...code.matchAll(/^export async function (\w+)\(/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(exported, [
    "saveDraftAction",
    "publishAction",
    "restoreAction",
    "resetAction",
    "discardAction",
    "uploadAssetAction",
    "studioAction",
    "versionsAction",
    "versionAction",
    "assetsAction",
  ]);
  // Each exported action is exactly one gated call of one use case.
  const uses = {
    saveDraftAction: "saveAppearanceDraft",
    publishAction: "publishAppearance",
    restoreAction: "restoreAppearanceVersion",
    resetAction: "resetAppearanceDraft",
    discardAction: "discardAppearanceDraft",
    uploadAssetAction: "uploaded(fileOf(formData))",
    studioAction: "resolveAppearanceStudio",
    versionsAction: "listAppearanceVersions",
    versionAction: "readAppearanceVersion",
    assetsAction: "listAppearanceAssets",
  };
  for (const [name, use] of Object.entries(uses)) {
    const start = code.indexOf(`export async function ${name}(`);
    const body = code.slice(start, code.indexOf("\n}\n", start));
    assert.ok(body.includes("  return gated(() =>"), name);
    assert.ok(body.includes(use), name);
    assert.equal(body.match(/return /g).length, 1, name);
    assert.equal(
      body.includes(".then(settled)") || body.includes("settled,"),
      ["publishAction", "restoreAction", "resetAction"].includes(name),
      name,
    );
  }
  // The gate first, then the operation; a refusal is returned unchanged.
  assert.ok(
    code.includes(
      '  const refusal = await stepUpRefusal("staff");\n  if (refusal !== null) {\n    return refusal;\n  }\n  const state = await operation();\n',
    ),
  );
  assert.equal(code.match(/stepUpRefusal\(/g).length, 1);
  // Only a settled outcome drops the memo and revalidates the studio page.
  assert.ok(
    code.includes(
      '  if (state.status === "outcome") {\n    invalidatePublishedAppearance();\n    revalidatePath("/staff/appearance");\n  }\n  return state;\n',
    ),
  );
  assert.equal(code.match(/invalidatePublishedAppearance\(\)/g).length, 1);
  assert.equal(code.match(/revalidatePath\(/g).length, 1);
  // Arguments are own data properties of a plain object, else undefined
  // (which every use case refuses); nothing is assumed to have its type.
  assert.ok(
    code.includes(
      "Object.getPrototypeOf(value) === Object.prototype &&\n  Object.hasOwn(value, key)",
    ),
  );
  assert.doesNotMatch(code, /\bas (?:string|number)\b|JSON\.parse|_previous/);
  // An upload is measured before a byte is read.
  assert.ok(
    code.includes(
      "file.size < 1 || file.size > MAX_ASSET_BYTES\n      ? Promise.resolve(TOO_LARGE)\n      : file\n          .arrayBuffer()",
    ),
  );
  // One fixed log line, with the fixed outcome only.
  assert.deepEqual(
    [...code.matchAll(/logRequestEvent\([^;]*;/g)].map((m) => m[0]),
    [
      'logRequestEvent("warn", "appearance.action_not_completed", {\n      outcome: state.status,\n    });',
    ],
  );
  assert.doesNotMatch(
    code,
    /process\.env|\bconsole\b|\.rpc\(|\.from\(|headers\(|cookies\(|redirect\(/,
  );
  assert.deepEqual(importsOf(source), [
    "next/cache",
    "../../../src/application/appearance.ts",
    "../../../src/application/appearance-image.ts",
    "../../../src/infrastructure/appearance/appearance-adapter.ts",
    "../../../src/infrastructure/observability/request-log.ts",
    "../../../src/presentation/appearance/registry.ts",
    "../../account/gate.ts",
  ]);
});

test("ST-3 the studio's client modules reach no infrastructure, render no inline style or raw markup, post only to this origin, and read frame messages only through the protocol's guards", () => {
  assert.deepEqual(
    filesIn(STUDIO).filter((f) => /\.tsx$/.test(f) && !f.endsWith("page.tsx")),
    CLIENT_MODULES,
  );
  for (const file of CLIENT_MODULES) {
    const source = read(file);
    const code = codeOf(source);
    assert.match(source, /^"use client";\n/, file);
    assert.ok(
      importsOf(source).every(
        (specifier) =>
          !/infrastructure|next\/server|next\/cache|\.\/page\.tsx/.test(
            specifier,
          ),
      ),
      file,
    );
    assert.doesNotMatch(
      code,
      /\bstyle=|\.style\.|setAttribute\(\s*["']style|dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcDoc|process\.env/,
      file,
    );
    // Never "*" as a target origin.
    assert.doesNotMatch(code, /postMessage\([^)]*["']\*["']/, file);
  }
  const frame = codeOf(read(`${STUDIO}preview-frame.tsx`));
  // One window message: the hello, for this origin only, with the port.
  assert.equal(frame.match(/\.postMessage\(helloOf\(/g).length, 1);
  assert.match(
    frame,
    /target\.postMessage\(helloOf\(nonce\), window\.location\.origin, \[\s*channel\.port2,?\s*\]\);/,
  );
  // Every message from the frame is read through the guard, and a ready
  // counts only with this load's nonce.
  assert.ok(frame.includes("const message = readFrameMessage(event.data);"));
  assert.ok(
    frame.includes(
      "if (message.nonce !== nonce || port.current !== null) {\n          return;\n        }",
    ),
  );
  assert.doesNotMatch(frame, /addEventListener\(\s*["']message["']/);
  // The studio never reads the frame's document.
  assert.doesNotMatch(
    frame,
    /contentDocument|contentWindow\.document|\.document\b/,
  );
  // The studio calls the server only through its actions.
  const studio = codeOf(read(`${STUDIO}studio.tsx`));
  assert.doesNotMatch(studio, /\bfetch\(|XMLHttpRequest|WebSocket/);
});

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

test("ST-4 the protocol reads only its exact message shapes within the size cap", () => {
  assert.deepEqual(readHello(helloOf(NONCE)), {
    type: "rz:hello",
    protocol: 1,
    nonce: NONCE,
  });
  for (const forged of [
    null,
    "rz:hello",
    { type: "rz:hello", protocol: 1 },
    { type: "rz:hello", protocol: 2, nonce: NONCE },
    { type: "rz:hello", protocol: 1, nonce: "nonce" },
    { type: "rz:hello", protocol: 1, nonce: NONCE, extra: true },
    Object.assign(Object.create({ inherited: 1 }), {
      type: "rz:hello",
      protocol: 1,
      nonce: NONCE,
    }),
  ]) {
    assert.equal(readHello(forged), null, JSON.stringify(forged));
  }
  // Studio messages.
  assert.deepEqual(readStudioMessage({ type: "rz:select", id: "home.hero" }), {
    type: "rz:select",
    id: "home.hero",
  });
  assert.deepEqual(readStudioMessage({ type: "rz:hover", id: null }), {
    type: "rz:hover",
    id: null,
  });
  assert.deepEqual(readStudioMessage({ type: "rz:mode", mode: "browse" }), {
    type: "rz:mode",
    mode: "browse",
  });
  const configuration = { schema: 1 };
  assert.equal(
    readStudioMessage({ type: "rz:config", configuration }).configuration,
    configuration,
  );
  for (const forged of [
    { type: "rz:select", id: "HOME" },
    { type: "rz:select", id: '"];}body{display:none}' },
    { type: "rz:select" },
    { type: "rz:mode", mode: "edit" },
    { type: "rz:config" },
    { type: "rz:config", configuration, more: 1 },
    { type: "rz:eval", code: "alert(1)" },
    {
      type: "rz:config",
      configuration: { blob: "x".repeat(MAX_MESSAGE_CHARACTERS) },
    },
  ]) {
    assert.equal(
      readStudioMessage(forged),
      null,
      JSON.stringify(forged).slice(0, 80),
    );
  }
  // Frame messages.
  const ready = {
    type: "rz:ready",
    nonce: NONCE,
    path: "/?rz-preview=1",
    components: ["home.hero", "site.header"],
    slots: ["home.hero.title"],
    sections: ["home.hero"],
  };
  assert.deepEqual(readFrameMessage(ready), ready);
  assert.deepEqual(
    readFrameMessage({
      type: "rz:selected",
      id: "home.hero.title",
      roles: ["type.display"],
      rect: { x: 1, y: 2, width: 3, height: 4 },
    }).roles,
    ["type.display"],
  );
  assert.deepEqual(readFrameMessage({ type: "rz:escape" }), {
    type: "rz:escape",
  });
  for (const forged of [
    { ...ready, nonce: "x" },
    { ...ready, path: "https://elsewhere.test/" },
    { ...ready, components: ["<b>"] },
    { ...ready, components: Array(257).fill("home.hero") },
    { ...ready, html: "<p>" },
    {
      type: "rz:selected",
      id: "home.hero",
      roles: [],
      rect: { x: Infinity, y: 0, width: 0, height: 0 },
    },
    { type: "rz:navigate", path: "javascript:alert(1)" },
    { type: "rz:navigate", path: `/${"a".repeat(600)}` },
    { type: "rz:escape", extra: 1 },
  ]) {
    assert.equal(
      readFrameMessage(forged),
      null,
      JSON.stringify(forged).slice(0, 80),
    );
  }
});

test("ST-5 a preview address is a same-origin registry page (or an attorney profile) with rz-preview=1 set once", () => {
  const origin = "https://studio.test";
  const paths = APPEARANCE_REGISTRY.pages.map((page) => page.path);
  assert.equal(previewAddressOf("/", origin, paths), "/?rz-preview=1");
  assert.equal(
    previewAddressOf(
      "/find-an-attorney?jurisdiction=x&rz-preview=0&rz-preview=1",
      origin,
      paths,
    ),
    "/find-an-attorney?jurisdiction=x&rz-preview=1",
  );
  assert.equal(
    previewAddressOf(
      `${origin}/attorneys/00000000-0000-4000-8000-000000000001`,
      origin,
      paths,
    ),
    "/attorneys/00000000-0000-4000-8000-000000000001?rz-preview=1",
  );
  for (const href of [
    "https://elsewhere.test/",
    "//elsewhere.test/",
    "/staff/appearance",
    "/staff/capabilities",
    "/appearance/theme.css",
    "/attorneys/not-an-id",
    "javascript:alert(1)",
    "https://user:pass@studio.test/",
    `/?q=${"a".repeat(600)}`,
  ]) {
    assert.equal(previewAddressOf(href, origin, paths), null, href);
  }
  assert.equal(isPreviewSearch("?rz-preview=1"), true);
  assert.equal(isPreviewSearch("?a=b&rz-preview=1"), true);
  assert.equal(isPreviewSearch("?rz-preview=1&rz-preview=0"), false);
  assert.equal(isPreviewSearch("?rz-preview=true"), false);
  assert.equal(isPreviewSearch(""), false);
});

// ---------------------------------------------------------------------------
// The editor state
// ---------------------------------------------------------------------------

const at = (ms) => 1_000_000 + ms;
const ink = (hex) =>
  withValue(EMPTY_CONFIGURATION, ["tokens", "site", "ink"], hex);

test("ST-6 edits: a value set or removed at a path, empty objects pruned, and the image list exactly the images referenced", () => {
  const a = withValue(
    EMPTY_CONFIGURATION,
    ["tokens", "site", "accent"],
    "#0f5f5a",
  );
  assert.deepEqual(a, { schema: 1, tokens: { site: { accent: "#0f5f5a" } } });
  assert.deepEqual(withValue(a, ["tokens", "site", "accent"], undefined), {
    schema: 1,
  });
  assert.equal(valueAt(a, ["tokens", "site", "accent"]), "#0f5f5a");
  assert.equal(valueAt(a, ["tokens", "workspace", "accent"]), undefined);
  const hero = withValue(
    EMPTY_CONFIGURATION,
    ["components", "home.hero.figure", "background"],
    {
      type: "image",
      asset: { sha256: SHA, format: "png" },
      fit: "cover",
      position: "center",
    },
  );
  assert.deepEqual(hero.assets, [{ sha256: SHA, format: "png" }]);
  assert.equal(validateAppearance(hero, APPEARANCE_REGISTRY, "draft").ok, true);
  assert.equal(
    withValue(hero, ["components", "home.hero.figure"], undefined).assets,
    undefined,
  );
  // Only plain JSON data survives.
  assert.deepEqual(
    normalized({ schema: 2, x: () => 1, y: NaN, slots: {}, z: undefined }),
    { schema: 1 },
  );
  assert.ok(Object.isFrozen(a));
});

test("ST-7 undo and redo over whole configurations; one property changed within 500 ms is one step; a replace is always its own step; the history holds at most 100", () => {
  let state = initialEditorState(EMPTY_CONFIGURATION, null);
  state = editorReducer(state, {
    type: "edit",
    next: ink("#111111"),
    key: "ink",
    at: at(0),
  });
  state = editorReducer(state, {
    type: "edit",
    next: ink("#121212"),
    key: "ink",
    at: at(300),
  });
  state = editorReducer(state, {
    type: "edit",
    next: ink("#131313"),
    key: "ink",
    at: at(700),
  });
  assert.equal(state.past.length, 1);
  assert.equal(valueAt(state.current, ["tokens", "site", "ink"]), "#131313");
  // Past the window, or another property: a new step.
  state = editorReducer(state, {
    type: "edit",
    next: ink("#141414"),
    key: "ink",
    at: at(1300),
  });
  assert.equal(state.past.length, 2);
  state = editorReducer(state, {
    type: "edit",
    next: withValue(state.current, ["tokens", "site", "accent"], "#0f5f5a"),
    key: "accent",
    at: at(1350),
  });
  assert.equal(state.past.length, 3);
  // A replace never joins the previous step.
  state = editorReducer(state, {
    type: "replace",
    next: EMPTY_CONFIGURATION,
    at: at(1360),
  });
  assert.equal(state.past.length, 4);
  assert.deepEqual(state.current, { schema: 1 });
  state = editorReducer(state, { type: "undo", at: at(1400) });
  assert.equal(valueAt(state.current, ["tokens", "site", "accent"]), "#0f5f5a");
  assert.equal(state.future.length, 1);
  state = editorReducer(state, { type: "redo", at: at(1500) });
  assert.deepEqual(state.current, { schema: 1 });
  // A new edit drops the redo branch; an edit that changes nothing is none.
  state = editorReducer(state, { type: "undo", at: at(1600) });
  state = editorReducer(state, {
    type: "edit",
    next: ink("#222222"),
    key: "x",
    at: at(1700),
  });
  assert.equal(state.future.length, 0);
  const same = editorReducer(state, {
    type: "edit",
    next: state.current,
    key: "y",
    at: at(1800),
  });
  assert.equal(same, state);
  // The cap.
  let long = initialEditorState(EMPTY_CONFIGURATION, null);
  for (let i = 0; i < 130; i += 1) {
    long = editorReducer(long, {
      type: "edit",
      next: ink(`#${(16 + i).toString(16).padStart(6, "0")}`),
      key: `k${i}`,
      at: at(i * 10),
    });
  }
  assert.equal(long.past.length, HISTORY_LIMIT);
  // Undo with nothing to undo changes nothing.
  const fresh = initialEditorState(EMPTY_CONFIGURATION, null);
  assert.equal(editorReducer(fresh, { type: "undo", at: at(0) }), fresh);
  assert.equal(editorReducer(fresh, { type: "redo", at: at(0) }), fresh);
});

test("ST-8 autosave: 2 s after the last change, at most 15 s after the first, one save at a time, retries 2, 5 and 10 s, then by hand; a conflict or a refused draft waits for the editor", () => {
  let state = initialEditorState(EMPTY_CONFIGURATION, null);
  assert.equal(autosaveDelay(state, at(0)), null);
  assert.equal(expectedRevision(state), null);
  state = editorReducer(state, {
    type: "edit",
    next: ink("#111111"),
    key: "a",
    at: at(0),
  });
  assert.equal(state.save, "pending");
  assert.equal(autosaveDelay(state, at(0)), AUTOSAVE_DEBOUNCE_MS);
  assert.equal(autosaveDelay(state, at(1500)), 500);
  // Changes keep pushing the save back, but never past 15 s.
  for (let t = 1000; t <= 14_000; t += 1000) {
    state = editorReducer(state, {
      type: "edit",
      next: ink(`#1111${(t / 1000 + 16).toString(16)}`),
      key: `k${t}`,
      at: at(t),
    });
  }
  assert.equal(autosaveDelay(state, at(14_000)), AUTOSAVE_MAX_WAIT_MS - 14_000);
  // One save at a time: nothing is due while one is in flight.
  state = editorReducer(state, { type: "save-start" });
  assert.equal(state.save, "saving");
  assert.equal(autosaveDelay(state, at(15_000)), null);
  const sent = state.currentJson;
  // A change during the save waits for it, then saves the latest.
  state = editorReducer(state, {
    type: "edit",
    next: ink("#abcdef"),
    key: "late",
    at: at(15_100),
  });
  assert.equal(state.save, "saving");
  state = editorReducer(state, {
    type: "save-ok",
    draft: { id: "d", revision: 1 },
    json: sent,
    at: at(15_200),
  });
  assert.equal(state.save, "pending");
  assert.equal(expectedRevision(state), 1);
  assert.ok(isDirty(state));
  state = editorReducer(state, { type: "save-start" });
  state = editorReducer(state, {
    type: "save-ok",
    draft: { id: "d", revision: 2 },
    json: state.currentJson,
    at: at(16_000),
  });
  assert.equal(state.save, "saved");
  assert.equal(isDirty(state), false);
  assert.equal(autosaveDelay(state, at(20_000)), null);
  // Failures: retried after 2, 5 and 10 s, then only by hand.
  state = editorReducer(state, {
    type: "edit",
    next: ink("#222222"),
    key: "f",
    at: at(30_000),
  });
  for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
    state = editorReducer(state, { type: "save-start" });
    state = editorReducer(state, { type: "save-failed", at: at(40_000) });
    assert.equal(state.save, "failed");
    assert.equal(state.attempt, index + 1);
    assert.equal(autosaveDelay(state, at(40_000)), delay);
  }
  state = editorReducer(state, { type: "save-start" });
  state = editorReducer(state, { type: "save-failed", at: at(50_000) });
  assert.equal(autosaveDelay(state, at(50_000)), null);
  state = editorReducer(state, { type: "save-now", at: at(60_000) });
  assert.equal(state.save, "pending");
  assert.equal(autosaveDelay(state, at(60_000)), 0);
  // A refusal retrying cannot change waits for the editor at once.
  state = editorReducer(state, { type: "save-start" });
  state = editorReducer(state, {
    type: "save-failed",
    at: at(61_000),
    final: true,
  });
  assert.equal(autosaveDelay(state, at(61_000)), null);
  // A conflict stops autosave until the editor decides; Keep mine saves on
  // the server's revision, Load the latest replaces the editor's draft.
  state = editorReducer(state, { type: "save-now", at: at(62_000) });
  state = editorReducer(state, { type: "save-start" });
  state = editorReducer(state, { type: "save-conflict" });
  assert.equal(state.save, "conflict");
  state = editorReducer(state, {
    type: "edit",
    next: ink("#333333"),
    key: "c",
    at: at(63_000),
  });
  assert.equal(state.save, "conflict");
  assert.equal(autosaveDelay(state, at(99_000)), null);
  const kept = editorReducer(state, {
    type: "rebase",
    draft: { id: "d", revision: 7 },
    at: at(64_000),
  });
  assert.equal(kept.save, "pending");
  assert.equal(expectedRevision(kept), 7);
  assert.equal(autosaveDelay(kept, at(64_000)), 0);
  assert.equal(
    expectedRevision(
      editorReducer(state, { type: "rebase", draft: null, at: at(64_000) }),
    ),
    null,
  );
  const loaded = editorReducer(state, {
    type: "server",
    configuration: ink("#444444"),
    draft: { id: "d", revision: 8 },
    keep: false,
    at: at(65_000),
  });
  assert.equal(loaded.save, "saved");
  assert.equal(loaded.past.length, 0);
  assert.equal(valueAt(loaded.current, ["tokens", "site", "ink"]), "#444444");
  // A refused draft waits for the next change.
  let refused = editorReducer(kept, { type: "save-start" });
  refused = editorReducer(refused, {
    type: "save-invalid",
    issues: [{ path: "/tokens/site/ink", code: "bad_color" }],
  });
  assert.equal(autosaveDelay(refused, at(70_000)), null);
  refused = editorReducer(refused, {
    type: "edit",
    next: ink("#555555"),
    key: "n",
    at: at(71_000),
  });
  assert.equal(refused.save, "pending");
  // A server reset kept undoable.
  const reset = editorReducer(loaded, {
    type: "server",
    configuration: EMPTY_CONFIGURATION,
    draft: { id: "d", revision: 9 },
    keep: true,
    at: at(72_000),
  });
  assert.deepEqual(reset.current, { schema: 1 });
  assert.equal(
    valueAt(editorReducer(reset, { type: "undo", at: at(73_000) }).current, [
      "tokens",
      "site",
      "ink",
    ]),
    "#444444",
  );
});

test("ST-9 sections: move up and down within the reorderable sections, drop before another, show or hide a hideable one; the default order and no hidden section are left out", () => {
  const view = sectionsOf(EMPTY_CONFIGURATION, HOME_SECTIONS);
  assert.deepEqual(view.order, [
    "home.available",
    "home.ways",
    "home.how",
    "home.issues",
    "home.attorneys",
  ]);
  assert.deepEqual(view.hidden, []);
  const up = movedSection(view.order, "home.how", -1);
  assert.deepEqual(up, [
    "home.available",
    "home.how",
    "home.ways",
    "home.issues",
    "home.attorneys",
  ]);
  assert.equal(movedSection(view.order, "home.available", -1), null);
  assert.equal(movedSection(view.order, "home.attorneys", 1), null);
  assert.equal(movedSection(view.order, "home.hero", 1), null);
  assert.deepEqual(
    droppedSection(view.order, "home.attorneys", "home.available"),
    [
      "home.attorneys",
      "home.available",
      "home.ways",
      "home.how",
      "home.issues",
    ],
  );
  assert.deepEqual(droppedSection(view.order, "home.available", null), [
    "home.ways",
    "home.how",
    "home.issues",
    "home.attorneys",
    "home.available",
  ]);
  assert.equal(droppedSection(view.order, "home.ways", "home.how"), null);
  const hidden = withHidden([], "home.ways", true);
  const next = withSections(EMPTY_CONFIGURATION, HOME_SECTIONS, {
    order: up,
    hidden,
  });
  assert.deepEqual(next.sections, {
    "home.sections": { order: up, hidden: ["home.ways"] },
  });
  assert.equal(validateAppearance(next, APPEARANCE_REGISTRY, "draft").ok, true);
  assert.deepEqual(
    withSections(next, HOME_SECTIONS, { order: view.order, hidden: [] }),
    { schema: 1 },
  );
  assert.deepEqual(withHidden(["home.ways"], "home.ways", false), []);
  // A forged hidden list keeps only hideable sections.
  assert.deepEqual(
    sectionsOf(
      {
        schema: 1,
        sections: {
          "home.sections": { hidden: ["home.hero", "home.issues", "home.how"] },
        },
      },
      HOME_SECTIONS,
    ).hidden,
    ["home.how"],
  );
});

test("ST-10 the publish summary lists what differs from the live version, by area, with the old and new page text", () => {
  const base = withValue(
    EMPTY_CONFIGURATION,
    ["slots", "home.ways.title"],
    "Talk now, or plan ahead.",
  );
  let current = withValue(base, ["tokens", "site", "accent"], "#0f5f5a");
  current = withValue(
    current,
    ["slots", "home.ways.title"],
    "Talk now, or later.",
  );
  current = withValue(current, ["components", "home.ways", "background"], {
    type: "color",
    color: "#f6f5f2",
  });
  current = withValue(
    current,
    ["roles", "role.link", "color", "text"],
    "#2b2d33",
  );
  const summary = changeSummary(base, current, APPEARANCE_REGISTRY);
  assert.deepEqual(summary.tokens, ["site.accent"]);
  assert.deepEqual(summary.components, [
    APPEARANCE_REGISTRY.components.find((c) => c.id === "home.ways").label,
  ]);
  assert.deepEqual(summary.roles, ["Links"]);
  assert.deepEqual(summary.slots, [
    {
      id: "home.ways.title",
      before: "Talk now, or plan ahead.",
      after: "Talk now, or later.",
    },
  ]);
  assert.equal(summary.sections, false);
  assert.equal(summaryIsEmpty(summary), false);
  assert.equal(
    summaryIsEmpty(changeSummary(base, base, APPEARANCE_REGISTRY)),
    true,
  );
  assert.equal(
    exportFileName("rosuno", new Date("2026-11-26T23:59:00Z")),
    "appearance-rosuno-20261126.json",
  );
});

// ---------------------------------------------------------------------------
// Words and the studio's own design
// ---------------------------------------------------------------------------

function stringsOf(value, seen = new Set()) {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "function") {
    return [];
  }
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return Object.values(value).flatMap((item) => stringsOf(item, seen));
}

test("ST-11 the studio's own words hold no regulated phrase, link or markup, and every refusal has its message", () => {
  const texts = [
    ...stringsOf(labels),
    labels.VERSION_LABELS.viewing(3),
    labels.VERSION_LABELS.viewing(null),
    labels.movedText("Two ways to consult", 3, 5),
    labels.visibilityText("Two ways to consult", true),
    labels.visibilityText("Two ways to consult", false),
    labels.characterCountText(12, 40),
    labels.lineLimitText(1),
    labels.lineLimitText(2),
    labels.contrastText(3.9, 4.5, "Muted text on paper background").text,
    labels.contrastText(6.1, 4.5, "Muted text on paper background").text,
  ];
  assert.ok(texts.length > 150);
  for (const text of texts) {
    const issue = appearanceTextIssue(
      text
        .replace(/[\n{}]/g, " ")
        .trim()
        .slice(0, 300) || "x",
    );
    assert.ok(issue !== "slot_banned" && issue !== "slot_link", text);
  }
  for (const status of [
    "step-up-required",
    "sign-in-required",
    "denied",
    "unavailable",
    "unconfirmed",
    "invalid",
    "accessibility",
  ]) {
    assert.ok(
      labels.commandMessage("save", { status }).text.length > 0,
      status,
    );
  }
  assert.equal(
    labels.commandMessage("publish", {
      status: "outcome",
      outcome: "published",
      versionNumber: 4,
    }).text,
    "Version 4 is live. Visitors see it on their next page load.",
  );
  assert.equal(
    labels.commandMessage("upload", { status: "image", problem: "unsupported" })
      .text,
    labels.IMAGE_PROBLEM_MESSAGES.unsupported,
  );
  assert.match(labels.ASSET_LABELS.consent, /consent \(A45\)/);
  assert.match(labels.ASSET_LABELS.consent, /no portraits/);
  assert.deepEqual(
    labels.contrastText(3.9, 4.5, "Muted text on paper background"),
    {
      tone: "error",
      text: "Muted text on paper background: 3.90:1, too little contrast (needs 4.5).",
    },
  );
  assert.equal(labels.contrastText(4.36, 4.36, "x").tone, "success");
});

test("ST-12 the studio root resets every workspace token to the owner's workspace root and the three hooks to initial, and widens only its own page column", () => {
  const css = read("app/styles/product-staff.css");
  const start = css.indexOf("\n.W.st .rz-studio {\n");
  assert.ok(start >= 0);
  const body = css.slice(start, css.indexOf("\n}\n", start));
  const declared = new Map(
    [...body.matchAll(/^ {2}(--[\w-]+):\s*([^;]+);$/gms)].map((m) => [
      m[1],
      m[2].replace(/\s+/g, " ").trim(),
    ]),
  );
  const workspace = read("app/styles/workspace.css");
  const rootStart = workspace.indexOf(".rzw:not(.rzw .rzw) {\n");
  const root = workspace.slice(
    rootStart,
    workspace.indexOf("\n}\n", rootStart),
  );
  const owner = new Map(
    [...root.matchAll(/^ {2}(--[\w-]+):\s*([^;]+);$/gms)].map((m) => [
      m[1],
      m[2].replace(/\s+/g, " ").trim(),
    ]),
  );
  // Every token a published workspace theme can set, with its root value.
  const themed = [
    ...APPEARANCE_REGISTRY.tokens
      .filter(
        (t) =>
          t.scope === "workspace" &&
          t.key !== "staffRadius" &&
          t.key !== "elevation",
      )
      .map((t) => t.cssName),
    "--e1",
    "--e2",
    "--e3",
  ];
  for (const name of themed) {
    assert.ok(declared.has(name), name);
    assert.equal(declared.get(name), owner.get(name), name);
  }
  assert.equal(declared.get("--st-r"), "16px");
  for (const hook of ["--rz-on-ink", "--rz-ink-hover", "--rz-surface-hover"]) {
    assert.equal(declared.get(hook), "initial", hook);
  }
  assert.equal(declared.size, themed.length + 4);
  // The registry's workspace colour defaults are the same values.
  for (const spec of APPEARANCE_REGISTRY.tokens.filter(
    (t) => t.scope === "workspace" && t.type === "color",
  )) {
    assert.equal(declared.get(spec.cssName), spec.default, spec.key);
  }
  assert.ok(
    css.includes("\n.W.st .st-wrap:has(.rz-studio) {\n  max-width: none;\n}\n"),
  );
  // The studio's rules select nothing outside the studio but that column.
  const studioRules = css
    .slice(
      css.indexOf("/* ---------- DEV-001: the website and appearance studio"),
    )
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...studioRules.matchAll(/^\s*([^\s@/}][^{;]*)\{$/gm)];
  assert.ok(selectors.length > 100);
  for (const [, selector] of selectors) {
    for (const part of selector.split(",")) {
      assert.match(
        part.trim(),
        /^(?:\.W\.st )?\.rz-studio\b|^\.W\.st \.st-wrap:has\(\.rz-studio\)$/,
        part,
      );
    }
  }
  assert.doesNotMatch(studioRules, /\[data-rz/);
  // The page names the studio root once.
  assert.equal(
    codeOf(read(`${STUDIO}studio.tsx`)).match(/className="rz-studio"/g).length,
    1,
  );
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
