// MVP-001 S3 part 2: the privacy and help entry points (MBS section 18;
// MVP-001 Packet rule 11 and the section 3 gate "Public content, Privacy,
// Terms, disclosures": unapproved content is not rendered) and the client
// suggestion, routing and change wording (MB section 27; MBS sections 8 and
// 10). The two pages are checked as source, then transpiled with the
// installed TypeScript compiler into a temporary directory outside the
// repository and rendered with the installed React server renderer; nothing
// else is written, and the directory is removed.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { suggestionMessage } from "../src/presentation/client-intake-labels.ts";
import {
  AI_SUGGESTION_NOTE,
  CHANGE_LABELS,
  CHANGE_NOTE,
  outcomeMessage,
  PREFILL_NOTE,
  routingText,
  SUGGESTION_STATUS_LABELS,
  suggestionText,
} from "../src/presentation/client-intake-labels.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*\n/gm, "");
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);

const PAGES = Object.freeze({
  "app/privacy/page.tsx": [
    "Privacy",
    "Privacy information is not yet available.",
  ],
  "app/help/page.tsx": ["Help", "Help information is not yet available."],
});

// MBS section 10's banned recommendation claims, and affirmative claims that
// a law applies or that anything is approved or live.
const BANNED =
  /best match|recommended attorney|perfect attorney|ai-selected|right lawyer for you|(?<!which )law (definitely )?applies|is the governing law|approved by the|licensed by the|live in your state/i;

