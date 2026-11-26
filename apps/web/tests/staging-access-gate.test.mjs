// The Staging access gate (the reviewed P2-925 design, implemented under
// DEV-001): the pure activation and access decision with an injected
// identity, the strict credential check, the exact response headers, the
// removal of the Authorization request header, the identity reader and its
// caching, the privileged identity port, and the source contract of the gate
// and the proxy.
//
// No server, network, provider, or database is used. Every credential is
// generated here, at random, for this run only; every project reference is
// synthetic.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  BASIC_CHALLENGE,
  createIdentityReader,
  decideStagingAccess,
  GATED_CACHE_CONTROL,
  GATED_ROBOTS,
  identityOf,
  IDENTITY_DEADLINE_MS,
  isGateRequired,
  isMachineRoute,
  isValidGateValue,
  MACHINE_ROUTES,
  markGatedResponse,
  presentsStagingCredential,
  readGateSettings,
  STAGING_ACCESS_USER,
  stagingAccessGate,
} from "../src/infrastructure/environment/staging-access-gate.ts";
import { createDeploymentIdentityPort } from "../src/infrastructure/identity/registration-provisioning.ts";
import { allowedFields } from "../src/infrastructure/observability/log.ts";

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

const codeOf = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*\n/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

// A fresh random secret of the given length, of the valid alphabet.
function secretOf(length) {
  let value = "";
  while (value.length < length) {
    value += randomBytes(96).toString("base64url");
  }
  return value.slice(0, length);
}

const GATE_VALUE = secretOf(64);
const OTHER_VALUE = secretOf(64);
const REF = "syntheticprojectrefa";
const OTHER_REF = "syntheticprojectrefb";

const basic = (text) => `Basic ${Buffer.from(text, "utf8").toString("base64")}`;
const ACCESS_HEADER = basic(`${STAGING_ACCESS_USER}:${GATE_VALUE}`);

const identity = (environmentClass, projectRef = null) =>
  Object.freeze({ environmentClass, projectRef });
const settings = (overrides = {}) =>
  Object.freeze({
    configuredClass: undefined,
    expectedProjectRef: null,
    hosted: false,
    gateValue: undefined,
    ...overrides,
  });

// The design's two "off" rows, restated independently of the module.
function expectedOff(recorded, configured) {
  if (recorded === null) {
    return false;
  }
  const productionBound =
    recorded.environmentClass === "production" &&
    configured.configuredClass === "production" &&
    typeof recorded.projectRef === "string" &&
    configured.expectedProjectRef === recorded.projectRef;
  const localDevelopment =
    recorded.environmentClass === "development" &&
    configured.configuredClass === "development" &&
    configured.hosted === false &&
    configured.gateValue === undefined;
  return productionBound || localDevelopment;
}

const GATE_VALUES = Object.freeze({
  missing: undefined,
  valid: GATE_VALUE,
  invalid: secretOf(31),
  empty: "",
});

function gatedRequest(pathname, headers = {}) {
  return { headers: new Headers(headers), nextUrl: { pathname } };
}

function fixedDependencies(recorded, configured) {
  return Object.freeze({
    identity: async () => recorded,
    settings: () => configured,
  });
}

const throwingDependencies = Object.freeze({
  identity: async () => {
    throw new Error("must not be read");
  },
  settings: () => {
    throw new Error("must not be read");
  },
});

const sortedHeaders = (response) => [...response.headers.entries()];

test("G-1. activation matrix: the gate is off in exactly its two cases and required in every other one", () => {
  const recordedIdentities = [
    null,
    identity("unrecorded"),
    identity("development"),
    identity("staging", REF),
    identity("production", REF),
  ];
  const configuredClasses = [
    "development",
    "staging",
    "production",
    undefined,
    "",
    "Production",
    " production",
  ];
  const references = [REF, OTHER_REF, null];
  let off = 0;
  let total = 0;
  for (const recorded of recordedIdentities) {
    for (const configuredClass of configuredClasses) {
      for (const expectedProjectRef of references) {
        for (const hosted of [false, true]) {
          for (const secret of Object.values(GATE_VALUES)) {
            const configured = settings({
              configuredClass,
              expectedProjectRef,
              hosted,
              gateValue: secret,
            });
            const required = isGateRequired(recorded, configured);
            assert.equal(
              required,
              !expectedOff(recorded, configured),
              JSON.stringify({ recorded, configured: { ...configured } }),
            );
            total += 1;
            off += required ? 0 : 1;
          }
        }
      }
    }
  }
  // Row 1: 1 identity x 1 class x 1 reference x 2 hosted x 4 secrets = 8.
  // Row 2: 1 identity x 1 class x 3 references x 1 hosted x 1 secret = 3.
  assert.equal(off, 11);
  assert.equal(total, 5 * 7 * 3 * 2 * 4);
});

