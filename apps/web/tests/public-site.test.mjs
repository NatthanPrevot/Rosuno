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
    if (s.endsWith("site-chrome.tsx")) {
      return `${keyword}"${local("site-chrome.mjs")}"`;
    }
    if (s.endsWith("public-content.ts")) {
      return `${keyword}"${content}"`;
    }
    throw new Error(`unexpected import ${s}`);
  });

for (const [name, path] of [
  ["design-system.mjs", "src/presentation/design-system.tsx"],
  ["site-chrome.mjs", "src/presentation/site-chrome.tsx"],
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

// DEV-001: the public site chrome of the owner's design (header and footer)
// frames every public page. Its text is fixed first-party navigation and the
// design's placeholders, pinned here once and held to the fail-closed rule.
const CHROME_HEADER_TEXT =
  "rosuno Find an attorney Legal matters How it works Help For attorneys Log in Sign up";
const CHROME_FOOTER_TEXT =
  "rosuno Talk to an attorney by video or audio — now, or at a time that suits you. [platform statement — counsel’s text] Clients Find an attorney Help me find an attorney How it works My consultations Finish account confirmation Attorneys Rosuno for attorneys Apply to join Attorney sign in Rosuno About Help &amp; FAQ Contact Legal Privacy Terms Disclosures © Rosuno Legal and regulatory disclosures [jurisdiction disclosures — counsel’s text]";
const CHROME_HEADER_HREFS = [
  "/",
  "/find-an-attorney",
  "/#legal-issues",
  "/how-it-works",
  "/help",
  "/for-attorneys",
  "/sign-in",
  "/sign-up",
];
const CHROME_FOOTER_HREFS = [
  "/",
  "/find-an-attorney",
  "/client/requests/new",
  "/how-it-works",
  "/client/consultations",
  "/auth/confirm",
  "/for-attorneys",
  "/attorney/apply",
  "/sign-in",
  "/about",
  "/help",
  "/contact",
  "/privacy",
  "/terms",
  "/disclosures",
  "/disclosures",
];
const FAIL_CLOSED =
  /policy|we collect|personal data|cookie|consent|retain|liab|warrant|disclaim|complain|contact us|@|phone|email|licensed|approved|live in|regulated/i;

async function renderChrome() {
  const module = await import(local("site-chrome.mjs"));
  const text = (html) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const header = renderToStaticMarkup(
    module.SiteHeader({ session: "anonymous" }),
  );
  const footer = renderToStaticMarkup(module.SiteFooter());
  return {
    headerText: text(header),
    footerText: text(footer),
    headerHrefs: [...header.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    footerHrefs: [...footer.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
  };
}

test("S5-P0. the site chrome holds only fixed first-party links, labels and the design's placeholders", async () => {
  const chrome = await renderChrome();
  assert.equal(chrome.headerText, CHROME_HEADER_TEXT);
  assert.equal(chrome.footerText, CHROME_FOOTER_TEXT);
  assert.deepEqual(chrome.headerHrefs, CHROME_HEADER_HREFS);
  assert.deepEqual(chrome.footerHrefs, CHROME_FOOTER_HREFS);
  for (const text of [chrome.headerText, chrome.footerText]) {
    assert.doesNotMatch(text, FAIL_CLOSED);
  }
});

const SIDE_TEXT = `Rosuno ${NAVIGATION_TEXT}`;

function assertContentPage(page, title, label) {
  assert.equal(
    page.text,
    `${CHROME_HEADER_TEXT} ${SIDE_TEXT} Rosuno ${title} ${title} information is not yet available. Return to the home page ${CHROME_FOOTER_TEXT}`,
    label,
  );
  assert.deepEqual(
    page.hrefs,
    [...CHROME_HEADER_HREFS, ...NAVIGATION_HREFS, "/", ...CHROME_FOOTER_HREFS],
    label,
  );
  assert.deepEqual(page.metadata, { title }, label);
  // DEV-001: the owner's UI/UX design names the site-pages list "Site pages";
  // its phone rule (one column, the list as a row) keys on that name.
  assert.match(page.html, /<nav [^>]*aria-label="Site pages">/);
  // The current page is marked in the site-pages list, exactly once.
  assert.equal(page.html.match(/aria-current="page"/g)?.length, 1, label);
  // Fail closed: nothing on the page could be policy, legal or contact text.
  assert.doesNotMatch(
    page.text.replace(NAVIGATION_TEXT, ""),
    FAIL_CLOSED,
    label,
  );
}

test("S5-P1. every public content page renders only the site chrome, the site-pages list, its title, the fixed statement that its information is not yet available, and the way home", async () => {
  for (const [topic, title] of Object.entries(PUBLIC_CONTENT_TOPICS)) {
    assertContentPage(await render(`app/${topic}/page.tsx`), title, topic);
  }
});

test("S5-P2. the privacy and help pages say the same fixed statement in the same frame", async () => {
  for (const [path, title] of [
    ["app/privacy/page.tsx", "Privacy"],
    ["app/help/page.tsx", "Help"],
  ]) {
    assertContentPage(await render(path), title, path);
  }
});
