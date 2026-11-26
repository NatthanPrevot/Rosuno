// MVP-001 S1 staff configuration routes: source contracts and rendering
// (fixture-only).
//
// The pages are checked as source, then transpiled with the installed
// TypeScript compiler into a temporary directory outside the repository and
// rendered with the installed React server renderer against the synthetic
// world in configuration-fixtures.mjs. Only their trusted wiring imports,
// the server actions their forms post to, the request logger, and the
// Next.js runtime call they make are replaced by stand-ins. Nothing is
// written anywhere but that temporary directory, which is removed, and every
// value is synthetic test data.

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import {
  addAssessment,
  addGate,
  addJob,
  addJurisdiction,
  addPolicyType,
  addPolicyVersion,
  addReviewIntake,
  addStaff,
  configurationSources,
  createWorld,
  grant,
  production,
  stamp,
} from "./configuration-fixtures.mjs";
import {
  addAttorney,
  addGrant as addVerificationGrant,
  addJurisdiction as addVerificationJurisdiction,
  addLicense,
  addStaff as addVerificationStaff,
  createWorld as createVerificationWorld,
  staffSources,
} from "./m4-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const real = (path) => new URL(path, appRoot).href;
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*\n/gm, "");
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

// Every staff configuration route file, exactly.
const CONFIGURATION_FILES = [
  "app/staff/actions.ts",
  "app/staff/capabilities/[member]/page.tsx",
  "app/staff/capabilities/forms.tsx",
  "app/staff/capabilities/page.tsx",
  "app/staff/catalog/forms.tsx",
  "app/staff/catalog/page.tsx",
  "app/staff/frame.tsx",
  "app/staff/intake-configuration/forms.tsx",
  "app/staff/intake-configuration/page.tsx",
  // MVP-001 S2: the operational job view and its forms.
  "app/staff/jobs/forms.tsx",
  "app/staff/jobs/page.tsx",
  // MVP-001 S3 part 2: the jurisdiction assessment review and its forms.
  "app/staff/jurisdiction-review/forms.tsx",
  "app/staff/jurisdiction-review/page.tsx",
  "app/staff/jurisdictions/[jurisdiction]/page.tsx",
  "app/staff/jurisdictions/forms.tsx",
  "app/staff/jurisdictions/page.tsx",
  "app/staff/launch/[jurisdiction]/page.tsx",
  "app/staff/launch/forms.tsx",
  "app/staff/launch/page.tsx",
  // DEV-001: the owner's UI/UX design's staff workspace frame (a server
  // layout) and its navigation (a client module the layout alone imports).
  "app/staff/layout.tsx",
  "app/staff/navigation.tsx",
  "app/staff/outcome.tsx",
  "app/staff/page.tsx",
  "app/staff/policies/[version]/page.tsx",
  "app/staff/policies/forms.tsx",
  "app/staff/policies/page.tsx",
];

// MVP-001 S11: the completion workspaces' staff files.
const S11_STAFF_FILES = [
  "app/staff/complaints/[case]/page.tsx",
  "app/staff/complaints/actions.ts",
  "app/staff/complaints/forms.tsx",
  "app/staff/complaints/page.tsx",
  "app/staff/compliance/actions.ts",
  "app/staff/compliance/page.tsx",
  "app/staff/consultations/[consultation]/page.tsx",
  "app/staff/consultations/actions.ts",
  "app/staff/consultations/forms.tsx",
  "app/staff/consultations/page.tsx",
  "app/staff/legal-holds/actions.ts",
  "app/staff/legal-holds/forms.tsx",
  "app/staff/legal-holds/page.tsx",
  "app/staff/review-item-list.tsx",
  "app/staff/review-items.tsx",
  "app/staff/reviews/actions.ts",
  "app/staff/reviews/forms.tsx",
  "app/staff/reviews/page.tsx",
];

// MVP-001 S11 pass 2: the operations and administration workspaces' staff
// files outside the finance workspace (the financial activity summary is
// admitted with the finance files below).
const S11_OPERATIONS_STAFF_FILES = [
  "app/staff/attorneys/[attorney]/page.tsx",
  "app/staff/attorneys/actions.ts",
  "app/staff/attorneys/forms.tsx",
  "app/staff/audit/[event]/page.tsx",
  "app/staff/audit/page.tsx",
  "app/staff/clients/[client]/page.tsx",
  "app/staff/clients/actions.ts",
  "app/staff/clients/forms.tsx",
  "app/staff/clients/page.tsx",
  "app/staff/operations/page.tsx",
  "app/staff/referrals/page.tsx",
  "app/staff/system-health/page.tsx",
];

// MVP-001 S11 PS-A6: break-glass access and data requests, their own staff
// surfaces (the privacy adapter's sources and their own use cases).
const S11_PS_A6_STAFF_FILES = [
  "app/staff/break-glass/[grant]/page.tsx",
  "app/staff/break-glass/actions.ts",
  "app/staff/break-glass/forms.tsx",
  "app/staff/break-glass/page.tsx",
  "app/staff/data-requests/[request]/page.tsx",
  "app/staff/data-requests/actions.ts",
  "app/staff/data-requests/forms.tsx",
  "app/staff/data-requests/page.tsx",
];

// Each list page: its use case. Each reads exactly one query value, page.
const LIST_PAGES = {
  "app/staff/policies/page.tsx": "resolvePolicyWorkspace",
  "app/staff/jurisdictions/page.tsx": "resolveJurisdictionList",
  "app/staff/launch/page.tsx": "resolveLaunchList",
  "app/staff/catalog/page.tsx": "resolveCatalog",
  "app/staff/capabilities/page.tsx": "resolveCapabilityAdministration",
  "app/staff/intake-configuration/page.tsx": "resolveIntakeConfiguration",
};

// Each detail page: its route segment and use case.
const DETAIL_PAGES = {
  "app/staff/policies/[version]/page.tsx": ["version", "resolvePolicyVersion"],
  "app/staff/jurisdictions/[jurisdiction]/page.tsx": [
    "jurisdiction",
    "resolveJurisdiction",
  ],
  "app/staff/launch/[jurisdiction]/page.tsx": ["jurisdiction", "resolveLaunch"],
  "app/staff/capabilities/[member]/page.tsx": [
    "member",
    "resolveMemberCapabilities",
  ],
};