test("G-2. each row of the design's activation matrix, by name", () => {
  const cases = [
    // Row 1: production fully bound, any H and any S (a valid S included).
    ...[false, true].flatMap((hosted) =>
      Object.values(GATE_VALUES).map((secret) => [
        "row 1",
        identity("production", REF),
        settings({
          configuredClass: "production",
          expectedProjectRef: REF,
          hosted,
          gateValue: secret,
        }),
        "off",
      ]),
    ),
    // Row 2: local development, S missing, any R_app.
    ...[null, REF].map((expectedProjectRef) => [
      "row 2",
      identity("development"),
      settings({ configuredClass: "development", expectedProjectRef }),
      "off",
    ]),
    // Row 3: local development with a valid S: active.
    [
      "row 3",
      identity("development"),
      settings({ configuredClass: "development", gateValue: GATE_VALUE }),
      "challenge",
    ],
    // Row 4: local development with an invalid S: 503.
    ...[
      GATE_VALUES.invalid,
      GATE_VALUES.empty,
      secretOf(129),
      `${GATE_VALUE}!`,
    ].map((secret) => [
      "row 4",
      identity("development"),
      settings({ configuredClass: "development", gateValue: secret }),
      "unavailable",
    ]),
    // Row 5: hosted development, any C_app.
    ...["development", "staging", "production", undefined].flatMap(
      (configuredClass) => [
        [
          "row 5",
          identity("development"),
          settings({ configuredClass, hosted: true }),
          "unavailable",
        ],
        [
          "row 5",
          identity("development"),
          settings({ configuredClass, hosted: true, gateValue: GATE_VALUE }),
          "challenge",
        ],
      ],
    ),
    // Row 6: canonical Staging, C_app production and a matching R_app
    // included.
    ...["staging", "production", "development", undefined].flatMap(
      (configuredClass) =>
        [REF, OTHER_REF, null].map((expectedProjectRef) => [
          "row 6",
          identity("staging", REF),
          settings({
            configuredClass,
            expectedProjectRef,
            gateValue: GATE_VALUE,
          }),
          "challenge",
        ]),
    ),
    [
      "row 6, no secret",
      identity("staging", REF),
      settings({ configuredClass: "production", expectedProjectRef: REF }),
      "unavailable",
    ],
    // Row 7: production database, C_app not production or unset.
    ...["staging", "development", undefined, ""].map((configuredClass) => [
      "row 7",
      identity("production", REF),
      settings({
        configuredClass,
        expectedProjectRef: REF,
        gateValue: GATE_VALUE,
      }),
      "challenge",
    ]),
    // Row 8: production database and setting, R_app different or unset.
    ...[OTHER_REF, null].map((expectedProjectRef) => [
      "row 8",
      identity("production", REF),
      settings({
        configuredClass: "production",
        expectedProjectRef,
        gateValue: GATE_VALUE,
      }),
      "challenge",
    ]),
    // Row 9: unrecorded or unknown.
    ...[identity("unrecorded"), null].flatMap((recorded) => [
      [
        "row 9",
        recorded,
        settings({
          configuredClass: "production",
          expectedProjectRef: REF,
          gateValue: GATE_VALUE,
        }),
        "challenge",
      ],
      [
        "row 9, no secret",
        recorded,
        settings({ configuredClass: "development" }),
        "unavailable",
      ],
    ]),
    // Row 10: development database, C_app not development or unset, not
    // hosted.
    ...["staging", "production", undefined].map((configuredClass) => [
      "row 10",
      identity("development"),
      settings({ configuredClass }),
      "unavailable",
    ]),
  ];
  for (const [name, recorded, configured, expected] of cases) {
    assert.equal(
      decideStagingAccess(recorded, configured, null),
      expected,
      name,
    );
  }
  // A required gate with a valid S passes the right credential, and an off
  // gate decides nothing from the header.
  assert.equal(
    decideStagingAccess(
      identity("staging", REF),
      settings({ configuredClass: "production", gateValue: GATE_VALUE }),
      ACCESS_HEADER,
    ),
    "pass",
  );
  assert.equal(
    decideStagingAccess(
      identity("production", REF),
      settings({
        configuredClass: "production",
        expectedProjectRef: REF,
        gateValue: GATE_VALUE,
      }),
      "Bearer synthetic",
    ),
    "off",
  );
});