const directory = mkdtempSync(join(tmpdir(), "rosuno-s3v2-entry-"));
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
const relink = (code) =>
  code.replace(/(\bfrom\s+|\bimport\s+)"([^"]+)"/g, (_m, keyword, s) => {
    if (s === "react/jsx-runtime") {
      return `${keyword}"${jsxRuntime}"`;
    }
    if (s === "react") {
      return `${keyword}"${react}"`;
    }
    if (s.endsWith("design-system.tsx")) {
      return `${keyword}"${pathToFileURL(join(directory, "design-system.mjs")).href}"`;
    }
    if (s.endsWith("site-chrome.tsx")) {
      return `${keyword}"${pathToFileURL(join(directory, "site-chrome.mjs")).href}"`;
    }
    if (s.endsWith("public-site.tsx")) {
      return `${keyword}"${pathToFileURL(join(directory, "public-site.mjs")).href}"`;
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
  const module = await import(pathToFileURL(join(directory, name)).href);
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

test("PE-1. the privacy and help pages are fixed public server pages that read and decide nothing, and render only that the information is not yet available", async () => {
  for (const [path, [title, sentence]] of Object.entries(PAGES)) {
    const source = read(path);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, path);
    // DEV-001: the pages render the public-site frame of the owner's design.
    assert.deepEqual(importsOf(source), [
      "next",
      "../../src/presentation/public-site.tsx",
    ]);
    assert.doesNotMatch(
      code,
      /searchParams|params|connection|headers\(|cookies\(|process\.env|fetch\(|dangerouslySetInnerHTML|\bstyle=|https?:|\bawait\b/,
      path,
    );
    const page = await render(path);
    // The page's own content (its article) is the title, the one fixed
    // sentence and the way home; the chrome and the site-pages list around it
    // are fixed navigation, pinned in the public-site tests.
    const article = page.html.slice(
      page.html.indexOf("<article"),
      page.html.indexOf("</article>") + "</article>".length,
    );
    const articleText = article
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(
      articleText,
      `Rosuno ${title} ${sentence} Return to the home page`,
      path,
    );
    assert.deepEqual(
      [...article.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
      ["/"],
      path,
    );
    assert.deepEqual(page.metadata, { title }, path);
    assert.doesNotMatch(
      articleText,
      /policy|terms|we collect|personal data|cookie|consent|retain|disclos|complain|contact us|@/i,
      path,
    );
  }
});

test("PE-2. the entry points are reachable from the home page and the client workspace as fixed first-party links", () => {
  // DEV-001: the home page renders the site chrome, whose footer holds the
  // fixed help and privacy entry points once each.
  const home = codeOf(read("app/page.tsx"));
  const chrome = codeOf(read("src/presentation/site-chrome.tsx"));
  const footer = chrome.slice(chrome.indexOf("SITE_FOOTER"));
  assert.match(
    home,
    /<SitePage session=\{view\.session\} signOut=\{signOut\}>/,
  );
  assert.equal(footer.match(/href: "\/help"/g).length, 1);
  assert.equal(footer.match(/href: "\/privacy"/g).length, 1);
  // DEV-001: the owner's UI/UX design renders the client workspace inside the
  // same site chrome, so its help and privacy entry points are the chrome's
  // own fixed links (the header's Help and the footer's two, pinned above),
  // and the workspace adds no second copy of either.
  const workspace = codeOf(read("app/client/page.tsx"));
  assert.equal(
    workspace.match(
      /<SitePage session=\{shell\.session\} signOut=\{signOut\}>/g,
    ).length,
    4,
  );
  assert.match(chrome, /\{ href: "\/help", label: "Help" \}/);
  assert.equal(workspace.match(/href="\/help"/g), null);
  assert.equal(workspace.match(/href="\/privacy"/g), null);
});

test("PE-3. client suggestion wording: places only ever 'may be relevant', a category only as one that may fit, no banned recommendation claim, and nothing changes until the client saves", () => {
  const places = suggestionText("potentially_relevant_jurisdictions", [
    "State A",
    "State B",
  ]);
  assert.equal(
    places,
    "Places where attorneys may be relevant, based on what you told us: State A or State B.",
  );
  assert.equal(
    suggestionText("practice_category", ["Family"]),
    "A category that may fit what you told us: Family.",
  );
  const texts = [
    places,
    AI_SUGGESTION_NOTE,
    PREFILL_NOTE,
    CHANGE_NOTE,
    ...Object.values(CHANGE_LABELS),
    ...Object.values(SUGGESTION_STATUS_LABELS).map((l) => l.label),
    routingText({ kind: "category", name: "Family" }),
    routingText({ kind: "not_sure" }),
    routingText({ kind: "unanswered" }),
    routingText({ kind: "none" }),
  ];
  for (const status of [
    "suggested",
    "no-suggestion",
    "ai-unavailable",
    "conflict",
    "not-editable",
    "not-found",
    "rate-limited",
    "outcome-unknown",
    "sign-in-required",
    "denied",
    "unavailable",
  ]) {
    const message = suggestionMessage({ status });
    assert.ok(message !== null, status);
    texts.push(message.title, message.body);
  }
  for (const status of [
    "suggestion-confirmed",
    "suggestion-rejected",
    "already-decided",
    "change-not-configured",
    "change-not-applicable",
    "expired",
  ]) {
    const message = outcomeMessage({ status });
    assert.ok(message !== null, status);
    texts.push(message.title, message.body);
  }
  for (const text of texts) {
    assert.doesNotMatch(text, BANNED, text);
  }
  assert.equal(suggestionMessage({ status: "idle" }), null);
  // Packet rule 11: no unapproved legal text (no disclaimer wording).
  assert.doesNotMatch(
    AI_SUGGESTION_NOTE,
    /legal advice|disclaim|liab|warrant/i,
  );
  assert.match(AI_SUGGESTION_NOTE, /never choose an attorney/);
  assert.match(
    AI_SUGGESTION_NOTE,
    /Nothing changes in your answers unless you save them/,
  );
  assert.match(PREFILL_NOTE, /saved only when you save/);
  assert.match(
    suggestionMessage({ status: "ai-unavailable" }).body,
    /complete and submit your Intake on your own/,
  );
  assert.match(
    routingText({ kind: "category", name: "Family" }),
    /your own choice, not a legal classification/,
  );
  assert.match(
    routingText({ kind: "not_sure" }),
    /We have not chosen one for you/,
  );
  assert.match(CHANGE_NOTE, /not available yet/);
  assert.match(
    outcomeMessage({ status: "change-not-configured" }).title,
    /Not available yet/,
  );
});

test("PE-4. the client suggestion section is offered only on a draft with saved content, decision forms only for an undecided suggestion, and change forms only after submission or expiry", () => {
  const page = codeOf(read("app/client/intakes/[intake]/page.tsx"));
  assert.match(
    page.replace(/\s+/g, " "),
    /\{view\.canRequestSuggestions && view\.latestRevision !== null \? \( <SuggestionRequestForm/,
  );
  assert.match(
    page.replace(/\s+/g, " "),
    /\{suggestion\.decidable \? \( <SuggestionDecisionForms/,
  );
  assert.match(
    page.replace(/\s+/g, " "),
    /\{view\.changes\.length === 0 \? null : \(/,
  );
  assert.equal(page.match(/<SuggestionRequestForm/g).length, 1);
  assert.equal(page.match(/<IntakeChangeForm/g).length, 1);
  const forms = codeOf(read("app/client/intakes/[intake]/forms.tsx"));
  // The decision form sends exactly the Intake, the suggestion and one fixed
  // decision; the change form exactly the Intake and one fixed change.
  assert.equal(forms.match(/name="decision" value="confirm"/g).length, 1);
  assert.equal(forms.match(/name="decision" value="reject"/g).length, 1);
  assert.equal(forms.match(/name="change" value=\{change\}/g).length, 1);
  assert.doesNotMatch(forms, /name="(?:practice_area|value|model|user|client)/);
});