const FORBIDDEN_IN_PAGES =
  /headers\(|cookies\(|process\.env|\bconsole\b|dangerouslySetInnerHTML|\.from\(|getUser|\.insert\(|\.update\(|\.rpc\(|\bstyle=|registration-provisioning|staff-verification-adapter/;

test("SR-1. the staff configuration routes are exactly these files: server pages rendered per request and unindexed, client forms, and one server action module", () => {
  // MVP-001 S7: the finance workspace is its own staff surface (its own
  // sources and use cases, like verification), admitted by its exact files:
  // three server pages rendered per request and unindexed, one client form
  // module and one server action module, none of them reading the
  // configuration sources or anything this list forbids.
  assert.deepEqual(
    filesIn("app/staff/").filter(
      (f) =>
        !f.startsWith("app/staff/verification/") &&
        !f.startsWith("app/staff/finance/") &&
        !S11_STAFF_FILES.includes(f) &&
        !S11_OPERATIONS_STAFF_FILES.includes(f) &&
        !S11_PS_A6_STAFF_FILES.includes(f),
    ),
    CONFIGURATION_FILES,
  );
  // MVP-001 S11 PS-A6: break-glass access and data requests are their own
  // staff surfaces, admitted by their exact files: server pages rendered per
  // request and unindexed that read the privacy adapter's sources and nothing
  // this list forbids, client form modules that import no infrastructure,
  // and server action modules.
  assert.deepEqual(
    filesIn("app/staff/").filter((f) => S11_PS_A6_STAFF_FILES.includes(f)),
    S11_PS_A6_STAFF_FILES,
  );
  for (const file of S11_PS_A6_STAFF_FILES.filter((f) =>
    f.endsWith("page.tsx"),
  )) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(code, FORBIDDEN_IN_PAGES, file);
    assert.doesNotMatch(code, /STAFF_CONFIGURATION_SOURCES/, file);
    assert.match(
      code,
      /import \{ (?:BREAK_GLASS_SOURCES|STAFF_DATA_REQUEST_SOURCES) \} from "(?:\.\.\/)+src\/infrastructure\/privacy\/privacy-adapter\.ts";/,
      file,
    );
  }
  for (const file of S11_PS_A6_STAFF_FILES.filter((f) =>
    f.endsWith("actions.ts"),
  )) {
    assert.match(read(file), /^"use server";\n/, file);
  }
  for (const file of S11_PS_A6_STAFF_FILES.filter((f) =>
    f.endsWith("forms.tsx"),
  )) {
    assert.match(read(file), /^"use client";\n/, file);
    assert.ok(
      importsOf(read(file)).every(
        (specifier) => !/infrastructure/.test(specifier),
      ),
      file,
    );
  }
  // MVP-001 S11 pass 2: the operations and administration workspaces are
  // their own staff surfaces, admitted by their exact files: server pages
  // rendered per request and unindexed that read the operations adapter's
  // sources and nothing this list forbids, client form modules that import no
  // infrastructure, and server action modules.
  assert.deepEqual(
    filesIn("app/staff/").filter((f) => S11_OPERATIONS_STAFF_FILES.includes(f)),
    S11_OPERATIONS_STAFF_FILES,
  );
  for (const file of [
    ...S11_OPERATIONS_STAFF_FILES.filter((f) => f.endsWith("page.tsx")),
    "app/staff/finance/summary/page.tsx",
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(code, FORBIDDEN_IN_PAGES, file);
    assert.doesNotMatch(code, /STAFF_CONFIGURATION_SOURCES/, file);
    assert.match(
      code,
      /import \{ (?:OPERATIONS_WORKSPACE_SOURCES|ADMINISTRATION_SOURCES) \} from "(?:\.\.\/)+src\/infrastructure\/staff\/operations-adapter\.ts";/,
      file,
    );
  }
  for (const file of S11_OPERATIONS_STAFF_FILES.filter((f) =>
    f.endsWith("actions.ts"),
  )) {
    assert.match(read(file), /^"use server";\n/, file);
  }
  for (const file of S11_OPERATIONS_STAFF_FILES.filter((f) =>
    f.endsWith("forms.tsx"),
  )) {
    assert.match(read(file), /^"use client";\n/, file);
    assert.ok(
      importsOf(read(file)).every(
        (specifier) => !/infrastructure/.test(specifier),
      ),
      file,
    );
  }
  // MVP-001 S11: the completion workspaces are their own staff surfaces
  // (their own sources and use cases, like finance), admitted by their exact
  // files: server pages rendered per request and unindexed that read the
  // completion adapter's sources and nothing this list forbids, client form
  // modules that import no infrastructure, and server action modules.
  assert.deepEqual(
    filesIn("app/staff/").filter((f) => S11_STAFF_FILES.includes(f)),
    S11_STAFF_FILES,
  );
  for (const file of S11_STAFF_FILES.filter((f) => f.endsWith("page.tsx"))) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(code, FORBIDDEN_IN_PAGES, file);
    assert.doesNotMatch(code, /STAFF_CONFIGURATION_SOURCES/, file);
    assert.match(
      code,
      /from "(?:\.\.\/)+src\/infrastructure\/consultations\/completion-adapter\.ts";/,
      file,
    );
  }
  for (const file of S11_STAFF_FILES.filter((f) => f.endsWith("actions.ts"))) {
    assert.match(read(file), /^"use server";\n/, file);
  }
  for (const file of [
    ...S11_STAFF_FILES.filter((f) => f.endsWith("forms.tsx")),
    "app/staff/review-items.tsx",
  ]) {
    assert.match(read(file), /^"use client";\n/, file);
    assert.ok(
      importsOf(read(file)).every(
        (specifier) => !/infrastructure/.test(specifier),
      ),
      file,
    );
  }
  assert.doesNotMatch(
    read("app/staff/review-item-list.tsx"),
    /["']use (?:client|server)["']/,
  );
  assert.doesNotMatch(
    codeOf(read("app/staff/review-item-list.tsx")),
    FORBIDDEN_IN_PAGES,
  );
  assert.deepEqual(filesIn("app/staff/finance/"), [
    "app/staff/finance/[payment]/page.tsx",
    "app/staff/finance/actions.ts",
    "app/staff/finance/exceptions/page.tsx",
    "app/staff/finance/forms.tsx",
    "app/staff/finance/page.tsx",
    // MVP-001 S11 pass 2: the financial activity summary (checked with the
    // operations pages above).
    "app/staff/finance/summary/page.tsx",
  ]);
  for (const file of [
    "app/staff/finance/[payment]/page.tsx",
    "app/staff/finance/exceptions/page.tsx",
    "app/staff/finance/page.tsx",
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(code, FORBIDDEN_IN_PAGES, file);
    assert.doesNotMatch(code, /STAFF_CONFIGURATION_SOURCES/, file);
    assert.match(
      code,
      /import \{ FINANCE_SOURCES \} from "(?:\.\.\/)+src\/infrastructure\/payments\/payment-adapter\.ts";/,
      file,
    );
  }
  assert.match(read("app/staff/finance/actions.ts"), /^"use server";\n/);
  assert.match(read("app/staff/finance/forms.tsx"), /^"use client";\n/);
  assert.ok(
    importsOf(read("app/staff/finance/forms.tsx")).every(
      (specifier) => !/infrastructure/.test(specifier),
    ),
  );
  const pages = CONFIGURATION_FILES.filter((f) => f.endsWith("page.tsx"));
  assert.equal(pages.length, 13);
  for (const file of pages) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(code, FORBIDDEN_IN_PAGES, file);
    assert.match(
      code,
      /import \{ STAFF_CONFIGURATION_SOURCES \} from "(?:\.\.\/)+src\/infrastructure\/staff\/staff-configuration-adapter\.ts";/,
      file,
    );
  }
  // The home page reads nothing of the request at all.
  assert.doesNotMatch(
    codeOf(read("app/staff/page.tsx")),
    /searchParams|params/,
  );
  for (const [file, resolver] of Object.entries(LIST_PAGES)) {
    const code = codeOf(read(file));
    assert.equal(code.match(/\bsearchParams\b/g)?.length, 3, file);
    assert.ok(
      code.includes(
        "readonly searchParams: Promise<{ readonly page?: string | string[] }>;",
      ),
      file,
    );
    assert.ok(code.includes("const { page } = await searchParams;"), file);
    assert.match(
      code.replace(/\s+/g, " "),
      new RegExp(
        `const view = await ${resolver}\\( ?STAFF_CONFIGURATION_SOURCES, page,? ?\\);`,
      ),
      file,
    );
    assert.doesNotMatch(code, /\bparams\b/, file);
  }
  // MVP-001 S2: the job view reads exactly two query values, state and
  // page, in exactly these three places, and hands both unread to its use
  // case, which checks them.
  const jobs = codeOf(read("app/staff/jobs/page.tsx"));
  assert.equal(jobs.match(/\bsearchParams\b/g)?.length, 3);
  assert.ok(
    jobs.includes(
      "readonly searchParams: Promise<{\n    readonly state?: string | string[];\n    readonly page?: string | string[];\n  }>;",
    ),
  );
  assert.ok(jobs.includes("const { state, page } = await searchParams;"));
  assert.match(
    jobs.replace(/\s+/g, " "),
    /const view = await resolveOperationalJobs\( ?STAFF_CONFIGURATION_SOURCES, state, page,? ?\);/,
  );
  assert.doesNotMatch(jobs, /\bparams\b|last_error_message|lastErrorMessage/);
  // MVP-001 S3 part 2: the review reads exactly two query values, group and
  // page, in exactly these three places, and hands both unread to its use
  // case, which checks them; it shows no client identity or intake content.
  const review = codeOf(read("app/staff/jurisdiction-review/page.tsx"));
  assert.equal(review.match(/\bsearchParams\b/g)?.length, 3);
  assert.ok(
    review.includes(
      "readonly searchParams: Promise<{\n    readonly group?: string | string[];\n    readonly page?: string | string[];\n  }>;",
    ),
  );
  assert.ok(review.includes("const { group, page } = await searchParams;"));
  assert.match(
    review.replace(/\s+/g, " "),
    /const view = await resolveJurisdictionReview\( ?STAFF_CONFIGURATION_SOURCES, group, page,? ?\);/,
  );
  assert.doesNotMatch(
    review,
    /\bparams\b|client_id|clientId|description|structured_answers|answers|voice/,
  );
  for (const [file, [segment, resolver]] of Object.entries(DETAIL_PAGES)) {
    const code = codeOf(read(file));
    assert.equal(code.match(/\bparams\b/g)?.length, 3, file);
    assert.ok(code.includes(`const { ${segment} } = await params;`), file);
    assert.match(
      code.replace(/\s+/g, " "),
      new RegExp(
        `const view = await ${resolver}\\( ?STAFF_CONFIGURATION_SOURCES, ${segment},? ?\\);`,
      ),
      file,
    );
    assert.doesNotMatch(code, /searchParams/, file);
  }
  // Forms are client modules that reach no infrastructure; the frame is a
  // server module.
  for (const file of CONFIGURATION_FILES.filter(
    (f) => f.endsWith("forms.tsx") || f === "app/staff/outcome.tsx",
  )) {
    const source = read(file);
    assert.match(source, /^"use client";\n/, file);
    assert.ok(
      importsOf(source).every((s) => !/infrastructure|provisioning/.test(s)),
      file,
    );
    assert.doesNotMatch(
      codeOf(source),
      /\bstyle=|dangerouslySetInnerHTML/,
      file,
    );
  }
  assert.doesNotMatch(
    read("app/staff/frame.tsx"),
    /["']use (?:client|server)["']/,
  );
  // DEV-001: the owner's UI/UX design's staff workspace frame. The layout is
  // a server module rendered per request: it opts out of prerendering, asks
  // the step-up gate first and then only the staff home's own use case with
  // the trusted sources, reads nothing of the request, offers no form, and
  // imports exactly these modules. Its navigation is a client module that
  // reads only the browser path, imports no infrastructure and holds no
  // state, and only the layout imports it.
  const layout = read("app/staff/layout.tsx");
  const layoutCode = codeOf(layout);
  assert.doesNotMatch(layout, /["']use (?:client|server)["']/);
  assert.ok(
    layoutCode.includes(
      '  await connection();\n  await requireSteppedUp("staff");\n  const home = await resolveStaffHome(STAFF_CONFIGURATION_SOURCES);\n',
    ),
  );
  assert.equal(layoutCode.match(/\bawait /g).length, 3);
  assert.doesNotMatch(layoutCode, FORBIDDEN_IN_PAGES);
  assert.doesNotMatch(
    layoutCode,
    /searchParams|params|<form|action=|logRequestEvent/,
  );
  assert.deepEqual(importsOf(layout), [
    "next/server",
    "react",
    "../../src/application/staff-configuration.ts",
    "../../src/infrastructure/staff/staff-configuration-adapter.ts",
    "../../src/presentation/staff-workspace.tsx",
    "../account/gate.ts",
    "./navigation.tsx",
  ]);
  const navigation = read("app/staff/navigation.tsx");
  assert.match(navigation, /^"use client";\n/);
  assert.deepEqual(importsOf(navigation), [
    "next/navigation",
    "../../src/application/staff-configuration.ts",
    "../../src/presentation/staff-workspace.tsx",
  ]);
  assert.ok(
    navigation.includes(
      'import type { StaffSurface } from "../../src/application/staff-configuration.ts";',
    ),
  );
  assert.doesNotMatch(
    codeOf(navigation),
    /\bstyle=|dangerouslySetInnerHTML|fetch\(|useEffect|useState|useSearchParams|useParams|document\.|window\.|<form/,
  );
  assert.deepEqual(
    filesIn("app/").filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        importsOf(read(f)).some((s) => /(?:^|\/)navigation\.tsx$/.test(s)),
    ),
    ["app/staff/layout.tsx"],
  );
});

test("SR-2. the server actions hand the form and the trusted sources to the use cases, never read the previous state, and log only the action and its outcome", () => {
  const source = read("app/staff/actions.ts");
  assert.match(source, /^"use server";\n/);
  const code = codeOf(source);
  assert.doesNotMatch(
    code,
    /_previous\.|process\.env|\bconsole\b|headers\(|cookies\(|redirect\(/,
  );
  const exported = [...code.matchAll(/^export async function (\w+)\(/gm)].map(
    (m) => m[1],
  );
  // MVP-001 S2: eighteen configuration actions and the two job actions.
  // MVP-001 S3 part 2: and the one jurisdiction assessment review action.
  assert.equal(exported.length, 21);
  assert.equal(code.match(/^export /gm).length, 21);
  for (const name of exported) {
    assert.match(name, /^[a-z][A-Za-z]+Action$/);
    const operation = name.replace(/Action$/, "");
    assert.ok(
      code
        .replace(/\s+/g, " ")
        .includes(`return run( "${operation}", ${operation},`) ||
        code
          .replace(/\s+/g, " ")
          .includes(`return run("${operation}", ${operation},`),
      name,
    );
  }
  assert.ok(
    code.includes(
      "const state = await operation(STAFF_CONFIGURATION_SOURCES, formData);",
    ),
  );
});

test("SR-3. no configuration value, jurisdiction, or payment term is written into the configuration modules", () => {
  for (const file of [
    ...CONFIGURATION_FILES,
    "src/application/staff-configuration.ts",
    "src/infrastructure/staff/staff-configuration-adapter.ts",
    "src/presentation/staff-configuration-labels.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /california|arizona|\bCA\b|\bAZ\b|state bar of/i,
      file,
    );
    assert.doesNotMatch(code, /\bfee\b|stripe|payment|price/i, file);
    assert.doesNotMatch(code, /\bstyle=/, file);
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

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

const directory = mkdtempSync(join(tmpdir(), "rosuno-s1-staff-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const target = (name) => pathToFileURL(join(directory, name)).href;
const write = (name, text) => writeFileSync(join(directory, name), text);
const jsxRuntime = import.meta.resolve("react/jsx-runtime");
const react = import.meta.resolve("react");

write(
  "wiring.mjs",
  `export const wiring = { sources: null, log: [], path: "/staff" };
const delegate = new Proxy({}, { get: (_t, key) => wiring.sources[key] });
export const STAFF_CONFIGURATION_SOURCES = delegate;
export const STAFF_VERIFICATION_SOURCES = delegate;
`,
);
write(
  "next-server.mjs",
  `import { wiring } from "./wiring.mjs";
export async function connection() { wiring.log.push("connection"); }
`,
);
// DEV-001: the browser path the staff navigation marks, given by the test.
write(
  "next-navigation.mjs",
  `import { wiring } from "./wiring.mjs";
export function usePathname() { return wiring.path; }
`,
);
write(
  "request-log.mjs",
  `import { wiring } from "./wiring.mjs";
export async function logRequestEvent(level, event, fields) { wiring.log.push({ level, event, fields }); }
`,
);
// MVP-001 S2: the step-up gate, replaced by a stand-in that lets the request
// through and refuses any principal kind but staff.
write(
  "gate.mjs",
  `export async function requireSteppedUp(kind) {
  if (kind !== "staff") {
    throw new Error("unexpected principal kind");
  }
}
`,
);
const ACTION_NAMES = [
  ...codeOf(read("app/staff/actions.ts")).matchAll(
    /^export async function (\w+)\(/gm,
  ),
  ...codeOf(read("app/staff/verification/actions.ts")).matchAll(
    /^export async function (\w+)\(/gm,
  ),
].map((m) => m[1]);
write(
  "actions.mjs",
  `const action = async (state) => state;\n${ACTION_NAMES.map((n) => `export const ${n} = action;`).join("\n")}\n`,
);

const built = new Map();

// Transpiles one app or presentation module with its imports relinked:
// application modules load as they are, and the trusted wiring, the server
// actions, the request logger, and the Next.js runtime are stand-ins.
function build(path) {
  if (built.has(path)) {
    return built.get(path);
  }
  const code = transpile(read(path), path).replace(
    /(\bfrom\s+|\bimport\s+)"([^"]+)"/g,
    (_m, keyword, specifier) => `${keyword}"${targetOf(path, specifier)}"`,
  );
  const name = `${path.replace(/[/[\]]/g, "_")}.mjs`;
  write(name, code);
  built.set(path, target(name));
  return target(name);
}

function targetOf(from, specifier) {
  if (specifier === "react") {
    return react;
  }
  if (specifier === "react/jsx-runtime") {
    return jsxRuntime;
  }
  if (specifier === "next/server") {
    return target("next-server.mjs");
  }
  // DEV-001: only the staff navigation reads the browser path.
  if (specifier === "next/navigation") {
    assert.equal(from, "app/staff/navigation.tsx");
    return target("next-navigation.mjs");
  }
  assert.ok(specifier.startsWith("."), `${from}: ${specifier}`);
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (
    path === "src/infrastructure/staff/staff-configuration-adapter.ts" ||
    path === "src/infrastructure/staff/staff-verification-adapter.ts"
  ) {
    return target("wiring.mjs");
  }
  if (path === "src/infrastructure/observability/request-log.ts") {
    return target("request-log.mjs");
  }
  if (
    path === "app/staff/actions.ts" ||
    path === "app/staff/verification/actions.ts"
  ) {
    return target("actions.mjs");
  }
  if (path === "app/account/gate.ts") {
    return target("gate.mjs");
  }
  assert.ok(!path.startsWith("src/infrastructure/"), `${from}: ${path}`);
  return path.startsWith("src/application/") ? real(path) : build(path);
}

const { wiring } = await import(target("wiring.mjs"));
const page = async (path) => import(build(path));

async function render(path, sources, props) {
  wiring.sources = sources;
  wiring.log.length = 0;
  const module = await page(path);
  const html = renderToStaticMarkup(await module.default(props));
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim(),
    hrefs: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    log: [...wiring.log],
    metadata: module.metadata,
  };
}

const ALL = [
  "manage_attorney_verification",
  "manage_policy_configuration",
  "manage_jurisdiction_configuration",
  "authorize_jurisdiction_launch",
  "manage_staff_capabilities",
  "manage_intake_configuration",
];

function world() {
  const w = createWorld();
  const a = addJurisdiction(w, 1, "SYN_A");
  addPolicyType(w, "synthetic_type");
  const admin = addStaff(w, 10, { name: "Synthetic Admin" });
  for (const capability of ALL) {
    grant(w, admin.userId, capability);
  }
  const scoped = addStaff(w, 11, { name: "Synthetic Scoped" });
  grant(w, scoped.userId, "manage_policy_configuration", {
    jurisdiction_id: a,
  });
  const plain = addStaff(w, 12);
  return { w, a, admin, scoped, plain };
}

const sources = (w, who) => configurationSources(w, who.authId);
const firstPage = { searchParams: Promise.resolve({}) };

test("SR-4. the staff home links only to the surfaces the caller holds, and refused callers see a fixed message and no surface", async () => {
  const { w, admin, scoped, plain } = world();
  const home = await render("app/staff/page.tsx", sources(w, admin));
  assert.deepEqual(home.log, ["connection"]);
  assert.deepEqual(home.hrefs, [
    "/staff/verification",
    "/staff/policies",
    "/staff/jurisdictions",
    "/staff/launch",
    "/staff/catalog",
    "/staff/capabilities",
    // MVP-001 S11 PS-A6: break-glass access, which every active staff member
    // may request (in the security and audit area).
    "/staff/break-glass",
    "/staff/intake-configuration",
    // MVP-001 S3 part 2: the review, for a manage_intake_configuration grant.
    "/staff/jurisdiction-review",
  ]);
  assert.equal(home.html.includes("<form"), false);
  assert.ok(
    home.metadata.robots.index === false &&
      home.metadata.robots.follow === false,
  );
  assert.deepEqual(
    (await render("app/staff/page.tsx", sources(w, scoped))).hrefs,
    ["/staff/policies", "/staff/break-glass"],
  );
  // MVP-001 S11 PS-A6 re-pin: an active staff member without any grant sees
  // exactly the break-glass request surface (a Staff Profile alone opens it)
  // and no other.
  const none = await render("app/staff/page.tsx", sources(w, plain));
  assert.deepEqual(none.hrefs, ["/staff/break-glass"]);
  assert.equal(none.text.includes("No staff tools available"), false);
  const anonymous = await render(
    "app/staff/page.tsx",
    configurationSources(w, null),
  );
  assert.deepEqual(anonymous.hrefs, ["/sign-in"]);
  assert.ok(anonymous.text.includes("Sign in to continue"));
});

test("SR-5. every surface refuses a caller without its capability with no form and no configuration data, and an unavailable view writes one log line naming the route", async () => {
  const { w, a, plain } = world();
  const version = addPolicyVersion(w, { jurisdiction_id: a });
  const pages = [
    ["app/staff/policies/page.tsx", firstPage],
    [
      "app/staff/policies/[version]/page.tsx",
      { params: Promise.resolve({ version: version.id }) },
    ],
    ["app/staff/jurisdictions/page.tsx", firstPage],
    [
      "app/staff/jurisdictions/[jurisdiction]/page.tsx",
      { params: Promise.resolve({ jurisdiction: a }) },
    ],
    ["app/staff/launch/page.tsx", firstPage],
    [
      "app/staff/launch/[jurisdiction]/page.tsx",
      { params: Promise.resolve({ jurisdiction: a }) },
    ],
    ["app/staff/catalog/page.tsx", firstPage],
    ["app/staff/capabilities/page.tsx", firstPage],
    [
      "app/staff/capabilities/[member]/page.tsx",
      { params: Promise.resolve({ member: plain.userId }) },
    ],
    ["app/staff/intake-configuration/page.tsx", firstPage],
    // MVP-001 S2.
    ["app/staff/jobs/page.tsx", firstPage],
    // MVP-001 S3 part 2.
    ["app/staff/jurisdiction-review/page.tsx", firstPage],
  ];
  for (const [path, props] of pages) {
    const denied = await render(path, sources(w, plain), props);
    assert.ok(denied.text.includes("not available"), path);
    assert.ok(denied.text.includes("No access"), path);
    assert.equal(denied.html.includes("<form"), false, path);
    assert.equal(denied.html.includes("<table"), false, path);
    assert.equal(denied.text.includes("SYN_A"), false, path);
    assert.deepEqual(denied.hrefs, ["/staff"], path);
    assert.ok(denied.metadata.robots.index === false, path);
    const unavailable = await render(
      path,
      { ...sources(w, plain), reads: async () => null },
      props,
    );
    assert.ok(unavailable.text.includes("unavailable"), path);
    assert.equal(unavailable.html.includes("<form"), false, path);
    assert.deepEqual(unavailable.hrefs, [], path);
    const route = path.replace(/^app/, "").replace(/\/page\.tsx$/, "");
    assert.deepEqual(
      unavailable.log,
      [
        "connection",
        {
          level: "warn",
          event: "staff_configuration.view_unavailable",
          fields: { route, outcome: "unavailable" },
        },
      ],
      path,
    );
  }
});

test("SR-6. development configuration is offered and marked only where the database records development or staging, and policy changes are not offered on an unbound environment", async () => {
  const { w, a, admin } = world();
  addPolicyVersion(w, {
    jurisdiction_id: a,
    development_only: true,
    effective_from: stamp(w.now - 1000),
  });
  const development = await render(
    "app/staff/policies/page.tsx",
    sources(w, admin),
    firstPage,
  );
  assert.ok(
    development.text.includes("Database environment: Development database."),
  );
  assert.ok(
    development.text.includes(
      "Create as development configuration (development or staging only)",
    ),
  );
  assert.ok(development.text.includes("Development configuration"));
  assert.ok(development.html.includes('name="development_only"'));
  production(w);
  const productionView = await render(
    "app/staff/policies/page.tsx",
    sources(w, admin),
    firstPage,
  );
  assert.equal(productionView.html.includes('name="development_only"'), false);
  assert.ok(productionView.html.includes("<form"));
  // The existing development configuration row stays marked as such.
  assert.ok(productionView.text.includes("Development configuration"));
  w.deployment_environment = null;
  const unrecorded = await render(
    "app/staff/policies/page.tsx",
    sources(w, admin),
    firstPage,
  );
  assert.ok(unrecorded.text.includes("Policy changes are refused"));
  assert.equal(unrecorded.html.includes("<form"), false);
});

test("SR-7. a policy version offers only the changes its state allows; a scoped caller sees only its own scope; the catalog is refused without the global grant", async () => {
  const { w, a, admin, scoped } = world();
  const b = addJurisdiction(w, 2, "SYN_B");
  const draft = addPolicyVersion(w, { jurisdiction_id: a });
  const other = addPolicyVersion(w, { jurisdiction_id: b });
  const view = await render(
    "app/staff/policies/[version]/page.tsx",
    sources(w, scoped),
    { params: Promise.resolve({ version: draft.id }) },
  );
  assert.ok(view.text.includes("Move to Internal review"));
  assert.equal(view.text.includes("Move to Approved"), false);
  assert.ok(view.text.includes("Revise this draft"));
  assert.ok(view.text.includes("Add an authority reference"));
  assert.ok(
    view.html.includes(
      `name="expected_updated_at" value="${draft.updated_at}"`,
    ),
  );
  const denied = await render(
    "app/staff/policies/[version]/page.tsx",
    sources(w, scoped),
    { params: Promise.resolve({ version: other.id }) },
  );
  assert.equal(denied.html.includes("<form"), false);
  assert.equal(denied.text.includes(other.version_label), false);
  const list = await render(
    "app/staff/policies/page.tsx",
    sources(w, scoped),
    firstPage,
  );
  assert.ok(list.hrefs.includes(`/staff/policies/${draft.id}`));
  assert.equal(list.hrefs.includes(`/staff/policies/${other.id}`), false);
  const catalog = await render(
    "app/staff/catalog/page.tsx",
    sources(w, scoped),
    firstPage,
  );
  assert.ok(catalog.text.includes("No access"));
  const adminCatalog = await render(
    "app/staff/catalog/page.tsx",
    sources(w, admin),
    firstPage,
  );
  assert.ok(adminCatalog.text.includes("Add a practice area"));
});

test("SR-8. launch offers gate changes and authorization only to their own capability holders, and nobody is offered a grant to themselves", async () => {
  const { w, a, admin } = world();
  addGate(w, a, "synthetic_gate");
  const launcher = addStaff(w, 20);
  grant(w, launcher.userId, "authorize_jurisdiction_launch", {
    jurisdiction_id: a,
  });
  const props = { params: Promise.resolve({ jurisdiction: a }) };
  const asLauncher = await render(
    "app/staff/launch/[jurisdiction]/page.tsx",
    sources(w, launcher),
    props,
  );
  assert.ok(asLauncher.text.includes("Grant launch authorization"));
  assert.equal(asLauncher.text.includes("Define a launch gate"), false);
  assert.equal(asLauncher.html.includes('name="evaluation_status"'), false);
  assert.ok(asLauncher.text.includes("0 of 1"));
  const asAdmin = await render(
    "app/staff/launch/[jurisdiction]/page.tsx",
    sources(w, admin),
    props,
  );
  assert.ok(asAdmin.text.includes("Define a launch gate"));
  assert.ok(asAdmin.html.includes('name="evaluation_status"'));
  const self = await render(
    "app/staff/capabilities/[member]/page.tsx",
    sources(w, admin),
    { params: Promise.resolve({ member: admin.userId }) },
  );
  assert.ok(self.text.includes("You cannot grant capabilities to yourself."));
  assert.equal(self.html.includes('name="capability_code"'), false);
  const otherMember = await render(
    "app/staff/capabilities/[member]/page.tsx",
    sources(w, admin),
    { params: Promise.resolve({ member: launcher.userId }) },
  );
  assert.ok(otherMember.html.includes('name="capability_code"'));
  assert.ok(otherMember.text.includes("authorize_jurisdiction_launch"));
});

test("SR-9. D-4: the verification queue page links to its neighbouring pages and to the other staff tools", async () => {
  const w = createVerificationWorld();
  const a = addVerificationJurisdiction(w, 1, "SYN_A");
  for (let n = 0; n < 30; n += 1) {
    const attorney = addAttorney(w, 100 + n, "under_review");
    w.attorney_profiles.at(-1).updated_at = stamp(w.now - n * 1000);
    addLicense(w, attorney.attorneyId, a);
  }
  const reviewer = addVerificationStaff(w, 30);
  addVerificationGrant(w, reviewer.userId);
  const first = await render(
    "app/staff/verification/page.tsx",
    staffSources(w, reviewer.authId),
    firstPage,
  );
  assert.ok(first.text.includes("Page 1 of the queue."));
  assert.ok(first.text.includes("More of the queue is on the next page."));
  assert.ok(first.hrefs.includes("/staff/verification?page=2"));
  assert.equal(first.text.includes("Previous page"), false);
  assert.ok(first.hrefs.includes("/staff"));
  assert.equal(
    first.hrefs.filter((h) => /^\/staff\/verification\/.+/.test(h)).length,
    25,
  );
  const second = await render(
    "app/staff/verification/page.tsx",
    staffSources(w, reviewer.authId),
    { searchParams: Promise.resolve({ page: "2" }) },
  );
  assert.ok(second.text.includes("This is the last page."));
  assert.ok(second.hrefs.includes("/staff/verification"));
  assert.equal(second.hrefs.includes("/staff/verification?page=3"), false);
  assert.equal(
    second.hrefs.filter((h) => /^\/staff\/verification\/.+/.test(h)).length,
    5,
  );
  // A page value the server does not accept shows the first page.
  const odd = await render(
    "app/staff/verification/page.tsx",
    staffSources(w, reviewer.authId),
    { searchParams: Promise.resolve({ page: ["2", "3"] }) },
  );
  assert.ok(odd.text.includes("Page 1 of the queue."));
});

// ---------------------------------------------------------------------------
// MVP-001 S2: the operational job view
// ---------------------------------------------------------------------------

function jobWorld() {
  const w = createWorld();
  const operator = addStaff(w, 50, { name: "Synthetic Operator" });
  grant(w, operator.userId, "manage_operational_jobs");
  const plain = addStaff(w, 51);
  const escalated = addJob(w, { state: "escalated" });
  const overdue = addJob(w, { available_at: stamp(w.now - 5_000) });
  const running = addJob(w, {
    state: "running",
    available_at: stamp(w.now + 90_000),
  });
  const done = addJob(w, { state: "completed" });
  const cancelled = addJob(w, { state: "cancelled" });
  return { w, operator, plain, escalated, overdue, running, done, cancelled };
}

const jobsPage = (query = {}) => ({ searchParams: Promise.resolve(query) });

test("SR-10. the job view is listed for its capability holders, shows escalated jobs first with retry and cancel, and never a message, worker, or subject data", async () => {
  const j = jobWorld();
  const home = await render("app/staff/page.tsx", sources(j.w, j.operator));
  // MVP-001 S11 PS-A6 re-pin: and the break-glass request surface every
  // active staff member sees.
  assert.deepEqual(home.hrefs, ["/staff/jobs", "/staff/break-glass"]);
  assert.ok(home.text.includes("Operational jobs"));
  const view = await render(
    "app/staff/jobs/page.tsx",
    sources(j.w, j.operator),
    jobsPage(),
  );
  assert.deepEqual(view.log, ["connection"]);
  assert.ok(view.metadata.robots.index === false);
  assert.ok(view.text.includes("Escalated jobs"));
  assert.ok(view.text.includes("synthetic.check"));
  assert.ok(view.text.includes("unknown_job_type"));
  assert.ok(view.text.includes("1 of 1"));
  assert.ok(view.text.includes(j.escalated.subject_id));
  assert.ok(view.text.includes("Retry this job"));
  assert.ok(view.text.includes("Cancel this job"));
  assert.equal(view.html.match(/<form/g).length, 2);
  assert.equal(
    view.html.match(new RegExp(`name="job" value="${j.escalated.id}"`, "g"))
      .length,
    2,
  );
  // Only the escalated group is listed: no other job's id appears.
  for (const other of [j.overdue, j.running, j.done, j.cancelled]) {
    assert.equal(view.html.includes(other.id), false);
  }
  assert.equal(view.text.includes("Synthetic message never shown"), false);
  assert.equal(view.html.includes("synthetic-worker"), false);
  assert.deepEqual(view.hrefs, [
    "/staff",
    "/staff/jobs",
    "/staff/jobs?state=open",
    "/staff/jobs?state=finished",
  ]);
  assert.ok(
    view.html.includes(
      'aria-current="page" class="btn btn-ink" data-variant="primary" href="/staff/jobs"',
    ),
  );
});

test("SR-11. waiting and running jobs show that they wait for a worker run, finished jobs offer no change, and every group pages on its own address", async () => {
  const j = jobWorld();
  const open = await render(
    "app/staff/jobs/page.tsx",
    sources(j.w, j.operator),
    jobsPage({ state: "open" }),
  );
  assert.ok(open.text.includes("Waiting or running jobs"));
  assert.ok(open.text.includes("waiting for a worker run"));
  assert.ok(open.text.includes("lease until"));
  assert.equal(open.text.includes("Retry this job"), false);
  assert.equal(open.html.match(/<form/g).length, 2);
  assert.equal(open.html.includes(j.escalated.id), false);
  const finished = await render(
    "app/staff/jobs/page.tsx",
    sources(j.w, j.operator),
    jobsPage({ state: "finished" }),
  );
  assert.ok(finished.text.includes("Completed at"));
  assert.ok(finished.text.includes("Cancelled"));
  assert.equal(finished.html.includes("<form"), false);
  // A group with no jobs says so; paging keeps the group in its addresses.
  const empty = createWorld();
  const operator = addStaff(empty, 60);
  grant(empty, operator.userId, "manage_operational_jobs");
  const none = await render(
    "app/staff/jobs/page.tsx",
    sources(empty, operator),
    jobsPage({ state: "open" }),
  );
  assert.ok(none.text.includes("There are no waiting or running jobs."));
  for (let n = 0; n < 27; n += 1) {
    addJob(empty, { available_at: stamp(empty.now + 1_000 + n) });
  }
  const first = await render(
    "app/staff/jobs/page.tsx",
    sources(empty, operator),
    jobsPage({ state: "open" }),
  );
  // The markup escapes the separator.
  assert.ok(first.hrefs.includes("/staff/jobs?state=open&amp;page=2"));
  const second = await render(
    "app/staff/jobs/page.tsx",
    sources(empty, operator),
    jobsPage({ state: "open", page: "2" }),
  );
  assert.ok(second.hrefs.includes("/staff/jobs?state=open"));
  assert.ok(second.text.includes("There are no more jobs."));
  // A value the server does not accept shows the escalated group.
  const odd = await render(
    "app/staff/jobs/page.tsx",
    sources(j.w, j.operator),
    jobsPage({ state: ["open", "finished"], page: "x" }),
  );
  assert.ok(odd.text.includes("Escalated jobs"));
  // Without the capability nothing of the view is shown.
  const denied = await render(
    "app/staff/jobs/page.tsx",
    sources(j.w, j.plain),
    jobsPage({ state: "open" }),
  );
  assert.ok(denied.text.includes("No access"));
  assert.equal(denied.html.includes("synthetic.check"), false);
});

test("SR-12. MVP-001 S3 part 2: the jurisdiction assessment review lists the Intakes awaiting review with each in-scope assessment and its two decisions, shows several jurisdictions as several, and never a client, description or answer", async () => {
  const { w, a, admin, plain } = world();
  const b = addJurisdiction(w, 2, "SYN_B");
  const several = addReviewIntake(w);
  const inA = addAssessment(w, several.id, a);
  addAssessment(w, several.id, b, {
    review_status: "not_confirmed",
    reviewed_at: stamp(w.now - 1000),
    reviewed_by_user_id: admin.userId,
  });
  const none = addReviewIntake(w);
  const view = await render(
    "app/staff/jurisdiction-review/page.tsx",
    sources(w, admin),
    firstPage,
  );
  assert.deepEqual(view.log, ["connection"]);
  assert.ok(view.metadata.robots.index === false);
  assert.ok(view.text.includes(`Intake ${several.id}`));
  assert.ok(view.text.includes("Several jurisdictions named; none is chosen"));
  assert.ok(view.text.includes("Synthetic SYN_A (SYN_A)"));
  assert.ok(view.text.includes("Not reviewed"));
  assert.ok(view.text.includes("Not confirmed"));
  assert.ok(view.text.includes("By you at"));
  assert.ok(view.text.includes("never decides which law applies"));
  // Exactly the two decision forms of the one unreviewed assessment.
  assert.equal(view.html.match(/<form/g).length, 2);
  assert.equal(
    view.html.match(new RegExp(`name="assessment" value="${inA.id}"`, "g"))
      .length,
    2,
  );
  assert.ok(view.html.includes('name="decision" value="confirmed"'));
  assert.ok(view.html.includes('name="decision" value="not_confirmed"'));
  assert.ok(view.text.includes("Confirm: may be relevant"));
  assert.equal(view.text.includes(none.id), false);
  assert.doesNotMatch(
    view.text,
    /description|answer|voice|client_id|governing law is|best match|recommended/i,
  );
  assert.deepEqual(view.hrefs, [
    "/staff",
    "/staff/jurisdiction-review",
    "/staff/jurisdiction-review?group=unnamed",
  ]);
  // The unnamed group: the Intake that names none, with nothing to choose.
  const unnamed = await render(
    "app/staff/jurisdiction-review/page.tsx",
    sources(w, admin),
    { searchParams: Promise.resolve({ group: "unnamed" }) },
  );
  assert.ok(unnamed.text.includes(`Intake ${none.id}`));
  assert.ok(unnamed.text.includes("No jurisdiction named"));
  assert.ok(unnamed.text.includes("there is nothing to review"));
  assert.equal(unnamed.html.includes("<form"), false);
  // A scoped reviewer: its own jurisdiction only, and no unnamed group.
  const scoped = addStaff(w, 13);
  grant(w, scoped.userId, "manage_intake_configuration", {
    jurisdiction_id: b,
  });
  const scopedView = await render(
    "app/staff/jurisdiction-review/page.tsx",
    sources(w, scoped),
    firstPage,
  );
  assert.ok(scopedView.text.includes("No assessment waits for your review."));
  assert.deepEqual(scopedView.hrefs, ["/staff", "/staff/jurisdiction-review"]);
  const refused = await render(
    "app/staff/jurisdiction-review/page.tsx",
    sources(w, plain),
    firstPage,
  );
  assert.ok(refused.text.includes("No access"));
});

// ---------------------------------------------------------------------------
// DEV-001: the staff workspace navigation (the owner's UI/UX design)
// ---------------------------------------------------------------------------

async function renderLayout(sources, path) {
  wiring.sources = sources;
  wiring.path = path;
  wiring.log.length = 0;
  const module = await page("app/staff/layout.tsx");
  const html = renderToStaticMarkup(
    await module.default({
      children: createElement("p", { id: "page-marker" }, "Page content"),
    }),
  );
  return {
    html,
    hrefs: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    log: [...wiring.log],
  };
}

function sliceOf(html, open, close) {
  const start = html.indexOf(open);
  if (start < 0) {
    return null;
  }
  return html.slice(start, html.indexOf(close, start) + close.length);
}

const hrefsIn = (html) =>
  html === null ? [] : [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test("SR-13. DEV-001: the staff workspace navigation shows only the destinations whose surfaces the staff home's use case answered for the caller, marks where the caller is, and stands in for no page's own access decision", async () => {
  const { STAFF_SURFACES } = await import(
    real("src/application/staff-configuration.ts")
  );
  const shell = await import(build("src/presentation/staff-workspace.tsx"));
  // Every destination's view is an existing staff page, every staff surface
  // is one destination's view, and only the overview needs no surface.
  const views = shell.STAFF_NAVIGATION.flatMap((group) =>
    group.destinations.flatMap((destination) => destination.views),
  );
  for (const view of views) {
    assert.match(view.href, /^\/staff(\/[a-z-]+)*$/, view.href);
    assert.ok(
      statSync(
        new URL(`app${view.href}/page.tsx`.replace("//", "/"), appRoot),
      ).isFile(),
      view.href,
    );
  }
  assert.deepEqual(
    [...new Set(views.map((view) => view.surface).filter(Boolean))].sort(),
    [...STAFF_SURFACES].sort(),
  );
  assert.deepEqual(
    views.filter((view) => view.surface === null).map((view) => view.href),
    ["/staff"],
  );
  // The Owner group holds Approvals only (no owner role exists); the
  // design's Readiness and access matrix are not shipped.
  assert.deepEqual(
    shell.STAFF_NAVIGATION.map((group) => [
      group.id,
      group.destinations.map((destination) => destination.id),
    ]),
    [
      ["home", ["overview"]],
      ["owner", ["approvals"]],
      ["operations", ["bookings", "support"]],
      ["people", ["clients", "applications"]],
      ["platform", ["marketplace", "finance"]],
      ["admin", ["staff", "settings"]],
    ],
  );

  const { w, admin, scoped, plain } = world();
  const nav = (html) => hrefsIn(sliceOf(html, '<nav class="st-nav"', "</nav>"));
  const tabs = (html) =>
    hrefsIn(sliceOf(html, '<nav class="w-tabs st-tabs st-vtabs"', "</nav>"));
  // A holder of every configuration capability: exactly the destinations
  // holding the surfaces the staff home answered, each to its first held
  // view, then the account link; the page follows unchanged.
  const full = await renderLayout(sources(w, admin), "/staff/launch");
  assert.deepEqual(full.log, ["connection"]);
  assert.deepEqual(nav(full.html), [
    "/staff",
    "/staff/policies",
    "/staff/verification",
    "/staff/jurisdictions",
    "/staff/capabilities",
  ]);
  assert.deepEqual(full.hrefs, [
    "/",
    ...nav(full.html),
    "/account/security",
    ...tabs(full.html),
  ]);
  assert.ok(
    full.html.endsWith(
      '<p id="page-marker">Page content</p></div></div></div></div></div>',
    ),
  );
  // The current destination and its current view are marked, and the
  // destination's held views are its tabs.
  assert.equal(full.html.match(/aria-current="page"/g).length, 2);
  assert.ok(
    full.html.includes(
      'class="w-ni on" href="/staff/jurisdictions" aria-current="page"',
    ),
  );
  assert.deepEqual(tabs(full.html), [
    "/staff/jurisdictions",
    "/staff/launch",
    "/staff/catalog",
    "/staff/intake-configuration",
    "/staff/jurisdiction-review",
  ]);
  assert.ok(
    full.html.includes(
      'class="w-tb on" href="/staff/launch" aria-current="page"',
    ),
  );
  // A record page belongs to its list's view.
  const record = await renderLayout(
    sources(w, admin),
    "/staff/capabilities/00000000-0000-4000-8000-000000000001",
  );
  assert.ok(
    record.html.includes(
      'class="w-ni on" href="/staff/capabilities" aria-current="page"',
    ),
  );
  // Only the held views are tabs (the activity log needs view_audit_events,
  // which this caller does not hold), the list's view marked.
  assert.deepEqual(tabs(record.html), [
    "/staff/capabilities",
    "/staff/break-glass",
  ]);
  assert.ok(
    record.html.includes(
      'class="w-tb on" href="/staff/capabilities" aria-current="page"',
    ),
  );
  // A destination with one held view shows no tabs.
  const policies = await renderLayout(sources(w, scoped), "/staff/policies");
  assert.deepEqual(nav(policies.html), [
    "/staff",
    "/staff/policies",
    "/staff/break-glass",
  ]);
  assert.deepEqual(tabs(policies.html), []);
  // An active staff member without any grant: the dashboard and break-glass
  // access only.
  const none = await renderLayout(sources(w, plain), "/staff");
  assert.deepEqual(nav(none.html), ["/staff", "/staff/break-glass"]);
  assert.deepEqual(tabs(none.html), []);
  for (const forbidden of [
    "/staff/policies",
    "/staff/verification",
    "/staff/finance",
    "/staff/capabilities",
    "/staff/jobs",
  ]) {
    assert.equal(none.hrefs.includes(forbidden), false, forbidden);
  }
  // On a page the caller does not hold, nothing of it is advertised: the
  // page's own refusal decides, the navigation adds no way in.
  const elsewhere = await renderLayout(sources(w, plain), "/staff/catalog");
  assert.deepEqual(nav(elsewhere.html), ["/staff", "/staff/break-glass"]);
  assert.equal(elsewhere.html.includes('aria-current="page"'), false);
  assert.deepEqual(tabs(elsewhere.html), []);
  const operator = jobWorld();
  const jobs = await renderLayout(
    sources(operator.w, operator.operator),
    "/staff/jobs",
  );
  assert.deepEqual(nav(jobs.html), [
    "/staff",
    "/staff/break-glass",
    "/staff/jobs",
  ]);
  // A visitor the staff home does not admit, or a home that cannot be read:
  // the frame with the brand only, no navigation, no account link.
  for (const [name, refused] of [
    ["signed out", configurationSources(w, null)],
    ["unavailable", { ...sources(w, admin), reads: async () => null }],
  ]) {
    const frame = await renderLayout(refused, "/staff");
    assert.deepEqual(frame.hrefs, ["/"], name);
    assert.equal(frame.html.includes("<nav"), false, name);
    assert.ok(
      frame.html.includes('<p id="page-marker">Page content</p>'),
      name,
    );
  }
  // The frame offers no form, field or button of its own.
  assert.doesNotMatch(full.html, /<form|<input|<select|<textarea|<button/);
});