test("G-3. the secret is valid only as 32 to 128 characters of [A-Za-z0-9_-]; otherwise a required gate answers 503 whatever is presented", () => {
  for (const valid of [
    secretOf(32),
    secretOf(128),
    "a".repeat(32),
    "_-".repeat(40),
  ]) {
    assert.equal(isValidGateValue(valid), true, valid.length);
  }
  const invalid = [
    undefined,
    null,
    "",
    secretOf(31),
    secretOf(129),
    `${secretOf(40)}+`,
    `${secretOf(40)}/`,
    `${secretOf(40)}=`,
    `${secretOf(40)}:`,
    `${secretOf(40)} `,
    ` ${secretOf(40)}`,
    `${secretOf(40)}\n`,
    `${secretOf(40)}é`,
    42,
  ];
  for (const secret of invalid) {
    assert.equal(isValidGateValue(secret), false, String(secret));
    const required = settings({
      configuredClass: "staging",
      gateValue: secret,
    });
    for (const authorization of [
      null,
      ACCESS_HEADER,
      typeof secret === "string"
        ? basic(`${STAGING_ACCESS_USER}:${secret}`)
        : null,
    ]) {
      assert.equal(
        decideStagingAccess(identity("staging", REF), required, authorization),
        "unavailable",
      );
    }
  }
});

test("G-4. only the exact Basic credential passes; every other header is a challenge", () => {
  assert.equal(STAGING_ACCESS_USER, "rosuno-staging");
  assert.equal(presentsStagingCredential(ACCESS_HEADER, GATE_VALUE), true);
  // A non-canonical encoding of the right bytes (nonzero padding bits) is
  // refused: only the canonical form is accepted.
  const userPass = `${STAGING_ACCESS_USER}:${GATE_VALUE}`;
  const encoded = Buffer.from(userPass, "utf8").toString("base64");
  assert.ok(encoded.endsWith("=="));
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = encoded.length - 3;
  const nonCanonical = `${encoded.slice(0, last)}${ALPHABET[ALPHABET.indexOf(encoded[last]) + 1]}${encoded.slice(last + 1)}`;
  assert.notEqual(nonCanonical, encoded);
  assert.deepEqual(
    Buffer.from(nonCanonical, "base64"),
    Buffer.from(userPass, "utf8"),
  );
  assert.equal(
    presentsStagingCredential(`Basic ${nonCanonical}`, GATE_VALUE),
    false,
  );
  const refused = {
    "no header": null,
    empty: "",
    "wrong password": basic(`${STAGING_ACCESS_USER}:${OTHER_VALUE}`),
    "password prefix": basic(
      `${STAGING_ACCESS_USER}:${GATE_VALUE.slice(0, 63)}`,
    ),
    "password extended": basic(`${STAGING_ACCESS_USER}:${GATE_VALUE}x`),
    "wrong user": basic(`rosuno-admin:${GATE_VALUE}`),
    "user case": basic(`Rosuno-Staging:${GATE_VALUE}`),
    "empty user": basic(`:${GATE_VALUE}`),
    "empty password": basic(`${STAGING_ACCESS_USER}:`),
    swapped: basic(`${GATE_VALUE}:${STAGING_ACCESS_USER}`),
    "no colon": basic(`${STAGING_ACCESS_USER}${GATE_VALUE}`),
    "malformed base64": "Basic !!!!",
    "unpadded base64": ACCESS_HEADER.replace(/=+$/, ""),
    "other short credential": `Basic ${Buffer.from(`${STAGING_ACCESS_USER}:a`).toString("base64")}`,
    "base64url alphabet": `Basic ${Buffer.from(`${STAGING_ACCESS_USER}:${GATE_VALUE}`).toString("base64url")}`,
    "scheme only": "Basic",
    "scheme and space": "Basic ",
    "two spaces": ACCESS_HEADER.replace("Basic ", "Basic  "),
    "leading space": ` ${ACCESS_HEADER}`,
    "trailing space": `${ACCESS_HEADER} `,
    "lowercase scheme": ACCESS_HEADER.replace("Basic", "basic"),
    bearer: `Bearer ${GATE_VALUE}`,
    "bearer of the credential": ACCESS_HEADER.replace("Basic", "Bearer"),
    digest: `Digest username="${STAGING_ACCESS_USER}", response="${GATE_VALUE}"`,
    "another scheme": ACCESS_HEADER.replace("Basic", "Negotiate"),
    "raw secret": GATE_VALUE,
    "duplicated header": `${ACCESS_HEADER}, ${ACCESS_HEADER}`,
    "credential then another": `${ACCESS_HEADER}, Bearer ${GATE_VALUE}`,
    overlong: basic(`${STAGING_ACCESS_USER}:${GATE_VALUE}${"a".repeat(400)}`),
  };
  for (const [name, authorization] of Object.entries(refused)) {
    assert.equal(
      presentsStagingCredential(authorization, GATE_VALUE),
      false,
      name,
    );
    assert.equal(
      decideStagingAccess(
        identity("staging", REF),
        settings({ configuredClass: "staging", gateValue: GATE_VALUE }),
        authorization,
      ),
      "challenge",
      name,
    );
  }
  // A duplicated header, as the Fetch Headers combine it, is refused.
  const duplicated = new Headers();
  duplicated.append("authorization", ACCESS_HEADER);
  duplicated.append("authorization", ACCESS_HEADER);
  assert.equal(
    presentsStagingCredential(duplicated.get("authorization"), GATE_VALUE),
    false,
  );
  // The check never passes an invalid secret, even when it is presented.
  const short = secretOf(20);
  assert.equal(
    presentsStagingCredential(basic(`${STAGING_ACCESS_USER}:${short}`), short),
    false,
  );
});

