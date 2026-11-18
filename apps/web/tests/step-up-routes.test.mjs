// MVP-001 S2: step-up routes, gate wiring, and server actions (source
// contracts and rendering, fixture-only).
//
// The account pages, the gate, the account actions, and representative
// gated pages and actions are transpiled with the installed TypeScript
// compiler into temporary directories outside the repository and run with
// the installed React server renderer. Only their trusted wiring imports,
// the Next.js runtime calls, the request logger, and the gate (where a route
// is driven past it) are replaced by stand-ins; application modules load as
// they are. Every value is synthetic test data.

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
  addAccount,
  createWorld,
  form,
  sourcesFor,
} from "./step-up-fixtures.mjs";

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

const ACCOUNT_FILES = [
  "app/account/actions.ts",
  "app/account/gate.ts",
  "app/account/security/forms.tsx",
  "app/account/security/page.tsx",
  "app/account/step-up/forms.tsx",
  "app/account/step-up/page.tsx",
];

const NEW_MODULES = [
  "src/application/session-assurance.ts",
  "src/application/totp-step-up.ts",
  "src/infrastructure/identity/authenticator-provider.ts",
  "src/presentation/authenticator-labels.ts",
];

// Every attorney and staff page, and the principal kind its gate serves.
const GATED_PAGES = [
  ...filesIn("app/attorney/").filter((f) => f.endsWith("/page.tsx")),
  ...filesIn("app/staff/").filter((f) => f.endsWith("/page.tsx")),
];

// The gated server action modules and the kind each serves.
const GATED_ACTIONS = {
  "app/attorney/professional/actions.ts": "attorney",
  // MVP-001 S4: the attorney schedule changes and its heartbeat.
  "app/attorney/schedule/actions.ts": "attorney",
  // MVP-001 S6 PS-A3: the attorney's offer price and withdrawal changes.
  "app/attorney/offers/actions.ts": "attorney",
  // MVP-001 S8: the attorney's acceptance and decline of a request.
  "app/attorney/requests/actions.ts": "attorney",
  // MVP-001 S9: the attorney's consultation room access, start and end.
  "app/attorney/consultations/actions.ts": "attorney",
  "app/staff/actions.ts": "staff",
  // MVP-001 S7: the finance workspace changes.
  "app/staff/finance/actions.ts": "staff",
  "app/staff/verification/actions.ts": "staff",
};

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

