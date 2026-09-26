// Targeted WI-P2-001 application-shell tests.
//
// They run on Node.js built-ins alone, so they execute before (or without)
// pnpm install. Pure TypeScript modules, including next.config.ts, run through
// Node.js native type stripping. TSX presentation files are checked as source
// contracts, because rendering them would require installed React packages.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { types } from "node:util";

import nextConfig from "../next.config.ts";
import {
  INITIAL_FORM_STATE,
  readFormFields,
  runFormOperation,
  toFormAction,
} from "../src/application/form-operation.ts";
import {
  ANONYMOUS_SESSION,
  NO_IDENTITY_PROVIDER,
  resolveSession,
} from "../src/application/session.ts";
import { getShellView } from "../src/application/shell.ts";

const appRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../", appRoot);

function read(relativePath, root = appRoot) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function lines(text) {
  return text.split("\n").map((line) => line.trim());
}

// Every file below an app directory, as app-relative paths. Folder metadata
// that macOS and Windows write, which the root .gitignore ignores, is not
// source.
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => !/(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/.test(file))
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

// Import or export syntax without the spacing Prettier writes, or with a
// comment inside it, would hide its specifier from importsOf.
const unspacedImport = /\b(?:import|export|from)(?:["'{*]|\s*\/[*/])/;

// A value as plain data: its prototype and every own property, enumerable or
// not and string- or symbol-keyed, of it and of each object it holds.
// deepEqual and JSON.stringify skip non-enumerable properties (such as an
// Error's message and stack), so state compared through this carries nothing
// hidden, and no Proxy may stand in for it.
function ownData(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  assert.equal(types.isProxy(value), false);
  return [
    Object.getPrototypeOf(value),
    ...Reflect.ownKeys(value).map((key) => [key, ownData(value[key])]),
  ];
}

// State handed out is immutable plain data all the way down: no module-level
// object shared between requests, and no accessor computing a value later.
function assertFrozenData(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.ok(Object.isFrozen(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(Object.hasOwn(descriptor, "value"), String(key));
    assertFrozenData(descriptor.value);
  }
}

function assertExactly(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.deepEqual(ownData(actual), ownData(expected));
  assertFrozenData(actual);
}

// Source without its full-line comments.
function codeOf(source) {
  return source.replace(/^\s*\/\/.*\n/gm, "");
}

// Reads the component a presentation module exports: how many functions,
// returns, and arrows its code holds, and the tags, attributes, {expressions},
// and literal text of the JSX it returns ("{}" marks a rendered expression).
function componentShape(source) {
  const code = codeOf(source);
  const jsx = code.slice(code.lastIndexOf("return"));
  const expressions = [];
  let markup = "";
  for (let index = 0; index < jsx.length; index += 1) {
    if (jsx[index] !== "{") {
      markup += jsx[index];
      continue;
    }
    let depth = 1;
    let end = index + 1;
    while (end < jsx.length && depth > 0) {
      if (jsx[end] === "{") depth += 1;
      if (jsx[end] === "}") depth -= 1;
      end += 1;
    }
    expressions.push(jsx.slice(index + 1, end - 1).trim());
    markup += "{}";
    index = end - 1;
  }
  // The component returns one parenthesized JSX tree and nothing else: no code
  // before its first tag or after its last, and whatever sits between two tags
  // is reported as text.
  const between = markup.split(/<[^<>]*>/);
  assert.match(between[0], /^return \(\n\s*$/);
  assert.equal(between.at(-1), "\n  );\n}\n");
  const count = (pattern) => code.match(pattern)?.length ?? 0;
  return {
    functions: count(/\bfunction\b/g),
    returns: count(/\breturn\b/g),
    arrows: count(/=>/g),
    tags: [...markup.matchAll(/<([A-Za-z][\w.]*)/g)].map((match) => match[1]),
    // Every attribute name inside a tag, boolean attributes included.
    attributes: [...markup.matchAll(/<[A-Za-z][\w.]*([^<>]*)>/g)].flatMap(
      (match) =>
        match[1]
          .replace(/"[^"]*"|'[^']*'|\{\}/g, " ")
          .split(/[\s=/]+/)
          .filter(Boolean),
    ),
    expressions,
    text: between
      .slice(1, -1)
      .map((piece) => piece.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  };
}

const fallbackText = [
  "Something went wrong",
  "This request could not be completed. Please try again.",
  "Try again",
];

// Error boundaries are one client component whose body is only its return:
// fixed text, and one Next.js retry per explicit click. The thrown value is
// never declared, received by name, or read, and nothing runs on its own.
function assertSafeFallback(file, shape) {
  const source = read(file);
  assert.match(
    source,
    /^"use client";\n\ntype (\w+) = \{\n {2}readonly retry: \(\) => void;\n\};\n\n(?:\/\/ [^\n]*\n)*export default function \w+\(\{ retry \}: \1\) \{\n {2}return \(\n[\s\S]*\n {2}\);\n\}\n$/,
    file,
  );
  assert.equal(codeOf(source).match(/\bretry\b/g)?.length, 3, file);
  assert.match(
    source,
    /<button type="button" onClick=\{\(\) => retry\(\)\}>/,
    file,
  );
  assert.doesNotMatch(
    source,
    /\berror\b|\.(?:message|stack|digest|cause)\b/,
    file,
  );
  assert.doesNotMatch(
    codeOf(source),
    /\bprops\b|\barguments\b|\breset\b|useEffect|useLayoutEffect|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|globalThis|window\.|document\.|location\.|console\.|dangerouslySetInnerHTML|localStorage|sessionStorage/,
    file,
  );
  assert.deepEqual(importsOf(source), [], file);
  assert.deepEqual(
    componentShape(source),
    {
      functions: 1,
      returns: 1,
      arrows: 2,
      expressions: ["() => retry()"],
      ...shape,
    },
    file,
  );
  return source;
}

const requireInput = {
  validate: (fields) => {
    const value = (fields.get("value") ?? "").trim();
    return value === ""
      ? { ok: false, fieldErrors: { value: ["Enter a value."] } }
      : { ok: true, value: { value } };
  },
  execute: async () => ({ ok: true }),
};

const withValue = new Map([["value", "valid input"]]);

// Detail an operation might report beside ok.
const reportedByOperation = {
  message: "internal 7f3a",
  detail: "internal 7f3a",
  data: { id: "7f3a" },
  fieldErrors: { value: ["internal 7f3a"] },
};

test("1. App Router shell route and boundary files exist", () => {
  for (const file of [
    "app/layout.tsx",
    "app/page.tsx",
    "app/loading.tsx",
    "app/not-found.tsx",
    "app/error.tsx",
    "app/global-error.tsx",
  ]) {
    assert.ok(existsSync(new URL(file, appRoot)), `missing ${file}`);
  }
  // No Pages Router, static public assets, public route handlers, or request
  // interception, in any file extension Next.js would serve.
  for (const directory of ["./", "src/"]) {
    for (const entry of readdirSync(new URL(directory, appRoot))) {
      assert.doesNotMatch(
        entry,
        /^(?:pages|public|(?:proxy|middleware|instrumentation(?:-client)?)\.[a-z]+)$/,
        `${directory}${entry}`,
      );
    }
  }
  // The App Router holds exactly the shell files: no route handler, metadata
  // route (robots, sitemap, manifest, icon, ...), template, or other route.
  assert.deepEqual(filesIn("app/"), [
    "app/error.tsx",
    "app/global-error.tsx",
    "app/layout.tsx",
    "app/loading.tsx",
    "app/not-found.tsx",
    "app/page.tsx",
  ]);
  // Application source is TypeScript only.
  for (const file of [...filesIn("app/"), ...filesIn("src/")]) {
    assert.match(file, /\.tsx?$/, file);
  }
});

test("2. root layout is shared by every route and renders its children", () => {
  const source = read("app/layout.tsx");
  assert.doesNotMatch(source, /^["']use client["']/m);
  assert.match(
    source,
    /<html lang="en">\s*<body>\s*<main>\{children\}<\/main>\s*<\/body>\s*<\/html>/,
  );
  assert.match(
    source,
    /export const metadata: Metadata = \{\s*title: "Rosuno",\s*\};/,
  );
  // The component is its return alone: no code runs in its parameters or
  // before its JSX tree.
  assert.match(
    source,
    /\nexport default function RootLayout\(\{\n {2}children,\n\}: \{\n {2}readonly children: ReactNode;\n\}\) \{\n {2}return \(\n {4}<html lang="en">\n/,
  );
  assert.deepEqual(componentShape(source), {
    functions: 1,
    returns: 1,
    arrows: 0,
    tags: ["html", "body", "main"],
    attributes: ["lang"],
    expressions: ["children"],
    text: ["{}"],
  });
});

test("3. loading boundary renders generic status without artificial delay", () => {
  assert.equal(
    read("app/loading.tsx"),
    'export default function Loading() {\n  return <p role="status">Loading...</p>;\n}\n',
  );
});

test("4. not-found boundary renders generic unknown-route text", () => {
  const source = read("app/not-found.tsx");
  assert.match(source, /<a href="\/">Return to the home page<\/a>/);
  // The component is its return alone: no code runs before its JSX tree.
  assert.match(
    source,
    /^export default function NotFound\(\) \{\n {2}return \(\n {4}<>\n/m,
  );
  assert.deepEqual(componentShape(source), {
    functions: 1,
    returns: 1,
    arrows: 0,
    tags: ["h1", "p", "a"],
    attributes: ["href"],
    expressions: [],
    text: [
      "Page not found",
      "The requested page does not exist.",
      "Return to the home page",
    ],
  });
});

test("5a. segment error boundary never exposes the raw error", () => {
  const source = assertSafeFallback("app/error.tsx", {
    tags: ["h1", "p", "button"],
    attributes: ["type", "onClick"],
    text: fallbackText,
  });
  // Segment fallbacks render inside the root layout's document.
  assert.doesNotMatch(source, /<html|<body/);
});

test("5b. root global error boundary never exposes the raw error", () => {
  const source = assertSafeFallback("app/global-error.tsx", {
    tags: ["html", "body", "main", "h1", "p", "button", "a"],
    attributes: ["lang", "type", "onClick", "href"],
    text: [...fallbackText, "Return to the home page"],
  });
  // It replaces the failed root layout, so it renders its own document and
  // offers a full-page way home.
  assert.match(
    source,
    /return \(\n {4}<html lang="en">\n {6}<body>[\s\S]*<\/body>\n {4}<\/html>\n {2}\);/,
  );
  assert.match(source, /<a href="\/">Return to the home page<\/a>/);
  assert.doesNotMatch(source, /export const metadata/);
});

test("6. form pattern reports validation failure without running the operation", async () => {
  let executed = false;
  const operation = {
    ...requireInput,
    execute: async () => {
      executed = true;
      return { ok: true };
    },
  };
  const state = await runFormOperation(operation, new Map([["value", "  "]]));
  assertExactly(state, {
    status: "validation-failed",
    fieldErrors: { value: ["Enter a value."] },
  });
  assert.equal(executed, false);
  assert.ok(Object.isFrozen(state));

  // Only the validation's own string messages survive; internal objects,
  // String objects, and inherited fields never reach presentation, even when
  // the validation hands them over frozen.
  for (const freeze of [(value) => value, Object.freeze]) {
    const filtered = await runFormOperation(
      {
        ...requireInput,
        validate: () => ({
          ok: false,
          fieldErrors: freeze(
            Object.assign(Object.create({ internal: ["internal 7f3a"] }), {
              value: freeze([
                new Error("internal 7f3a"),
                new String("internal 7f3a"),
                "Enter a value.",
              ]),
            }),
          ),
        }),
      },
      withValue,
    );
    assertExactly(filtered, {
      status: "validation-failed",
      fieldErrors: { value: ["Enter a value."] },
    });
  }
  // Messages are copied into plain arrays: nothing an array subclass's
  // constructor attaches reaches the state, and the constructor is not read.
  class Messages extends Array {
    constructor(...items) {
      super(...items);
      this.detail = "internal 7f3a";
    }
  }
  const unreadConstructor = Object.defineProperty(
    ["Enter a value."],
    "constructor",
    {
      get: () => {
        throw new Error("internal 7f3a");
      },
    },
  );
  for (const messages of [
    Messages.from(["Enter a value.", 7]),
    unreadConstructor,
  ]) {
    const copied = await runFormOperation(
      {
        ...requireInput,
        validate: () => ({ ok: false, fieldErrors: { value: messages } }),
      },
      withValue,
    );
    assertExactly(copied, {
      status: "validation-failed",
      fieldErrors: { value: ["Enter a value."] },
    });
  }
  // Readable output that is not in the expected shape stays a validation
  // failure: every string message of every own enumerable field is kept in
  // order, duplicates and empty strings included, and anything else is
  // dropped rather than turned into an operation failure.
  const irregular = Object.defineProperty(
    {
      second: ["x", 1, " y ", "x", ""],
      first: [2],
      bare: "Enter a value.",
      last: ["z"],
    },
    "hidden",
    { value: ["internal 7f3a"], enumerable: false },
  );
  for (const [fieldErrors, expected] of [
    [irregular, { second: ["x", " y ", "x", ""], last: ["z"] }],
    [{}, {}],
    [null, {}],
    ["Enter a value.", {}],
    [undefined, {}],
  ]) {
    let executed = false;
    const state = await runFormOperation(
      {
        validate: () => ({ ok: false, fieldErrors }),
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      },
      withValue,
    );
    assertExactly(state, {
      status: "validation-failed",
      fieldErrors: expected,
    });
    assert.equal(executed, false);
  }
});

test("7. form pattern reports operation failure and hides thrown errors", async () => {
  const failed = await runFormOperation(
    { ...requireInput, execute: async () => ({ ok: false }) },
    withValue,
  );
  assertExactly(failed, { status: "operation-failed" });

  // Nothing thrown by validation or the operation reaches the state, whatever
  // its shape.
  const thrownValues = [
    new Error("internal failure detail 7f3a"),
    Object.assign(new Error("internal"), { code: "7f3a" }),
    { detail: "internal 7f3a" },
    "internal 7f3a",
    null,
    undefined,
  ];
  for (const thrown of thrownValues) {
    for (const operation of [
      {
        ...requireInput,
        execute: async () => {
          throw thrown;
        },
      },
      {
        ...requireInput,
        validate: () => {
          throw thrown;
        },
      },
    ]) {
      const state = await runFormOperation(operation, withValue);
      assertExactly(state, { status: "operation-failed" });
      assert.equal(JSON.stringify(state).includes("7f3a"), false);
    }
  }

  // Anything other than an explicit ok: true is never treated as success,
  // whether the operation or the validation reports it.
  const notExplicitlyOk = [
    { ok: "yes" },
    { ok: 1 },
    { ok: 0 },
    { ok: "" },
    {},
    true,
    null,
    undefined,
  ];
  for (const outcome of notExplicitlyOk) {
    const state = await runFormOperation(
      { ...requireInput, execute: async () => outcome },
      withValue,
    );
    assertExactly(state, { status: "operation-failed" });
  }
  // Only ok decides the state: nothing else an outcome reports (a message,
  // detail, data, or field errors) is carried into it.
  for (const outcome of [
    { ...reportedByOperation, ok: false },
    { ...reportedByOperation, ok: "yes" },
    reportedByOperation,
  ]) {
    const state = await runFormOperation(
      { ...requireInput, execute: async () => outcome },
      withValue,
    );
    assertExactly(state, { status: "operation-failed" });
  }
  for (const validation of notExplicitlyOk) {
    let executed = false;
    const state = await runFormOperation(
      {
        validate: () => validation && { ...validation, value: {} },
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      },
      withValue,
    );
    assertExactly(state, { status: "operation-failed" });
    assert.equal(executed, false);
  }

  // Validation output that cannot be read is an operation failure too, never
  // a rejection, and the operation does not run.
  const throwing = () => {
    throw new Error("internal 7f3a");
  };
  const revoked = (target) => {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
  };
  const unreadable = (target, key) =>
    Object.defineProperty(target, key, { enumerable: true, get: throwing });
  for (const validation of [
    unreadable({}, "ok"),
    unreadable({ ok: false }, "fieldErrors"),
    unreadable({ ok: true }, "value"),
    revoked({ ok: false, fieldErrors: {} }),
    { ok: false, fieldErrors: revoked({}) },
    { ok: false, fieldErrors: new Proxy({}, { ownKeys: throwing }) },
    { ok: false, fieldErrors: unreadable({}, "value") },
    { ok: false, fieldErrors: { value: revoked([]) } },
    { ok: false, fieldErrors: { value: new Proxy([], { get: throwing }) } },
    { ok: false, fieldErrors: { value: unreadable(["Enter a value."], "0") } },
  ]) {
    let executed = false;
    const state = await runFormOperation(
      {
        validate: () => validation,
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      },
      withValue,
    );
    assertExactly(state, { status: "operation-failed" });
    assert.equal(executed, false);
  }
});

test("8. form pattern reports success and passes only validated input", async () => {
  let received;
  const state = await runFormOperation(
    {
      ...requireInput,
      execute: async (...args) => {
        received = args;
        return { ok: true };
      },
    },
    new Map([
      ["value", "  valid input  "],
      ["unexpected", "ignored"],
    ]),
  );
  assertExactly(state, { status: "succeeded" });
  // The operation receives the validated input and nothing else.
  assert.deepEqual(received, [{ value: "valid input" }]);
  // Success carries nothing else the operation reports.
  assertExactly(
    await runFormOperation(
      {
        ...requireInput,
        execute: async () => ({ ...reportedByOperation, ok: true }),
      },
      withValue,
    ),
    { status: "succeeded" },
  );

  // The form-action adapter reads string fields and ignores file entries.
  const formData = new FormData();
  formData.append("value", "valid input");
  formData.append("value", "second value");
  formData.append("upload", new Blob(["x"]), "x.txt");
  const fields = readFormFields(formData);
  assert.deepEqual([...fields], [["value", "valid input"]]);
  // Each submission is read on its own; nothing carries over between them.
  const another = new FormData();
  another.append("value", "another submission");
  assert.deepEqual(
    [...readFormFields(another)],
    [["value", "another submission"]],
  );
  assert.deepEqual([...fields], [["value", "valid input"]]);
  assertExactly(INITIAL_FORM_STATE, { status: "idle" });
  // The previous state comes back from the browser with each submission, so
  // it never decides or shapes the result, and neither the validation nor the
  // operation receives it.
  const argumentCounts = [];
  const counting = {
    validate: (...args) => {
      argumentCounts.push(args.length);
      return requireInput.validate(...args);
    },
    execute: async (...args) => {
      argumentCounts.push(args.length);
      return { ok: true };
    },
  };
  for (const previous of [
    INITIAL_FORM_STATE,
    { status: "succeeded" },
    { status: "idle", detail: "client 7f3a" },
  ]) {
    assertExactly(await toFormAction(counting)(previous, new FormData()), {
      status: "validation-failed",
      fieldErrors: { value: ["Enter a value."] },
    });
    assertExactly(await toFormAction(counting)(previous, formData), {
      status: "succeeded",
    });
  }
  assert.deepEqual(argumentCounts, [1, 1, 1, 1, 1, 1, 1, 1, 1]);

  // One action serves every user's submissions, so nothing carries over
  // between them: each one, sequential or concurrent, runs its own validation
  // and operation once and reports that operation's own outcome.
  const outcomes = [false, true, false, true, false, true];
  const executed = [];
  const action = toFormAction({
    ...requireInput,
    execute: async (input) => {
      executed.push(input);
      return { ok: outcomes[executed.length - 1] };
    },
  });
  const submit = (value) => {
    const submission = new FormData();
    if (value !== undefined) {
      submission.append("value", value);
    }
    return action(INITIAL_FORM_STATE, submission);
  };
  assertExactly(await submit("same input"), { status: "operation-failed" });
  assertExactly(await submit("same input"), { status: "succeeded" });
  assertExactly(await submit("same input"), { status: "operation-failed" });
  const concurrent = await Promise.all([
    submit("same input"),
    submit("same input"),
    submit(),
    submit("another submission"),
  ]);
  assertExactly(concurrent[0], { status: "succeeded" });
  assertExactly(concurrent[1], { status: "operation-failed" });
  assertExactly(concurrent[2], {
    status: "validation-failed",
    fieldErrors: { value: ["Enter a value."] },
  });
  assertExactly(concurrent[3], { status: "succeeded" });
  assert.deepEqual(executed, [
    { value: "same input" },
    { value: "same input" },
    { value: "same input" },
    { value: "same input" },
    { value: "same input" },
    { value: "another submission" },
  ]);
});

test("9. session boundary represents anonymous state", async () => {
  assert.equal(await resolveSession(NO_IDENTITY_PROVIDER), ANONYMOUS_SESSION);
  assertExactly(ANONYMOUS_SESSION, { status: "anonymous" });
  assert.ok(Object.isFrozen(ANONYMOUS_SESSION));
  assertExactly(await getShellView(), { session: "anonymous" });
  // Any source reporting no subject is anonymous, not only the default one.
  assertExactly(await getShellView({ currentSubject: async () => null }), {
    session: "anonymous",
  });
});

test("10. session boundary represents an authenticated opaque subject", async () => {
  // Synthetic, test-only identity reported by a server-side source.
  const source = { currentSubject: async () => "synthetic-test-subject-0001" };
  const session = await resolveSession(source);
  assertExactly(session, {
    status: "authenticated",
    subject: "synthetic-test-subject-0001",
  });
  assert.ok(Object.isFrozen(session));

  // Presentation receives the session state, never the identifier.
  const view = await getShellView(source);
  assertExactly(view, { session: "authenticated" });
  assert.equal(JSON.stringify(view).includes("synthetic"), false);

  // Every call resolves the session afresh from exactly one server answer:
  // nothing is cached per source, and nothing is re-read after the type check.
  const answers = [null, "synthetic-test-subject-0002", 42];
  let asked = 0;
  const changing = { currentSubject: async () => answers[asked++] };
  assertExactly(await getShellView(changing), { session: "anonymous" });
  assertExactly(await resolveSession(changing), {
    status: "authenticated",
    subject: "synthetic-test-subject-0002",
  });
  await assert.rejects(getShellView(changing), TypeError);
  assert.equal(asked, 3);

  // Concurrent requests never share or overwrite each other's view.
  const [first, second] = await Promise.all([
    getShellView(source),
    getShellView(),
  ]);
  assertExactly(first, { session: "authenticated" });
  assertExactly(second, { session: "anonymous" });
  // A source is shared server-wide and answers for whichever request asks, so
  // concurrent requests through one source never share a lookup: each asks it
  // once and gets its own answer.
  const perRequest = [
    null,
    "synthetic-test-subject-0003",
    "synthetic-test-subject-0004",
  ];
  let served = 0;
  const shared = { currentSubject: async () => perRequest[served++] };
  const [sharedFirst, sharedSession, sharedThird] = await Promise.all([
    getShellView(shared),
    resolveSession(shared),
    getShellView(shared),
  ]);
  assertExactly(sharedFirst, { session: "anonymous" });
  assertExactly(sharedSession, {
    status: "authenticated",
    subject: "synthetic-test-subject-0003",
  });
  assertExactly(sharedThird, { session: "authenticated" });
  assert.equal(served, 3);

  // A failing server source yields no session state at all.
  for (const currentSubject of [
    async () => {
      throw new Error("source failure");
    },
    () => {
      throw new Error("source failure");
    },
  ]) {
    await assert.rejects(resolveSession({ currentSubject }));
    await assert.rejects(getShellView({ currentSubject }));
  }

  // The subject is opaque. Whatever string the trusted source reports is kept
  // exactly as reported: no length, character, whitespace, case, Unicode, or
  // other format rule applies, and no value has a meaning of its own.
  // Presentation still learns only that the request is authenticated.
  for (const subject of [
    "",
    " ",
    " padded ",
    "a\tb\nc\r\n",
    "AbC",
    "\u00e9",
    "e\u0301",
    "\ufb01",
    "\u0130",
    "\u0000\u007f",
    "a\u200bb",
    "\ud83d\ude00",
    "\ud800",
    "null",
    "anonymous",
    '{"status":"anonymous"}',
    "x".repeat(100000),
    String.fromCharCode(
      ...Array.from({ length: 94 }, (_, offset) => 0x21 + offset),
    ),
  ]) {
    const reported = { currentSubject: async () => subject };
    assertExactly(await resolveSession(reported), {
      status: "authenticated",
      subject,
    });
    assertExactly(await getShellView(reported), { session: "authenticated" });
  }
  // Only the port's declared type is enforced: anything other than a string
  // or null is refused, never taken as a subject or as anonymous.
  const notReported = {
    name: "TypeError",
    message: "the server session source must report a string or null",
  };
  for (const answer of [
    undefined,
    0,
    42,
    false,
    true,
    {},
    [],
    new String("abc"),
    Symbol("subject"),
    1n,
  ]) {
    const reported = { currentSubject: async () => answer };
    await assert.rejects(resolveSession(reported), notReported);
    await assert.rejects(getShellView(reported), notReported);
  }
  // The boundary compares the reported value with null, checks its type, and
  // stores it; nothing else in session.ts touches the subject.
  assert.deepEqual(
    lines(codeOf(read("src/application/session.ts"))).filter((line) =>
      /\bsubject\b/.test(line),
    ),
    [
      "readonly subject: string;",
      "const subject: unknown = await source.currentSubject();",
      "if (subject === null) {",
      'if (typeof subject !== "string") {',
      'return Object.freeze({ status: "authenticated", subject });',
    ],
  );
  // Nothing on the way to presentation reads the subject.
  for (const file of ["src/application/shell.ts", ...filesIn("app/")]) {
    assert.doesNotMatch(codeOf(read(file)), /\bsubject\b/i, file);
  }
  // Only session.ts asks the source (its port type, the default source, the
  // guard, and the one read), so no other module can read what the source
  // reports under another name.
  for (const file of [...filesIn("src/"), ...filesIn("app/")]) {
    assert.equal(
      codeOf(read(file)).match(/\bcurrentSubject\b/g)?.length ?? 0,
      file === "src/application/session.ts" ? 4 : 0,
      file,
    );
  }
});

test("11. browser-supplied assertions are never authoritative session state", async () => {
  // A client-shaped claim is not a server session source.
  const notASource = {
    name: "TypeError",
    message: "a server session source is required",
  };
  for (const claim of [
    { status: "authenticated", subject: "client-claimed" },
    { status: "anonymous" },
    "authenticated",
    null,
    undefined,
  ]) {
    await assert.rejects(resolveSession(claim), notASource);
    if (claim !== undefined) {
      await assert.rejects(getShellView(claim), notASource);
    }
  }

  // The page passes no request input into the session boundary.
  assert.match(read("app/page.tsx"), /getShellView\(\)/);
  for (const file of [...filesIn("app/"), ...filesIn("src/")]) {
    assert.doesNotMatch(
      read(file),
      /next\/headers|\bcookies\s*\(|\bheaders\s*\(|searchParams|localStorage|sessionStorage|document\.cookie|indexedDB/,
      file,
    );
  }
});

test("12. presentation reaches application state only through application modules", () => {
  const page = read("app/page.tsx");
  assert.deepEqual(importsOf(page), [
    "next/server",
    "../src/application/shell.ts",
  ]);
  // The page renders exactly the server-derived view it is given.
  assert.match(
    page,
    /\nexport default async function HomePage\(\) \{\n(?: {2}\/\/ [^\n]*\n)* {2}await connection\(\);\n {2}const view = await getShellView\(\);\n {2}return \(\n[\s\S]*\n {2}\);\n\}\n$/,
  );
  assert.equal(codeOf(page).match(/\bview\b/g)?.length, 2);
  assert.deepEqual(componentShape(page), {
    functions: 1,
    returns: 1,
    arrows: 0,
    tags: ["h1", "p"],
    attributes: [],
    expressions: ["view.session"],
    text: ["Rosuno", "Session: {}"],
  });
  for (const file of filesIn("app/")) {
    // Each app module exports only its component (the root layout also its
    // metadata), so no route segment config (dynamic, revalidate, ...) can
    // make Next.js prerender or cache per-request session state.
    assert.equal(
      codeOf(read(file)).match(/\bexport\b/g)?.length,
      file === "app/layout.tsx" ? 2 : 1,
      file,
    );
    // No server actions: each would be a public POST endpoint.
    assert.doesNotMatch(read(file), /["']use server["']/, file);
    assert.doesNotMatch(read(file), unspacedImport, file);
    for (const specifier of importsOf(read(file))) {
      assert.match(
        specifier,
        /^(?:react|next(?:\/[a-z]+)?|\.\.\/src\/application\/[a-z-]+\.ts)$/,
        `${file} imports ${specifier}`,
      );
    }
  }
  // The application layer never depends on presentation or a UI runtime.
  for (const file of filesIn("src/")) {
    const source = read(file);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    for (const specifier of importsOf(source)) {
      assert.match(
        specifier,
        /^\.\/[a-z-]+\.ts$/,
        `${file} imports ${specifier}`,
      );
    }
  }
  // Only the error boundaries, which Next.js requires, are client modules. A
  // directive still applies after leading comments, so it is matched anywhere.
  assert.deepEqual(
    filesIn("app/").filter((file) => /["']use client["']/.test(read(file))),
    ["app/error.tsx", "app/global-error.tsx"],
  );
});

test("13. generic shell contains no feature-specific business logic or records", () => {
  for (const file of [...filesIn("app/"), ...filesIn("src/")]) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /attorney|lawyer|consultation|referral|intake|booking|payment|payout|ledger|refund|\bfee\b|stripe|\bdaily\b|\bresend\b|supabase|postgres|database|jurisdiction|california|arizona|eligib|bookab|engagement|marketplace|complaint|licen[cs]e/i,
      file,
    );
    assert.doesNotMatch(
      source,
      /\bfetch\s*\(|@[a-z0-9-]+\.[a-z]{2,}|lorem/i,
      file,
    );
    // Identifiers are split into their words first, so FAKE_PROVIDER,
    // mockSession, and sampleView count as well.
    assert.doesNotMatch(
      source
        .replaceAll("_", " ")
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2"),
      /\b(?:demo|fake|mock|sample)\b/i,
      file,
    );
    // Shell code reads no process state, stack traces, or module metadata, so
    // it cannot read configuration or behave differently under these tests.
    assert.doesNotMatch(source, /\bprocess\b|\.stack\b|\bimport\.meta\b/, file);
  }
  // App modules hold no module-level code or data: before the component there
  // is only a directive, imports, a props type, and the layout's metadata.
  for (const file of filesIn("app/")) {
    const code = codeOf(read(file));
    const preamble = code
      .slice(0, code.indexOf("export default"))
      .replace(/^"use client";\n/, "")
      .replace(/^import [^;]*;\n/gm, "")
      .replace(/^type \w+ = \{\n[^}]*\};\n/gm, "")
      .replace(/^export const metadata: Metadata = \{\n[^}]*\};\n/m, "");
    assert.equal(preamble.trim(), "", file);
  }
});

test("14. generated Next.js state stays in ignored app-local locations", () => {
  // next.config.ts runs here too: output goes to dist/ and next dev writes no
  // agent files into the app.
  assert.deepEqual(nextConfig, { agentRules: false, distDir: "dist" });
  // Next.js copies every own key of the config, enumerable or not, and runs it
  // in its own process, so the file itself is exactly these two directives:
  // nothing hidden, computed, or conditional on how it is run.
  assert.equal(
    codeOf(read("next.config.ts")),
    'import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  agentRules: false,\n  distDir: "dist",\n};\n\nexport default nextConfig;\n',
  );
  // Next.js loads next.config.js or next.config.mjs ahead of next.config.ts,
  // so no other config file may exist beside it.
  assert.deepEqual(
    readdirSync(appRoot).filter((entry) => /^next\.config\./.test(entry)),
    ["next.config.ts"],
  );
  // The root .gitignore, which Prettier also reads, already ignores dist.
  assert.ok(lines(read(".gitignore", repositoryRoot)).includes("dist"));
  const ignored = lines(read(".gitignore"));
  for (const entry of ["dist/", ".next/", "next-env.d.ts"]) {
    assert.ok(ignored.includes(entry), entry);
  }
  // next build and next dev rewrite the committed tsconfig.json unless it
  // already sets each option Next.js suggests (to any value), holds each value
  // Next.js requires, enables its plugin, has an exclude list, and includes
  // the generated route types.
  const tsconfig = JSON.parse(read("tsconfig.json"));
  const options = tsconfig.compilerOptions;
  for (const option of [
    "target",
    "lib",
    "allowJs",
    "skipLibCheck",
    "strict",
    "noEmit",
    "incremental",
  ]) {
    assert.ok(Object.hasOwn(options, option), option);
  }
  for (const [option, value] of Object.entries({
    module: "esnext",
    esModuleInterop: true,
    moduleResolution: "bundler",
    resolveJsonModule: true,
    jsx: "react-jsx",
  })) {
    assert.equal(options[option], value, option);
  }
  assert.ok(
    options.isolatedModules === true || options.verbatimModuleSyntax === true,
  );
  assert.ok(options.plugins?.some((plugin) => plugin.name === "next"));
  assert.ok(Object.hasOwn(tsconfig, "exclude"));
  for (const entry of ["dist/types/**/*.ts", "dist/dev/types/**/*.ts"]) {
    assert.ok(tsconfig.include.includes(entry), entry);
  }
});

test("15. the tests and the modules they run need only Node.js built-ins", () => {
  const testFiles = filesIn("tests/");
  assert.ok(testFiles.length > 0);
  for (const file of [...testFiles, "next.config.ts", ...filesIn("src/")]) {
    const source = read(file);
    // No dynamic loading or re-export can reach a package.
    assert.doesNotMatch(
      source,
      /\bimport\s*\(|\brequire\s*\(|\bcreate[R]equire\b|^\s*export\s*(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s/m,
      file,
    );
    assert.doesNotMatch(source, unspacedImport, file);
    const allowed = file.startsWith("tests/")
      ? /^(?:node:[a-z/]+|\.\.\/next\.config\.ts|\.\.\/src\/application\/[a-z-]+\.ts)$/
      : file === "next.config.ts"
        ? /^next$/
        : /^\.\/[a-z-]+\.ts$/;
    for (const specifier of importsOf(source)) {
      assert.match(specifier, allowed, `${file} imports ${specifier}`);
    }
  }
  // next.config.ts imports only a type, which type stripping removes.
  assert.equal(read("next.config.ts").match(/^import /gm)?.length, 1);
  assert.match(
    read("next.config.ts"),
    /^import type \{ NextConfig \} from "next";$/m,
  );
});