test("G-5. exact response headers: 401 with the Basic challenge, 503 without it, and a marked pass; Authorization is removed after the check", async () => {
  const required = settings({
    configuredClass: "staging",
    gateValue: GATE_VALUE,
  });
  const staging = identity("staging", REF);
  const extra = {
    cookie: "synthetic=1",
    "x-rosuno-correlation-id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  };

  const challenged = gatedRequest("/find-an-attorney", {
    ...extra,
    authorization: `Bearer ${GATE_VALUE}`,
  });
  const challenge = await stagingAccessGate(
    challenged,
    fixedDependencies(staging, required),
  );
  assert.equal(challenge.kind, "refused");
  assert.equal(challenge.response.status, 401);
  assert.equal(challenge.response.body, null);
  assert.deepEqual(sortedHeaders(challenge.response), [
    ["cache-control", "private, no-store, max-age=0"],
    ["www-authenticate", 'Basic realm="Rosuno Staging", charset="UTF-8"'],
    ["x-robots-tag", "noindex, nofollow"],
  ]);
  assert.equal(challenged.headers.has("authorization"), false);
  assert.equal(challenged.headers.get("cookie"), "synthetic=1");

  const unconfigured = gatedRequest("/privacy", {
    ...extra,
    authorization: ACCESS_HEADER,
  });
  const unavailable = await stagingAccessGate(
    unconfigured,
    fixedDependencies(staging, settings({ configuredClass: "staging" })),
  );
  assert.equal(unavailable.kind, "refused");
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.response.body, null);
  assert.deepEqual(sortedHeaders(unavailable.response), [
    ["cache-control", "private, no-store, max-age=0"],
    ["x-robots-tag", "noindex, nofollow"],
  ]);
  assert.equal(unconfigured.headers.has("authorization"), false);

  const accepted = gatedRequest("/attorneys/synthetic", {
    ...extra,
    authorization: ACCESS_HEADER,
  });
  const pass = await stagingAccessGate(
    accepted,
    fixedDependencies(staging, required),
  );
  assert.deepEqual(pass, { kind: "passed" });
  assert.equal(accepted.headers.has("authorization"), false);
  assert.deepEqual([...accepted.headers.entries()], Object.entries(extra));
  // A pass marks the page's own response, replacing a shared-cache lifetime.
  const page = new Response("synthetic", {
    headers: {
      "cache-control": "s-maxage=31536000",
      "content-type": "text/html",
    },
  });
  markGatedResponse(page);
  assert.deepEqual(sortedHeaders(page), [
    ["cache-control", "private, no-store, max-age=0"],
    ["content-type", "text/html"],
    ["x-robots-tag", "noindex, nofollow"],
  ]);
  assert.equal(GATED_CACHE_CONTROL, "private, no-store, max-age=0");
  assert.equal(GATED_ROBOTS, "noindex, nofollow");
  assert.equal(
    BASIC_CHALLENGE,
    'Basic realm="Rosuno Staging", charset="UTF-8"',
  );

  // An off gate reads the header for nothing and changes nothing.
  const production = gatedRequest("/", {
    ...extra,
    authorization: `Bearer ${GATE_VALUE}`,
  });
  const off = await stagingAccessGate(
    production,
    fixedDependencies(
      identity("production", REF),
      settings({ configuredClass: "production", expectedProjectRef: REF }),
    ),
  );
  assert.deepEqual(off, { kind: "ungated" });
  assert.equal(production.headers.get("authorization"), `Bearer ${GATE_VALUE}`);
});