test("S2-R1. the account routes are exactly these files: two server pages, two client forms, one server action module, and one server-only gate", () => {
  assert.deepEqual(filesIn("app/account/"), ACCOUNT_FILES);
  for (const file of [
    "app/account/security/page.tsx",
    "app/account/step-up/page.tsx",
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    // Opts out of prerendering first, then reads only the one query value.
    assert.ok(
      code.includes(
        "  await connection();\n  const { to } = await searchParams;\n",
      ),
      file,
    );
    assert.ok(
      code.includes(
        "readonly searchParams: Promise<{ readonly to?: string | string[] }>;",
      ),
      file,
    );
    assert.equal(code.match(/\bsearchParams\b/g).length, 3, file);
    assert.doesNotMatch(
      code,
      /\bparams\b|headers\(|cookies\(|process\.env|\bconsole\b|redirect|\.from\(|getUser|getSession|\.mfa\b/,
      file,
    );
    // Every destination is a fixed address or one of the fixed tables.
    for (const href of code.matchAll(/href=(\{[^}]*\}|"[^"]*")/g)) {
      assert.match(
        href[1],
        /^(?:"\/sign-in"|"\/"|\{ACCOUNT_PAGES\[view\.kind\]\.(?:stepUp|security)\}|\{STEP_UP_DESTINATIONS\[view\.kind\]\})$/,
        `${file}: ${href[1]}`,
      );
    }
  }
  for (const file of [
    "app/account/security/forms.tsx",
    "app/account/step-up/forms.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /^"use client";\n/, file);
    assert.ok(
      importsOf(source).every((s) => !/infrastructure|gate\.ts/.test(s)),
      file,
    );
  }
});

test("S2-R2. no setup picture, embedded markup, or image is ever rendered, and the setup key and link are read-only text that is never posted", () => {
  for (const file of [...ACCOUNT_FILES, ...NEW_MODULES]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /dangerouslySetInnerHTML|<img\b|qr_?code|qrCode|data:image|\bsrc=|innerHTML/i,
      file,
    );
  }
  const forms = codeOf(read("app/account/security/forms.tsx"));
  for (const id of ["authenticator-setup-key", "authenticator-setup-link"]) {
    const field = forms.slice(
      forms.indexOf(`id="${id}"`),
      forms.indexOf("/>", forms.indexOf(`id="${id}"`)),
    );
    assert.match(field, /\breadOnly\b/, id);
    assert.doesNotMatch(field, /\bname=/, id);
  }
  assert.equal(forms.match(/value=\{setup\.secret\}/g).length, 1);
  assert.equal(forms.match(/value=\{setup\.uri\}/g).length, 1);
  // The setup key is shown only by the pending-setup branch, outside any form.
  const pending = forms.slice(forms.indexOf('if (setup.status !== "pending")'));
  assert.ok(
    pending.indexOf("setup.secret") <
      pending.indexOf("<form action={confirmAction}>"),
  );
});

test("S2-R3. every attorney page and every staff page asks the step-up gate first, right after opting out of prerendering", () => {
  // MVP-001 S2: sixteen pages, and the operational job view. MVP-001 S3
  // part 2: and the jurisdiction assessment review. MVP-001 S4: and the
  // attorney schedule. MVP-001 S6 PS-A3: and the attorney's offers. MVP-001
  // S7: and the attorney's earnings and the three finance pages. MVP-001 S8:
  // and the attorney's request queue and request page. MVP-001 S9: and the
  // attorney's consultation list and consultation page.
  assert.equal(GATED_PAGES.length, 28);
  for (const file of [
    "app/attorney/consultations/page.tsx",
    "app/attorney/consultations/[consultation]/page.tsx",
  ]) {
    assert.ok(GATED_PAGES.includes(file), file);
  }
  for (const file of [
    "app/attorney/requests/page.tsx",
    "app/attorney/requests/[request]/page.tsx",
  ]) {
    assert.ok(GATED_PAGES.includes(file), file);
  }
  for (const file of [
    "app/attorney/earnings/page.tsx",
    "app/staff/finance/page.tsx",
    "app/staff/finance/[payment]/page.tsx",
    "app/staff/finance/exceptions/page.tsx",
  ]) {
    assert.ok(GATED_PAGES.includes(file), file);
  }
  assert.ok(GATED_PAGES.includes("app/attorney/offers/page.tsx"));
  assert.ok(GATED_PAGES.includes("app/staff/jurisdiction-review/page.tsx"));
  assert.ok(GATED_PAGES.includes("app/attorney/schedule/page.tsx"));
  for (const file of GATED_PAGES) {
    const kind = file.startsWith("app/staff/") ? "staff" : "attorney";
    const code = codeOf(read(file));
    const depth = file.split("/").length - 2;
    const specifier = `${"../".repeat(depth)}account/gate.ts`;
    assert.ok(
      code.includes(`import { requireSteppedUp } from "${specifier}";`),
      file,
    );
    const gate = `  await connection();\n  await requireSteppedUp("${kind}");\n`;
    assert.equal(code.split(gate).length, 2, file);
    assert.equal(code.match(/requireSteppedUp\(/g).length, 1, file);
    // Nothing else is awaited before the gate.
    const beforeGate = code.slice(0, code.indexOf(gate));
    assert.doesNotMatch(
      beforeGate.slice(beforeGate.lastIndexOf("{")),
      /await /,
      file,
    );
  }
});

test("S2-R4. every attorney and staff server action asks the gate before its use case and returns the gate's refusal unchanged", () => {
  for (const [file, kind] of Object.entries(GATED_ACTIONS)) {
    const code = codeOf(read(file));
    assert.match(read(file), /^"use server";\n/, file);
    const depth = file.split("/").length - 2;
    assert.ok(
      code.includes(
        `import { stepUpRefusal } from "${"../".repeat(depth)}account/gate.ts";`,
      ),
      file,
    );
    const guard = `  const refusal = await stepUpRefusal("${kind}");\n  if (refusal !== null) {\n    return refusal;\n  }\n`;
    assert.equal(code.split(guard).length, 2, file);
    assert.equal(code.match(/stepUpRefusal\(/g).length, 1, file);
    const after = code.slice(code.indexOf(guard) + guard.length);
    if (file === "app/staff/actions.ts") {
      assert.ok(
        after.startsWith(
          "  const state = await operation(STAFF_CONFIGURATION_SOURCES, formData);",
        ),
        file,
      );
      continue;
    }
    // MVP-001 S7: every finance action goes through the one guarded helper
    // with the finance sources: four changes (refund, assignment,
    // resolution and reconciliation).
    if (file === "app/staff/finance/actions.ts") {
      assert.ok(
        after.startsWith(
          "  const state = await operation(FINANCE_SOURCES, formData);",
        ),
        file,
      );
      const exported = [...code.matchAll(/^export async function (\w+)\(/gm)];
      assert.equal(exported.length, 4, file);
      assert.equal(code.match(/ {2}return gated\("/g).length, 4, file);
      assert.doesNotMatch(code, /return (?!gated|refusal|state)\w/, file);
      continue;
    }
    assert.ok(after.startsWith("  const state = await operation();"), file);
    // Every exported action goes through the one guarded helper: the six
    // verification changes and (MVP-001 S3) opening an uploaded document.
    // MVP-001 S4: the schedule's five changes and its heartbeat, the
    // heartbeat answering the gate's refusal unchanged like every change.
    // MVP-001 S6 PS-A3: the offers' two changes (price and withdrawal).
    // MVP-001 S8: the request decision's two changes (accept and decline).
    // MVP-001 S9: the consultation's room access, start and end.
    const verification = file === "app/staff/verification/actions.ts";
    const offers = file === "app/attorney/offers/actions.ts";
    const requests = file === "app/attorney/requests/actions.ts";
    const consultations = file === "app/attorney/consultations/actions.ts";
    const expected = verification
      ? 7
      : offers || requests
        ? 2
        : consultations
          ? 3
          : 6;
    const exported = [...code.matchAll(/^export async function (\w+)\(/gm)];
    assert.equal(exported.length, expected, file);
    assert.equal(
      code.match(/return gated\(\(\) =>/g).length,
      expected,
      file,
    );
    assert.equal(
      code.includes(
        "export async function openArtifact(\n  _previous: ArtifactAccessState,\n  formData: FormData,\n): Promise<ArtifactAccessState> {\n  return gated(() => observedArtifact(formData));\n}",
      ),
      verification,
      file,
    );
    assert.doesNotMatch(code, /return (?!gated|refusal|state)\w/, file);
  }
  // The one attorney or staff action left outside the gate is the
  // application start: it creates an applicant profile for an account that
  // holds none yet (no professional write and no staff operation), and it
  // returns only to the gated application page.
  const otherActions = [
    ...filesIn("app/attorney/"),
    ...filesIn("app/staff/"),
  ].filter(
    (f) =>
      /["']use server["']/.test(read(f)) && !Object.hasOwn(GATED_ACTIONS, f),
  );
  assert.deepEqual(otherActions, ["app/attorney/apply/actions.ts"]);
});

test("S2-R5. the gate and the account actions read no request input and return only to fixed addresses", () => {
  const gate = codeOf(read("app/account/gate.ts"));
  assert.doesNotMatch(
    read("app/account/gate.ts"),
    /["']use (?:client|server)["']/,
  );
  assert.deepEqual(importsOf(read("app/account/gate.ts")), [
    "next/navigation",
    "../../src/application/session-assurance.ts",
    "../../src/infrastructure/identity/authenticator-provider.ts",
  ]);
  assert.equal(gate.match(/\bredirect\(/g).length, 1);
  assert.match(gate, /if \(path !== null\) \{\n {4}redirect\(path\);\n {2}\}/);
  assert.match(
    gate,
    /const path = stepUpPathOf\(\n {4}await resolveStepUpGate\(STEP_UP_SOURCES, kind\),\n {4}kind,\n {2}\);/,
  );
  assert.doesNotMatch(
    gate,
    /headers|cookies|searchParams|formData|process\.env|\bconsole\b/,
  );
  const actions = read("app/account/actions.ts");
  const code = codeOf(actions);
  assert.match(actions, /^"use server";\n/);
  assert.deepEqual(importsOf(actions), [
    "next/cache",
    "next/navigation",
    "../../src/application/totp-step-up.ts",
    "../../src/infrastructure/identity/authenticator-provider.ts",
  ]);
  assert.deepEqual(
    [...code.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]),
    ["startEnrollment", "confirmEnrollment", "confirmStepUp"],
  );
  assert.equal(code.match(/\bexport\b/g).length, 3);
  assert.equal(code.match(/\bredirect\(/g).length, 1);
  assert.match(
    code,
    /if \(state\.status === "verified"\) \{\n {4}revalidatePath\(state\.destination\);\n {4}redirect\(state\.destination\);\n {2}\}/,
  );
  assert.doesNotMatch(
    code,
    /_previous\.|formData\.|headers|cookies|searchParams|process\.env|\bconsole\b/,
  );
});

test("S2-R6. the new modules stay layered: the application boundary is provider-neutral, and only the adapter talks to Auth, without privileged access", () => {
  for (const file of [
    "src/application/session-assurance.ts",
    "src/application/totp-step-up.ts",
  ]) {
    const source = read(file);
    for (const specifier of importsOf(source)) {
      assert.match(specifier, /^\.\/[a-z-]+\.ts$/, `${file}: ${specifier}`);
    }
    assert.doesNotMatch(
      codeOf(source),
      /supabase|next|react|\bprocess\b|\bconsole\b|\bfetch\s*\(|Date\.now|new Date|Math\.random|cookie|header|localStorage|sessionStorage|\bmfa\b/i,
      file,
    );
    assert.doesNotMatch(codeOf(source), /^(?:let|var) /m, file);
  }
  const adapter = codeOf(
    read("src/infrastructure/identity/authenticator-provider.ts"),
  );
  assert.doesNotMatch(
    adapter,
    /service_role|sb_secret_|ROSUNO_SUPABASE|createClient\b|adminKey|auth\.admin|\.rpc\b|\.insert\(|\.update\(|\.upsert\(|\.delete\(|process\.env|\bconsole\b/,
  );
  // Exactly these Auth calls, each once.
  for (const call of [
    "client.auth.getSession()",
    "client.auth.mfa.getAuthenticatorAssuranceLevel(accessJwt)",
    "client.auth.mfa.unenroll({ factorId })",
    "client.auth.mfa.challenge({ factorId })",
    "client.auth.mfa.verify({ factorId, challengeId, code })",
  ]) {
    assert.equal(adapter.split(call).length, 2, call);
  }
  assert.equal(adapter.split("client.auth.mfa.listFactors()").length, 3);
  assert.equal(adapter.match(/client\.auth\.mfa\.enroll\(\{/g).length, 1);
  assert.deepEqual(
    [
      ...new Set(
        [...adapter.matchAll(/\.auth\.(?:mfa\.)?(\w+)\(/g)].map((m) => m[1]),
      ),
    ].sort(),
    [
      "challenge",
      "enroll",
      "getAuthenticatorAssuranceLevel",
      "getSession",
      "listFactors",
      "unenroll",
      "verify",
    ],
  );
  // No log line is handed a code, a key, a link, a token, or an id.
  for (const [call] of adapter.matchAll(/logRequestEvent\([^;]*;/g)) {
    assert.doesNotMatch(
      call,
      /\bcode\b|secret|uri|accessJwt|access_token|factorId|challengeId|\bdata\b/,
      call,
    );
  }
});

// ---------------------------------------------------------------------------
// Rendering and running from source
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

const jsxRuntime = import.meta.resolve("react/jsx-runtime");
const react = import.meta.resolve("react");

const WIRING = `export const wiring = { sources: null, touched: [], log: [], stop: null, refusal: null };
const delegate = new Proxy({}, {
  get: (_t, key) => {
    wiring.touched.push(String(key));
    if (wiring.sources === null) {
      throw new Error("sources must not be read");
    }
    return wiring.sources[key];
  },
});
export const AUTHENTICATOR_SOURCES = delegate;
export const STEP_UP_SOURCES = delegate;
export const STAFF_CONFIGURATION_SOURCES = delegate;
export const STAFF_VERIFICATION_SOURCES = delegate;
export const ATTORNEY_PROFESSIONAL_SOURCES = delegate;
export const ATTORNEY_PRINCIPAL_SOURCE = delegate;
export const SUPABASE_SERVER_SESSION_SOURCE = delegate;
`;
const NEXT_SERVER = `import { wiring } from "./wiring.mjs";
export async function connection() { wiring.log.push("connection"); }
`;
const NEXT_NAVIGATION = `import { wiring } from "./wiring.mjs";
export class SyntheticRedirect extends Error {}
export function redirect(path) {
  wiring.log.push(["redirect", path]);
  throw new SyntheticRedirect(path);
}
`;
const NEXT_CACHE = `import { wiring } from "./wiring.mjs";
export function revalidatePath(path) { wiring.log.push(["revalidatePath", path]); }
`;
const REQUEST_LOG = `import { wiring } from "./wiring.mjs";
export async function logRequestEvent(level, event) { wiring.log.push(["log", level, event]); }
`;
// A gate stand-in: a page stops when wiring.stop names a path, and an action
// gets wiring.refusal.
const GATE = `import { wiring } from "./wiring.mjs";
import { redirect } from "./next-navigation.mjs";
export async function requireSteppedUp(kind) {
  wiring.log.push(["gate", kind]);
  if (wiring.stop !== null) {
    redirect(wiring.stop);
  }
}
export async function stepUpRefusal(kind) {
  wiring.log.push(["gate", kind]);
  return wiring.refusal;
}
`;

// A transpiling loader: app and presentation modules are transpiled with
// their imports relinked; application modules load as they are; the named
// paths are stand-ins; anything else in infrastructure is refused.
function harness(prefix, stubbed) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const target = (name) => pathToFileURL(join(directory, name)).href;
  const write = (name, text) => writeFileSync(join(directory, name), text);
  write("wiring.mjs", WIRING);
  write("next-server.mjs", NEXT_SERVER);
  write("next-navigation.mjs", NEXT_NAVIGATION);
  write("next-cache.mjs", NEXT_CACHE);
  write("request-log.mjs", REQUEST_LOG);
  write("gate.mjs", GATE);
  const stubs = {
    "next/server": "next-server.mjs",
    "next/navigation": "next-navigation.mjs",
    "next/cache": "next-cache.mjs",
    "src/infrastructure/observability/request-log.ts": "request-log.mjs",
    ...stubbed,
  };
  const built = new Map();
  function targetOf(from, specifier) {
    if (specifier === "react") return react;
    if (specifier === "react/jsx-runtime") return jsxRuntime;
    if (Object.hasOwn(stubs, specifier)) return target(stubs[specifier]);
    assert.ok(specifier.startsWith("."), `${from}: ${specifier}`);
    const path = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (Object.hasOwn(stubs, path)) return target(stubs[path]);
    assert.ok(!path.startsWith("src/infrastructure/"), `${from}: ${path}`);
    return path.startsWith("src/application/") ? real(path) : build(path);
  }
  function build(path) {
    if (built.has(path)) return built.get(path);
    const code = transpile(read(path), path).replace(
      /(\bfrom\s+|\bimport\s+)"([^"]+)"/g,
      (_m, keyword, specifier) => `${keyword}"${targetOf(path, specifier)}"`,
    );
    const name = `${path.replace(/[/[\]]/g, "_")}.mjs`;
    write(name, code);
    built.set(path, target(name));
    return target(name);
  }
  return { load: async (path) => import(build(path)), target };
}

const WIRED = {
  "src/infrastructure/identity/authenticator-provider.ts": "wiring.mjs",
  "src/infrastructure/staff/staff-configuration-adapter.ts": "wiring.mjs",
  "src/infrastructure/staff/staff-verification-adapter.ts": "wiring.mjs",
  "src/infrastructure/professional/attorney-professional-adapter.ts":
    "wiring.mjs",
  "src/infrastructure/identity/attorney-principal-source.ts": "wiring.mjs",
  "src/infrastructure/identity/server-session-source.ts": "wiring.mjs",
};

// Account pages and the real gate and account actions, over synthetic
// sources.
const accountHarness = harness("rosuno-s2-account-", WIRED);
const { wiring } = await import(accountHarness.target("wiring.mjs"));
const { SyntheticRedirect } = await import(
  accountHarness.target("next-navigation.mjs")
);

function resetWiring(target, sources) {
  target.sources = sources;
  target.touched.length = 0;
  target.log.length = 0;
  target.stop = null;
  target.refusal = null;
}
const reset = (sources = null) => resetWiring(wiring, sources);

async function render(path, sources, props) {
  reset(sources);
  const module = await accountHarness.load(path);
  const html = renderToStaticMarkup(await module.default(props));
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim(),
    hrefs: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    metadata: module.metadata,
  };
}

const query = (to) => ({
  searchParams: Promise.resolve(to === undefined ? {} : { to }),
});

test("S2-R7. the security page shows one fixed state per principal and assurance, and links only to fixed addresses", async () => {
  const w = createWorld();
  const fresh = addAccount(w, 1, { staff: "active" });
  const enrolled = addAccount(w, 2, { attorney: "applicant", factors: [{}] });
  const stepped = addAccount(w, 3, {
    staff: "active",
    level: "aal2",
    factors: [{}],
  });
  const client = addAccount(w, 4);
  const page = "app/account/security/page.tsx";
  const setUp = await render(page, sourcesFor(w, fresh.authId), query("staff"));
  assert.ok(setUp.text.includes("Set up an authenticator app"));
  assert.ok(setUp.html.includes("<form"));
  assert.ok(setUp.html.includes('value="start-authenticator-setup"'));
  assert.deepEqual(setUp.hrefs, []);
  assert.equal(setUp.metadata.robots.index, false);
  assert.equal(setUp.metadata.robots.follow, false);
  assert.equal(setUp.html.includes("<img"), false);
  const step = await render(
    page,
    sourcesFor(w, enrolled.authId),
    query("staff"),
  );
  assert.ok(step.text.includes("Authenticator app set up"));
  assert.deepEqual(step.hrefs, ["/account/step-up?to=attorney"]);
  assert.equal(step.html.includes("<form"), false);
  const done = await render(
    page,
    sourcesFor(w, stepped.authId),
    query("//elsewhere.invalid"),
  );
  assert.ok(done.text.includes("Sign-in confirmed"));
  assert.deepEqual(done.hrefs, ["/staff"]);
  const denied = await render(page, sourcesFor(w, client.authId), query());
  assert.ok(denied.text.includes("Sign-in security not available"));
  assert.deepEqual(denied.hrefs, ["/"]);
  const anonymous = await render(page, sourcesFor(w, null), query());
  assert.ok(anonymous.text.includes("Sign in to continue"));
  assert.deepEqual(anonymous.hrefs, ["/sign-in"]);
  const unavailable = await render(
    page,
    sourcesFor(w, fresh.authId, {
      sources: {
        assurance: { currentAssurance: async () => ({ kind: "unreadable" }) },
      },
    }),
    query(),
  );
  assert.ok(unavailable.text.includes("Sign-in security unavailable"));
  assert.deepEqual(unavailable.hrefs, []);
  assert.equal(unavailable.html.includes("<form"), false);
  assert.deepEqual(wiring.log, ["connection"]);
});

test("S2-R8. the step-up page offers the code form only to a principal at aal1 with a verified factor", async () => {
  const w = createWorld();
  const enrolled = addAccount(w, 1, { staff: "active", factors: [{}] });
  const fresh = addAccount(w, 2, { attorney: "approved" });
  const stepped = addAccount(w, 3, {
    attorney: "approved",
    level: "aal2",
    factors: [{}],
  });
  const client = addAccount(w, 4);
  const page = "app/account/step-up/page.tsx";
  const ready = await render(
    page,
    sourcesFor(w, enrolled.authId),
    query("staff"),
  );
  assert.ok(ready.text.includes("Confirm your sign-in"));
  assert.ok(ready.html.includes('name="code"'));
  assert.ok(
    ready.html.includes('autoComplete="one-time-code"') ||
      ready.html.includes('autocomplete="one-time-code"'),
  );
  assert.ok(ready.html.includes('name="to" value="staff"'));
  assert.deepEqual(ready.hrefs, []);
  const setUp = await render(
    page,
    sourcesFor(w, fresh.authId),
    query("attorney"),
  );
  assert.deepEqual(setUp.hrefs, ["/account/security?to=attorney"]);
  assert.equal(setUp.html.includes("<form"), false);
  const done = await render(
    page,
    sourcesFor(w, stepped.authId),
    query("staff"),
  );
  assert.deepEqual(done.hrefs, ["/attorney"]);
  assert.ok(
    (await render(page, sourcesFor(w, client.authId), query())).text.includes(
      "Not available",
    ),
  );
  assert.deepEqual((await render(page, sourcesFor(w, null), query())).hrefs, [
    "/sign-in",
  ]);
  // A hostile destination never reaches the form or a link.
  const hostile = await render(
    page,
    sourcesFor(w, enrolled.authId),
    query("https://elsewhere.invalid"),
  );
  assert.ok(hostile.html.includes('name="to" value="staff"'));
  assert.equal(hostile.html.includes("elsewhere"), false);
});

test("S2-R9. the real gate sends a principal at aal1 to a fixed account page, passes everyone else, and refuses a gated change", async () => {
  const gate = await accountHarness.load("app/account/gate.ts");
  const w = createWorld();
  const enrolled = addAccount(w, 1, { staff: "active", factors: [{}] });
  const fresh = addAccount(w, 2, { attorney: "applicant" });
  const stepped = addAccount(w, 3, {
    staff: "active",
    level: "aal2",
    factors: [{}],
  });
  const client = addAccount(w, 4);
  const stopped = async (account, kind) => {
    reset(sourcesFor(w, account?.authId ?? null));
    try {
      await gate.requireSteppedUp(kind);
      return null;
    } catch (error) {
      assert.ok(error instanceof SyntheticRedirect);
      return error.message;
    }
  };
  assert.equal(await stopped(enrolled, "staff"), "/account/step-up?to=staff");
  assert.equal(
    await stopped(fresh, "attorney"),
    "/account/security?to=attorney",
  );
  assert.equal(await stopped(stepped, "staff"), null);
  assert.equal(await stopped(client, "staff"), null);
  assert.equal(await stopped(null, "attorney"), null);
  assert.equal(await stopped(fresh, "staff"), null);
  reset(sourcesFor(w, enrolled.authId));
  assert.deepEqual(await gate.stepUpRefusal("staff"), {
    status: "step-up-required",
  });
  reset(sourcesFor(w, stepped.authId));
  assert.equal(await gate.stepUpRefusal("staff"), null);
  reset(
    sourcesFor(w, enrolled.authId, {
      sources: {
        assurance: { currentAssurance: async () => ({ kind: "unreadable" }) },
      },
    }),
  );
  assert.deepEqual(await gate.stepUpRefusal("staff"), {
    status: "unavailable",
  });
  assert.equal(await stopped(enrolled, "staff"), "/account/step-up?to=staff");
});

test("S2-R10. a confirmed code returns only to the fixed workspace; any other outcome stays on the page and redirects nowhere", async () => {
  const actions = await accountHarness.load("app/account/actions.ts");
  const run = async (sources, action, formData) => {
    reset(sources);
    try {
      return {
        state: await actions[action]({ status: "idle" }, formData),
        log: [...wiring.log],
      };
    } catch (error) {
      assert.ok(error instanceof SyntheticRedirect);
      return { redirected: error.message, log: [...wiring.log] };
    }
  };
  const w = createWorld();
  const staff = addAccount(w, 1, {
    staff: "active",
    attorney: "approved",
    factors: [{}],
  });
  assert.deepEqual(
    await run(
      sourcesFor(w, staff.authId),
      "confirmStepUp",
      form({ code: "123456", to: "https://elsewhere.invalid" }),
    ),
    {
      redirected: "/attorney",
      log: [
        ["revalidatePath", "/attorney"],
        ["redirect", "/attorney"],
      ],
    },
  );
  w.accounts.get(staff.authId).level = "aal1";
  assert.deepEqual(
    (
      await run(
        sourcesFor(w, staff.authId),
        "confirmStepUp",
        form({ code: "123456", to: "staff" }),
      )
    ).redirected,
    "/staff",
  );
  w.accounts.get(staff.authId).level = "aal1";
  assert.deepEqual(
    await run(
      sourcesFor(w, staff.authId),
      "confirmStepUp",
      form({ code: "000000", to: "staff" }),
    ),
    { state: { status: "wrong-code" }, log: [] },
  );
  const fresh = addAccount(w, 2, { staff: "active" });
  const started = await run(
    sourcesFor(w, fresh.authId),
    "startEnrollment",
    form({ intent: "start-authenticator-setup" }),
  );
  assert.equal(started.state.status, "pending");
  assert.deepEqual(started.log, []);
  assert.deepEqual(
    (
      await run(
        sourcesFor(w, fresh.authId),
        "confirmEnrollment",
        form({ code: "123456", to: "staff" }),
      )
    ).redirected,
    "/staff",
  );
});

// Gated pages and actions, driven with a gate stand-in.
const gatedHarness = harness("rosuno-s2-gated-", {
  ...WIRED,
  "app/account/gate.ts": "gate.mjs",
});
const { wiring: gated } = await import(gatedHarness.target("wiring.mjs"));
const { SyntheticRedirect: GatedRedirect } = await import(
  gatedHarness.target("next-navigation.mjs")
);
const resetGated = (sources = null) => resetWiring(gated, sources);

test("S2-R11. a stopped attorney or staff page redirects before it reads anything, and a passing one goes on to its own decision", async () => {
  for (const [path, kind, props] of [
    ["app/staff/page.tsx", "staff", undefined],
    [
      "app/staff/verification/page.tsx",
      "staff",
      { searchParams: Promise.resolve({}) },
    ],
    [
      "app/staff/policies/[version]/page.tsx",
      "staff",
      { params: Promise.resolve({ version: "x" }) },
    ],
    ["app/attorney/page.tsx", "attorney", undefined],
    ["app/attorney/professional/page.tsx", "attorney", undefined],
  ]) {
    const page = await gatedHarness.load(path);
    resetGated();
    gated.stop = `/account/step-up?to=${kind}`;
    await assert.rejects(() => page.default(props), GatedRedirect, path);
    assert.deepEqual(gated.log, [
      "connection",
      ["gate", kind],
      ["redirect", `/account/step-up?to=${kind}`],
    ]);
    assert.deepEqual(gated.touched, [], path);
  }
});

test("S2-R12. a gated server action returns the fixed step-up refusal before its use case or any source is reached", async () => {
  const cases = [
    ["app/staff/actions.ts", "createPolicyVersionAction", "staff"],
    ["app/staff/actions.ts", "grantCapabilityAction", "staff"],
    ["app/staff/verification/actions.ts", "recordFinding", "staff"],
    ["app/staff/verification/actions.ts", "changeStage", "staff"],
    ["app/attorney/professional/actions.ts", "saveDetails", "attorney"],
    ["app/attorney/professional/actions.ts", "submitForReview", "attorney"],
  ];
  for (const [path, name, kind] of cases) {
    const actions = await gatedHarness.load(path);
    for (const refusal of [
      { status: "step-up-required" },
      { status: "unavailable" },
    ]) {
      resetGated();
      gated.refusal = refusal;
      const state = await actions[name](
        { status: "idle" },
        form({ code: "x" }),
      );
      assert.equal(state, refusal, `${path} ${name}`);
      assert.deepEqual(gated.log, [["gate", kind]], `${path} ${name}`);
      assert.deepEqual(gated.touched, [], `${path} ${name}`);
    }
    // Let through, the use case runs and answers for itself.
    resetGated({});
    gated.refusal = null;
    const answered = await actions[name]({ status: "idle" }, form({}));
    assert.notEqual(answered.status, "step-up-required", `${path} ${name}`);
    assert.deepEqual(gated.log[0], ["gate", kind], `${path} ${name}`);
  }
});
