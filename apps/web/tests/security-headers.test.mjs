// MVP-001 D-5: security headers on every route.
//
// next.config.ts runs here through Node.js type stripping, and its header
// rules are matched with the same path matcher Next.js uses for them. The
// email confirmation handler is run from its own source to show that it keeps
// its own, stricter headers, which a matching rule here would replace.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import nextConfig from "../next.config.ts";
import * as confirmRoute from "../app/auth/confirm/route.ts";

const requireHere = createRequire(import.meta.url);
const { getPathMatch } = requireHere(
  "next/dist/shared/lib/router/utils/path-match.js",
);
const { modifyRouteRegex } = requireHere("next/dist/lib/redirect-status.js");

const EXPECTED_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TRANSPORT = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000; includeSubDomains",
};
const EXPECTED_RULES = [
  {
    source: "/((?!auth/confirm$).*)",
    headers: [
      { key: "Content-Security-Policy", value: EXPECTED_POLICY },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      TRANSPORT,
    ],
  },
  { source: "/auth/confirm", headers: [TRANSPORT] },
];

function directives(policy) {
  return new Map(
    policy.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

// The headers Next.js would send for a path from these rules, as it matches
// them, later rules winning.
async function headersFor(path) {
  const sent = new Map();
  for (const rule of await nextConfig.headers()) {
    const match = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex) => modifyRouteRegex(regex),
    });
    if (match(path) !== false) {
      for (const { key, value } of rule.headers) {
        sent.set(key.toLowerCase(), value);
      }
    }
  }
  return sent;
}

test("1. the header set is exactly the fixed policy, framing, referrer, sniffing and transport headers", async () => {
  assert.deepEqual(await nextConfig.headers(), EXPECTED_RULES);
  // Fresh, equal rules on every call: nothing is computed from a request.
  assert.deepEqual(await nextConfig.headers(), await nextConfig.headers());
});

test("2. the policy allows only this origin, no eval, no inline style, no plugin, no framing, and no foreign form target", () => {
  const policy = directives(EXPECTED_POLICY);
  assert.deepEqual(
    [...policy.keys()],
    [
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ],
  );
  for (const [name, values] of policy) {
    assert.doesNotMatch(
      values.join(" "),
      /unsafe-eval|\*|https?:|data:|blob:/,
      name,
    );
  }
  // Only scripts take 'unsafe-inline': the App Router's per-request inline
  // hydration data cannot be allowed by hash, and no nonce is issued.
  assert.deepEqual(policy.get("script-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(policy.get("style-src"), ["'self'"]);
  assert.deepEqual(policy.get("connect-src"), ["'self'"]);
  assert.deepEqual(policy.get("object-src"), ["'none'"]);
  assert.deepEqual(policy.get("base-uri"), ["'none'"]);
  assert.deepEqual(policy.get("form-action"), ["'self'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
  // Transport security lasts at least a year and covers subdomains.
  const [maxAge, ...rest] = TRANSPORT.value.split("; ");
  assert.ok(Number(maxAge.replace("max-age=", "")) >= 31536000);
  assert.deepEqual(rest, ["includeSubDomains"]);
});

test("3. every route gets the full set, and the confirmation handler gets only transport security from here", async () => {
  const full = new Map(
    EXPECTED_RULES[0].headers.map(({ key, value }) => [
      key.toLowerCase(),
      value,
    ]),
  );
  for (const path of [
    "/",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
    "/client",
    "/client/intakes/00000000-0000-4000-8000-000000000401",
    "/attorney",
    "/attorney/apply",
    "/attorney/professional",
    "/staff/verification",
    "/staff/verification/00000000-0000-4000-8000-000000000001",
    // MVP-001 S2: the authenticator setup and step-up pages, the
    // operational job view, and the protected job worker route.
    "/account/security",
    "/account/step-up",
    "/staff/jobs",
    "/api/jobs/run",
    "/_next/static/chunks/synthetic.js",
    "/no-such-page",
    "/auth",
    "/auth/confirm/",
    "/auth/confirmation",
    "/auth/confirm/extra",
  ]) {
    assert.deepEqual(await headersFor(path), full, path);
  }
  assert.deepEqual(
    await headersFor("/auth/confirm"),
    new Map([[TRANSPORT.key.toLowerCase(), TRANSPORT.value]]),
  );
});

test("4. the confirmation handler still sends its own stricter headers on every response", async () => {
  const previous = process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
  delete process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
  try {
    const responses = [
      confirmRoute.GET(new Request("http://localhost/auth/confirm")),
      await confirmRoute.POST(
        new Request("http://localhost/auth/confirm", { method: "POST" }),
      ),
    ];
    for (const response of responses) {
      const policy = directives(
        response.headers.get("content-security-policy"),
      );
      assert.deepEqual(policy.get("default-src"), ["'none'"]);
      assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
      assert.deepEqual(policy.get("base-uri"), ["'none'"]);
      assert.equal(response.headers.get("referrer-policy"), "strict-origin");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  } finally {
    if (previous === undefined) {
      delete process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
    } else {
      process.env.ROSUNO_AUTH_PUBLIC_ORIGIN = previous;
    }
  }
});