test("G-6. the four machine routes are exempt by exact pathname only; the gate reads nothing there and a gate credential grants nothing", async () => {
  assert.deepEqual(MACHINE_ROUTES, [
    "/api/payments/stripe",
    "/api/media/daily",
    "/api/notifications/resend",
    "/api/jobs/run",
  ]);
  assert.ok(Object.isFrozen(MACHINE_ROUTES));
  for (const pathname of MACHINE_ROUTES) {
    assert.equal(isMachineRoute(pathname), true);
    for (const authorization of [ACCESS_HEADER, `Bearer ${GATE_VALUE}`]) {
      const request = gatedRequest(pathname, { authorization });
      const outcome = await stagingAccessGate(request, throwingDependencies);
      assert.deepEqual(outcome, { kind: "ungated" });
      assert.equal(request.headers.get("authorization"), authorization);
    }
  }
  const required = fixedDependencies(
    identity("staging", REF),
    settings({ configuredClass: "staging", gateValue: GATE_VALUE }),
  );
  for (const pathname of [
    "/api/jobs/run/",
    "/API/jobs/run",
    "/api/Jobs/run",
    "/api//jobs/run",
    "/api/jobs/run;x",
    "/api/jobs/%72un",
    "/%61pi/jobs/run",
    "/api/jobs/run%2F",
    "/api/jobs/./run",
    "/api/jobs",
    "/api/jobs/run/x",
    "/api/payments/stripe/",
    "/api/media/daily.png",
    "/api/notifications",
    "api/jobs/run",
    "",
    "/",
  ]) {
    assert.equal(isMachineRoute(pathname), false, pathname);
    const request = gatedRequest(pathname, {
      authorization: `Bearer ${GATE_VALUE}`,
    });
    const outcome = await stagingAccessGate(request, required);
    assert.equal(outcome.kind, "refused", pathname);
    assert.equal(outcome.response.status, 401, pathname);
    assert.equal(request.headers.has("authorization"), false, pathname);
  }
});

test("G-7. the gate never throws and never passes on a failure: a failing identity or settings source is a 503", async () => {
  for (const dependencies of [
    {
      identity: async () => {
        throw new Error("synthetic");
      },
      settings: () =>
        settings({ configuredClass: "staging", gateValue: GATE_VALUE }),
    },
    {
      identity: async () => identity("staging", REF),
      settings: () => {
        throw new Error("synthetic");
      },
    },
  ]) {
    const request = gatedRequest("/", { authorization: ACCESS_HEADER });
    const outcome = await stagingAccessGate(request, dependencies);
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.response.status, 503);
    assert.equal(request.headers.has("authorization"), false);
  }
  // An unknown identity (a failed read) is required, never off.
  const unknown = gatedRequest("/", { authorization: ACCESS_HEADER });
  const outcome = await stagingAccessGate(
    unknown,
    fixedDependencies(
      null,
      settings({ configuredClass: "production", expectedProjectRef: REF }),
    ),
  );
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.response.status, 503);
});

test("G-8. the accessor's answer is read strictly; anything unexpected is unknown", () => {
  const rows = (...values) => ({ kind: "rows", rows: values });
  assert.deepEqual(
    identityOf(rows({ environment_class: "staging", project_ref: REF })),
    identity("staging", REF),
  );
  assert.deepEqual(
    identityOf(rows({ environment_class: "production", project_ref: REF })),
    identity("production", REF),
  );
  assert.deepEqual(
    identityOf(rows({ environment_class: "development", project_ref: null })),
    identity("development"),
  );
  assert.deepEqual(
    identityOf(rows({ environment_class: "unrecorded", project_ref: null })),
    identity("unrecorded"),
  );
  for (const result of [
    { kind: "unreadable" },
    rows(),
    rows(
      { environment_class: "staging", project_ref: REF },
      { environment_class: "staging", project_ref: REF },
    ),
    rows({ environment_class: "staging" }),
    rows({ environment_class: "staging", project_ref: REF, extra: 1 }),
    rows({ environment_class: "Staging", project_ref: REF }),
    rows({ environment_class: "test", project_ref: null }),
    rows({ environment_class: "unrecorded", project_ref: REF }),
    rows({ environment_class: "staging", project_ref: "SYNTHETICPROJECTREFA" }),
    rows({ environment_class: "staging", project_ref: "short" }),
    rows({ environment_class: "staging", project_ref: 42 }),
    rows(null),
    rows([]),
    rows("staging"),
  ]) {
    assert.equal(identityOf(result), null, JSON.stringify(result));
  }
});

