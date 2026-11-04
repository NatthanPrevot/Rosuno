// P3-003 route rendering tests (fixture-only).
//
// The professional setup page and the staff review pages are transpiled
// with the installed TypeScript compiler into a temporary directory outside
// the repository and rendered with the installed React server renderer
// against the synthetic M4 world in m4-fixtures.mjs. Only their trusted
// wiring imports, the server actions their forms post to, and the Next.js
// runtime calls they make are replaced by stand-ins. Nothing is written
// anywhere but that temporary directory, which is removed, and every value
// is synthetic test data.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import {
  addAttorney,
  addEvidence,
  addGrant,
  addJurisdiction,
  addLicense,
  addPracticeArea,
  addStaff,
  attorneySources,
  createWorld,
  staffSources,
} from "./m4-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const real = (path) => new URL(path, appRoot).href;

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

// Every import of a transpiled module must have a target, and every target
// must be used, so the module's imports stay exact.
function relink(code, targets) {
  const seen = new Set();
  const linked = code.replace(
    /(\bfrom\s+|\bimport\s+)"([^"]+)"/g,
    (_m, keyword, specifier) => {
      assert.ok(Object.hasOwn(targets, specifier), specifier);
      seen.add(specifier);
      return `${keyword}"${targets[specifier]}"`;
    },
  );
  assert.deepEqual([...seen].sort(), Object.keys(targets).sort());
  return linked;
}

const WIRING = `export const wiring = { sources: null, log: [] };
const delegate = new Proxy({}, { get: (_t, key) => wiring.sources[key] });
export const ATTORNEY_PROFESSIONAL_SOURCES = delegate;
export const STAFF_VERIFICATION_SOURCES = delegate;
`;
const NEXT_SERVER = `import { wiring } from "./wiring.mjs";
export async function connection() { wiring.log.push("connection"); }
`;
const ACTIONS = `const action = async (state) => state;
export const saveDetails = action, saveLicense = action, saveInsurance = action, requestArea = action, changeAreaRequest = action, submitForReview = action;
export const recordFinding = action, recordUnavailableSource = action, recordDiscipline = action, decideArea = action, changeStage = action, recordDetermination = action;
`;

