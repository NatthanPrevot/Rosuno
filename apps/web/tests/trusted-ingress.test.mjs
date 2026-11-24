// P2-923 trusted ingress (owner DECISION C; P2-007 section 5 and D-04).
//
// The registration client address comes only from X-Forwarded-For, and only
// as the fourth entry from the right behind the observed Replit edge: its
// load balancer 34.117.33.233, then an address in 35.191.0.0/16, then one
// internal hop. These cases replay the P2-923 evidence shapes with
// documentation addresses only (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24, 2001:db8::/32); none is a real client.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createRegistrationAbuseControl } from "../src/infrastructure/identity/registration-abuse-control.ts";
import {
  trustedClientAddress,
  trustedClientAddressOf,
} from "../src/infrastructure/identity/trusted-ingress.ts";

const appRoot = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
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

const CLIENT = "192.0.2.44";
const CLIENT_V6 = "2001:db8::44";
const EDGE = "34.117.33.233";
const FRONT_END = "35.191.17.81";
const INTERNAL = "35.253.99.231";

// The edge's own three entries, exactly as observed (the last appended
// without a space).
const edgeSuffix = (frontEnd = FRONT_END, internal = INTERNAL) =>
  `${EDGE}, ${frontEnd},${internal}`;

const chain = (...left) => [...left, edgeSuffix()].join(", ");

// ---------------------------------------------------------------------------
// The one trusted position
// ---------------------------------------------------------------------------

test("1. the client is exactly the fourth entry from the right behind the observed edge", () => {
  // Evidence shape 1: a plain request.
  assert.equal(trustedClientAddressOf(chain(CLIENT)), CLIENT);
  // The front-end and internal hops vary from request to request.
  for (const [frontEnd, internal] of [
    ["35.191.76.26", "34.56.62.242"],
    ["35.191.161.96", "34.9.159.120"],
    ["35.191.0.1", "10.0.0.1"],
    ["35.191.255.255", "34.16.195.99"],
  ]) {
    assert.equal(
      trustedClientAddressOf(`${CLIENT}, ${edgeSuffix(frontEnd, internal)}`),
      CLIENT,
    );
  }
  // Separators with or without spaces, as the edge writes them.
  assert.equal(
    trustedClientAddressOf(`${CLIENT},${EDGE},${FRONT_END},${INTERNAL}`),
    CLIENT,
  );
  // An IPv6 client is handed on as written for the strict parser to judge.
  assert.equal(trustedClientAddressOf(chain(CLIENT_V6)), CLIENT_V6);
});

test("2. entries a client sends on the left never change the trusted address", () => {
  // Evidence shapes 2, 3 and 6: forged values stay on the left.
  assert.equal(trustedClientAddressOf(chain("203.0.113.7", CLIENT)), CLIENT);
  assert.equal(
    trustedClientAddressOf(chain("203.0.113.7", "198.51.100.9", CLIENT)),
    CLIENT,
  );
  // A client that forges the whole edge topology itself is still read at
  // its real position, after the edge's genuine three entries.
  assert.equal(
    trustedClientAddressOf(
      chain("203.0.113.9", EDGE, "35.191.1.1", "10.0.0.1", CLIENT),
    ),
    CLIENT,
  );
  assert.equal(
    trustedClientAddressOf(chain(EDGE, FRONT_END, INTERNAL, CLIENT)),
    CLIENT,
  );
});

test("3. twenty entries are the most accepted; more, fewer, or any empty entry is no address", () => {
  const forged = Array.from({ length: 16 }, (_, i) => `198.51.100.${i + 1}`);
  assert.equal(forged.length + 4, 20);
  assert.equal(trustedClientAddressOf(chain(...forged, CLIENT)), CLIENT);
  assert.equal(
    trustedClientAddressOf(chain("198.51.100.200", ...forged, CLIENT)),
    null,
  );
  for (const value of [
    `${EDGE}, ${FRONT_END},${INTERNAL}`,
    `${EDGE}, ${FRONT_END}`,
    "",
    ",",
    `, ${chain(CLIENT)}`,
    `${chain(CLIENT)},`,
    `${CLIENT}, , ${edgeSuffix()}`,
    `${CLIENT},, ${edgeSuffix()}`,
  ]) {
    assert.equal(trustedClientAddressOf(value), null, value);
  }
});

test("4. any other topology, or a missing or non-text header, is no address", () => {
  for (const value of [
    null,
    undefined,
    42,
    {},
    ["192.0.2.44"],
    // The load balancer must be exactly the observed address, third from the right.
    `${CLIENT}, 34.117.33.234, ${FRONT_END},${INTERNAL}`,
    `${CLIENT}, 34.117.33.2330, ${FRONT_END},${INTERNAL}`,
    `${CLIENT}, ${EDGE}x, ${FRONT_END},${INTERNAL}`,
    `${CLIENT}, ${FRONT_END}, ${EDGE},${INTERNAL}`,
    `${CLIENT}, ${FRONT_END},${INTERNAL}, ${EDGE}`,
    `${EDGE}, ${CLIENT}, ${FRONT_END},${INTERNAL}`,
    // The front end must be a strict four-octet address inside 35.191.0.0/16.
    `${CLIENT}, ${EDGE}, 35.192.1.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 34.191.1.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 36.191.0.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 035.191.1.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 35.191.01.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 35.191.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 35.191.1.256,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 35.191.1.1.1,${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 2001:db8::35,${INTERNAL}`,
    // A header longer than any legitimate chain is refused before splitting.
    `${"1".repeat(1025)}, ${chain(CLIENT)}`,
  ]) {
    assert.equal(trustedClientAddressOf(value), null, String(value));
  }
});