test("G-9. the identity reader keeps a recorded identity only after a successful read, retries otherwise, bounds each read in time, and shares one read in flight", async () => {
  assert.equal(IDENTITY_DEADLINE_MS, 2000);
  const staging = { environment_class: "staging", project_ref: REF };
  const answers = [
    "unbound",
    "throw",
    { kind: "unreadable" },
    {
      kind: "rows",
      rows: [{ environment_class: "unrecorded", project_ref: null }],
    },
    "hang",
    { kind: "rows", rows: [staging] },
  ];
  let sourceCalls = 0;
  const source = async () => {
    const answer = answers[sourceCalls];
    sourceCalls += 1;
    if (answer === "unbound") {
      return null;
    }
    if (answer === "throw") {
      throw new Error("synthetic");
    }
    return {
      read: () =>
        answer === "hang" ? new Promise(() => {}) : Promise.resolve(answer),
    };
  };
  const reader = createIdentityReader(source, 25);
  assert.equal(await reader(), null);
  assert.equal(await reader(), null);
  assert.equal(await reader(), null);
  assert.deepEqual(await reader(), identity("unrecorded"));
  assert.equal(await reader(), null);
  assert.equal(sourceCalls, 5);
  assert.deepEqual(await reader(), identity("staging", REF));
  assert.equal(sourceCalls, 6);
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await reader(), identity("staging", REF));
  }
  assert.equal(sourceCalls, 6);

  // Concurrent requests share the one read in flight, and a failure is not
  // kept.
  let calls = 0;
  let release;
  const gated = new Promise((resolve) => {
    release = resolve;
  });
  const shared = createIdentityReader(async () => {
    calls += 1;
    await gated;
    return { read: async () => ({ kind: "unreadable" }) };
  }, 1000);
  const first = shared();
  const second = shared();
  release();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(calls, 1);
  assert.equal(await shared(), null);
  assert.equal(calls, 2);
});