const directory = mkdtempSync(join(tmpdir(), "rosuno-p3-003-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const target = (name) => pathToFileURL(join(directory, name)).href;
const write = (name, text) => writeFileSync(join(directory, name), text);
const jsxRuntime = import.meta.resolve("react/jsx-runtime");
const react = import.meta.resolve("react");

write("wiring.mjs", WIRING);
write("next-server.mjs", NEXT_SERVER);
write("actions.mjs", ACTIONS);
write(
  "design-system.mjs",
  relink(transpile(read("src/presentation/design-system.tsx"), "design.tsx"), {
    "react/jsx-runtime": jsxRuntime,
  }),
);
write(
  "attorney-forms.mjs",
  relink(transpile(read("app/attorney/professional/forms.tsx"), "forms.tsx"), {
    react,
    "react/jsx-runtime": jsxRuntime,
    "../../../src/application/attorney-professional.ts": real(
      "src/application/attorney-professional.ts",
    ),
    "../../../src/presentation/design-system.tsx": target("design-system.mjs"),
    "./actions.ts": target("actions.mjs"),
  }),
);
write(
  "attorney-page.mjs",
  relink(transpile(read("app/attorney/professional/page.tsx"), "page.tsx"), {
    "react/jsx-runtime": jsxRuntime,
    "next/server": target("next-server.mjs"),
    "../../../src/application/attorney-professional.ts": real(
      "src/application/attorney-professional.ts",
    ),
    "../../../src/infrastructure/professional/attorney-professional-adapter.ts":
      target("wiring.mjs"),
    "../../../src/presentation/design-system.tsx": target("design-system.mjs"),
    "./forms.tsx": target("attorney-forms.mjs"),
  }),
);
write(
  "staff-forms.mjs",
  relink(transpile(read("app/staff/verification/forms.tsx"), "forms.tsx"), {
    react,
    "react/jsx-runtime": jsxRuntime,
    "../../../src/application/staff-verification.ts": real(
      "src/application/staff-verification.ts",
    ),
    "../../../src/presentation/design-system.tsx": target("design-system.mjs"),
    "./actions.ts": target("actions.mjs"),
  }),
);
write(
  "staff-queue.mjs",
  relink(transpile(read("app/staff/verification/page.tsx"), "page.tsx"), {
    "react/jsx-runtime": jsxRuntime,
    "next/server": target("next-server.mjs"),
    "../../../src/application/staff-verification.ts": real(
      "src/application/staff-verification.ts",
    ),
    "../../../src/infrastructure/staff/staff-verification-adapter.ts":
      target("wiring.mjs"),
    "../../../src/presentation/design-system.tsx": target("design-system.mjs"),
  }),
);
write(
  "labels.mjs",
  relink(
    transpile(read("src/presentation/professional-labels.ts"), "labels.ts"),
    {},
  ),
);
write(
  "staff-review.mjs",
  relink(
    transpile(read("app/staff/verification/[attorney]/page.tsx"), "page.tsx"),
    {
      "react/jsx-runtime": jsxRuntime,
      "next/server": target("next-server.mjs"),
      "../../../../src/application/staff-verification.ts": real(
        "src/application/staff-verification.ts",
      ),
      "../../../../src/infrastructure/staff/staff-verification-adapter.ts":
        target("wiring.mjs"),
      "../../../../src/presentation/design-system.tsx":
        target("design-system.mjs"),
      "../../../../src/presentation/professional-labels.ts":
        target("labels.mjs"),
      "../forms.tsx": target("staff-forms.mjs"),
    },
  ),
);

const { wiring } = await import(target("wiring.mjs"));
const attorneyPage = await import(target("attorney-page.mjs"));
const staffQueue = await import(target("staff-queue.mjs"));
const staffReview = await import(target("staff-review.mjs"));

async function render(page, sources, props) {
  wiring.sources = sources;
  wiring.log.length = 0;
  const html = renderToStaticMarkup(await page.default(props));
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    log: [...wiring.log],
  };
}

function world() {
  const w = createWorld();
  const a = addJurisdiction(w, 1, "SYN_A");
  addPracticeArea(w, 1);
  return { w, a };
}

test("M4-R1. professional setup keeps the five readiness facts apart and offers claim forms only in the applicant stage", async () => {
  const { w, a } = world();
  const me = addAttorney(w, 10, "applicant");
  const { html, text, log } = await render(
    attorneyPage,
    attorneySources(w, me.authId),
  );
  assert.deepEqual(log, ["connection"]);
  for (const row of [
    "Account access Active",
    "Application stage Applicant (not yet submitted)",
    "Verification evidence No claims yet",
    "Current eligibility Not determined",
    "Marketplace and scheduling Not activated at this stage",
  ]) {
    assert.ok(text.includes(row), row);
  }
  assert.ok(text.includes("Each of these is a separate fact"));
  assert.ok(html.includes("<form"));
  assert.ok(!text.includes("Submit application for review"));
  assert.ok(text.includes("Add at least one license claim before submitting"));
  addLicense(w, me.attorneyId, a);
  const withLicense = await render(attorneyPage, attorneySources(w, me.authId));
  assert.ok(withLicense.text.includes("Submit application for review"));
  assert.ok(withLicense.text.includes("Awaiting review"));
  assert.ok(metadataIsPrivate(attorneyPage.metadata));
});

test("M4-R2. under review, a checked claim shows its source status and no form of any kind is offered", async () => {
  const { w, a } = world();
  const me = addAttorney(w, 10, "under_review");
  const license = addLicense(w, me.attorneyId, a, {
    reported_status: "synthetic-active",
  });
  addEvidence(w, "license", license);
  const { html, text } = await render(
    attorneyPage,
    attorneySources(w, me.authId),
  );
  assert.equal(html.includes("<form"), false);
  assert.ok(text.includes("Claims are with review staff"));
  assert.ok(text.includes("Source check recorded"));
  assert.ok(text.includes("synthetic-active"));
  assert.ok(text.includes("Application stage Under review"));
  // An approved stage is labeled as a stage only.
  w.attorney_profiles[0].profile_state = "approved";
  assert.ok(
    (await render(attorneyPage, attorneySources(w, me.authId))).text.includes(
      "Approved (profile stage only)",
    ),
  );
});

test("M4-R3. sign-in, no application, denied, and unavailable states show fixed messages and no record or form", async () => {
  const { w } = world();
  const me = addAttorney(w, 10, "applicant");
  const cases = [
    [attorneySources(w, null), "Sign in to continue", ["/sign-in"]],
    [
      attorneySources(w, addStaff(w, 30).authId),
      "Start an application first",
      ["/attorney/apply"],
    ],
    [
      attorneySources(w, addAttorney(w, 11, "suspended").authId),
      "Professional setup not available",
      [],
    ],
    [
      attorneySources(w, me.authId, { provisioning: async () => null }),
      "Professional setup unavailable",
      ["/attorney"],
    ],
  ];
  for (const [sources, title, hrefs] of cases) {
    const { html, text } = await render(attorneyPage, sources);
    assert.ok(text.includes(title), title);
    assert.equal(html.includes("<form"), false, title);
    assert.equal(html.includes("<table"), false, title);
    assert.deepEqual(
      [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
      hrefs,
      title,
    );
  }
});

test("M4-R4. the staff queue and review render only within the reviewer's scope, and viewing records no evaluation", async () => {
  const { w, a } = world();
  const applicant = addAttorney(w, 10, "under_review", {
    display_name: "Synthetic Applicant",
  });
  addLicense(w, applicant.attorneyId, a);
  const global = addStaff(w, 30);
  addGrant(w, global.userId);
  const queue = await render(staffQueue, staffSources(w, global.authId));
  assert.ok(queue.text.includes("Synthetic Applicant"));
  assert.ok(
    queue.html.includes(`href="/staff/verification/${applicant.attorneyId}"`),
  );
  const review = await render(staffReview, staffSources(w, global.authId), {
    params: Promise.resolve({ attorney: applicant.attorneyId }),
  });
  assert.ok(review.text.includes("Profile stage Under review"));
  assert.ok(review.text.includes("Shown, not recorded"));
  // Under review is a definite "not eligible" on the profile factor, while
  // the policy-dependent factors stay on hold rather than assumed.
  assert.ok(review.text.includes("Synthetic SYN_A (SYN_A) Not eligible"));
  assert.ok(
    review.text.includes(
      "Profile stage Not met The profile stage is not approved.",
    ),
  );
  assert.ok(
    review.text.includes(
      "License Not determined Cannot be assessed until an applicable policy is selected.",
    ),
  );
  assert.ok(
    review.text.includes(
      "No approved, active, effective policy applies to this jurisdiction.",
    ),
  );
  assert.ok(review.text.includes("No verification evidence recorded"));
  assert.ok(review.html.includes("<form"));
  assert.equal(w.eligibility_evaluations.length, 0);
  assert.equal(w.audit_events.length, 0);
  // A reviewer without access sees no record data or form.
  const none = addStaff(w, 31);
  for (const [page, props] of [
    [staffQueue, undefined],
    [
      staffReview,
      { params: Promise.resolve({ attorney: applicant.attorneyId }) },
    ],
  ]) {
    const { html, text } = await render(
      page,
      staffSources(w, none.authId),
      props,
    );
    assert.equal(html.includes("<form"), false);
    assert.equal(text.includes("Synthetic Applicant"), false);
    assert.equal(text.includes("SYN-"), false);
  }
  // A jurisdiction-scoped reviewer sees records but not the profile.
  const scoped = addStaff(w, 32);
  addGrant(w, scoped.userId, { jurisdiction_id: a });
  const scopedReview = await render(
    staffReview,
    staffSources(w, scoped.authId),
    { params: Promise.resolve({ attorney: applicant.attorneyId }) },
  );
  assert.ok(scopedReview.text.includes("Profile not in your scope"));
  assert.equal(scopedReview.text.includes("Synthetic Applicant"), false);
  assert.ok(
    metadataIsPrivate(staffQueue.metadata) &&
      metadataIsPrivate(staffReview.metadata),
  );
});

function metadataIsPrivate(metadata) {
  return metadata.robots.index === false && metadata.robots.follow === false;
}
