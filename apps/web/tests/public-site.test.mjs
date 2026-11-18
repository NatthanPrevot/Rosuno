// MVP-001 S5: the public site (MBS section 18.1; MVP-001 Packet rule 11 and
// the section 3 gate "Public content, Privacy, Terms, disclosures":
// unapproved content is not rendered). The public navigation and every
// public content page are transpiled with the installed TypeScript compiler
// into a temporary directory outside the repository and rendered with the
// installed React server renderer; nothing else is written, and the
// directory is removed.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { PUBLIC_CONTENT_TOPICS } from "../src/application/public-content.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");

const directory = mkdtempSync(join(tmpdir(), "rosuno-s5-public-site-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function transpile(source, fileName) {
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(output.diagnostics, [], fileName);
  return output.outputText;
}

const jsxRuntime = import.meta.resolve("react/jsx-runtime");
const react = import.meta.resolve("react");
const content = new URL("src/application/public-content.ts", appRoot).href;
const local = (name) => pathToFileURL(join(directory, name)).href;

// A not-found stub that records the call, so a page that would 404 is seen.
writeFileSync(
  join(directory, "navigation.mjs"),
  "export function notFound() { throw new Error('NOT_FOUND'); }\n",
);

const relink = (code) =>
  code.replace(/(\bfrom\s+|\bimport\s+)"([^"]+)"/g, (_m, keyword, s) => {
    if (s === "react/jsx-runtime") {
      return `${keyword}"${jsxRuntime}"`;
    }
    if (s === "react") {
      return `${keyword}"${react}"`;
    }
    if (s === "next/navigation") {
      return `${keyword}"${local("navigation.mjs")}"`;
    }
    if (s.endsWith("design-system.tsx")) {
      return `${keyword}"${local("design-system.mjs")}"`;
    }
    if (s.endsWith("public-site.tsx")) {
      return `${keyword}"${local("public-site.mjs")}"`;
    }
    if (s.endsWith("public-content.ts")) {
      return `${keyword}"${content}"`;
    }
    throw new Error(`unexpected import ${s}`);
  });

for (const [name, path] of [
  ["design-system.mjs", "src/presentation/design-system.tsx"],
  ["public-site.mjs", "src/presentation/public-site.tsx"],
]) {
  writeFileSync(join(directory, name), relink(transpile(read(path), path)));
}

async function render(path) {
  const name = `${path.replace(/[/[\]]/g, "_")}.mjs`;
  writeFileSync(join(directory, name), relink(transpile(read(path), path)));
  const module = await import(local(name));
  const html = renderToStaticMarkup(module.default());
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    hrefs: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    metadata: module.metadata,
  };
}

const NAVIGATION_TEXT =
  "Home Find an attorney How Rosuno works For attorneys About Help Contact Privacy Terms Disclosures";
const NAVIGATION_HREFS = [
  "/",
  "/find-an-attorney",
  "/how-it-works",
  "/for-attorneys",
  "/about",
  "/help",
  "/contact",
  "/privacy",
  "/terms",
  "/disclosures",
];

test("S5-P1. every public content page renders only the public navigation, its title, the fixed statement that its information is not yet available, and the way home", async () => {
  for (const [topic, title] of Object.entries(PUBLIC_CONTENT_TOPICS)) {
    const page = await render(`app/${topic}/page.tsx`);
    assert.equal(
      page.text,
      `${NAVIGATION_TEXT} Rosuno ${title} ${title} information is not yet available. Return to the home page`,
      topic,
    );
    assert.deepEqual(page.hrefs, [...NAVIGATION_HREFS, "/"], topic);
    assert.deepEqual(page.metadata, { title }, topic);
    assert.match(page.html, /<nav aria-label="Rosuno">/);
    // Fail closed: nothing that could be policy, legal or contact text.
    assert.doesNotMatch(
      page.text.replace(NAVIGATION_TEXT, ""),
      /policy|we collect|personal data|cookie|consent|retain|liab|warrant|disclaim|complain|contact us|@|phone|email|licensed|approved|live in|regulated/i,
      topic,
    );
  }
});

test("S5-P2. the existing privacy and help pages say the same fixed statement in the same frame, without navigation (unchanged)", async () => {
  for (const [path, title] of [
    ["app/privacy/page.tsx", "Privacy"],
    ["app/help/page.tsx", "Help"],
  ]) {
    const page = await render(path);
    assert.equal(
      page.text,
      `Rosuno ${title} ${title} information is not yet available. Return to the home page`,
    );
  }
});
