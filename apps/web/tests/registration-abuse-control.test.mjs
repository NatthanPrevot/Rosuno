// Targeted P2-007 registration abuse-control tests.
//
// The server-only adapter runs against an injected synthetic quota
// operation, and the narrow privileged quota capability runs through the
// installed supabase-js client against a synthetic in-memory HTTP API, so
// every request it would send is checked as sent. The registration action's
// wiring and the migration are held to source contracts here; the database
// behavior itself is proven only by the separate, explicitly invoked
// disposable PostgreSQL harness (registration-abuse-db-proof.mjs), never by
// these tests. No real provider, account, address, key, network, or database
// is contacted, and every value here is synthetic test data.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  NO_TRUSTED_ABUSE_CONTROL,
  registerClientAccount,
} from "../src/application/client-registration.ts";
import {
  NO_TRUSTED_CLIENT_ADDRESS,
  createRegistrationAbuseControl,
} from "../src/infrastructure/identity/registration-abuse-control.ts";
import { decideQuotaRpc } from "../src/infrastructure/identity/registration-provisioning.ts";

const appRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../", appRoot);

function read(relativePath, root = appRoot) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function importsOf(source) {
  return [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

// Source without its comments.
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*\n/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

// SQL without its line comments.
function sqlOf(source) {
  return source.replace(/^\s*--.*\n/gm, "");
}

// Synthetic, test-only values. None is a real account, address, or key.
const EMAIL = "applicant@synthetic.invalid";
const PHRASE = "synthetic phrase 7f3a";
const ADDRESS = "192.0.2.10";
const KEY = Buffer.alloc(32, 0x5a).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 0x3c).toString("base64");
const HMAC_SETTING = "REGISTRATION_QUOTA_HMAC_SECRET";
const DOMAIN = "registration-quota/v1";
const MIGRATION =
  "supabase/migrations/20261020070000_p2_registration_abuse_control.sql";

const quotaEnvironment = (overrides = {}) => ({
  [HMAC_SETTING]: KEY,
  REGISTRATION_QUOTA_IP_MAX_PER_HOUR: "10",
  REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY: "10",
  REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR: "120",
  ...overrides,
});

const INITIAL_MAXIMA = {
  ipPerHour: 10,
  identityPerDay: 10,
  globalPerHour: 120,
};

// A quota operation stand-in answering one fixed value, recording each call.
function quotaOperation(answer) {
  const calls = [];
  return {
    calls,
    decideQuota: async (...args) => {
      calls.push(args);
      if (answer instanceof Error) {
        throw answer;
      }
      return typeof answer === "function" ? answer(...args) : answer;
    },
  };
}

function controlOver(
  operation,
  { address = ADDRESS, environment = quotaEnvironment() } = {},
) {
  return createRegistrationAbuseControl(
    { trustedClientAddress: address, decideQuota: operation.decideQuota },
    environment,
  );
}

function digestOf(key, purpose, value) {
  return createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${DOMAIN}\u0000${purpose}\u0000`, "utf8")
    .update(value)
    .digest("hex");
}

function expectedDigests({ key = KEY, address, email = EMAIL } = {}) {
  return {
    ip: digestOf(key, "ip", Buffer.from(address)),
    identity: digestOf(key, "identity", Buffer.from(email.toLowerCase())),
    global: digestOf(key, "global", Buffer.alloc(0)),
  };
}

const ADDRESS_BYTES = [4, 192, 0, 2, 10];

function form(entries) {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
}

const validForm = () =>
  form([
    ["email", EMAIL],
    ["password", PHRASE],
    ["confirm_password", PHRASE],
  ]);

// Records every provisioning and dispatch call the application makes.
function recordingPorts() {
  const calls = [];
  const port =
    (name) =>
    async (...args) => {
      calls.push([name, ...args]);
      return { kind: "unreadable" };
    };
  return {
    calls,
    sources: (abuseControl) => ({
      abuseControl,
      provisioning: async () => {
        calls.push(["provisioning"]);
        return {
          createAccount: port("createAccount"),
          readAccount: port("readAccount"),
          usersOf: port("usersOf"),
          insertPendingUser: port("insertPendingUser"),
          clientProfilesOf: port("clientProfilesOf"),
          insertClientProfile: port("insertClientProfile"),
          activatePendingUser: port("activatePendingUser"),
        };
      },
      dispatch: async () => {
        calls.push(["dispatch"]);
        return { requestSignupConfirmation: port("requestSignupConfirmation") };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Default deny: no trusted ingress, no configuration
// ---------------------------------------------------------------------------

test("1. without a trusted client address every attempt is unavailable before any key, digest, or quota call", async () => {
  assert.equal(NO_TRUSTED_CLIENT_ADDRESS, null);
  const operation = quotaOperation("allow");
  for (const address of [NO_TRUSTED_CLIENT_ADDRESS, undefined]) {
    const control = createRegistrationAbuseControl(
      { trustedClientAddress: address, decideQuota: operation.decideQuota },
      quotaEnvironment(),
    );
    assert.equal(await control.decide({ email: EMAIL }), "unavailable");
  }
  assert.deepEqual(operation.calls, []);
  // Through the unchanged application boundary, a valid form then creates,
  // writes, and sends nothing.
  const ports = recordingPorts();
  const control = controlOver(operation, {
    address: NO_TRUSTED_CLIENT_ADDRESS,
  });
  assert.deepEqual(
    await registerClientAccount(ports.sources(control), validForm()),
    { status: "unavailable" },
  );
  assert.deepEqual(ports.calls, []);
  assert.deepEqual(operation.calls, []);
  // The P2-006 default-deny control is unchanged.
  assert.equal(
    await NO_TRUSTED_ABUSE_CONTROL.decide({ email: EMAIL }),
    "unavailable",
  );
});

test("2. spoofed, forwarded, multi-hop, ambiguous, or malformed address text is never trusted", async () => {
  const operation = quotaOperation("allow");
  for (const address of [
    "",
    " 192.0.2.10",
    "192.0.2.10 ",
    "192.0.2.10, 198.51.100.7",
    "198.51.100.7,192.0.2.10",
    "for=192.0.2.10",
    "192.0.2.10:443",
    "[2001:db8::10]",
    "2001:db8::10%eth0",
    "2001:db8::/64",
    "192.0.2.0/24",
    "unknown",
    "localhost",
    "192.0.2",
    "192.0.2.10.1",
    "192.000.2.10",
    "0192.0.2.10",
    "0x7f.0.0.1",
    "256.0.2.10",
    "1e2.0.2.10",
    "+192.0.2.10",
    "１９２.0.2.10",
    "0.0.0.0",
    "::",
    "0:0:0:0:0:0:0:0",
    "::ffff:192.0.2.10",
    "::ffff:c000:20a",
    "0:0:0:0:0:ffff:c000:20a",
    "::192.0.2.10",
    "2001:db8::10::1",
    "2001:db8:0:0:0:0:0:0:1",
    "2001:db8:0:0:0:0:0:1:",
    ":2001:db8::1",
    "2001:db8:::1",
    "2001:db8::12345",
    "2001:db8::g",
    "a".repeat(40),
    "1:2:3:4:5:6:7:8:9",
    3221226010,
    ["192.0.2.10"],
    { address: "192.0.2.10" },
    new String("192.0.2.10"),
  ]) {
    const control = controlOver(operation, { address });
    assert.equal(
      await control.decide({ email: EMAIL }),
      "unavailable",
      String(address),
    );
  }
  assert.deepEqual(operation.calls, []);
});

test("3. each trusted address has exactly one binary quota key, with IPv4 and IPv6 families kept apart", async () => {
  const keyOf = async (address) => {
    const operation = quotaOperation("allow");
    assert.equal(
      await controlOver(operation, { address }).decide({ email: EMAIL }),
      "allow",
      address,
    );
    assert.equal(operation.calls.length, 1, address);
    return operation.calls[0][0].ip;
  };
  assert.equal(
    await keyOf("192.0.2.10"),
    digestOf(KEY, "ip", Buffer.from(ADDRESS_BYTES)),
  );
  assert.equal(
    await keyOf("0.0.0.1"),
    digestOf(KEY, "ip", Buffer.from([4, 0, 0, 0, 1])),
  );
  assert.equal(
    await keyOf("255.255.255.255"),
    digestOf(KEY, "ip", Buffer.from([4, 255, 255, 255, 255])),
  );
  // Different spellings of one IPv6 address are the same key.
  const v6 = [6, 0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 0x10];
  for (const address of [
    "2001:db8::10",
    "2001:DB8::10",
    "2001:0db8:0000:0000:0000:0000:0000:0010",
    "2001:db8:0:0:0:0:0:10",
    "2001:db8:0::0:10",
  ]) {
    assert.equal(await keyOf(address), digestOf(KEY, "ip", Buffer.from(v6)));
  }
  assert.equal(
    await keyOf("::1"),
    digestOf(KEY, "ip", Buffer.from([6, ...Array(15).fill(0), 1])),
  );
  assert.equal(
    await keyOf("1::"),
    digestOf(KEY, "ip", Buffer.from([6, 0, 1, ...Array(14).fill(0)])),
  );
  // The same four low bytes in the other family are a different key.
  assert.notEqual(await keyOf("::c000:20a"), await keyOf("192.0.2.10"));
  assert.notEqual(await keyOf("198.51.100.7"), await keyOf("192.0.2.10"));
});

// ---------------------------------------------------------------------------
// Server-only deployment configuration
// ---------------------------------------------------------------------------

test("4. missing, malformed, or out-of-envelope quota settings are refused, never defaulted or clamped", async () => {
  const operation = quotaOperation("allow");
  const malformed = [
    undefined,
    "",
    " 10",
    "10 ",
    "+10",
    "-10",
    "0",
    "00",
    "010",
    "10.0",
    "1e1",
    "0x0a",
    "10n",
    "1_0",
    "１０",
    "Infinity",
    "NaN",
    "99999999999999999999",
  ];
  const cases = [];
  for (const value of malformed) {
    for (const name of [
      "REGISTRATION_QUOTA_IP_MAX_PER_HOUR",
      "REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY",
      "REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR",
    ]) {
      cases.push([name, value]);
    }
  }
  cases.push(
    ["REGISTRATION_QUOTA_IP_MAX_PER_HOUR", "101"],
    ["REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY", "101"],
    ["REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR", "1201"],
    ["REGISTRATION_QUOTA_IP_MAX_PER_HOUR", "1200"],
    ["REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY", "1000"],
    ["REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR", "9999"],
  );
  for (const [name, value] of cases) {
    const control = controlOver(operation, {
      environment: quotaEnvironment({ [name]: value }),
    });
    assert.equal(
      await control.decide({ email: EMAIL }),
      "unavailable",
      `${name}=${value}`,
    );
  }
  assert.deepEqual(operation.calls, []);
  // Nothing reads a setting from the request: with no deployment
  // configuration at all, even a trusted address is unavailable.
  for (const name of [
    HMAC_SETTING,
    "REGISTRATION_QUOTA_IP_MAX_PER_HOUR",
    "REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY",
    "REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR",
  ]) {
    assert.equal(process.env[name], undefined, name);
  }
  const unconfigured = createRegistrationAbuseControl({
    trustedClientAddress: ADDRESS,
    decideQuota: operation.decideQuota,
  });
  assert.equal(await unconfigured.decide({ email: EMAIL }), "unavailable");
  assert.deepEqual(operation.calls, []);
});

test("5. every envelope bound is accepted exactly, and the 10 / 10 / 120 baseline reaches the operation as numbers", async () => {
  for (const [settings, maxima] of [
    [["10", "10", "120"], INITIAL_MAXIMA],
    [["1", "1", "1"], { ipPerHour: 1, identityPerDay: 1, globalPerHour: 1 }],
    [
      ["100", "100", "1200"],
      { ipPerHour: 100, identityPerDay: 100, globalPerHour: 1200 },
    ],
    [
      ["99", "100", "999"],
      { ipPerHour: 99, identityPerDay: 100, globalPerHour: 999 },
    ],
  ]) {
    const operation = quotaOperation("allow");
    const control = controlOver(operation, {
      environment: quotaEnvironment({
        REGISTRATION_QUOTA_IP_MAX_PER_HOUR: settings[0],
        REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY: settings[1],
        REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR: settings[2],
      }),
    });
    assert.equal(await control.decide({ email: EMAIL }), "allow");
    assert.equal(operation.calls.length, 1);
    const [, received, signal] = operation.calls[0];
    assert.deepEqual(received, maxima);
    assert.ok(Object.isFrozen(received));
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  }
});

test("6. a missing, malformed, wrong-length, or non-canonical HMAC key is refused", async () => {
  const operation = quotaOperation("allow");
  const bytes = (length) => Buffer.alloc(length, 0x5a).toString("base64");
  for (const value of [
    undefined,
    "",
    KEY.slice(0, -1),
    `${KEY}=`,
    ` ${KEY}`,
    `${KEY}\n`,
    bytes(31),
    bytes(33),
    bytes(64),
    Buffer.alloc(32, 0x5a).toString("base64url"),
    Buffer.alloc(32, 0xfb).toString("base64url"),
    Buffer.alloc(32, 0x5a).toString("hex"),
    `${KEY.slice(0, 42)}B=`,
  ]) {
    const control = controlOver(operation, {
      environment: quotaEnvironment({ [HMAC_SETTING]: value }),
    });
    assert.equal(await control.decide({ email: EMAIL }), "unavailable");
  }
  assert.deepEqual(operation.calls, []);
  // The canonical encoding of the same 32 bytes with a final character that
  // carries stray bits is a different text, and refused.
  assert.equal(KEY.at(-2), "o");
  const stray = `${KEY.slice(0, 42)}p=`;
  assert.deepEqual(Buffer.from(stray, "base64"), Buffer.from(KEY, "base64"));
  assert.equal(
    await controlOver(operation, {
      environment: quotaEnvironment({ [HMAC_SETTING]: stray }),
    }).decide({ email: EMAIL }),
    "unavailable",
  );
  assert.deepEqual(operation.calls, []);
});

// ---------------------------------------------------------------------------
// Identity normalization, HMAC domain separation, privacy
// ---------------------------------------------------------------------------

test("7. the three opaque digests are domain-separated HMAC-SHA-256 values of the address, lower-cased email, and global label", async () => {
  const operation = quotaOperation("allow");
  assert.equal(await controlOver(operation).decide({ email: EMAIL }), "allow");
  const [digests] = operation.calls[0];
  assert.deepEqual(Object.keys(digests), ["ip", "identity", "global"]);
  assert.ok(Object.isFrozen(digests));
  assert.deepEqual(digests, expectedDigests({ address: ADDRESS_BYTES }));
  for (const value of Object.values(digests)) {
    assert.match(value, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(Object.values(digests)).size, 3);
  // The purpose label separates domains: the same bytes under another label
  // are another digest.
  assert.notEqual(
    digests.identity,
    digestOf(KEY, "ip", Buffer.from(EMAIL.toLowerCase())),
  );
  assert.notEqual(digests.global, digestOf(KEY, "identity", Buffer.alloc(0)));
  // A different key changes every digest; the global label is otherwise
  // invariant across addresses and emails.
  const other = quotaOperation("allow");
  await controlOver(other, {
    environment: quotaEnvironment({ [HMAC_SETTING]: OTHER_KEY }),
  }).decide({ email: EMAIL });
  for (const name of ["ip", "identity", "global"]) {
    assert.notEqual(other.calls[0][0][name], digests[name], name);
  }
  const elsewhere = quotaOperation("allow");
  await controlOver(elsewhere, { address: "198.51.100.7" }).decide({
    email: "other@synthetic.invalid",
  });
  assert.equal(elsewhere.calls[0][0].global, digests.global);
  assert.notEqual(elsewhere.calls[0][0].ip, digests.ip);
  assert.notEqual(elsewhere.calls[0][0].identity, digests.identity);
});

test("8. identity matches the frozen P2-006 lower-case model only: no Unicode, alias, dot, or plus folding", async () => {
  const identityOf = async (email) => {
    const operation = quotaOperation("allow");
    assert.equal(await controlOver(operation).decide({ email }), "allow");
    return operation.calls[0][0].identity;
  };
  const base = await identityOf(EMAIL);
  assert.equal(await identityOf("Applicant@Synthetic.INVALID"), base);
  assert.equal(await identityOf("APPLICANT@SYNTHETIC.INVALID"), base);
  for (const email of [
    "applicant+tag@synthetic.invalid",
    "app.licant@synthetic.invalid",
    "applicant@synthetic.invalid.",
    "applicant@SYNTHETIC.invalid.example",
  ]) {
    assert.notEqual(await identityOf(email), base, email);
  }
  // Composed and decomposed forms stay distinct; nothing is normalized.
  assert.notEqual(
    await identityOf("café@synthetic.invalid"),
    await identityOf("café@synthetic.invalid"),
  );
  // Locale-independent ECMAScript lower-casing.
  assert.equal(
    await identityOf("İ@synthetic.invalid"),
    digestOf(KEY, "identity", Buffer.from("i̇@synthetic.invalid")),
  );
  // An empty, ill-formed, or non-text email is never sent.
  const operation = quotaOperation("allow");
  for (const email of ["", "\ud800@synthetic.invalid", undefined, null, 7]) {
    assert.equal(await controlOver(operation).decide({ email }), "unavailable");
  }
  assert.deepEqual(operation.calls, []);
});

test("9. nothing but the digests, the validated maxima, and an abort signal reaches the quota operation", async () => {
  const operation = quotaOperation("allow");
  const environment = quotaEnvironment();
  await controlOver(operation, { environment }).decide({
    email: EMAIL,
    password: PHRASE,
    role: "staff",
  });
  assert.equal(operation.calls.length, 1);
  const [digests, maxima, signal, ...rest] = operation.calls[0];
  assert.deepEqual(rest, []);
  assert.ok(signal instanceof AbortSignal);
  const serialized = JSON.stringify([digests, maxima]);
  for (const secret of [
    EMAIL,
    EMAIL.toUpperCase(),
    "applicant",
    PHRASE,
    ADDRESS,
    KEY,
    Buffer.from(KEY, "base64").toString("hex"),
    "staff",
    "synthetic",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.deepEqual(Object.keys(maxima), [
    "ipPerHour",
    "identityPerDay",
    "globalPerHour",
  ]);
});

// ---------------------------------------------------------------------------
// Decision parsing, failure, and deadline
// ---------------------------------------------------------------------------

test("10. only an exact allow allows and an exact throttle throttles; every other answer or failure is unavailable", async () => {
  assert.equal(
    await controlOver(quotaOperation("allow")).decide({ email: EMAIL }),
    "allow",
  );
  assert.equal(
    await controlOver(quotaOperation("throttle")).decide({ email: EMAIL }),
    "throttle",
  );
  for (const answer of [
    "deny",
    "unavailable",
    "ALLOW",
    " allow",
    "allow\n",
    "allowed",
    "",
    ["allow"],
    { decision: "allow" },
    { data: "allow" },
    new String("allow"),
    true,
    1,
    null,
    undefined,
    new Error("synthetic failure"),
    () => Promise.reject(new Error("synthetic rejection")),
    () => {
      throw new Error("synthetic throw");
    },
  ]) {
    assert.equal(
      await controlOver(quotaOperation(answer)).decide({ email: EMAIL }),
      "unavailable",
      String(answer),
    );
  }
  for (const decideQuota of [
    undefined,
    null,
    "allow",
    { call: () => "allow" },
  ]) {
    const control = createRegistrationAbuseControl(
      { trustedClientAddress: ADDRESS, decideQuota },
      quotaEnvironment(),
    );
    assert.equal(await control.decide({ email: EMAIL }), "unavailable");
  }
  // A malformed request never throws out of the control.
  for (const options of [null, undefined, {}]) {
    const control = createRegistrationAbuseControl(options, quotaEnvironment());
    assert.equal(await control.decide({ email: EMAIL }), "unavailable");
  }
  const control = controlOver(quotaOperation("allow"));
  assert.equal(await control.decide(null), "unavailable");
  assert.equal(await control.decide(undefined), "unavailable");
});

test("11. an answer later than the 2,000 ms client deadline is unavailable and the operation is aborted", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let seen;
    let resolveLate;
    const operation = quotaOperation(
      (_digests, _maxima, signal) =>
        new Promise((resolve) => {
          seen = signal;
          resolveLate = resolve;
        }),
    );
    let settled = false;
    const pending = controlOver(operation)
      .decide({ email: EMAIL })
      .then((decision) => {
        settled = true;
        return decision;
      });
    await Promise.resolve();
    // setImmediate is not mocked, so each flush runs every pending reaction
    // without waiting on a decision that might never settle.
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1999);
    await flush();
    assert.equal(settled, false);
    assert.equal(seen.aborted, false);
    mock.timers.tick(1);
    await flush();
    assert.equal(settled, true);
    assert.equal(await pending, "unavailable");
    assert.equal(seen.aborted, true);
    // A late allow changes nothing.
    resolveLate("allow");
    assert.equal(await pending, "unavailable");
    // An answer within the deadline clears its timer.
    const prompt = controlOver(quotaOperation("allow")).decide({
      email: EMAIL,
    });
    assert.equal(await prompt, "allow");
  } finally {
    mock.timers.reset();
  }
});

test("12. only an exact allow reaches the unchanged provisioning sequence; invalid forms never reach the quota", async () => {
  for (const [answer, expected, provisioned] of [
    ["allow", "submitted", true],
    ["throttle", "unavailable", false],
    ["deny", "unavailable", false],
    [new Error("synthetic"), "unavailable", false],
  ]) {
    const operation = quotaOperation(answer);
    const ports = recordingPorts();
    const result = await registerClientAccount(
      ports.sources(controlOver(operation)),
      validForm(),
    );
    assert.equal(result.status, expected, String(answer));
    assert.equal(operation.calls.length, 1);
    assert.equal(
      ports.calls.some((call) => call[0] === "createAccount"),
      provisioned,
    );
    if (!provisioned) {
      assert.deepEqual(ports.calls, []);
    }
  }
  const operation = quotaOperation("allow");
  const ports = recordingPorts();
  for (const entries of [
    [],
    [["email", EMAIL]],
    [
      ["email", "not an address"],
      ["password", PHRASE],
      ["confirm_password", PHRASE],
    ],
    [
      ["email", EMAIL],
      ["password", "short"],
      ["confirm_password", "short"],
    ],
    [
      ["email", EMAIL],
      ["password", PHRASE],
      ["confirm_password", `${PHRASE}!`],
    ],
  ]) {
    const result = await registerClientAccount(
      ports.sources(controlOver(operation)),
      form(entries),
    );
    assert.equal(result.status, "invalid");
  }
  assert.deepEqual(operation.calls, []);
  assert.deepEqual(ports.calls, []);
});

test("13. identical settings on separate instances send identical requests; differing settings send their own maxima", async () => {
  const first = quotaOperation("allow");
  const second = quotaOperation("allow");
  await controlOver(first).decide({ email: EMAIL });
  await controlOver(second).decide({ email: EMAIL });
  assert.deepEqual(first.calls[0].slice(0, 2), second.calls[0].slice(0, 2));
  // A differently configured instance cannot pass another instance's policy:
  // it sends its own maxima, and the database refuses a mismatch with any
  // existing current row (proven only by the disposable PostgreSQL harness).
  const mixed = quotaOperation("allow");
  await controlOver(mixed, {
    environment: quotaEnvironment({ REGISTRATION_QUOTA_IP_MAX_PER_HOUR: "11" }),
  }).decide({ email: EMAIL });
  assert.deepEqual(mixed.calls[0][0], first.calls[0][0]);
  assert.deepEqual(mixed.calls[0][1], { ...INITIAL_MAXIMA, ipPerHour: 11 });
});

// ---------------------------------------------------------------------------
// The narrow privileged quota capability through the installed client
// ---------------------------------------------------------------------------

const PROJECT_REF = "syntheticprojectrefa";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const ADMIN = "sb_secret_synthetic7f3a";

const boundEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: PROJECT_REF,
  ...overrides,
});

const DIGESTS = Object.freeze(expectedDigests({ address: ADDRESS_BYTES }));

function syntheticRpcApi(answer = () => [200, "allow"]) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: await request.text(),
      signal: init.signal,
    });
    const [status, payload] = answer();
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetch };
}

function factoryOver(fetch, made = []) {
  return (url, key, options) => {
    made.push([url, key, options]);
    return createClient(url, key, { ...options, global: { fetch } });
  };
}

test("14. the quota capability sends one privileged, cookie-free POST of exactly the six fixed arguments", async () => {
  const api = syntheticRpcApi();
  const made = [];
  const signal = new AbortController().signal;
  assert.equal(
    await decideQuotaRpc(
      { ...DIGESTS, email: EMAIL },
      { ...INITIAL_MAXIMA, extra: 999 },
      signal,
      boundEnvironment(),
      factoryOver(api.fetch, made),
    ),
    "allow",
  );
  assert.deepEqual(made, [
    [
      PROJECT_URL,
      ADMIN,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    ],
  ]);
  assert.equal(api.requests.length, 1);
  const [request] = api.requests;
  assert.equal(request.method, "POST");
  assert.equal(
    request.url.href,
    `${PROJECT_URL}/rest/v1/rpc/registration_quota_decide`,
  );
  assert.deepEqual(JSON.parse(request.body), {
    ip_digest: DIGESTS.ip,
    identity_digest: DIGESTS.identity,
    global_digest: DIGESTS.global,
    ip_max: 10,
    identity_max: 10,
    global_max: 120,
  });
  assert.equal(request.headers.get("authorization"), `Bearer ${ADMIN}`);
  assert.equal(request.headers.get("apikey"), ADMIN);
  assert.equal(request.headers.get("cookie"), null);
  assert.equal(request.body.includes(EMAIL), false);
  assert.equal(request.signal, signal);
  // The database's answer is returned exactly as received.
  for (const [status, payload, expected] of [
    [200, "throttle", "throttle"],
    [200, "something else", "something else"],
    [200, null, null],
    [
      400,
      { code: "22023", message: "registration quota unavailable" },
      undefined,
    ],
    [
      500,
      { code: "55000", message: "registration quota unavailable" },
      undefined,
    ],
    [404, { code: "PGRST202", message: "not found" }, undefined],
  ]) {
    const failing = syntheticRpcApi(() => [status, payload]);
    assert.deepEqual(
      await decideQuotaRpc(
        DIGESTS,
        INITIAL_MAXIMA,
        signal,
        boundEnvironment(),
        factoryOver(failing.fetch),
      ),
      expected,
      `${status}`,
    );
    assert.equal(failing.requests.length, 1, "never retried");
  }
});

test("15. an unbound project or invalid argument builds no client and sends nothing; an aborted call is undefined", async () => {
  const signal = new AbortController().signal;
  const invalid = [
    [{ ROSUNO_SUPABASE_ADMIN_KEY: undefined }, DIGESTS, INITIAL_MAXIMA],
    [{ ROSUNO_SUPABASE_ADMIN_KEY: PUBLISHABLE }, DIGESTS, INITIAL_MAXIMA],
    [
      { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "syntheticprojectrefb" },
      DIGESTS,
      INITIAL_MAXIMA,
    ],
    [{}, { ...DIGESTS, ip: DIGESTS.ip.toUpperCase() }, INITIAL_MAXIMA],
    [{}, { ...DIGESTS, identity: DIGESTS.identity.slice(1) }, INITIAL_MAXIMA],
    [{}, { ...DIGESTS, global: undefined }, INITIAL_MAXIMA],
    [{}, { ...DIGESTS, ip: EMAIL }, INITIAL_MAXIMA],
    [{}, DIGESTS, { ...INITIAL_MAXIMA, ipPerHour: 0 }],
    [{}, DIGESTS, { ...INITIAL_MAXIMA, identityPerDay: 1.5 }],
    [{}, DIGESTS, { ...INITIAL_MAXIMA, globalPerHour: "120" }],
    [{}, DIGESTS, { ...INITIAL_MAXIMA, globalPerHour: Number.NaN }],
  ];
  for (const [overrides, digests, maxima] of invalid) {
    const made = [];
    const api = syntheticRpcApi();
    assert.equal(
      await decideQuotaRpc(
        digests,
        maxima,
        signal,
        boundEnvironment(overrides),
        factoryOver(api.fetch, made),
      ),
      undefined,
    );
    assert.deepEqual(made, []);
    assert.deepEqual(api.requests, []);
  }
  // Abort: the transport is cancelled and the call resolves undefined.
  const controller = new AbortController();
  let attempts = 0;
  const waiting = (_input, init) =>
    new Promise((_resolve, reject) => {
      attempts += 1;
      if (init.signal.aborted) {
        reject(init.signal.reason);
      }
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const call = decideQuotaRpc(
    DIGESTS,
    INITIAL_MAXIMA,
    controller.signal,
    boundEnvironment(),
    factoryOver(waiting),
  );
  for (let turn = 0; turn < 100 && attempts === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(attempts, 1);
  controller.abort();
  assert.equal(await call, undefined);
  assert.equal(attempts, 1);
});

test("16. through the adapter and the installed client, a throttled or failed database answer never allows", async () => {
  for (const [status, payload, expected] of [
    [200, "allow", "allow"],
    [200, "throttle", "throttle"],
    [200, "deny", "unavailable"],
    [
      500,
      { code: "57014", message: "registration quota unavailable" },
      "unavailable",
    ],
  ]) {
    const api = syntheticRpcApi(() => [status, payload]);
    const control = createRegistrationAbuseControl(
      {
        trustedClientAddress: ADDRESS,
        decideQuota: (digests, maxima, signal) =>
          decideQuotaRpc(
            digests,
            maxima,
            signal,
            boundEnvironment(),
            factoryOver(api.fetch),
          ),
      },
      quotaEnvironment(),
    );
    assert.equal(await control.decide({ email: EMAIL }), expected);
    assert.equal(api.requests.length, 1);
    assert.deepEqual(JSON.parse(api.requests[0].body), {
      ip_digest: DIGESTS.ip,
      identity_digest: DIGESTS.identity,
      global_digest: DIGESTS.global,
      ip_max: 10,
      identity_max: 10,
      global_max: 120,
    });
  }
});

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

test("17. the adapter is server-only, reads only its four settings, and holds no credential, client, or request input", () => {
  const file = "src/infrastructure/identity/registration-abuse-control.ts";
  const source = read(file);
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "node:crypto",
    "../../application/client-registration.ts",
  ]);
  assert.match(
    code,
    /^import type \{\n {2}AbuseControl,\n {2}AbuseDecision,\n\} from "\.\.\/\.\.\/application\/client-registration\.ts";$/m,
  );
  assert.deepEqual([...new Set(code.match(/process\.env\.\w+/g))].sort(), [
    "process.env.REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR",
    `process.env.${HMAC_SETTING}`,
    "process.env.REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY",
    "process.env.REGISTRATION_QUOTA_IP_MAX_PER_HOUR",
  ]);
  assert.equal(code.match(/\bprocess\.env\b/g).length, 4);
  assert.deepEqual(
    [
      ...code.matchAll(
        /^export (?:async function|function|const|type) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    [
      "AbuseControlEnvironment",
      "QuotaDecisionRpc",
      "RegistrationAbuseControlOptions",
      "NO_TRUSTED_CLIENT_ADDRESS",
      "createRegistrationAbuseControl",
    ],
  );
  assert.equal(code.match(/\bexport\b/g).length, 5);
  assert.match(code, /^export const NO_TRUSTED_CLIENT_ADDRESS = null;$/m);
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  assert.doesNotMatch(
    code,
    /supabase|createClient|ROSUNO_|NEXT_PUBLIC|service_role|sb_secret|admin|next\/|headers|cookies|forwarded|\bconsole\b|\bfetch\b|\.rpc\b|localStorage|Math\.random|\bDate\b|\beval\b|\bimport\s*\(|\brequire\s*\(|^(?:let|var) /im,
  );
  // One HMAC construction, with SHA-256 and the versioned domain.
  assert.equal(code.match(/\bcreateHmac\(/g).length, 1);
  assert.match(code, /createHmac\("sha256", key\)/);
  assert.match(code, /const DIGEST_DOMAIN = "registration-quota\/v1";/);
  assert.match(code, /const QUOTA_DEADLINE_MS = 2000;/);
  assert.match(code, /const IP_MAX_CEILING = 100;/);
  assert.match(code, /const IDENTITY_MAX_CEILING = 100;/);
  assert.match(code, /const GLOBAL_MAX_CEILING = 1200;/);
});

test("18. the migration is one private relation and one restricted SECURITY INVOKER decision function", () => {
  const sql = read(MIGRATION, repositoryRoot);
  const code = sqlOf(sql);
  assert.match(
    sql,
    /^-- P2-007 local candidate\. Unreviewed and unapplied\.\n/,
  );
  assert.equal(code.match(/\bcreate\b/gi).length, 3);
  assert.equal(
    code.match(/^create table public\.registration_quota_counters \(/gm).length,
    1,
  );
  assert.equal(
    code.match(/^create function public\.registration_quota_decide\(/gm).length,
    1,
  );
  assert.equal(
    code.match(/^create index registration_quota_counters_expiry_idx$/gm)
      .length,
    1,
  );
  assert.match(
    code,
    /\nreturns text\nlanguage plpgsql\nvolatile\nsecurity invoker\nset search_path = pg_catalog\nset lock_timeout = '250ms'\nas \$function\$\n/,
  );
  assert.match(
    code,
    /^alter table public\.registration_quota_counters enable row level security;$/m,
  );
  assert.doesNotMatch(
    code,
    /security definer|create policy|create extension|pgcrypto|dblink|execute\s+format|\bexecute\s+'|grant\s+[^;]*\bto\s+(?:public|anon|authenticated)\b|alter role|alter default|set role|bypassrls|truncate|drop\b|now\(\)|current_timestamp/i,
  );
  // The fixed signature: three opaque digests and three maxima.
  assert.match(
    code,
    /create function public\.registration_quota_decide\(\n {2}ip_digest text,\n {2}identity_digest text,\n {2}global_digest text,\n {2}ip_max integer,\n {2}identity_max integer,\n {2}global_max integer\n\)/,
  );
  // Revocation from every caller role, then the minimum for service_role.
  assert.match(
    code,
    /revoke all on function public\.registration_quota_decide\(\n {2}text, text, text, integer, integer, integer\n\) from public, anon, authenticated, service_role;\ngrant execute on function public\.registration_quota_decide\(\n {2}text, text, text, integer, integer, integer\n\) to service_role;/,
  );
  assert.match(
    code,
    /revoke all on table public\.registration_quota_counters\n {2}from public, anon, authenticated, service_role;\ngrant select, insert, delete\n {2}on table public\.registration_quota_counters to service_role;\ngrant update \(\n {2}accepted_count,\n {2}throttled_count\n\) on table public\.registration_quota_counters to service_role;/,
  );
  assert.equal(code.match(/\bgrant\b/gi).length, 3);
  // SQL-enforced envelopes, fixed windows, and bounds.
  assert.match(code, /ip_max not between 1 and 100\n/);
  assert.match(code, /identity_max not between 1 and 100\n/);
  assert.match(code, /global_max not between 1 and 1200 then\n/);
  assert.match(
    code,
    /'v1:ip=%s:identity=%s:global=%s:windows=3600,86400,3600'/,
  );
  assert.equal(
    code.match(/pg_advisory_xact_lock\(2026102007000000\)/g).length,
    1,
  );
  assert.equal(code.match(/clock_timestamp\(\)/g).length, 2);
  assert.match(code, /decided_at := clock_timestamp\(\);/);
  assert.match(code, /limit 100\n/);
  assert.match(code, /> interval '1500 milliseconds' then/);
  assert.match(code, /c\.throttled_count < 2147483647;/);
  // No raw identifier, person, account, brand, tenant, or jurisdiction
  // column.
  const table = code.slice(
    code.indexOf("create table"),
    code.indexOf("alter table"),
  );
  assert.deepEqual(
    [
      ...table.matchAll(
        /^ {2}([a-z_]+) (?:text|timestamptz|integer) not null,$/gm,
      ),
    ].map((match) => match[1]),
    [
      "dimension",
      "digest",
      "window_start",
      "window_end",
      "expires_at",
      "accepted_count",
      "throttled_count",
      "policy_marker",
    ],
  );
  assert.doesNotMatch(
    code.slice(0, code.indexOf("\ncomment on table")),
    /email|\baddress\b|ip_address|inet|user_id|auth\.|profile|attorney|client_id|brand|tenant|licensee|jurisdiction|password|token/i,
  );
});