test("G-10. the privileged identity port is built only from the verified binding and makes only the one bounded accessor call", async () => {
  const made = [];
  const calls = [];
  let answer = {
    data: [{ environment_class: "staging", project_ref: REF }],
    error: null,
  };
  const create = (...args) => {
    made.push(args);
    return {
      rpc: (...rpcArgs) => {
        calls.push(rpcArgs);
        return {
          abortSignal: (signal) => {
            assert.ok(signal instanceof AbortSignal);
            if (answer === "throw") {
              return Promise.reject(new Error("synthetic"));
            }
            return Promise.resolve(answer);
          },
        };
      },
    };
  };
  const publishable = `sb_publishable_${randomBytes(12).toString("hex")}`;
  const admin = `sb_secret_${randomBytes(12).toString("hex")}`;
  const hosted = {
    NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
    ROSUNO_SUPABASE_ADMIN_KEY: admin,
    ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: REF,
    ROSUNO_ENVIRONMENT_CLASS: "staging",
  };
  for (const unbound of [
    {},
    { ...hosted, ROSUNO_SUPABASE_ADMIN_KEY: undefined },
    { ...hosted, ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: OTHER_REF },
    { ...hosted, ROSUNO_ENVIRONMENT_CLASS: "development" },
  ]) {
    assert.equal(await createDeploymentIdentityPort(unbound, create), null);
  }
  assert.deepEqual(made, []);
  const port = await createDeploymentIdentityPort(hosted, create);
  assert.ok(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port), ["read"]);
  assert.equal(made.length, 1);
  assert.equal(made[0][0], `https://${REF}.supabase.co`);
  assert.equal(made[0][1], admin);
  assert.deepEqual(made[0][2], {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  assert.deepEqual(await port.read(), {
    kind: "rows",
    rows: [{ environment_class: "staging", project_ref: REF }],
  });
  assert.deepEqual(calls, [["deployment_environment_identity"]]);
  answer = { data: null, error: { code: "42501" } };
  assert.deepEqual(await port.read(), { kind: "unreadable" });
  answer = "throw";
  assert.deepEqual(await port.read(), { kind: "unreadable" });
  // The local development binding is admitted too.
  const local = await createDeploymentIdentityPort(
    {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
      ROSUNO_SUPABASE_ADMIN_KEY: admin,
      ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined,
      ROSUNO_ENVIRONMENT_CLASS: "development",
    },
    create,
  );
  assert.notEqual(local, null);
  assert.equal(made.length, 2);
  assert.equal(made[1][0], "http://127.0.0.1:54321");
});

test("G-11. the settings come from the server environment unchanged: hosted only for REPLIT_DEPLOYMENT exactly 1, R_app from the configured project URL", () => {
  for (const [value, hosted] of [
    ["1", true],
    [undefined, false],
    ["", false],
    ["0", false],
    ["true", false],
    [" 1", false],
    ["1 ", false],
    ["01", false],
  ]) {
    assert.equal(readGateSettings({ REPLIT_DEPLOYMENT: value }).hosted, hosted);
  }
  assert.deepEqual(
    {
      ...readGateSettings({
        ROSUNO_ENVIRONMENT_CLASS: "staging",
        NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
        REPLIT_DEPLOYMENT: "1",
        ROSUNO_STAGING_ACCESS_GATE: GATE_VALUE,
      }),
    },
    {
      configuredClass: "staging",
      expectedProjectRef: REF,
      hosted: true,
      gateValue: GATE_VALUE,
    },
  );
  const local = readGateSettings({
    ROSUNO_ENVIRONMENT_CLASS: "development",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    ROSUNO_STAGING_ACCESS_GATE: "",
  });
  assert.equal(local.expectedProjectRef, null);
  assert.equal(local.gateValue, "");
  assert.equal(readGateSettings({}).gateValue, undefined);
  assert.equal(readGateSettings({}).configuredClass, undefined);
  assert.ok(Object.isFrozen(local));
});

test("G-12. source contract: the gate runs after the correlation id and before the session refresh, and the matcher skips only /_next/static/", () => {
  const proxySource = read("proxy.ts");
  const proxy = codeOf(proxySource);
  const correlation = proxy.indexOf(
    "request.headers.set(CORRELATION_HEADER, correlationId);",
  );
  const gate = proxy.indexOf("await stagingAccessGate(request)");
  const refresh = proxy.indexOf("await refreshSupabaseSession(request)");
  assert.ok(correlation > 0 && correlation < gate && gate < refresh);
  assert.equal(proxy.match(/stagingAccessGate\(/g).length, 1);
  assert.equal(proxy.match(/refreshSupabaseSession\(/g).length, 1);
  assert.ok(
    proxy.includes(
      '  const response =\n    access.kind === "refused"\n      ? access.response\n      : await refreshSupabaseSession(request);\n  if (access.kind !== "ungated") {\n    markGatedResponse(response);\n  }\n',
    ),
  );
  assert.ok(
    proxy.endsWith(
      'export const config = {\n  matcher: ["/((?!_next/static/).*)"],\n};\n',
    ),
  );
  assert.equal(proxySource.match(/matcher/g).length, 1);
  assert.doesNotMatch(
    proxy,
    /console\.|\blog\(|logRequestEvent|headers\.get\(/,
  );
  // The matcher's pattern, read as a whole-path regular expression, skips
  // exactly the build output and nothing image-looking.
  const matcher = /^\/((?!_next\/static\/).*)$/;
  for (const skipped of [
    "/_next/static/chunks/synthetic.js",
    "/_next/static/css/synthetic.css",
  ]) {
    assert.equal(matcher.test(skipped), false, skipped);
  }
  for (const gated of [
    "/",
    "/_next/image",
    "/_next/data/synthetic/page.json",
    "/_next/staticx",
    "/favicon.ico",
    "/x.png",
    "/attorneys/synthetic.png",
    "/x.svg",
    "/api/jobs/run",
  ]) {
    assert.equal(matcher.test(gated), true, gated);
  }
});

test("G-13. source contract: digests are compared with timingSafeEqual, the gate imports only what it needs, and nothing logs or forwards the credential", () => {
  const source = read("src/infrastructure/environment/staging-access-gate.ts");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "node:crypto",
    "../../application/policy-selection.ts",
    "../../application/professional-identity.ts",
    "../../application/professional-records.ts",
    "../identity/registration-provisioning.ts",
    "./environment-configuration.ts",
  ]);
  assert.match(
    code,
    /^import \{ createHash, timingSafeEqual \} from "node:crypto";$/m,
  );
  assert.match(
    code,
    /^import \{ createDeploymentIdentityPort \} from "\.\.\/identity\/registration-provisioning\.ts";$/m,
  );
  assert.equal(code.match(/timingSafeEqual\(/g).length, 1);
  assert.ok(
    code.includes(
      '  const equal = timingSafeEqual(\n    digestOf(presented ?? ""),\n    digestOf(`${STAGING_ACCESS_USER}:${gateValue}`),\n  );\n  return presented !== null && isValidGateValue(gateValue) && equal;\n',
    ),
  );
  assert.ok(code.includes('createHash("sha256").update(value).digest()'));
  // The gate value is never compared directly with what was presented: its
  // only equality test is whether the setting is absent, and the presented
  // bytes are only tested for presence.
  assert.deepEqual(
    code.match(
      /[\w.]*gateValue\s*[=!]==?\s*[\w.]+|[\w.]+\s*[=!]==?\s*[\w.]*gateValue\b/gi,
    ),
    ["settings.gateValue === undefined"],
  );
  assert.deepEqual(
    code.match(
      /\bpresented\s*[=!]==?\s*[\w.]+|[\w.]+\s*[=!]==?\s*presented\b/g,
    ),
    ["presented !== null"],
  );
  // The header is read once and removed once, and nothing else names it.
  assert.equal(code.match(/"authorization"/gi).length, 2);
  assert.equal(
    code.match(/request\.headers\.get\("authorization"\)/g).length,
    1,
  );
  assert.equal(
    code.match(/\n {2}request\.headers\.delete\("authorization"\);\n/g).length,
    1,
  );
  // The gate logs nothing, calls no database or provider itself, and reads
  // exactly its four settings.
  assert.doesNotMatch(
    code,
    /\bconsole\b|\blog\(|logRequestEvent|observability|\brpc\b|createClient|(?<!Buffer)\.from\(|\bfetch\s*\(|ROSUNO_SUPABASE|service_role|sb_secret_|cookies|next\/headers|next\/server|setTimeout|\bimport\s*\(/,
  );
  assert.deepEqual([...new Set(code.match(/process\.env\.\w+/g))].sort(), [
    "process.env.NEXT_PUBLIC_SUPABASE_URL",
    "process.env.REPLIT_DEPLOYMENT",
    "process.env.ROSUNO_ENVIRONMENT_CLASS",
    "process.env.ROSUNO_STAGING_ACCESS_GATE",
  ]);
  // Only the proxy loads the gate, and the gate's settings name is read
  // nowhere else.
  const sources = [...filesIn("app/"), ...filesIn("src/")].filter((file) =>
    /\.tsx?$/.test(file),
  );
  for (const file of sources) {
    const text = read(file);
    if (file !== "src/infrastructure/environment/staging-access-gate.ts") {
      assert.doesNotMatch(
        text,
        /staging-access-gate|ROSUNO_STAGING_ACCESS_GATE/,
        file,
      );
    }
  }
  // The log module never takes request headers: no allowed field can carry
  // a header, a credential or a cookie, a header-shaped field is dropped,
  // and the request module reads only the correlation header.
  const log = codeOf(read("src/infrastructure/observability/log.ts"));
  assert.doesNotMatch(log, /authori[sz]|cookie|\bheaders\b|\.get\(/i);
  assert.deepEqual(
    allowedFields({
      headers: { authorization: ACCESS_HEADER },
      authorization: ACCESS_HEADER,
      cookie: "synthetic=1",
      ["credential"]: ACCESS_HEADER,
      outcome: "challenge",
    }),
    { outcome: "challenge" },
  );
  const requestLog = codeOf(
    read("src/infrastructure/observability/request-log.ts"),
  );
  assert.deepEqual(
    [...requestLog.matchAll(/\.get\(([^)]*)\)/g)].map((match) => match[1]),
    ["CORRELATION_HEADER"],
  );
  assert.doesNotMatch(
    requestLog,
    /authori[sz]|cookie|\.entries\(|\.forEach\(/i,
  );
});

test("G-14. DEV-001: website & appearance studio: the published stylesheet and appearance images are gated exactly like pages, and the matcher is unchanged", async () => {
  const matcher = /^\/((?!_next\/static\/).*)$/;
  assert.ok(
    codeOf(read("proxy.ts")).endsWith(
      'export const config = {\n  matcher: ["/((?!_next/static/).*)"],\n};\n',
    ),
  );
  const required = fixedDependencies(
    identity("staging", REF),
    settings({ configuredClass: "staging", gateValue: GATE_VALUE }),
  );
  for (const pathname of [
    "/appearance/theme.css",
    `/appearance/assets/${"a".repeat(64)}.png`,
    `/appearance/assets/${"b".repeat(64)}.webp`,
    // DEV-001: website & appearance studio (G3): the studio preview's draft
    // stylesheet and editor status, and the studio itself, gated alike.
    "/appearance/draft.css",
    "/appearance/editor",
    "/staff/appearance",
  ]) {
    assert.equal(matcher.test(pathname), true, pathname);
    assert.equal(isMachineRoute(pathname), false, pathname);
    const refused = await stagingAccessGate(gatedRequest(pathname), required);
    assert.equal(refused.kind, "refused", pathname);
    assert.equal(refused.response.status, 401, pathname);
    const request = gatedRequest(pathname, { authorization: ACCESS_HEADER });
    assert.deepEqual(await stagingAccessGate(request, required), {
      kind: "passed",
    });
    assert.equal(request.headers.has("authorization"), false, pathname);
  }
});
