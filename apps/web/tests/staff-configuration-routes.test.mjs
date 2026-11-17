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

import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import {
  addGate,
  addJurisdiction,
  addPolicyType,
  addPolicyVersion,
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
  "app/staff/jurisdictions/[jurisdiction]/page.tsx",
  "app/staff/jurisdictions/forms.tsx",
  "app/staff/jurisdictions/page.tsx",
  "app/staff/launch/[jurisdiction]/page.tsx",
  "app/staff/launch/forms.tsx",
  "app/staff/launch/page.tsx",
  "app/staff/outcome.tsx",
  "app/staff/page.tsx",
  "app/staff/policies/[version]/page.tsx",
  "app/staff/policies/forms.tsx",
  "app/staff/policies/page.tsx",
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
  assert.deepEqual(
    filesIn("app/staff/").filter(
      (f) => !f.startsWith("app/staff/verification/"),
    ),
    CONFIGURATION_FILES,
  );
  const pages = CONFIGURATION_FILES.filter((f) => f.endsWith("page.tsx"));
  assert.equal(pages.length, 11);
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
  assert.equal(exported.length, 18);
  assert.equal(code.match(/^export /gm).length, 18);
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
  `export const wiring = { sources: null, log: [] };
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
write(
  "request-log.mjs",
  `import { wiring } from "./wiring.mjs";
export async function logRequestEvent(level, event, fields) { wiring.log.push({ level, event, fields }); }
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
    "/staff/intake-configuration",
  ]);
  assert.equal(home.html.includes("<form"), false);
  assert.ok(
    home.metadata.robots.index === false &&
      home.metadata.robots.follow === false,
  );
  assert.deepEqual(
    (await render("app/staff/page.tsx", sources(w, scoped))).hrefs,
    ["/staff/policies"],
  );
  const none = await render("app/staff/page.tsx", sources(w, plain));
  assert.deepEqual(none.hrefs, []);
  assert.ok(none.text.includes("No staff tools available"));
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