test("5. a client entry with characters no address literal has is no address", () => {
  for (const client of [
    "[2001:db8::44]",
    "fe80::1%en0",
    "client.synthetic.invalid",
    "unknown",
    "192.0.2.44/32",
    "_hidden",
    "1",
    "0123456789abcdef0123456789abcdef01234567",
  ]) {
    assert.equal(trustedClientAddressOf(chain(client)), null, client);
  }
});

// ---------------------------------------------------------------------------
// Through the unchanged registration abuse control
// ---------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 0x5a).toString("base64");
const DOMAIN = "registration-quota/v1";
const EMAIL = "applicant@synthetic.invalid";

const environment = () => ({
  REGISTRATION_QUOTA_HMAC_SECRET: KEY,
  REGISTRATION_QUOTA_IP_MAX_PER_HOUR: "10",
  REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY: "10",
  REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR: "120",
});

function ipDigest(bytes) {
  return createHmac("sha256", Buffer.from(KEY, "base64"))
    .update(`${DOMAIN}\u0000ip\u0000`, "utf8")
    .update(Buffer.from(bytes))
    .digest("hex");
}

async function decideFor(forwardedFor) {
  const calls = [];
  const control = createRegistrationAbuseControl(
    {
      trustedClientAddress: trustedClientAddressOf(forwardedFor),
      decideQuota: async (...args) => {
        calls.push(args);
        return "allow";
      },
    },
    environment(),
  );
  return { decision: await control.decide({ email: EMAIL }), calls };
}

test("6. a trusted chain reaches the quota once, keyed by the real client, and forged entries do not move the key", async () => {
  const plain = await decideFor(chain(CLIENT));
  assert.equal(plain.decision, "allow");
  assert.equal(plain.calls.length, 1);
  assert.equal(plain.calls[0][0].ip, ipDigest([4, 192, 0, 2, 44]));
  for (const forwarded of [
    chain("203.0.113.7", CLIENT),
    chain("203.0.113.7", "198.51.100.9", CLIENT),
    chain("203.0.113.9", EDGE, "35.191.1.1", "10.0.0.1", CLIENT),
  ]) {
    const attempt = await decideFor(forwarded);
    assert.equal(attempt.decision, "allow");
    assert.equal(attempt.calls.length, 1);
    assert.equal(attempt.calls[0][0].ip, plain.calls[0][0].ip);
  }
  // An IPv6 client gets its own canonical key.
  const v6 = await decideFor(chain(CLIENT_V6));
  assert.equal(v6.decision, "allow");
  assert.equal(
    v6.calls[0][0].ip,
    ipDigest([6, 0x20, 0x01, 0x0d, 0xb8, ...Array(10).fill(0), 0x00, 0x44]),
  );
});

test("7. an untrusted chain, or a client entry the strict parser refuses, is unavailable before any quota call", async () => {
  for (const forwarded of [
    null,
    `${CLIENT}, 34.117.33.234, ${FRONT_END},${INTERNAL}`,
    `${CLIENT}, ${EDGE}, 35.192.1.1,${INTERNAL}`,
    `${EDGE}, ${FRONT_END},${INTERNAL}`,
    // Address characters, but no canonical literal: a port, an IPv4-mapped
    // IPv6 address, the unspecified addresses, and a leading-zero octet.
    chain("192.0.2.44:443"),
    chain("::ffff:192.0.2.44"),
    chain("::ffff:c000:22c"),
    chain("0.0.0.0"),
    chain("::"),
    chain("192.0.2.044"),
    chain("2001:db8:::44"),
  ]) {
    const attempt = await decideFor(forwarded);
    assert.equal(attempt.decision, "unavailable", String(forwarded));
    assert.deepEqual(attempt.calls, [], String(forwarded));
  }
});

test("8. outside a request no header can be read, so there is no address and nothing throws", async () => {
  assert.equal(await trustedClientAddress(), null);
});

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

test("9. the module reads exactly one header through next/headers, pins the evidenced edge, and logs nothing", () => {
  const source = read("src/infrastructure/identity/trusted-ingress.ts");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), []);
  assert.deepEqual(
    [...code.matchAll(/\bimport\s*\(([^)]*)\)/g)].map((match) => match[1]),
    ['"next/headers"'],
  );
  assert.deepEqual(
    [...code.matchAll(/\.get\(([^)]*)\)/g)].map((match) => match[1]),
    ["FORWARDED_FOR"],
  );
  assert.match(code, /\nconst FORWARDED_FOR = "x-forwarded-for";\n/);
  assert.match(code, /\nconst EDGE_LOAD_BALANCER = "34\.117\.33\.233";\n/);
  assert.match(
    code,
    /\nconst FRONT_END_FIRST_OCTETS = \["35", "191"\] as const;\n/,
  );
  assert.match(code, /\nconst MIN_ENTRIES = 4;\nconst MAX_ENTRIES = 20;\n/);
  assert.deepEqual(
    [...code.matchAll(/\bexport\b[^\n]*/g)].map((match) => match[0]),
    [
      "export function trustedClientAddressOf(",
      "export async function trustedClientAddress(): Promise<string | null> {",
    ],
  );
  // No other source of an address, no configuration, and no output.
  assert.doesNotMatch(
    code,
    /x-real-ip|true-client-ip|cf-connecting-ip|"forwarded"|remoteAddress|socket|process\.env|console|logRequestEvent|cookies|searchParams|\brequest\b/i,
  );
});

test("10. the sign-up action takes its client address from the trusted ingress only", () => {
  const action = codeOf(read("app/sign-up/actions.ts"));
  assert.equal(
    action.match(/trustedClientAddress: await trustedClientAddress\(\),/g)
      .length,
    1,
  );
  assert.doesNotMatch(action, /next\/headers|x-forwarded-for|headers\(\)/);
});
