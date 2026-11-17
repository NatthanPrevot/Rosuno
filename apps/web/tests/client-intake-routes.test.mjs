// P5-001: client workspace routes, module boundaries, configurability and
// suggestion wording.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

import { INTAKE_STATES } from "../src/application/client-intake.ts";
import {
  jurisdictionSuggestion,
  outcomeMessage,
  SUGGESTION_NOTE,
} from "../src/presentation/client-intake-labels.ts";

const appRoot = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, appRoot), "utf8");

function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

function importsOf(source) {
  return [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

// Source without comments, so a rule cannot hide in or be met by prose.
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const P5_MODULES = Object.freeze([
  "src/application/client-intake.ts",
  "src/application/intake-question-set.ts",
  "src/infrastructure/client/client-intake-adapter.ts",
  "src/presentation/client-intake-labels.ts",
  "app/client/actions.ts",
  "app/client/forms.tsx",
  "app/client/page.tsx",
  "app/client/intakes/[intake]/forms.tsx",
  "app/client/intakes/[intake]/page.tsx",
]);

test("1. the client routes are exactly the workspace, the Intake page, their forms and the server actions", () => {
  assert.deepEqual(filesIn("app/client/"), [
    "app/client/actions.ts",
    "app/client/forms.tsx",
    "app/client/intakes/[intake]/forms.tsx",
    "app/client/intakes/[intake]/page.tsx",
    "app/client/page.tsx",
  ]);
  assert.match(read("app/client/actions.ts"), /^"use server";\n/);
  for (const file of [
    "app/client/forms.tsx",
    "app/client/intakes/[intake]/forms.tsx",
  ]) {
    assert.match(read(file), /^"use client";\n/, file);
  }
});

test("2. pages decide access on the server for every request through the client intake use cases and the production sources", () => {
  const workspace = codeOf(read("app/client/page.tsx"));
  assert.match(workspace, /await connection\(\);/);
  // MVP-001 D-3: the workspace shows one page of the client's own Intakes.
  // The only request value it reads is the page query value, which it hands
  // to the use case unread; the use case checks it on the server.
  assert.match(workspace, /const \{ page \} = await searchParams;/);
  assert.match(
    workspace,
    /await resolveClientWorkspace\(CLIENT_INTAKE_SOURCES, page\);/,
  );
  assert.equal(workspace.match(/\bsearchParams\b/g).length, 3);
  assert.doesNotMatch(workspace, /\bheaders\s*\(|\bcookies\s*\(|\bparams\b/);
  const intake = codeOf(read("app/client/intakes/[intake]/page.tsx"));
  assert.match(intake, /await connection\(\);/);
  assert.match(
    intake,
    /await resolveIntake\(\s*CLIENT_INTAKE_SOURCES,\s*intake,\s*questions === "current",\s*\);/,
  );
  const actions = codeOf(read("app/client/actions.ts"));
  for (const call of [
    "startIntake(CLIENT_INTAKE_SOURCES)",
    "saveIntakeRevision(CLIENT_INTAKE_SOURCES, formData)",
    "submitIntake(CLIENT_INTAKE_SOURCES, formData)",
    "closeIntake(CLIENT_INTAKE_SOURCES, formData)",
  ]) {
    assert.ok(actions.replace(/\s+/g, " ").includes(call), call);
  }
});

test("3. no client intake module reaches a privileged credential, client or provisioning module", () => {
  for (const file of P5_MODULES) {
    const code = codeOf(read(file));
    for (const specifier of importsOf(code)) {
      assert.doesNotMatch(
        specifier,
        /registration-provisioning|attorney-application-provisioning|supabase-js$/,
        `${file}: ${specifier}`,
      );
    }
    assert.doesNotMatch(
      code,
      /createClient\b|ADMIN_KEY|service_role|SERVICE_ROLE|sb_secret/,
      file,
    );
  }
  // MVP-001 D-8 adds only the dependency-free logger and its request-scoped
  // correlation reader, which record a failed call's name, kind, error code
  // and HTTP status and nothing the call carried or answered.
  assert.deepEqual(
    importsOf(read("src/infrastructure/client/client-intake-adapter.ts")),
    [
      "../../application/client-intake.ts",
      "../../application/professional-identity.ts",
      "../identity/client-principal-source.ts",
      "../identity/server-session-source.ts",
      "../observability/log.ts",
      "../observability/request-log.ts",
      "../professional/professional-request-client.ts",
    ],
  );
});

test("4. question wording, choices, limits and launch jurisdictions are configuration, not code", () => {
  const configured = [
    "What do you need help with?",
    "Where did this happen?",
    "Is there already a court case?",
    "What kind of help are you looking for?",
    "Understand my options",
    "Help with a document",
    "Someone to represent me",
    "Tell us in your own words",
    "court_case",
    "assistance_type",
    "4000",
    "4096",
  ];
  for (const file of P5_MODULES) {
    const code = codeOf(read(file));
    for (const value of configured) {
      assert.ok(!code.includes(value), `${file} hard-codes ${value}`);
    }
    assert.doesNotMatch(code, /california|arizona/i, file);
  }
});

test("5. jurisdiction wording says attorneys may be relevant, never that a law applies, and shows unresolved answers as unresolved", () => {
  assert.equal(
    jurisdictionSuggestion({ kind: "stated", names: ["State A"] }),
    "Based on what you told us, attorneys in State A may be relevant.",
  );
  const several = jurisdictionSuggestion({
    kind: "stated",
    names: ["State A", "State B", "State C"],
  });
  assert.match(
    several,
    /attorneys in State A, State B, or State C may be relevant/,
  );
  assert.match(several, /not decided here/);
  assert.match(
    jurisdictionSuggestion({ kind: "not_sure" }),
    /not sure.*We have not guessed one/,
  );
  for (const text of [
    jurisdictionSuggestion({ kind: "stated", names: ["State A"] }),
    several,
    jurisdictionSuggestion({ kind: "not_sure" }),
    jurisdictionSuggestion({ kind: "unanswered" }),
  ]) {
    assert.doesNotMatch(text, /law (definitely )?applies|governing law/i);
  }
  assert.match(SUGGESTION_NOTE, /not a decision about which law applies/);
});

test("6. every action state has a fixed message, and every Intake state has a label", () => {
  const states = [
    "idle",
    "saved",
    "unchanged",
    "invalid",
    "conflict",
    "version-not-allowed",
    "not-editable",
    "rate-limited",
    "submitted",
    "already-submitted",
    "incomplete",
    "needs-update",
    "closed",
    "already-closed",
    "not-found",
    "outcome-unknown",
    "sign-in-required",
    "denied",
    "unavailable",
  ];
  for (const status of states) {
    const message = outcomeMessage(
      status === "invalid"
        ? { status, fieldErrors: {} }
        : status === "saved"
          ? { status, revision: 1 }
          : { status },
    );
    if (status === "idle") {
      assert.equal(message, null);
    } else {
      assert.ok(message?.title && message.body, status);
    }
  }
  const labels = read("src/presentation/client-intake-labels.ts");
  for (const state of INTAKE_STATES) {
    assert.match(labels, new RegExp(`\\b${state}: \\{ label:`), state);
  }
});
